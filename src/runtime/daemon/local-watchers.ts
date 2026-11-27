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

/**
 * Whether a started watcher still delivers changes. A helper process that has exited does not,
 * and the scheduler then polls the source again until the watcher is back.
 */
export function isNativeWatcherRunning(
  watcher:
    | { exitCode: number | null; signalCode: NodeJS.Signals | null; killed: boolean }
    | object
    | undefined,
): boolean {
  if (!watcher) {
    return false;
  }
  if ("exitCode" in watcher) {
    return watcher.exitCode == null && watcher.signalCode == null && !watcher.killed;
  }
  return true;
}
