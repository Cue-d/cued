/**
 * LinkedIn Contacts API
 * Fetches connections and searches for people using LinkedIn's Voyager API
 */

import type { LinkedInClient, ConnectionsResult } from './client'
import type { Connection, VectorImage } from './types'
import { API_URLS, PAGINATION_DEFAULTS, CONTENT_TYPES } from './constants'
import { newGetRequest, LinkedInRequestError } from './request'

// ============================================================================
// Response Types (internal)
// ============================================================================

interface ConnectionsApiResponse {
  data?: {
    data?: {
      '*relationshipsDashConnectionsByMember'?: string
    }
  }
  included?: ConnectionElement[]
  paging?: {
    count?: number
    start?: number
    total?: number
    links?: Array<{ rel: string; href: string }>
  }
}

interface ConnectionElement {
  $type?: string
  entityUrn?: string
  createdAt?: number
  connectedMember?: string
  connectedMemberResolutionResult?: ConnectedMemberResult
}

interface ConnectedMemberResult {
  entityUrn?: string
  firstName?: string
  lastName?: string
  headline?: string
  publicIdentifier?: string
  profilePicture?: ProfilePicture
}

interface ProfilePicture {
  displayImageReference?: {
    vectorImage?: {
      rootUrl?: string
      artifacts?: Array<{
        width: number
        height: number
        fileIdentifyingUrlPathSegment: string
      }>
    }
  }
}

interface SearchApiResponse {
  data?: {
    data?: {
      searchDashClustersByAll?: {
        '*elements'?: string[]
        paging?: {
          count?: number
          start?: number
          total?: number
        }
      }
    }
  }
  included?: SearchElement[]
}

interface SearchElement {
  $type?: string
  entityUrn?: string
  title?: {
    text?: string
  }
  primarySubtitle?: {
    text?: string
  }
  navigationUrl?: string
  image?: {
    attributes?: Array<{
      detailDataUnion?: {
        profilePicture?: {
          '*profilePicture'?: string
        }
      }
    }>
  }
  trackingUrn?: string
}

// ============================================================================
// Connections API
// ============================================================================

/**
 * Fetch connections for the authenticated user
 * Uses voyagerRelationshipsDashConnections endpoint
 */
export async function getConnections(
  client: LinkedInClient,
  cursor?: string
): Promise<ConnectionsResult> {
  const start = cursor ? parseInt(cursor, 10) : 0
  const count = PAGINATION_DEFAULTS.connectionsCount

  console.log('[LinkedIn Contacts] Fetching connections:', { start, count, hasCookies: client.cookies.length })

  // Build the query parameters
  // LinkedIn uses a decoratedList format for connections
  const queryParams = new URLSearchParams({
    decorationId:
      'com.linkedin.voyager.dash.deco.relationships.ConnectionListWithProfile-1',
    count: count.toString(),
    start: start.toString(),
    q: 'search',
    sortType: 'RECENTLY_ADDED',
  })

  console.log('[LinkedIn Contacts] Request URL:', `${API_URLS.connections}?${queryParams.toString()}`)

  const response = await newGetRequest(
    `${API_URLS.connections}?${queryParams.toString()}`,
    client.cookies
  )
    .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
    .withXLIHeaders()
    .doJSON<ConnectionsApiResponse>()

  console.log('[LinkedIn Contacts] Raw response:', {
    hasData: !!response.data,
    includedCount: response.included?.length ?? 0,
    paging: response.paging,
  })

  const connections = parseConnectionsResponse(response)
  console.log('[LinkedIn Contacts] Parsed connections:', connections.length)

  // Calculate next cursor
  const total = response.paging?.total ?? 0
  const nextStart = start + count
  const hasMore = nextStart < total

  return {
    connections,
    metadata: {
      start,
      count: connections.length,
      total,
    },
    ...(hasMore ? { cursor: nextStart.toString() } : {}),
  }
}

/**
 * Parse the connections API response into Connection[] type
 */
