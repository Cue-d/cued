import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

export function getSlackHelperBinaryCandidates(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot = resolveRepoRoot(),
): string[] {
  return [
    env.CUED_APP_PATH?.trim()
      ? join(env.CUED_APP_PATH.trim(), "Contents", "Resources", "helpers", SLACK_HELPER_BINARY_NAME)
      : null,
    runtimeBundledSlackHelperBinary(),
    join(repoRoot, "native", "helpers", "slack-go", ".build", SLACK_HELPER_BINARY_NAME),
    join(repoRoot, "native", "helpers", "slack-go", SLACK_HELPER_BINARY_NAME),
  ].filter((value): value is string => Boolean(value));
}

export function resolveSlackHelperBinary(
  envVarValue = process.env.CUED_SLACK_HELPER_BINARY,
  repoRoot = resolveRepoRoot(),
): string | null {
  if (envVarValue) {
    return envVarValue;
  }

  return (
    getSlackHelperBinaryCandidates(process.env, repoRoot).find((candidate) =>
      existsSync(candidate),
    ) ?? null
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

export function inspectSlackHelper(): SlackHelperInspection {
  const helperPath = resolveSlackHelperBinary();
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

export async function readSlackHelperStatus(): Promise<SlackHelperStatus> {
  const helperPath = resolveSlackHelperBinary();
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
