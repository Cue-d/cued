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
 * and the scheduler then polls the source again until the watcher is restarted.
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

export const NATIVE_WATCHER_RESTART = {
  /** Delay before restarting a watcher that stopped for the first time. */
  initialMs: 1_000,
  /** The delay doubles with each stop in a row, up to this. */
  maxMs: 5 * 60_000,
  /** A watcher that ran at least this long before stopping starts again from `initialMs`. */
  stableMs: 60_000,
} as const;

/**
 * When to restart a watcher helper that stopped after running for `ranMs`, given how many
 * times in a row it had stopped before. A helper that fails on start backs off instead of
 * being respawned in a loop.
 */
export function nextNativeWatcherRestart(
  previousFailures: number,
  ranMs: number,
): { delayMs: number; failures: number } {
  const failures = ranMs >= NATIVE_WATCHER_RESTART.stableMs ? 0 : previousFailures;
  return {
    delayMs: Math.min(
      NATIVE_WATCHER_RESTART.maxMs,
      NATIVE_WATCHER_RESTART.initialMs * 2 ** failures,
    ),
    failures: failures + 1,
  };
}
