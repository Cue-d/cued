import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { CUED_MENU_BAR_STATUS_PATH } from "../core/config.js";

export interface MenuBarStatusCacheEntry {
  path: string;
  snapshot: Record<string, unknown>;
  mtimeMs: number;
}

export interface ReadMenuBarStatusCacheOptions {
  statusPath?: string;
  maxAgeMs?: number;
  dbPath?: string;
  now?: () => number;
}

export interface WriteMenuBarStatusCacheOptions {
  statusPath?: string;
  pid?: number;
}

export function readMenuBarStatusCache(
  options: ReadMenuBarStatusCacheOptions = {},
): MenuBarStatusCacheEntry | null {
  const statusPath = options.statusPath ?? CUED_MENU_BAR_STATUS_PATH;
  try {
    if (!existsSync(statusPath)) {
      return null;
    }

    const stat = statSync(statusPath);
    if (options.maxAgeMs != null) {
      const ageMs = (options.now ?? Date.now)() - stat.mtimeMs;
      if (ageMs > options.maxAgeMs) {
        return null;
      }
    }

    const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    if (options.dbPath && typeof parsed.dbPath === "string" && parsed.dbPath !== options.dbPath) {
      return null;
    }

    return {
      path: statusPath,
      snapshot: parsed,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export function readMenuBarStatusSnapshot(
  options: ReadMenuBarStatusCacheOptions = {},
): Record<string, unknown> | null {
  return readMenuBarStatusCache(options)?.snapshot ?? null;
}

export function writeMenuBarStatusCache(
  snapshot: unknown,
  options: WriteMenuBarStatusCacheOptions = {},
): void {
  const statusPath = options.statusPath ?? CUED_MENU_BAR_STATUS_PATH;
  const tmpPath = `${statusPath}.${options.pid ?? process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statusPath);
}

export function removeMenuBarStatusCache(options: { statusPath?: string } = {}): void {
  rmSync(options.statusPath ?? CUED_MENU_BAR_STATUS_PATH, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
