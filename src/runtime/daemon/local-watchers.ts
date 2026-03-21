import type { AppMetadataSnapshot, IntegrationStateRow } from "../../db/database.js";

type LocalWatcherIntegrationState = Pick<IntegrationStateRow, "enabled" | "auth_state"> | null;
type LocalWatcherAppMetadata = Pick<AppMetadataSnapshot, "onboardingCompletedVersion">;

export function shouldBootstrapLocalIntegrations(appMetadata: LocalWatcherAppMetadata): boolean {
  return Boolean(appMetadata.onboardingCompletedVersion);
}

export function shouldRunLocalWatcher(
  appMetadata: LocalWatcherAppMetadata,
  integration: LocalWatcherIntegrationState,
): boolean {
  if (!shouldBootstrapLocalIntegrations(appMetadata)) {
    return false;
  }
  if (!integration || integration.enabled !== 1) {
    return false;
  }
  return integration.auth_state === "authorized" || integration.auth_state === "authenticated";
}
