import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CUED_HOME = join(homedir(), ".cued");
export const CUED_DB_PATH = join(CUED_HOME, "local.db");
export const CUED_SOCKET_PATH = join(CUED_HOME, "cued.sock");
export const CUED_LOG_DIR = join(CUED_HOME, "logs");
export const CUED_DAEMON_LOG_PATH = join(CUED_LOG_DIR, "daemon.log");
export const CUED_BROWSER_DIR = join(CUED_HOME, "browser");
export const CUED_INTEGRATIONS_DIR = join(CUED_HOME, "integrations");
export const CUED_SIGNAL_DIR = join(CUED_INTEGRATIONS_DIR, "signal");
export const CUED_WHATSAPP_DIR = join(CUED_INTEGRATIONS_DIR, "whatsapp");
export const CUED_ATTACHMENTS_DIR = join(CUED_HOME, "attachments");
export const CUED_ATTACHMENTS_OBJECTS_DIR = join(CUED_ATTACHMENTS_DIR, "objects");
export const CUED_ATTACHMENTS_TMP_DIR = join(CUED_ATTACHMENTS_DIR, "tmp");
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

  if (!existsSync(CUED_INTEGRATIONS_DIR)) {
    mkdirSync(CUED_INTEGRATIONS_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_SIGNAL_DIR)) {
    mkdirSync(CUED_SIGNAL_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_WHATSAPP_DIR)) {
    mkdirSync(CUED_WHATSAPP_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_ATTACHMENTS_DIR)) {
    mkdirSync(CUED_ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_ATTACHMENTS_OBJECTS_DIR)) {
    mkdirSync(CUED_ATTACHMENTS_OBJECTS_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(CUED_ATTACHMENTS_TMP_DIR)) {
    mkdirSync(CUED_ATTACHMENTS_TMP_DIR, { recursive: true, mode: 0o700 });
  }

  // Best-effort hardening for the local data dir.
  chmodSync(CUED_HOME, 0o700);
  chmodSync(CUED_BROWSER_DIR, 0o700);
  chmodSync(CUED_INTEGRATIONS_DIR, 0o700);
  chmodSync(CUED_SIGNAL_DIR, 0o700);
  chmodSync(CUED_WHATSAPP_DIR, 0o700);
  chmodSync(CUED_ATTACHMENTS_DIR, 0o700);
  chmodSync(CUED_ATTACHMENTS_OBJECTS_DIR, 0o700);
  chmodSync(CUED_ATTACHMENTS_TMP_DIR, 0o700);
}
