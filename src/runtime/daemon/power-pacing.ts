import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUED_HOME } from "../../core/config.js";
import type { SyncContinuation } from "../../platforms/core/sync.js";

export interface PowerState {
  onBattery: boolean;
  lowPowerMode: boolean;
}

// The host publishes on startup, power changes and wake. A stopped host's snapshot
// must not delay a standalone CLI daemon; unknown power always preserves sync.
export function readHostPowerState(): PowerState | null {
  try {
    const state = JSON.parse(readFileSync(join(CUED_HOME, "power-state.json"), "utf8"));
    if (
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.onBattery !== "boolean" ||
      typeof state.lowPowerMode !== "boolean"
    )
      return null;
    process.kill(state.pid, 0);
    return { onBattery: state.onBattery, lowPowerMode: state.lowPowerMode };
  } catch {
    return null;
  }
}

export function continuationDelay(input: {
  baseMs: number;
  originTrigger: string;
  syncMode: string;
  liveCoverage: boolean;
  continuation: SyncContinuation | null;
  power: PowerState | null;
}): number {
  const automatic = input.originTrigger === "scheduler" || input.originTrigger === "daemon_start";
  const historical =
    input.syncMode === "full" &&
    (input.continuation?.reason === "account_pagination" ||
      input.continuation?.reason === "scoped_proof_continuation");
  // Throttle, rather than indefinitely pause: durable history cursors still make
  // progress on laptops that spend days unplugged. Incremental catch-up is exempt.
  return automatic &&
    historical &&
    input.liveCoverage &&
    (input.power?.onBattery || input.power?.lowPowerMode)
    ? Math.max(input.baseMs, 60_000)
    : input.baseMs;
}
