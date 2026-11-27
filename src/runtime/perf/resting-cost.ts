/**
 * Resting cost: what an idle daemon spends while nothing is happening.
 *
 * Cued runs all day on laptops, so the daemon's cost at rest matters as much as its latency
 * under load. This starts a daemon of its own on an empty data directory, with no accounts
 * syncing, no realtime sessions and no client connected, lets it finish starting up, then
 * reads the process's CPU time and context switches before and after a quiet window.
 *
 * Context switches count every time the process was scheduled back onto a CPU: each timer
 * that fires, each fsync it waits on. That is the deterministic "how often does it wake up"
 * number. Idle wakeups (macOS only) are the subset that pulled the CPU out of idle; they are
 * reported for reference but depend on what else the machine is doing, so they are not gated.
 *
 * Kept separate from the latency scenarios: the stall probe there pings the daemon
 * continuously, which is the opposite of resting.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Targets for an idle daemon. What it still has to do at rest (the 5 s lock-file heartbeat,
 * the 15 s auto-sync scheduler, the 60 s status heartbeat) measures about 2 context switches a
 * second and 10-20 ms of CPU a minute. Before this was measured it was about 200 a second and
 * 150-210 ms a minute, nearly all of it a 10 ms event-loop sampling timer. The targets leave
 * room for noise and one more slow timer, and fail on anything that polls at sub-second rates.
 */
const RESTING_TARGETS = {
  /** CPU time the daemon may use per minute at rest (top reports it in 10 ms steps). */
  cpuMsPerMinute: 60,
  /** Context switches per second at rest. */
  wakeupsPerSecond: 5,
};
/** Start-up work (bootstrap, first counts) may run this long before the window must start. */
const MAX_SETTLE_MS = 90_000;
const SETTLE_PROBE_MS = 5_000;

export type RestingCostResult = {
  /** How long after the daemon answered its first ping the quiet window started. */
  settleMs: number;
  windowMs: number;
  cpuMs: number;
  cpuMsPerMinute: number;
  contextSwitches: number;
  wakeupsPerSecond: number;
  /** macOS idle wakeups, when `top` reports them; informational only. */
  idleWakeupsPerSecond: number | null;
  passed: boolean;
};

type ProcessCounters = { cpuMs: number; contextSwitches: number; idleWakeups: number | null };

/** Reads a process's cumulative CPU time and context switches. */
function readProcessCounters(pid: number): ProcessCounters {
  if (process.platform === "linux") {
    // utime and stime are fields 14 and 15, after the parenthesised command name.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const switches = [...status.matchAll(/^(?:non)?voluntary_ctxt_switches:\s+(\d+)/gm)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
    return { cpuMs: ticks * 10, contextSwitches: switches, idleWakeups: null };
  }
  const output = execFileSync(
    "top",
    ["-l", "1", "-pid", String(pid), "-stats", "pid,time,csw,idlew"],
    { encoding: "utf8" },
  );
  const row = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((cells) => cells[0] === String(pid));
  if (!row || row.length < 4) {
    throw new Error(`top did not report pid ${pid}`);
  }
  return {
    cpuMs: parseCpuTime(row[1] ?? ""),
    contextSwitches: parseCounter(row[2] ?? ""),
    idleWakeups: parseCounter(row[3] ?? ""),
  };
}

/** Parses top's TIME column: `MM:SS.cc`, `HH:MM:SS`, or `H:MM:SS.cc`. */
function parseCpuTime(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Unrecognised CPU time: ${value}`);
  }
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1_000);
}

/** Parses a top counter; top appends `+` or `-` to show the direction of change. */
function parseCounter(value: string): number {
  const parsed = Number(value.replace(/[+-]$/, ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unrecognised counter: ${value}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function ping(socketPath: string): Promise<boolean> {
  return new Promise((resolvePing) => {
    const socket = createConnection(socketPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolvePing(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: "resting-ping", command: "ping" })}\n`);
    });
    socket.once("data", () => done(true));
  });
}

async function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 120_000) {
    if (child.exitCode != null) {
      throw new Error(`Resting daemon exited during startup with code ${child.exitCode}`);
    }
    if (existsSync(socketPath) && (await ping(socketPath))) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Resting daemon did not answer within 120s");
}

