export const CUED_APP_BUNDLE_IDENTIFIER = "so.cued.desktop";
export const CUED_LEGACY_APP_BUNDLE_IDENTIFIERS = ["dev.cued.app"] as const;

export const CUED_LAUNCH_AGENT_LABEL = "so.cued.desktop.daemon";
export const CUED_LEGACY_LAUNCH_AGENT_LABELS = ["dev.cued.daemon"] as const;

export const CUED_DB_KEYCHAIN_SERVICE = "so.cued.desktop.db";
export const CUED_LEGACY_DB_KEYCHAIN_SERVICES = ["dev.cued.db"] as const;

export function cuedAuthKeychainService(platform: string): string {
  return `so.cued.desktop.auth.${platform}`;
}

export function legacyCuedAuthKeychainService(platform: string): string {
  return `dev.cued.auth.${platform}`;
}
