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

export const NATIVE_WATCH_SYNC_TIMING: {
  debounceMs: number;
  maxWaitMs: number;
  busyRetryWindowMs: number;
} = {
  /** A sync is requested once changes have paused for this long. */
  debounceMs: 1_500,
  /** Changes that never pause that long still get their sync this soon after the first. */
  maxWaitMs: 5_000,
  /** How long a change keeps asking while a sync that may have missed it is still running. */
  busyRetryWindowMs: 2 * 60_000,
};

/**
 * Turns a watcher's change lines into sync requests, one per `key` for changes that come
 * close together. `request` answers "busy" while a sync of that source is already reading:
 * it may have read before this change was written, so the request is made again until it
 * is taken or `busyRetryWindowMs` has passed.
 */
export function createWatcherSyncTrigger(
  timing: typeof NATIVE_WATCH_SYNC_TIMING = NATIVE_WATCH_SYNC_TIMING,
): (key: string, request: () => "taken" | "busy") => void {
  const pending = new Map<
    string,
    { timer: NodeJS.Timeout; deadline: number; retryUntil: number | null }
  >();

  const arm = (
    key: string,
    request: () => "taken" | "busy",
    delayMs: number,
    deadline: number,
    retryUntil: number | null,
  ) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      if (request() !== "busy") {
        return;
      }
      const now = Date.now();
      const until = retryUntil ?? now + timing.busyRetryWindowMs;
      if (now + timing.debounceMs <= until) {
        arm(key, request, timing.debounceMs, now, until);
      }
    }, delayMs);
    timer.unref?.();
    pending.set(key, { timer, deadline, retryUntil });
  };

  return (key, request) => {
    const now = Date.now();
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    // A change while waiting out a running sync starts over as a new change.
    const deadline =
      existing && existing.retryUntil == null ? existing.deadline : now + timing.maxWaitMs;
    arm(key, request, Math.max(0, Math.min(timing.debounceMs, deadline - now)), deadline, null);
  };
}
