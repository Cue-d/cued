import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUED_HOME } from "./config.js";

const WAKE_SETTLE_MS = 10_000;

export interface HostSleepState {
  sleeping: boolean;
  lastWakeAt: number;
}

export function readHostSleepState(): HostSleepState | null {
  try {
    const state = JSON.parse(readFileSync(join(CUED_HOME, "power-state.json"), "utf8"));
    if (
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.sleeping !== "boolean" ||
      !Number.isFinite(state.lastWakeAt) ||
      state.lastWakeAt < 0
    )
      return null;
    process.kill(state.pid, 0);
    return { sleeping: state.sleeping, lastWakeAt: state.lastWakeAt };
  } catch {
    return null;
  }
}

export function shouldDeferSyncForSleep(state = readHostSleepState()): boolean {
  return state != null && (state.sleeping || Date.now() - state.lastWakeAt < WAKE_SETTLE_MS);
}

export class SyncInterruptedBySleep extends Error {
  constructor() {
    super("Sync interrupted by system sleep or suspension; retry after wake");
    this.name = "SyncInterruptedBySleep";
  }
}

/** Also detects suspension without a native host (standalone CLI, or a missed notification). */
export class SleepInterruptionDetector {
  private lastTick = Date.now();
  private lastWakeAt = readHostSleepState()?.lastWakeAt;
  private interrupted = false;
  sleeping = false;
  generation = 0;

  check(): boolean {
    const timestamp = Date.now();
    const state = readHostSleepState();
    const sleeping = state?.sleeping === true;
    const resumed =
      state != null
        ? state.lastWakeAt > (this.lastWakeAt ?? this.lastTick)
        : timestamp - this.lastTick > WAKE_SETTLE_MS;
    if (resumed || sleeping !== this.sleeping) {
      this.generation++;
      this.interrupted = true;
    }
    this.sleeping = sleeping;
    this.lastWakeAt = state?.lastWakeAt;
    this.lastTick = timestamp;
    return this.interrupted;
  }
}
