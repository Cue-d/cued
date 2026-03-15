import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseChannel = "internal" | "stable" | "dev";

const FALLBACK_APP_VERSION = "0.1.0";
const FALLBACK_RELEASE_CHANNEL: ReleaseChannel = "dev";

function packageVersionFallback(): string {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_APP_VERSION;
  } catch {
    return FALLBACK_APP_VERSION;
  }
}

export function getCurrentAppVersion(): string {
  return (
    process.env.CUED_APP_VERSION ?? process.env.npm_package_version ?? packageVersionFallback()
  );
}

export function getCurrentReleaseChannel(): ReleaseChannel {
  const value = process.env.CUED_RELEASE_CHANNEL;
  if (value === "internal" || value === "stable" || value === "dev") {
    return value;
  }
  return FALLBACK_RELEASE_CHANNEL;
}
