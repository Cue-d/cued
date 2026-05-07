import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentAppPath } from "../macos/install.js";

const CUED_SKILL_NAME = "cued";
const GLOBAL_SKILL_AGENT = "*";

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

export interface LocalSkillInstallResult {
  ok: boolean;
  skillName: string;
  scope: "daemon-local";
  sourcePath: string | null;
  installedPath: string;
  actionDefinitionCount: number;
  executorCount: number;
  error?: string;
}

export interface LocalSkillStatusResult {
  installed: boolean;
  status: "installed" | "needs_action";
  summary: string;
  skillName: string;
  sourcePath: string | null;
  installedPath: string;
  actionDefinitionCount: number;
  executorCount: number;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function hasSkillDefinition(path: string): boolean {
  return existsSync(join(path, "SKILL.md"));
}

function cuedHome(): string {
  return process.env.CUED_HOME ?? join(homedir(), ".cued");
}

export function resolveLocalCuedSkillInstallPath(): string {
  return resolveLocalSkillInstallPath(CUED_SKILL_NAME);
}

export function resolveLocalSkillInstallPath(skillName: string): string {
  return join(cuedHome(), "skills", skillName);
}

function countFiles(path: string, suffix: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  return readdirSync(path).filter((fileName) => fileName.endsWith(suffix)).length;
}

function countSkillActionDefinitions(path: string): number {
  return countFiles(join(path, "actions"), ".json");
}

function countSkillExecutors(path: string): number {
  return countFiles(join(path, "actions"), ".cjs");
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

export function resolveNpxPath(): string | null {
  const candidates = [
    resolveShellNpxPath(),
    join("/opt", "homebrew", "bin", "npx"),
    join("/usr", "local", "bin", "npx"),
    join(homedir(), ".volta", "bin", "npx"),
    resolveNvmNpxPath(),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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

export function getGlobalCuedSkillStatus(): GlobalCuedSkillStatusResult {
  const sourcePath = resolveCuedSkillSourcePath();
  const npxPath = resolveNpxPath();
  if (!sourcePath) {
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

  if (!npxPath) {
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

  try {
    const stdout = execFileSync(npxPath, ["--yes", "skills", "list", "--global"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSkillsCommandEnv(npxPath),
    });
    const installedPath = findInstalledSkillPath(stdout, CUED_SKILL_NAME);
    return installedPath
      ? {
          installed: true,
          status: "installed",
          summary: "Cued skill is installed globally.",
          sourcePath,
          npxPath,
          installedPath,
        }
      : {
          installed: false,
          status: "needs_action",
          summary: "Install the Cued skill globally so agents can query local Cued data.",
          sourcePath,
          npxPath,
          installedPath: null,
        };
  } catch (error) {
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
}

export function getLocalCuedSkillStatus(skillName = CUED_SKILL_NAME): LocalSkillStatusResult {
  const sourcePath = skillName === CUED_SKILL_NAME ? resolveCuedSkillSourcePath() : null;
  const installedPath = resolveLocalSkillInstallPath(skillName);
  const installed = hasSkillDefinition(installedPath);
  const actionDefinitionCount = countSkillActionDefinitions(installedPath);
  const executorCount = countSkillExecutors(installedPath);
  return {
    installed,
    status: installed ? "installed" : "needs_action",
    summary: installed
      ? `${skillName} daemon skill is installed locally.`
      : `Install the ${skillName} daemon skill to enable local action loading.`,
    skillName,
    sourcePath,
    installedPath,
    actionDefinitionCount,
    executorCount,
  };
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
    const stdout = execFileSync(
      npxPath,
      ["--yes", "skills", "add", sourcePath, "--global", "--agent", GLOBAL_SKILL_AGENT, "--yes"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: buildSkillsCommandEnv(npxPath),
      },
    );

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

export function installLocalCuedSkill(sourcePathInput?: string): LocalSkillInstallResult {
  const sourcePath = sourcePathInput ? resolve(sourcePathInput) : resolveCuedSkillSourcePath();
  const skillName = sourcePath ? basename(sourcePath) : CUED_SKILL_NAME;
  const installedPath = resolveLocalSkillInstallPath(skillName);
  if (!sourcePath) {
    return {
      ok: false,
      skillName,
      scope: "daemon-local",
      sourcePath: null,
      installedPath,
      actionDefinitionCount: 0,
      executorCount: 0,
      error: "Bundled Cued skill not found.",
    };
  }
  if (!hasSkillDefinition(sourcePath)) {
    return {
      ok: false,
      skillName,
      scope: "daemon-local",
      sourcePath,
      installedPath,
      actionDefinitionCount: 0,
      executorCount: 0,
      error: `Skill definition not found at ${sourcePath}.`,
    };
  }

  try {
    mkdirSync(dirname(installedPath), { recursive: true });
    if (resolve(sourcePath) !== resolve(installedPath)) {
      rmSync(installedPath, { recursive: true, force: true });
      cpSync(sourcePath, installedPath, { recursive: true });
      rmSync(join(installedPath, "cued-workspace"), { recursive: true, force: true });
      rmSync(join(installedPath, "evals", "runs"), { recursive: true, force: true });
    }
    return {
      ok: true,
      skillName,
      scope: "daemon-local",
      sourcePath,
      installedPath,
      actionDefinitionCount: countSkillActionDefinitions(installedPath),
      executorCount: countSkillExecutors(installedPath),
    };
  } catch (error) {
    return {
      ok: false,
      skillName,
      scope: "daemon-local",
      sourcePath,
      installedPath,
      actionDefinitionCount: 0,
      executorCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
