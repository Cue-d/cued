import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { CUED_DAEMON_LOCK_PATH, CUED_SOCKET_PATH } from "../config.js";
import { readSingletonLock, type SingletonLockMetadata } from "../singleton-lock.js";

const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 100;

export interface RunningCuedProcess {
  pid: number;
  command: string;
  executablePath: string | null;
  appBundlePath: string | null;
}

export interface TerminateCompetingDaemonsOptions {
  expectedExecutablePath: string;
  currentPid?: number;
  psOutput?: string;
  waitMs?: number;
  pollMs?: number;
  isProcessRunning?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  readLock?: () => SingletonLockMetadata | null;
  socketExists?: () => boolean;
  sleep?: (ms: number) => void;
  now?: () => number;
}

export function parseRunningCuedProcesses(psOutput: string): RunningCuedProcess[] {
  return psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }

      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (!Number.isFinite(pid) || !looksLikeCuedProcess(command)) {
        return null;
      }

      return {
        pid,
        command,
        executablePath: extractExecutablePath(command),
        appBundlePath: extractAppBundlePath(command),
      } satisfies RunningCuedProcess;
    })
    .filter((processInfo): processInfo is RunningCuedProcess => processInfo !== null);
}

export function selectCompetingDaemonProcesses(
  processes: RunningCuedProcess[],
  expectedExecutablePath: string,
  currentPid = process.pid,
): RunningCuedProcess[] {
  const expectedExecutableRealpath = normalizeRealpath(expectedExecutablePath);
  const expectedBundleRealpath = normalizeRealpath(deriveAppBundlePath(expectedExecutablePath));

  return processes.filter((processInfo) => {
    if (processInfo.pid === currentPid) {
      return false;
    }

    const bundlePath = processInfo.appBundlePath;
    if (bundlePath) {
      if (!existsSync(bundlePath)) {
        return true;
      }

      const bundleRealpath = normalizeRealpath(bundlePath);
      if (isTrashPath(bundleRealpath)) {
        return true;
      }

      return expectedBundleRealpath !== null && bundleRealpath !== expectedBundleRealpath;
    }

    const executablePath = processInfo.executablePath;
    if (!executablePath) {
      return false;
    }

    return normalizeRealpath(executablePath) !== expectedExecutableRealpath;
  });
}

export function terminateCompetingDaemons(options: TerminateCompetingDaemonsOptions): {
  detected: RunningCuedProcess[];
  terminated: number[];
} {
  const detected = parseRunningCuedProcesses(
    options.psOutput ??
      execFileSync("ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
  );
  const competing = selectCompetingDaemonProcesses(
    detected,
    options.expectedExecutablePath,
    options.currentPid,
  );
  if (competing.length === 0) {
    return { detected, terminated: [] };
  }

  const killProcess =
    options.killProcess ??
    ((pid: number) => {
      process.kill(pid, "SIGTERM");
    });
  for (const processInfo of competing) {
    try {
      killProcess(processInfo.pid);
    } catch {
      // Best effort; stale pid is fine.
    }
  }

  const deadline = (options.now ?? Date.now)() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const readLock = options.readLock ?? (() => readSingletonLock(CUED_DAEMON_LOCK_PATH));
  const socketExists = options.socketExists ?? (() => existsSync(CUED_SOCKET_PATH));
  const sleep = options.sleep ?? sleepMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const terminated = competing.map((processInfo) => processInfo.pid);

  while ((options.now ?? Date.now)() < deadline) {
    const anyRunning = terminated.some((pid) => isProcessRunning(pid));
    const lockOwnerPid = readLock()?.pid ?? null;
    const competingOwnsLock = lockOwnerPid !== null && terminated.includes(lockOwnerPid);
    if (!anyRunning && !competingOwnsLock && !socketExists()) {
      break;
    }
    sleep(pollMs);
  }

  return { detected, terminated };
}

function looksLikeCuedProcess(command: string): boolean {
  return (
    command.includes("/Cued.app/") &&
    (command.includes("/Contents/MacOS/CuedDaemon") ||
      command.includes("/Contents/Resources/cued-cli daemon") ||
      command.includes("dist/cli.js daemon"))
  );
}

function extractExecutablePath(command: string): string | null {
  const firstToken = command.trim().split(/\s+/, 1)[0]?.trim() ?? "";
  return firstToken.length > 0 ? firstToken : null;
}

function extractAppBundlePath(command: string): string | null {
  const match = command.match(/(\S+\/Cued\.app)(?=\/|\s|$)/);
  return match?.[1] ?? null;
}

function deriveAppBundlePath(executablePath: string): string | null {
  const trimmed = executablePath.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/(\S+\/Cued\.app)(?=\/|\s|$)/);
  if (match?.[1]) {
    return match[1];
  }
  return dirname(dirname(dirname(resolve(trimmed))));
}

function normalizeRealpath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

function isTrashPath(path: string | null): boolean {
  return Boolean(path && (path.includes("/.Trash/") || path.includes("/Trash/")));
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
