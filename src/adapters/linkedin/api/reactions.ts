import type { LinkedInClient } from "./client.js";
import { GRAPHQL_QUERY_IDS } from "./constants.js";
import { linkedInEncode, newMessagingGraphQLRequest } from "./request.js";
import type { MessagingParticipant } from "./types.js";

interface ReactorsGraphQLResponse {
  data?: {
    messengerMessagingParticipantsByMessageAndEmoji?: {
      elements?: RawParticipant[];
    };
  };
}

interface RawParticipant {
  participantType?: {
    member?: {
      profileUrl?: string;
      firstName?: { text?: string } | string;
      lastName?: { text?: string } | string;
      headline?: { text?: string } | string;
      picture?: {
        rootUrl?: string;
        artifacts?: Array<{
          width?: number;
          height?: number;
          fileIdentifyingUrlPathSegment?: string;
        }>;
      };
    };
    organization?: {
      name?: { text?: string } | string;
      logoUrl?: string;
      pageUrl?: string;
    };
  };
  entityUrn?: string;
}

function extractText(value: { text?: string } | string | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  return value?.text ?? "";
}

function parseParticipant(raw: RawParticipant): MessagingParticipant | null {
  if (!raw.entityUrn) {
    return null;
  }

  const picture = raw.participantType?.member?.picture;
  const artifact = picture?.artifacts?.reduce((largest, current) =>
    (largest?.width ?? 0) > (current.width ?? 0) ? largest : current,
  );

  return {
    entityURN: raw.entityUrn,
    participantType: {
      member: raw.participantType?.member
        ? {
            profileUrl: raw.participantType.member.profileUrl ?? "",
            firstName: extractText(raw.participantType.member.firstName),
            lastName: extractText(raw.participantType.member.lastName),
            headline: extractText(raw.participantType.member.headline) || undefined,
            picture:
              picture?.rootUrl && artifact
                ? {
                    url: `${picture.rootUrl}${artifact.fileIdentifyingUrlPathSegment ?? ""}`,
                    width: artifact.width,
                    height: artifact.height,
                  }
                : undefined,
          }
        : undefined,
      organization: raw.participantType?.organization
        ? {
            name: extractText(raw.participantType.organization.name),
            logoUrl: raw.participantType.organization.logoUrl,
            pageUrl: raw.participantType.organization.pageUrl,
          }
        : undefined,
    },
  };
}

export async function getReactors(
  client: LinkedInClient,
  messageUrn: string,
  emoji: string,
): Promise<MessagingParticipant[]> {
  const response = await newMessagingGraphQLRequest(
    client.cookies,
    "messengerMessagingParticipantsByMessageAndEmoji",
    {
      messageUrn: linkedInEncode(messageUrn),
      emoji: encodeURIComponent(emoji),
    },
    {
      pageInstance: client.pageInstance,
      xLiTrack: client.xLiTrack,
      allowRedirects: false,
    },
  ).doJSON<ReactorsGraphQLResponse>();

  return (
    response.data?.messengerMessagingParticipantsByMessageAndEmoji?.elements
      ?.map(parseParticipant)
      .filter((participant): participant is MessagingParticipant => participant !== null) ?? []
  );
}

export { GRAPHQL_QUERY_IDS };
