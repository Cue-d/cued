/**
 * Normalize contact avatar URLs for global storage/consumption.
 * Only HTTP(S) URLs are considered cross-device safe.
 */
import { normalizePublicAvatarUrl } from "@cued/shared";

export type ContactAvatarSourcePlatform =
  | "linkedin"
  | "twitter"
  | "slack"
  | "imessage"
  | "signal";

export interface ContactAvatarInput {
  url: string;
  sourcePlatform: ContactAvatarSourcePlatform;
  updatedAt?: number;
}

export interface ContactAvatarOption {
  url: string;
  sourcePlatform: ContactAvatarSourcePlatform;
  updatedAt: number;
}

const AVATAR_SOURCE_PRIORITY: Record<ContactAvatarSourcePlatform, number> = {
  linkedin: 50,
  twitter: 40,
  slack: 30,
  signal: 20,
  imessage: 10,
};
export { normalizePublicAvatarUrl };

export function normalizeContactAvatarOption(
  avatar: ContactAvatarInput | null | undefined,
): ContactAvatarOption | undefined {
  if (!avatar) return undefined;
  const normalizedUrl = normalizePublicAvatarUrl(avatar.url);
  if (!normalizedUrl) return undefined;

  return {
    url: normalizedUrl,
    sourcePlatform: avatar.sourcePlatform,
    updatedAt: avatar.updatedAt ?? Date.now(),
  };
}

type ContactAvatarCarrier = {
  avatarUrl?: string;
  avatarSourcePlatform?: ContactAvatarSourcePlatform;
  avatarUpdatedAt?: number;
  avatarOptions?: ContactAvatarOption[];
};

/**
 * Read contact avatars from the new avatarOptions field and legacy top-level fields.
 */
export function getContactAvatarOptions(
  contact: ContactAvatarCarrier,
): ContactAvatarOption[] {
  const optionsBySource = new Map<ContactAvatarSourcePlatform, ContactAvatarOption>();

  for (const option of contact.avatarOptions ?? []) {
    const normalizedUrl = normalizePublicAvatarUrl(option.url);
    if (!normalizedUrl) continue;
    const normalized: ContactAvatarOption = {
      url: normalizedUrl,
      sourcePlatform: option.sourcePlatform,
      updatedAt: typeof option.updatedAt === "number" ? option.updatedAt : 0,
    };
    const existing = optionsBySource.get(normalized.sourcePlatform);
    if (!existing || normalized.updatedAt >= existing.updatedAt) {
      optionsBySource.set(normalized.sourcePlatform, normalized);
    }
  }

  const legacyUrl = normalizePublicAvatarUrl(contact.avatarUrl);
  if (legacyUrl && contact.avatarSourcePlatform) {
    const legacy: ContactAvatarOption = {
      url: legacyUrl,
      sourcePlatform: contact.avatarSourcePlatform,
      updatedAt: contact.avatarUpdatedAt ?? 0,
    };
    const existing = optionsBySource.get(legacy.sourcePlatform);
    if (!existing || legacy.updatedAt >= existing.updatedAt) {
      optionsBySource.set(legacy.sourcePlatform, legacy);
    }
  }

  return Array.from(optionsBySource.values()).sort((a, b) => {
    const priorityDiff =
      AVATAR_SOURCE_PRIORITY[b.sourcePlatform] -
      AVATAR_SOURCE_PRIORITY[a.sourcePlatform];
    if (priorityDiff !== 0) return priorityDiff;
    return b.updatedAt - a.updatedAt;
  });
}

export function upsertContactAvatarOption(
  options: ContactAvatarOption[],
  incoming: ContactAvatarOption,
): ContactAvatarOption[] {
  const next = options.filter((o) => o.sourcePlatform !== incoming.sourcePlatform);
  next.push(incoming);
  return next.sort((a, b) => {
    const priorityDiff =
      AVATAR_SOURCE_PRIORITY[b.sourcePlatform] -
      AVATAR_SOURCE_PRIORITY[a.sourcePlatform];
    if (priorityDiff !== 0) return priorityDiff;
    return b.updatedAt - a.updatedAt;
  });
}

export function pickPrimaryContactAvatar(
  options: ContactAvatarOption[],
): ContactAvatarOption | undefined {
  return options[0];
}

export function areContactAvatarOptionsEqual(
  left: ContactAvatarOption[],
  right: ContactAvatarOption[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (
      left[i].url !== right[i].url ||
      left[i].sourcePlatform !== right[i].sourcePlatform ||
      left[i].updatedAt !== right[i].updatedAt
    ) {
      return false;
    }
  }
  return true;
}

export function buildPrimaryAvatarFields(
  options: ContactAvatarOption[],
): {
  avatarUrl?: string;
  avatarSourcePlatform?: ContactAvatarSourcePlatform;
  avatarUpdatedAt?: number;
} {
  const primary = pickPrimaryContactAvatar(options);
  if (!primary) {
    return {
      avatarUrl: undefined,
      avatarSourcePlatform: undefined,
      avatarUpdatedAt: undefined,
    };
  }

  return {
    avatarUrl: primary.url,
    avatarSourcePlatform: primary.sourcePlatform,
    avatarUpdatedAt: primary.updatedAt,
  };
}
