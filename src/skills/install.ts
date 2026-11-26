import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getCurrentAppPath } from "../macos/install.js";

const execFileAsync = promisify(execFile);

const CUED_SKILL_NAME = "cued";
const GLOBAL_SKILL_AGENT = "*";
const SKILL_COMMAND_TIMEOUT_MS = 15_000;
const SKILL_LIST_TIMEOUT_MS = 30_000;
const SKILL_MONITOR_MIN_REFRESH_INTERVAL_MS = 60_000;
// `skills add --global` keeps the canonical copy here and links it into each agent.
const GLOBAL_SKILLS_DIR_SEGMENTS = [".agents", "skills"] as const;

export interface GlobalCuedSkillInstallResult {
  ok: boolean;
  agent: typeof GLOBAL_SKILL_AGENT;
  skillName: typeof CUED_SKILL_NAME;
  scope: "global";
  sourcePath: string | null;
  npxPath: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface GlobalCuedSkillStatusResult {
  installed: boolean;
  status: "installed" | "needs_action" | "unknown";
  summary: string;
  sourcePath: string | null;
  npxPath: string | null;
  installedPath: string | null;
  error?: string;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function hasSkillDefinition(path: string): boolean {
  return existsSync(join(path, "SKILL.md"));
}

export function resolveCuedSkillSourcePath(): string | null {
  const bundledAppPath = getCurrentAppPath();
  const candidates = [
    bundledAppPath
      ? join(bundledAppPath, "Contents", "Resources", "skills", CUED_SKILL_NAME)
      : null,
    join(repoRoot(), "skills", CUED_SKILL_NAME),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => hasSkillDefinition(candidate)) ?? null;
}

function resolveShellNpxPath(): string | null {
  try {
    const path = execFileSync("/bin/zsh", ["-lc", "command -v npx"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.startsWith("/") && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function compareNodeVersionNames(left: string, right: string): number {
  const leftParts = left
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const partCount = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function resolveNvmNpxPath(): string | null {
  const versionsRoot = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(versionsRoot)) {
    return null;
  }

  return (
    readdirSync(versionsRoot)
      .sort(compareNodeVersionNames)
      .map((version) => join(versionsRoot, version, "bin", "npx"))
      .find((candidate) => existsSync(candidate)) ?? null
  );
}

function firstExistingNpxPath(shellNpxPath: string | null): string | null {
  const candidates = [
    shellNpxPath,
    join("/opt", "homebrew", "bin", "npx"),
    join("/usr", "local", "bin", "npx"),
    join(homedir(), ".volta", "bin", "npx"),
    resolveNvmNpxPath(),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function resolveNpxPath(): string | null {
  return firstExistingNpxPath(resolveShellNpxPath());
}

async function resolveNpxPathAsync(): Promise<string | null> {
  let shellNpxPath: string | null = null;
  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-lc", "command -v npx"], {
      encoding: "utf8",
      timeout: SKILL_COMMAND_TIMEOUT_MS,
    });
    const path = stdout.trim();
    shellNpxPath = path.startsWith("/") && existsSync(path) ? path : null;
  } catch {
    shellNpxPath = null;
  }
  return firstExistingNpxPath(shellNpxPath);
}

function formatInstallError(error: unknown): { message: string; stdout: string; stderr: string } {
  if (error && typeof error === "object") {
    const stdout =
      typeof Reflect.get(error, "stdout") === "string" ? Reflect.get(error, "stdout") : "";
    const stderr =
      typeof Reflect.get(error, "stderr") === "string" ? Reflect.get(error, "stderr") : "";
    const message = error instanceof Error ? error.message : "Failed to install the Cued skill.";
    return { message, stdout, stderr };
  }

  return {
    message: "Failed to install the Cued skill.",
    stdout: "",
    stderr: "",
  };
}

function buildSkillsCommandEnv(npxPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [dirname(npxPath), process.env.PATH].filter(Boolean).join(":"),
  };
}

function stripAnsi(value: string): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "\u001B" && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index += 1;
      }
      if (index < value.length) {
        index += 1;
      }
      continue;
    }

    output += value[index];
    index += 1;
  }

  return output;
}

function findInstalledSkillPath(listOutput: string, skillName: string): string | null {
  const cleanOutput = stripAnsi(listOutput);
  for (const rawLine of cleanOutput.split(/\r?\n/)) {
    if (rawLine.startsWith("  ")) {
      continue;
    }

    const line = rawLine.trim();
    if (!line || line === "Global Skills") {
      continue;
    }

    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match?.[1] === skillName) {
      return match[2]?.trim() ?? null;
    }
  }

  return null;
}

