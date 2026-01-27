/**
 * LinkedIn Profile Lookup API
 * Resolves member IDs to public identifiers (vanity URLs)
 */

import type { LinkedInClient } from './client'
import type { VectorImage } from './types'
import { API_URLS, CONTENT_TYPES } from './constants'
import { newGetRequest, linkedInEncode } from './request'

// ============================================================================
// Types
// ============================================================================

export interface ProfileLookupResult {
  memberId: string
  publicIdentifier: string | null
  firstName: string | null
  lastName: string | null
  headline: string | null
  picture: VectorImage | null
}

interface RawMiniProfile {
  entityUrn?: string
  publicIdentifier?: string
  firstName?: string
  lastName?: string
  occupation?: string
  profilePicture?: {
    displayImageReference?: {
      vectorImage?: {
        rootUrl?: string
        artifacts?: Array<{
          width?: number
          height?: number
          fileIdentifyingUrlPathSegment: string
        }>
      }
    }
  }
  $type?: string
}

interface ProfileApiResponse {
  data?: Record<string, unknown>
  included?: RawMiniProfile[]
}

// ============================================================================
// Profile Lookup
// ============================================================================

/**
 * Look up a single profile by member ID to get public identifier.
 * Uses the Voyager identity API.
 */
export async function getProfileByMemberId(
  client: LinkedInClient,
  memberId: string
): Promise<ProfileLookupResult | null> {
  const results = await getProfilesByMemberIds(client, [memberId])
  return results[0] ?? null
}

/**
 * Batch look up profiles by member IDs to get public identifiers.
 * More efficient than individual lookups. Limited to 50 at a time.
 * 
 * @param client - LinkedIn client with valid cookies
 * @param memberIds - Array of member IDs (the URN ID portion, e.g., "ACoAAEFsIqIB...")
 * @returns Array of profile results (same order as input)
 */
export async function getProfilesByMemberIds(
  client: LinkedInClient,
  memberIds: string[]
): Promise<(ProfileLookupResult | null)[]> {
  if (memberIds.length === 0) return []
  if (memberIds.length > 50) {
    throw new Error('Cannot look up more than 50 profiles at once')
  }

  const cookies = client.cookies
  if (!cookies.length) {
    throw new Error('No cookies available for profile lookup')
  }

  // Build the profile URN list for the query
  const profileUrns = memberIds.map((id) => linkedInEncode(`urn:li:fsd_profile:${id}`))
  
  // Use the profiles decoration API with a simple decoration
  const queryId = 'voyagerIdentityDashProfiles.a3a77e9201f50ec7c2cd9e8cdae3ef38'
  
  const queryParams = new URLSearchParams({
    variables: `(profileUrns:List(${profileUrns.join(',')}))`,
    queryId,
  })

  const url = `${API_URLS.voyagerGraphQL}?${queryParams.toString()}`

  try {
    const response = await newGetRequest(url, cookies)
      .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
      .withXLIHeaders()
      .doJSON<ProfileApiResponse>()

    // Parse the included array for mini profiles
    const profileMap = new Map<string, ProfileLookupResult>()
    
    if (response.included) {
      for (const item of response.included) {
        if (item.$type === 'com.linkedin.voyager.dash.identity.profile.Profile' || 
            item.$type === 'com.linkedin.voyager.identity.shared.MiniProfile') {
          // Extract member ID from entityUrn
          const memberIdMatch = item.entityUrn?.match(/urn:li:(?:fsd_profile|member):([^,)]+)/)
          if (memberIdMatch) {
            const id = memberIdMatch[1]
            profileMap.set(id, {
              memberId: id,
              publicIdentifier: item.publicIdentifier ?? null,
              firstName: item.firstName ?? null,
              lastName: item.lastName ?? null,
              headline: item.occupation ?? null,
              picture: parseVectorImage(item.profilePicture),
            })
          }
        }
      }
    }

    // Return results in the same order as input
    return memberIds.map((id) => profileMap.get(id) ?? null)
  } catch (error) {
    console.error('[LinkedIn] Profile lookup failed:', error)
    return memberIds.map(() => null)
  }
}

/**
 * Look up profiles by URNs (full URN format).
 * Convenience wrapper that extracts member IDs from URNs.
 */
export async function getProfilesByURNs(
  client: LinkedInClient,
  urns: string[]
): Promise<(ProfileLookupResult | null)[]> {
  const memberIds = urns.map((urn) => {
    const match = urn.match(/urn:li:(?:fsd_profile|member):([^,)]+)/)
    return match?.[1] ?? ''
  }).filter(Boolean)

  if (memberIds.length !== urns.length) {
    console.warn('[LinkedIn] Some URNs could not be parsed')
  }

  return getProfilesByMemberIds(client, memberIds)
}

// ============================================================================
// Helpers
// ============================================================================

function parseVectorImage(
  profilePicture: RawMiniProfile['profilePicture']
): VectorImage | null {
  const vectorImage = profilePicture?.displayImageReference?.vectorImage
  const artifacts = vectorImage?.artifacts
  if (!vectorImage?.rootUrl || !artifacts?.length) {
    return null
  }

  const largest = artifacts.reduce((prev, curr) =>
    (curr.width ?? 0) > (prev.width ?? 0) ? curr : prev
  )

  return {
    url: `${vectorImage.rootUrl}${largest.fileIdentifyingUrlPathSegment}`,
    width: largest.width,
    height: largest.height,
  }
}
