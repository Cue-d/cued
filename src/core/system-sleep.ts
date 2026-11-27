import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUED_HOME } from "./config.js";

const WAKE_SETTLE_MS = 10_000;

export interface HostSleepState {
  sleeping: boolean;
  lastWakeAt: number;
}

export interface HostPowerState {
  onBattery: boolean;
  lowPowerMode: boolean;
}

/** The host's published file, or null when it is missing, malformed or its host has exited. */
function readHostStateFile(): Record<string, unknown> | null {
  try {
    const state = JSON.parse(readFileSync(join(CUED_HOME, "power-state.json"), "utf8"));
    if (!state || typeof state !== "object" || !Number.isInteger(state.pid) || state.pid <= 0) {
      return null;
    }
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}

function parseSleepState(state: Record<string, unknown> | null): HostSleepState | null {
  if (
    !state ||
    typeof state.sleeping !== "boolean" ||
    typeof state.lastWakeAt !== "number" ||
    !Number.isFinite(state.lastWakeAt) ||
    state.lastWakeAt < 0
  )
    return null;
  return { sleeping: state.sleeping, lastWakeAt: state.lastWakeAt };
}

function parsePowerState(state: Record<string, unknown> | null): HostPowerState | null {
  if (!state || typeof state.onBattery !== "boolean" || typeof state.lowPowerMode !== "boolean") {
    return null;
  }
  return { onBattery: state.onBattery, lowPowerMode: state.lowPowerMode };
}

export function readHostSleepState(): HostSleepState | null {
  return parseSleepState(readHostStateFile());
}

/**
 * Battery and Low Power Mode as the host app last published them. Null (treated as AC power)
 * without a running host, or from a host too old to publish them: unknown power never slows
 * sync down.
 */
export function readHostPowerState(): HostPowerState | null {
  return parsePowerState(readHostStateFile());
}

/** Both, from one read of the file. */
export function readHostState(): { sleep: HostSleepState | null; power: HostPowerState | null } {
  const state = readHostStateFile();
  return { sleep: parseSleepState(state), power: parsePowerState(state) };
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