const SKILL_LIST_ARGS = ["--yes", "skills", "list", "--global"];

function skillAddArgs(sourcePath: string): string[] {
  return ["--yes", "skills", "add", sourcePath, "--global", "--agent", GLOBAL_SKILL_AGENT, "--yes"];
}

function missingSourceStatus(npxPath: string | null): GlobalCuedSkillStatusResult {
  return {
    installed: false,
    status: "unknown",
    summary: "Bundled Cued skill was not found.",
    sourcePath: null,
    npxPath,
    installedPath: null,
    error: "Bundled Cued skill not found.",
  };
}

function missingNpxStatus(sourcePath: string): GlobalCuedSkillStatusResult {
  return {
    installed: false,
    status: "needs_action",
    summary: "Install Node.js to enable the global Cued skill install.",
    sourcePath,
    npxPath: null,
    installedPath: null,
    error: "npx not found. Install Node.js to enable the global Cued skill install.",
  };
}

function installedStatus(
  sourcePath: string,
  npxPath: string | null,
  installedPath: string,
): GlobalCuedSkillStatusResult {
  return {
    installed: true,
    status: "installed",
    summary: "Cued skill is installed globally.",
    sourcePath,
    npxPath,
    installedPath,
  };
}

function listedSkillStatus(
  sourcePath: string,
  npxPath: string,
  listOutput: string,
): GlobalCuedSkillStatusResult {
  const installedPath = findInstalledSkillPath(listOutput, CUED_SKILL_NAME);
  return installedPath
    ? installedStatus(sourcePath, npxPath, installedPath)
    : {
        installed: false,
        status: "needs_action",
        summary: "Install the Cued skill globally so agents can query local Cued data.",
        sourcePath,
        npxPath,
        installedPath: null,
      };
}

function unverifiedSkillStatus(
  sourcePath: string,
  npxPath: string | null,
  error: unknown,
): GlobalCuedSkillStatusResult {
  const formatted = formatInstallError(error);
  return {
    installed: false,
    status: "unknown",
    summary: "Could not verify whether the global Cued skill is installed.",
    sourcePath,
    npxPath,
    installedPath: null,
    error: formatted.stderr || formatted.message,
  };
}

export function getGlobalCuedSkillStatus(): GlobalCuedSkillStatusResult {
  const sourcePath = resolveCuedSkillSourcePath();
  const npxPath = resolveNpxPath();
  if (!sourcePath) {
    return missingSourceStatus(npxPath);
  }
  if (!npxPath) {
    return missingNpxStatus(sourcePath);
  }

  try {
    const stdout = execFileSync(npxPath, SKILL_LIST_ARGS, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSkillsCommandEnv(npxPath),
    });
    return listedSkillStatus(sourcePath, npxPath, stdout);
  } catch (error) {
    return unverifiedSkillStatus(sourcePath, npxPath, error);
  }
}

/** Filesystem-only install check: answers in microseconds and never spawns a process. */
export function probeGlobalCuedSkillInstallPath(home = homedir()): string | null {
  return hasSkillDefinition(join(home, ...GLOBAL_SKILLS_DIR_SEGMENTS, CUED_SKILL_NAME))
    ? join("~", ...GLOBAL_SKILLS_DIR_SEGMENTS, CUED_SKILL_NAME)
    : null;
}

/**
 * Global skill status for a long-lived process that must not block.
 *
 * `getGlobalCuedSkillStatus` shells out to `npx skills list`, which takes over a second and,
 * run synchronously, freezes the daemon for that long on every UI refresh. `status()` instead
 * answers from a filesystem probe, and only when that finds nothing does it verify (and
 * optionally install) with `npx` in the background, reporting the outcome through `onChange`.
 */
