import { API_URLS, CONTENT_TYPES, PAGINATION_DEFAULTS } from "./constants.js";
import type { LinkedInClient, ConnectionsResult } from "./client.js";
import type { Connection, VectorImage } from "./types.js";
import { newGetRequest } from "./request.js";

interface ConnectionsApiResponse {
  data?: {
    paging?: PagingInfo;
    metadata?: { paging?: PagingInfo };
  };
  included?: ConnectionElement[];
  paging?: PagingInfo;
}

interface PagingInfo {
  count?: number;
  start?: number;
  total?: number;
}

interface ConnectionElement {
  $type?: string;
  entityUrn?: string;
  createdAt?: number;
  connectedMember?: string;
  connectedMemberResolutionResult?: ConnectedMemberResult;
  "*connectedMemberResolutionResult"?: string;
}

interface ProfileElement {
  $type?: string;
  entityUrn?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  publicIdentifier?: string;
  profilePicture?: ProfilePicture;
}

interface ConnectedMemberResult {
  entityUrn?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  publicIdentifier?: string;
  profilePicture?: ProfilePicture;
}

interface ProfilePicture {
  displayImageReference?: {
    vectorImage?: {
      rootUrl?: string;
      artifacts?: Array<{
        width: number;
        height: number;
        fileIdentifyingUrlPathSegment: string;
      }>;
    };
  };
}

function parsePicture(profilePicture: ProfilePicture | undefined): VectorImage | undefined {
  const vectorImage = profilePicture?.displayImageReference?.vectorImage;
  if (!vectorImage?.rootUrl || !vectorImage.artifacts?.length) {
    return undefined;
  }
  const largest = vectorImage.artifacts.reduce((left, right) =>
    right.width > left.width ? right : left,
  );
  return {
    url: `${vectorImage.rootUrl}${largest.fileIdentifyingUrlPathSegment}`,
    width: largest.width,
    height: largest.height,
  };
}

function extractProfileId(urn: string | undefined): string | undefined {
  if (!urn) {
    return undefined;
  }
  const parts = urn.split(":");
  return parts[parts.length - 1];
}

function parseConnectionsResponse(response: ConnectionsApiResponse): Connection[] {
  if (!response.included) {
    return [];
  }

  const profileMap = new Map<string, ProfileElement>();
  for (const element of response.included) {
    if (element.$type === "com.linkedin.voyager.dash.identity.profile.Profile" && element.entityUrn) {
      profileMap.set(element.entityUrn, element as unknown as ProfileElement);
    }
  }

  const connections: Connection[] = [];
  for (const element of response.included) {
    if (element.$type !== "com.linkedin.voyager.dash.relationships.Connection") {
      continue;
    }
    const memberRef =
      element.connectedMemberResolutionResult
      ?? (element["*connectedMemberResolutionResult"]
        ? profileMap.get(element["*connectedMemberResolutionResult"])
        : undefined)
      ?? (element.connectedMember ? profileMap.get(element.connectedMember) : undefined);

    if (!memberRef) {
      continue;
    }

    connections.push({
      profileId: extractProfileId(memberRef.entityUrn) ?? memberRef.publicIdentifier ?? "",
      profileUrl: memberRef.publicIdentifier
        ? `https://www.linkedin.com/in/${memberRef.publicIdentifier}`
        : "",
      firstName: memberRef.firstName ?? "",
      lastName: memberRef.lastName ?? "",
      headline: memberRef.headline,
      connectionDate: element.createdAt ? new Date(element.createdAt).toISOString() : undefined,
      picture: parsePicture(memberRef.profilePicture),
    });
  }

  return connections;
}

export async function getConnections(
  client: LinkedInClient,
  cursor?: string,
): Promise<ConnectionsResult> {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  const count = PAGINATION_DEFAULTS.connectionsCount;
  const queryParams = new URLSearchParams({
    decorationId: "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15",
    count: String(count),
    start: String(start),
    q: "search",
    sortType: "RECENTLY_ADDED",
  });

  const response = await newGetRequest(`${API_URLS.connections}?${queryParams.toString()}`, client.cookies)
    .withHeader("Accept", CONTENT_TYPES.linkedInNormalized)
    .withXLIHeaders()
    .doJSON<ConnectionsApiResponse>();

  const connections = parseConnectionsResponse(response);
  const paging = response.paging ?? response.data?.paging ?? response.data?.metadata?.paging;
  const nextStart = start + connections.length;
  const total = paging?.total;
  const hasMore = total !== undefined && total > 0 ? nextStart < total : connections.length >= count;

  return {
    connections,
    metadata: { start, count: connections.length, total: total ?? connections.length },
    ...(hasMore ? { cursor: String(nextStart) } : {}),
  };
}
