import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function resolveNvmNpxPath(): string | null {
  const versionsRoot = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(versionsRoot)) {
    return null;
  }

  return (
    readdirSync(versionsRoot)
      .sort()
      .reverse()
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
