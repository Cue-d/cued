import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CUED_HOME = join(homedir(), ".cued");
export const CUED_DB_PATH = join(CUED_HOME, "local.db");
export const CUED_SOCKET_PATH = join(CUED_HOME, "cued.sock");
export const CUED_LOG_DIR = join(CUED_HOME, "logs");
export const CUED_BROWSER_DIR = join(CUED_HOME, "browser");
export const CUED_HOOKS_PATH = join(CUED_HOME, "hooks.toml");

export function ensureCuedDirs(): void {
  if (!existsSync(CUED_HOME)) {
    mkdirSync(CUED_HOME, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_LOG_DIR)) {
    mkdirSync(CUED_LOG_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_BROWSER_DIR)) {
    mkdirSync(CUED_BROWSER_DIR, { recursive: true, mode: 0o700 });
  }

  // Best-effort hardening for the local data dir.
  chmodSync(CUED_HOME, 0o700);
  chmodSync(CUED_BROWSER_DIR, 0o700);
}
