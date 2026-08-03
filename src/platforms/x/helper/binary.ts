import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINARY_NAME = "cued-birdclaw-helper";
const SUPPORTED_PROTOCOL_VERSION = 1;

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function resolveXArchivePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CUED_X_ARCHIVE_PATH?.trim();
  if (configured) return configured;
  const downloads = join(homedir(), "Downloads");
  if (!existsSync(downloads)) return null;
  return (
    readdirSync(downloads)
      .filter((name) => /^(?:twitter.*|x.*archive).*\.zip$/i.test(name))
      .map((name) => join(downloads, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null
  );
}

export function birdclawHelperCandidates(root = repoRoot()): string[] {
  return [
    process.env.CUED_APP_PATH?.trim()
      ? join(process.env.CUED_APP_PATH.trim(), "Contents", "Resources", "helpers", BINARY_NAME)
      : null,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../helpers", BINARY_NAME),
    join(root, "native", "helpers", "birdclaw-go", ".build", BINARY_NAME),
    join(root, "native", "helpers", "birdclaw-go", BINARY_NAME),
  ].filter((value): value is string => Boolean(value));
}

export function resolveBirdclawHelperBinary(
  envValue = process.env.CUED_X_ARCHIVE_HELPER_BINARY,
): string | null {
  return (
    envValue?.trim() ||
    birdclawHelperCandidates().find((candidate) => existsSync(candidate)) ||
    null
  );
}

export function inspectBirdclawHelper(): {
  helperPath: string | null;
  archivePath: string | null;
  available: boolean;
  reason: string | null;
} {
  const helperPath = resolveBirdclawHelperBinary();
  const archivePath = resolveXArchivePath();
  if (!helperPath) {
    return {
      helperPath: null,
      archivePath,
      available: false,
      reason: "X archive helper is missing",
    };
  }
  if (!archivePath || !existsSync(archivePath)) {
    return { helperPath, archivePath, available: false, reason: "X archive is missing" };
  }
  try {
    const output = execFileSync(helperPath, ["status", "--archive", archivePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output) as { protocolVersion?: unknown; available?: unknown };
    if (parsed.protocolVersion !== SUPPORTED_PROTOCOL_VERSION || parsed.available !== true) {
      return {
        helperPath,
        archivePath,
        available: false,
        reason: `Unsupported X archive helper protocol: ${String(parsed.protocolVersion)}`,
      };
    }
    return { helperPath, archivePath, available: true, reason: null };
  } catch (error) {
    return {
      helperPath,
      archivePath,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