export class GlobalCuedSkillMonitor {
  private cached: GlobalCuedSkillStatusResult | null = null;
  private cachedFromProbe = false;
  private refreshing: Promise<void> | null = null;
  private lastRefreshStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly options: {
      onChange?: (status: GlobalCuedSkillStatusResult) => void;
      minRefreshIntervalMs?: number;
      home?: string;
      now?: () => number;
    } = {},
  ) {}

  status(request: { ensureInstalled?: boolean } = {}): GlobalCuedSkillStatusResult {
    const sourcePath = resolveCuedSkillSourcePath();
    if (!sourcePath) {
      return missingSourceStatus(this.cached?.npxPath ?? null);
    }
    const installedPath = probeGlobalCuedSkillInstallPath(this.options.home);
    if (installedPath) {
      this.cached = installedStatus(sourcePath, this.cached?.npxPath ?? null, installedPath);
      this.cachedFromProbe = true;
      return this.cached;
    }
    if (this.cachedFromProbe) {
      // The copy the probe found is gone, so that answer no longer holds. An answer that came
      // from `npx skills list` (an install somewhere the probe does not look) still stands
      // until the next background verification replaces it.
      this.cached = null;
      this.cachedFromProbe = false;
    }
    this.refreshInBackground(sourcePath, request.ensureInstalled ?? false);
    return (
      this.cached ?? {
        installed: false,
        status: "unknown",
        summary: "Checking whether the Cued skill is installed.",
        sourcePath,
        npxPath: null,
        installedPath: null,
      }
    );
  }

  /** Resolves when the in-flight background verification, if any, has finished. */
  async settled(): Promise<void> {
    await this.refreshing;
  }

  private refreshInBackground(sourcePath: string, ensureInstalled: boolean): void {
    const nowMs = (this.options.now ?? Date.now)();
    const minIntervalMs =
      this.options.minRefreshIntervalMs ?? SKILL_MONITOR_MIN_REFRESH_INTERVAL_MS;
    if (this.refreshing || nowMs - this.lastRefreshStartedAt < minIntervalMs) {
      return;
    }
    this.lastRefreshStartedAt = nowMs;
    // Nothing awaits this promise, so nothing in it may reject: an unhandled rejection takes
    // the whole daemon down. Any failure becomes an "unknown" status instead.
    this.refreshing = this.verify(sourcePath, ensureInstalled)
      .catch((error) => unverifiedSkillStatus(sourcePath, null, error))
      .then((status) => {
        const changed = JSON.stringify(status) !== JSON.stringify(this.cached);
        this.cached = status;
        if (changed) {
          this.options.onChange?.(status);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = null;
      });
  }

  private async verify(
    sourcePath: string,
    ensureInstalled: boolean,
  ): Promise<GlobalCuedSkillStatusResult> {
    const npxPath = await resolveNpxPathAsync();
    if (!npxPath) {
      return missingNpxStatus(sourcePath);
    }
    const run = async (args: string[], timeout: number) =>
      (
        await execFileAsync(npxPath, args, {
          encoding: "utf8",
          env: buildSkillsCommandEnv(npxPath),
          timeout,
        })
      ).stdout;
    try {
      const listed = listedSkillStatus(
        sourcePath,
        npxPath,
        await run(SKILL_LIST_ARGS, SKILL_LIST_TIMEOUT_MS),
      );
      if (listed.installed || !ensureInstalled) {
        return listed;
      }
      try {
        await run(skillAddArgs(sourcePath), SKILL_COMMAND_TIMEOUT_MS);
      } catch (error) {
        const formatted = formatInstallError(error);
        return { ...listed, error: formatted.stderr || formatted.message };
      }
      return listedSkillStatus(
        sourcePath,
        npxPath,
        await run(SKILL_LIST_ARGS, SKILL_LIST_TIMEOUT_MS),
      );
    } catch (error) {
      return unverifiedSkillStatus(sourcePath, npxPath, error);
    }
  }
}

export function installGlobalCuedSkill(): GlobalCuedSkillInstallResult {
  const sourcePath = resolveCuedSkillSourcePath();
  if (!sourcePath) {
    return {
      ok: false,
      agent: GLOBAL_SKILL_AGENT,
      skillName: CUED_SKILL_NAME,
      scope: "global",
      sourcePath: null,
      npxPath: null,
      stdout: "",
      stderr: "",
      error: "Bundled Cued skill not found.",
    };
  }

  const npxPath = resolveNpxPath();
  if (!npxPath) {
    return {
      ok: false,
      agent: GLOBAL_SKILL_AGENT,
      skillName: CUED_SKILL_NAME,
      scope: "global",
      sourcePath,
      npxPath: null,
      stdout: "",
      stderr: "",
      error: "npx not found. Install Node.js to enable the global Cued skill install.",
    };
  }

  try {
    const stdout = execFileSync(npxPath, skillAddArgs(sourcePath), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSkillsCommandEnv(npxPath),
      timeout: SKILL_COMMAND_TIMEOUT_MS,
    });

    return {
      ok: true,
      agent: GLOBAL_SKILL_AGENT,
      skillName: CUED_SKILL_NAME,
      scope: "global",
      sourcePath,
      npxPath,
      stdout,
      stderr: "",
    };
  } catch (error) {
    const formatted = formatInstallError(error);
    return {
      ok: false,
      agent: GLOBAL_SKILL_AGENT,
      skillName: CUED_SKILL_NAME,
      scope: "global",
      sourcePath,
      npxPath,
      stdout: formatted.stdout,
      stderr: formatted.stderr,
      error: formatted.message,
    };
  }
}
