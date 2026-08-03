import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINARY_NAME = "cued-birdclaw-helper";
const SUPPORTED_PROTOCOL_VERSION = 1;

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function resolveBirdclawDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUED_BIRDCLAW_DB_PATH?.trim() || join(homedir(), ".birdclaw", "birdclaw.sqlite");
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
  envValue = process.env.CUED_BIRDCLAW_HELPER_BINARY,
): string | null {
  return (
    envValue?.trim() ||
    birdclawHelperCandidates().find((candidate) => existsSync(candidate)) ||
    null
  );
}

export function inspectBirdclawHelper(): {
  helperPath: string | null;
  databasePath: string;
  available: boolean;
  reason: string | null;
} {
  const helperPath = resolveBirdclawHelperBinary();
  const databasePath = resolveBirdclawDatabasePath();
  if (!helperPath) {
    return {
      helperPath: null,
      databasePath,
      available: false,
      reason: "Birdclaw helper is missing",
    };
  }
  if (!existsSync(databasePath)) {
    return { helperPath, databasePath, available: false, reason: "Birdclaw database is missing" };
  }
  try {
    const output = execFileSync(helperPath, ["version"], { encoding: "utf8" });
    const parsed = JSON.parse(output) as { protocolVersion?: unknown };
    if (parsed.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      return {
        helperPath,
        databasePath,
        available: false,
        reason: `Unsupported Birdclaw helper protocol: ${String(parsed.protocolVersion)}`,
      };
    }
    return { helperPath, databasePath, available: true, reason: null };
  } catch (error) {
    return {
      helperPath,
      databasePath,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
