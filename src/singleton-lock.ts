import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import process from "node:process";

export const SINGLETON_LOCK_HEARTBEAT_MS = 5_000;
export const SINGLETON_LOCK_STALE_MS = 15_000;

export type SingletonLockMetadata = {
  kind: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  version?: string | null;
};

export class SingletonLockHeldError extends Error {
  readonly metadata: SingletonLockMetadata | null;

  constructor(path: string, metadata: SingletonLockMetadata | null) {
    const ownerPid =
      metadata && typeof metadata.pid === "number" && metadata.pid > 0
        ? ` with pid ${metadata.pid}`
        : "";
    super(`Singleton lock already held at ${path}${ownerPid}`);
    this.name = "SingletonLockHeldError";
    this.metadata = metadata;
  }
}

type ProbeState = "active" | "stale";

type AcquireSingletonLockOptions = {
  path: string;
  kind: string;
  staleMs?: number;
  version?: string | null;
  now?: () => number;
  pid?: number;
  isProcessRunning?: (pid: number) => boolean;
  probe?: (metadata: SingletonLockMetadata | null) => ProbeState | Promise<ProbeState>;
};

export type SingletonLockLease = {
  path: string;
  metadata: SingletonLockMetadata;
  heartbeat: () => void;
  release: () => void;
};

export function readSingletonLock(path: string): SingletonLockMetadata | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SingletonLockMetadata>;
    if (
      typeof raw.kind !== "string" ||
      typeof raw.pid !== "number" ||
      typeof raw.startedAt !== "number" ||
      typeof raw.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      kind: raw.kind,
      pid: raw.pid,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt,
      version:
        raw.version === undefined || raw.version === null || typeof raw.version === "string"
          ? (raw.version ?? null)
          : null,
    };
  } catch {
    return null;
  }
}

export async function acquireSingletonLock(
  options: AcquireSingletonLockOptions,
): Promise<SingletonLockLease> {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const staleMs = options.staleMs ?? SINGLETON_LOCK_STALE_MS;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const buildMetadata = (): SingletonLockMetadata => {
    const timestamp = now();
    return {
      kind: options.kind,
      pid,
      startedAt: timestamp,
      updatedAt: timestamp,
      version: options.version ?? null,
    };
  };

  const tryAcquire = (): SingletonLockLease => {
    const metadata = buildMetadata();
    const fd = openSync(options.path, "wx", 0o600);
    writeLockFile(fd, metadata);
    return createLease(options.path, fd, metadata, now);
  };

  try {
    return tryAcquire();
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }

  const existing = readSingletonLock(options.path);
  const existingFresh = existing !== null && now() - existing.updatedAt < staleMs;
  const existingPidRunning =
    existing !== null && existing.pid > 0 ? isProcessRunning(existing.pid) : false;

  if (existing !== null && existingFresh && existingPidRunning) {
    throw new SingletonLockHeldError(options.path, existing);
  }

  const probeState = (await options.probe?.(existing)) ?? "stale";
  if (probeState === "active") {
    throw new SingletonLockHeldError(options.path, existing);
  }

  rmSync(options.path, { force: true });
  try {
    return tryAcquire();
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new SingletonLockHeldError(options.path, readSingletonLock(options.path));
    }
    throw error;
  }
}

function createLease(
  path: string,
  fd: number,
  metadata: SingletonLockMetadata,
  now: () => number,
): SingletonLockLease {
  let released = false;
  let ownedFd: number | null = fd;
  let current = metadata;

  const stillOwnsPath = (): boolean => {
    if (ownedFd === null) {
      return false;
    }
    try {
      const fdStats = fstatSync(ownedFd);
      const pathStats = statSync(path);
      return fdStats.dev === pathStats.dev && fdStats.ino === pathStats.ino;
    } catch {
      return false;
    }
  };

  return {
    path,
    get metadata() {
      return current;
    },
    heartbeat() {
      if (released || ownedFd === null) {
        return;
      }
      if (!stillOwnsPath()) {
        closeQuietly(ownedFd);
        ownedFd = null;
        released = true;
        return;
      }
      current = {
        ...current,
        updatedAt: now(),
      };
      writeLockFile(ownedFd, current);
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      const ownsPath = stillOwnsPath();
      if (ownedFd !== null) {
        closeQuietly(ownedFd);
        ownedFd = null;
      }
      if (ownsPath) {
        rmSync(path, { force: true });
      }
    },
  };
}

function writeLockFile(fd: number, metadata: SingletonLockMetadata): void {
  ftruncateSync(fd, 0);
  writeSync(fd, `${JSON.stringify(metadata)}\n`, 0, "utf8");
  fsyncSync(fd);
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort.
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
