import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SLACK_HELPER_CONFIG } from "../../../core/config.js";

const execFileAsync = promisify(execFile);
const SLACK_HELPER_BINARY_NAME = "cued-slack-helper";
const SUPPORTED_SLACK_HELPER_PROTOCOL_VERSION = 1;

function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function runtimeBundledSlackHelperBinary(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../helpers/cued-slack-helper",
  );
}

export function getSlackHelperBinaryCandidates(repoRoot = resolveRepoRoot()): string[] {
  return [
    runtimeBundledSlackHelperBinary(),
    join(repoRoot, "native", "helpers", "slack-go", ".build", SLACK_HELPER_BINARY_NAME),
    join(repoRoot, "native", "helpers", "slack-go", SLACK_HELPER_BINARY_NAME),
  ].filter((value): value is string => Boolean(value));
}

export function resolveSlackHelperBinary(
  explicitPath = SLACK_HELPER_CONFIG.helperBinary,
  repoRoot = resolveRepoRoot(),
): string | null {
  if (explicitPath) {
    return explicitPath;
  }

  return (
    getSlackHelperBinaryCandidates(repoRoot).find((candidate) => existsSync(candidate)) ?? null
  );
}

export interface SlackHelperInspection {
  helperPath: string | null;
  version: string | null;
  protocolVersion: number | null;
  versionSupported: boolean;
}

export interface SlackHelperStatus {
  helperVersion: string | null;
  protocolVersion: number | null;
}

export function isSlackHelperProtocolSupported(protocolVersion: number | null): boolean {
  return protocolVersion === SUPPORTED_SLACK_HELPER_PROTOCOL_VERSION;
}

export function inspectSlackHelper(helperPath = resolveSlackHelperBinary()): SlackHelperInspection {
  if (!helperPath) {
    return {
      helperPath: null,
      version: null,
      protocolVersion: null,
      versionSupported: false,
    };
  }

  try {
    const stdout = execFileSync(helperPath, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as { version?: unknown; protocolVersion?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version : null;
    const protocolVersion =
      typeof parsed.protocolVersion === "number" ? parsed.protocolVersion : null;
    return {
      helperPath,
      version,
      protocolVersion,
      versionSupported: Boolean(version) && isSlackHelperProtocolSupported(protocolVersion),
    };
  } catch {
    return {
      helperPath,
      version: null,
      protocolVersion: null,
      versionSupported: false,
    };
  }
}

export async function readSlackHelperStatus(
  helperPath = resolveSlackHelperBinary(),
): Promise<SlackHelperStatus> {
  if (!helperPath) {
    return {
      helperVersion: null,
      protocolVersion: null,
    };
  }

  const { stdout } = await execFileAsync(helperPath, ["status"], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { helperVersion?: unknown; protocolVersion?: unknown };
  return {
    helperVersion: typeof parsed.helperVersion === "string" ? parsed.helperVersion : null,
    protocolVersion: typeof parsed.protocolVersion === "number" ? parsed.protocolVersion : null,
  };
}