function parseConnectionsResponse(response: ConnectionsApiResponse): Connection[] {
  const connections: Connection[] = []

  if (!response.included) {
    console.log('[LinkedIn Contacts] No included array in response')
    return connections
  }

  // Log all types in included for debugging
  const types = new Map<string, number>()
  for (const element of response.included) {
    const type = element.$type ?? 'unknown'
    types.set(type, (types.get(type) ?? 0) + 1)
  }
  console.log('[LinkedIn Contacts] Element types in included:', Object.fromEntries(types))

  // Filter for connection elements that have member data
  for (const element of response.included) {
    if (element.$type !== 'com.linkedin.voyager.dash.relationships.Connection') {
      continue
    }

    const member = element.connectedMemberResolutionResult
    if (!member) {
      console.log('[LinkedIn Contacts] Connection element missing member data:', element.entityUrn)
      continue
    }

    // Extract profile picture
    let picture: VectorImage | undefined
    const pictureData = member.profilePicture?.displayImageReference?.vectorImage
    if (pictureData?.rootUrl && pictureData.artifacts?.length) {
      // Get the largest artifact
      const largestArtifact = pictureData.artifacts.reduce((prev, curr) =>
        (curr.width ?? 0) > (prev.width ?? 0) ? curr : prev
      )
      picture = {
        url: `${pictureData.rootUrl}${largestArtifact.fileIdentifyingUrlPathSegment}`,
        width: largestArtifact.width,
        height: largestArtifact.height,
      }
    }

    // Extract profile ID from entityUrn (format: urn:li:fsd_profile:ABC123)
    const profileId = extractProfileId(member.entityUrn)

    connections.push({
      profileId: profileId ?? member.publicIdentifier ?? '',
      profileUrl: member.publicIdentifier
        ? `https://www.linkedin.com/in/${member.publicIdentifier}`
        : '',
      firstName: member.firstName ?? '',
      lastName: member.lastName ?? '',
      headline: member.headline,
      connectionDate: element.createdAt
        ? new Date(element.createdAt).toISOString()
        : undefined,
      picture,
    })
  }

  return connections
}

// ============================================================================
// Search API
// ============================================================================

/**
 * Search for people on LinkedIn
 * Uses voyagerSearchDash endpoint
 */
export async function searchPeople(
  client: LinkedInClient,
  query: string
): Promise<ConnectionsResult> {
  if (!query.trim()) {
    return { connections: [], metadata: { count: 0, total: 0 } }
  }

  // Build search query parameters
  // LinkedIn's search API uses a complex query structure
  const variables = {
    start: 0,
    origin: 'GLOBAL_SEARCH_HEADER',
    query: {
      keywords: query,
      flagshipSearchIntent: 'SEARCH_SRP',
      queryParameters: {
        resultType: ['PEOPLE'],
      },
    },
  }

  const queryParams = new URLSearchParams({
    decorationId: 'com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175',
    variables: JSON.stringify(variables),
    queryId: 'voyagerSearchDashClusters.07ce8ffda1e6e88d9bbac97e0dc95bd0',
  })

  const response = await newGetRequest(
    `${API_URLS.search}?${queryParams.toString()}`,
    client.cookies
  )
    .withHeader('Accept', CONTENT_TYPES.linkedInNormalized)
    .withXLIHeaders()
    .doJSON<SearchApiResponse>()

  const connections = parseSearchResponse(response)

  const total =
    response.data?.data?.searchDashClustersByAll?.paging?.total ?? connections.length

  return {
    connections,
    metadata: {
      start: 0,
      count: connections.length,
      total,
    },
  }
}

/**
 * Parse the search API response into Connection[] type
 */
function parseSearchResponse(response: SearchApiResponse): Connection[] {
  const connections: Connection[] = []

  if (!response.included) {
    return connections
  }

  // Look for search result entities
  for (const element of response.included) {
    // Skip non-person results
    if (
      element.$type !== 'com.linkedin.voyager.dash.search.EntityResultViewModel'
    ) {
      continue
    }

    // Extract profile URL and ID from navigationUrl
    const navigationUrl = element.navigationUrl ?? ''
    const profileMatch = navigationUrl.match(
      /linkedin\.com\/in\/([^?/]+)/
    )
    const publicIdentifier = profileMatch?.[1] ?? ''

    // Extract profile ID from trackingUrn if available
    const profileId = extractProfileId(element.trackingUrn) ?? publicIdentifier

    // Parse name from title
    const fullName = element.title?.text ?? ''
    const nameParts = fullName.split(' ')
    const firstName = nameParts[0] ?? ''
    const lastName = nameParts.slice(1).join(' ')

    // Extract headline from primarySubtitle
    const headline = element.primarySubtitle?.text

    // Picture extraction is complex in search results - would need to resolve from included
    // For now, we'll skip it as the main use case is text-based matching

    connections.push({
      profileId,
      profileUrl: publicIdentifier
        ? `https://www.linkedin.com/in/${publicIdentifier}`
        : navigationUrl,
      firstName,
      lastName,
      headline,
    })
  }

  return connections
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extract profile ID from a LinkedIn URN
 * Examples:
 *   urn:li:fsd_profile:ABC123 -> ABC123
 *   urn:li:member:12345 -> 12345
 */
function extractProfileId(urn: string | undefined): string | undefined {
  if (!urn) return undefined
  const parts = urn.split(':')
  return parts[parts.length - 1]
}
