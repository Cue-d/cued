import "./env.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseChannel = "internal" | "stable" | "dev";

const FALLBACK_APP_VERSION = "0.1.0";
const FALLBACK_RELEASE_CHANNEL: ReleaseChannel = "dev";
const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_METADATA_PATH = join(RUNTIME_ROOT, "app-metadata.json");

export const APP_METADATA_CONFIG = {
  version: null as string | null,
  releaseChannel: null as ReleaseChannel | null,
};

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "internal" || value === "stable" || value === "dev";
}

function readBundledMetadata(): { version?: string; releaseChannel?: ReleaseChannel } {
  if (!existsSync(BUNDLED_METADATA_PATH)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(BUNDLED_METADATA_PATH, "utf8")) as {
      version?: unknown;
      releaseChannel?: unknown;
    };
    return {
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      releaseChannel: isReleaseChannel(parsed.releaseChannel) ? parsed.releaseChannel : undefined,
    };
  } catch {
    return {};
  }
}

function packageVersionFallback(): string {
  try {
    const packageJsonPath = join(RUNTIME_ROOT, "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_APP_VERSION;
  } catch {
    return FALLBACK_APP_VERSION;
  }
}

export function getCurrentAppVersion(): string {
  return APP_METADATA_CONFIG.version ?? readBundledMetadata().version ?? packageVersionFallback();
}

export function getCurrentReleaseChannel(): ReleaseChannel {
  return (
    APP_METADATA_CONFIG.releaseChannel ??
    readBundledMetadata().releaseChannel ??
    FALLBACK_RELEASE_CHANNEL
  );
}
