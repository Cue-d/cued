/**
 * LinkedIn Profile API
 * Fetches profile data including publicIdentifier (vanity URL slug)
 */

import type { LinkedInClient } from './client'
import { API_URLS, CONTENT_TYPES } from './constants'
import { newGetRequest } from './request'

// ============================================================================
// Response Types (internal)
// ============================================================================

interface ProfileApiResponse {
  data?: {
    data?: {
      identityDashProfilesByMemberIdentity?: {
        elements?: ProfileElement[]
      }
    }
  }
  included?: IncludedElement[]
}

interface IncludedElement {
  $type?: string
  entityUrn?: string
  publicIdentifier?: string
  firstName?: string
  lastName?: string
  headline?: string
}

interface ProfileElement {
  '*elements'?: string[]
  elements?: ProfileData[]
}

interface ProfileData {
  entityUrn?: string
  publicIdentifier?: string
  firstName?: string
  lastName?: string
  headline?: string
}

// ============================================================================
// Profile Lookup Result
// ============================================================================

export interface ProfileLookupResult {
  /** The member URN that was looked up */
  memberUrn: string
  /** The publicIdentifier (vanity URL slug) if found */
  publicIdentifier: string | null
  /** Display name */
  firstName?: string
  lastName?: string
  headline?: string
}

// ============================================================================
// Profile API
// ============================================================================

/**
 * Get public identifier (vanity URL slug) for a member URN.
 * This resolves URN-style profile IDs (ACoAABsfBygBj0...) to human-readable slugs (johndoe).
 *
 * @param client - LinkedIn client with valid cookies
 * @param memberUrn - The member URN (e.g., "urn:li:fsd_profile:ABC123" or just "ABC123")
 * @returns Profile lookup result with publicIdentifier if found
 */
export async function getProfileByMemberUrn(
  client: LinkedInClient,
  memberUrn: string
): Promise<ProfileLookupResult> {
  // Extract the ID portion from URN if full URN provided
  const memberId = memberUrn.includes(':') ? memberUrn.split(':').pop() ?? memberUrn : memberUrn

  // Use the identity/profiles API to get the publicIdentifier
  // This endpoint accepts the member ID and returns profile data including the vanity slug
  const url = `${API_URLS.voyagerGraphQL}?variables=(memberIdentity:${memberId})&queryId=voyagerIdentityDashProfiles.c48b0a5fff41e26ec14e54a3fcb92e18`

  const response = await newGetRequest(url, client.cookies)
    .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
    .withXLIHeaders()
    .doJSON<ProfileApiResponse>()

  // Look for the profile in included array (normalized format)
  const profile = response.included?.find(
    (item) =>
      item.$type?.includes('Profile') &&
      item.entityUrn?.includes(memberId)
  )

  if (profile?.publicIdentifier) {
    return {
      memberUrn,
      publicIdentifier: profile.publicIdentifier,
      firstName: profile.firstName,
      lastName: profile.lastName,
      headline: profile.headline,
    }
  }

  // Fallback: check data.data structure
  const profileElements = response.data?.data?.identityDashProfilesByMemberIdentity?.elements
  // ProfileElement contains nested ProfileData in its elements array
  const profileData = profileElements?.[0]?.elements?.[0]

  if (profileData?.publicIdentifier) {
    return {
      memberUrn,
      publicIdentifier: profileData.publicIdentifier,
      firstName: profileData.firstName,
      lastName: profileData.lastName,
      headline: profileData.headline,
    }
  }

  return {
    memberUrn,
    publicIdentifier: null,
  }
}

/**
 * Batch resolve multiple member URNs to public identifiers.
 * Uses single requests per URN (LinkedIn doesn't have a batch endpoint).
 * Includes rate limiting to avoid API throttling.
 *
 * @param client - LinkedIn client with valid cookies
 * @param memberUrns - Array of member URNs to resolve
 * @param options - Options for batch resolution
 * @returns Map of memberUrn -> publicIdentifier (null if not found)
 */
export async function batchGetPublicIdentifiers(
  client: LinkedInClient,
  memberUrns: string[],
  options: { delayMs?: number; onProgress?: (completed: number, total: number) => void } = {}
): Promise<Map<string, string | null>> {
  const { delayMs = 200, onProgress } = options
  const results = new Map<string, string | null>()

  for (let i = 0; i < memberUrns.length; i++) {
    const urn = memberUrns[i]

    try {
      const result = await getProfileByMemberUrn(client, urn)
      results.set(urn, result.publicIdentifier)
    } catch (error) {
      console.warn(`[LinkedIn] Failed to resolve profile for ${urn}:`, error)
      results.set(urn, null)
    }

    onProgress?.(i + 1, memberUrns.length)

    // Rate limiting delay between requests (skip after last)
    if (i < memberUrns.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return results
}
