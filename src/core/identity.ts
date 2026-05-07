export const CUED_APP_BUNDLE_IDENTIFIER = "so.cued.desktop";

export const CUED_LAUNCH_AGENT_LABEL = "so.cued.desktop.daemon";

export const CUED_DB_KEYCHAIN_SERVICE = "so.cued.desktop.db";

export function cuedAuthKeychainService(platform: string): string {
  return `so.cued.desktop.auth.${platform}`;
}