/**
 * Starts a daemon in `home`, waits at least `settleMs` and then until a short probe looks idle
 * (start-up work done; at most MAX_SETTLE_MS), then measures a quiet window of `windowMs`. `env` should already keep the daemon away from real data and
 * real helpers; this only points it at its own home and an empty database.
 */
export async function measureRestingCost(options: {
  nodePath: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  dbKey: string;
  settleMs: number;
  windowMs: number;
}): Promise<RestingCostResult> {
  mkdirSync(options.home, { recursive: true });
  const socketPath = join(options.home, "cued.sock");
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    CUED_HOME: options.home,
    CUED_DB_PATH: join(options.home, "local.db"),
    CUED_DB_KEY: options.dbKey,
    CUED_SIGNAL_DIR: join(options.home, "integrations", "signal"),
    CUED_AUTOSYNC_PLATFORMS: "none",
    CUED_REALTIME_PLATFORMS: "none",
  };
  // Production stall-monitor settings: the latency scenarios tighten these, which costs wakeups.
  delete env.CUED_STALL_THRESHOLD_MS;
  delete env.CUED_STALL_SECTION_MS;
  delete env.CUED_STALL_REPORT_INTERVAL_MS;

  const child = spawn(options.nodePath, [options.cliPath, "daemon"], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const pid = child.pid;
  try {
    if (pid == null) {
      throw new Error("Resting daemon did not start");
    }
    await waitForSocket(socketPath, child);
    const answeredAt = performance.now();
    await sleep(options.settleMs);
    while (performance.now() - answeredAt < MAX_SETTLE_MS) {
      const probeStart = readProcessCounters(pid);
      const probeStartedAt = performance.now();
      await sleep(SETTLE_PROBE_MS);
      const probeEnd = readProcessCounters(pid);
      const probeSeconds = (performance.now() - probeStartedAt) / 1_000;
      if (
        (probeEnd.contextSwitches - probeStart.contextSwitches) / probeSeconds <=
        RESTING_TARGETS.wakeupsPerSecond
      ) {
        break;
      }
    }
    const settleMs = performance.now() - answeredAt;
    const before = readProcessCounters(pid);
    const startedAt = performance.now();
    await sleep(options.windowMs);
    const after = readProcessCounters(pid);
    const windowMs = performance.now() - startedAt;
    if (child.exitCode != null) {
      throw new Error(`Resting daemon exited during the window with code ${child.exitCode}`);
    }
    const cpuMs = after.cpuMs - before.cpuMs;
    const contextSwitches = after.contextSwitches - before.contextSwitches;
    const cpuMsPerMinute = (cpuMs / windowMs) * 60_000;
    const wakeupsPerSecond = contextSwitches / (windowMs / 1_000);
    return {
      settleMs,
      windowMs,
      cpuMs,
      cpuMsPerMinute,
      contextSwitches,
      wakeupsPerSecond,
      idleWakeupsPerSecond:
        before.idleWakeups != null && after.idleWakeups != null
          ? (after.idleWakeups - before.idleWakeups) / (windowMs / 1_000)
          : null,
      passed:
        cpuMsPerMinute <= RESTING_TARGETS.cpuMsPerMinute &&
        wakeupsPerSecond <= RESTING_TARGETS.wakeupsPerSecond,
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      sleep(5_000),
    ]);
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  }
}

export function formatRestingCost(result: RestingCostResult): string {
  const idle =
    result.idleWakeupsPerSecond == null
      ? ""
      : `, idle wakeups ${result.idleWakeupsPerSecond.toFixed(2)}/s (info)`;
  return [
    `\nresting cost (${(result.windowMs / 1_000).toFixed(0)}s quiet window after ${(result.settleMs / 1_000).toFixed(0)}s settle, no clients): ${result.passed ? "ok" : "MISS"}`,
    `  cpu ${result.cpuMs}ms (${result.cpuMsPerMinute.toFixed(0)}ms/min), wakeups ${result.wakeupsPerSecond.toFixed(2)}/s${idle}`,
    `  targets: cpu <= ${RESTING_TARGETS.cpuMsPerMinute}ms/min, wakeups <= ${RESTING_TARGETS.wakeupsPerSecond}/s`,
  ].join("\n");
}
