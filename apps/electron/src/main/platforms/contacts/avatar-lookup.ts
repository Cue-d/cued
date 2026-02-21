import type { ContactAvatarLookupRequest } from "../../../shared/electron-api";

export interface ContactAvatarLookupResult {
  avatarUrl?: string | null;
}

export type ContactAvatarResolver = (
  handle: string,
) => ContactAvatarLookupResult | undefined;

export function resolveAvatarLookupRequests(
  requests: ContactAvatarLookupRequest[],
  resolveByHandle: ContactAvatarResolver,
): Record<string, string> {
  if (!Array.isArray(requests) || requests.length === 0) {
    return {};
  }

  const resolvedAvatars: Record<string, string> = {};

  for (const request of requests) {
    if (!request || typeof request.contactId !== "string" || !Array.isArray(request.handles)) {
      continue;
    }

    for (const handle of request.handles) {
      if (typeof handle !== "string" || handle.length === 0) {
        continue;
      }

      const contact = resolveByHandle(handle);
      if (contact?.avatarUrl) {
        resolvedAvatars[request.contactId] = contact.avatarUrl;
        break;
      }
    }
  }

  return resolvedAvatars;
}
