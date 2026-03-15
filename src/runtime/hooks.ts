import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { CUED_HOOKS_PATH, ensureCuedDirs } from "../core/config.js";

export const HOOK_EVENT_NAMES = [
  "integration.authenticated",
  "sync.completed",
  "sync.failed",
  "message.received",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface HookDefinition {
  event: HookEventName;
  enabled: boolean;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
}

interface HookConfigFile {
  version?: number;
  hooks?: HookDefinition[];
}

export interface HookExecutionResult {
  event: HookEventName;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface HookDoctorResult {
  path: string;
  exists: boolean;
  valid: boolean;
  openClawDetected: boolean;
  openClawPath: string | null;
  hooks: Array<{
    event: HookEventName;
    enabled: boolean;
    command: string;
    commandExists: boolean;
  }>;
  error?: string;
}

function isHookEventName(value: string): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

function resolveCommandPath(command: string): string | null {
  try {
    return execFileSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandExists(command: string): boolean {
  return resolveCommandPath(command) !== null;
}

function detectOpenClaw(): { detected: boolean; path: string | null } {
  const path = resolveCommandPath("openclaw")?.trim() ?? null;
  return { detected: path !== null, path };
}

function normalizeHook(raw: Record<string, unknown>): HookDefinition {
  const event = typeof raw.event === "string" && isHookEventName(raw.event) ? raw.event : null;
  if (!event) {
    throw new Error(`Unsupported hook event: ${String(raw.event)}`);
  }
  if (typeof raw.command !== "string" || raw.command.length === 0) {
    throw new Error(`Hook for ${event} is missing command`);
  }

  return {
    event,
    enabled: raw.enabled === true,
    command: raw.command,
    args: Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === "string")
      : [],
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    env:
      typeof raw.env === "object" && raw.env
        ? Object.fromEntries(
            Object.entries(raw.env as Record<string, unknown>).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value]] : [],
            ),
          )
        : {},
  };
}

export function loadHooksConfig(): { path: string; exists: boolean; hooks: HookDefinition[] } {
  ensureCuedDirs();
  if (!existsSync(CUED_HOOKS_PATH)) {
    return { path: CUED_HOOKS_PATH, exists: false, hooks: [] };
  }

  const raw = parse(readFileSync(CUED_HOOKS_PATH, "utf8")) as HookConfigFile;
  const hooks = Array.isArray(raw.hooks)
    ? raw.hooks.map((hook) => normalizeHook(hook as unknown as Record<string, unknown>))
    : [];
  return { path: CUED_HOOKS_PATH, exists: true, hooks };
}

function buildSampleHooks(openClaw: { detected: boolean; path: string | null }): string {
  const config = {
    version: 1,
    hooks: [
      {
        event: "integration.authenticated",
        enabled: false,
        command: "/bin/sh",
        args: ["-lc", "cat >/tmp/cued-hook-integration-authenticated.json"],
      },
      {
        event: "sync.completed",
        enabled: false,
        command: "/bin/sh",
        args: ["-lc", "cat >/tmp/cued-hook-sync-completed.json"],
      },
      {
        event: "sync.failed",
        enabled: false,
        command: "/bin/sh",
        args: ["-lc", "cat >/tmp/cued-hook-sync-failed.json"],
      },
      {
        event: "message.received",
        enabled: false,
        command: "/bin/sh",
        args: ["-lc", "cat >/tmp/cued-hook-message-received.json"],
      },
    ],
  };

  const header = [
    "# Cued local hook configuration",
    "# Hooks are disabled by default. Each hook receives one JSON document on stdin.",
    '# {"event":"message.received","payload":{...}}',
    "# Hook subprocess failures never block auth or sync.",
    openClaw.detected
      ? `# OpenClaw detected at ${openClaw.path}. Add your own disabled subprocess wrapper if you want to bridge Cued events into it.`
      : "# OpenClaw not detected on PATH. You can still add your own subprocess hooks here later.",
    "",
  ].join("\n");

  return `${header}${stringify(config)}`;
}

export function initHooksConfig(force = false): {
  path: string;
  created: boolean;
  openClawDetected: boolean;
  openClawPath: string | null;
} {
  ensureCuedDirs();
  const openClaw = detectOpenClaw();
  if (existsSync(CUED_HOOKS_PATH) && !force) {
    return {
      path: CUED_HOOKS_PATH,
      created: false,
      openClawDetected: openClaw.detected,
      openClawPath: openClaw.path,
    };
  }

  writeFileSync(CUED_HOOKS_PATH, buildSampleHooks(openClaw), "utf8");
  return {
    path: CUED_HOOKS_PATH,
    created: true,
    openClawDetected: openClaw.detected,
    openClawPath: openClaw.path,
  };
}

export function doctorHooksConfig(): HookDoctorResult {
  const openClaw = detectOpenClaw();
  try {
    const config = loadHooksConfig();
    return {
      path: config.path,
      exists: config.exists,
      valid: true,
      openClawDetected: openClaw.detected,
      openClawPath: openClaw.path,
      hooks: config.hooks.map((hook) => ({
        event: hook.event,
        enabled: hook.enabled,
        command: hook.command,
        commandExists: commandExists(hook.command),
      })),
    };
  } catch (error) {
    return {
      path: CUED_HOOKS_PATH,
      exists: existsSync(CUED_HOOKS_PATH),
      valid: false,
      openClawDetected: openClaw.detected,
      openClawPath: openClaw.path,
      hooks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function emitHookEvent(
  event: HookEventName,
  payload: Record<string, unknown>,
): Promise<HookExecutionResult[]> {
  const config = loadHooksConfig();
  const matchingHooks = config.hooks.filter((hook) => hook.enabled && hook.event === event);
  const body = JSON.stringify({ event, payload }, null, 2);

  const executions = matchingHooks.map(
    (hook) =>
      new Promise<HookExecutionResult>((resolve) => {
        const child = spawn(hook.command, hook.args ?? [], {
          cwd: hook.cwd ?? dirname(CUED_HOOKS_PATH),
          env: {
            ...process.env,
            ...(hook.env ?? {}),
            CUED_HOOK_EVENT: event,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          resolve({
            event,
            command: hook.command,
            args: hook.args ?? [],
            exitCode: 1,
            stdout,
            stderr: error.message,
            ok: false,
          });
        });
        child.on("close", (code) => {
          resolve({
            event,
            command: hook.command,
            args: hook.args ?? [],
            exitCode: code,
            stdout,
            stderr,
            ok: code === 0,
          });
        });
        child.stdin.end(body);
      }),
  );

  return Promise.all(executions);
}

export async function testHookEvent(event: HookEventName): Promise<{
  event: HookEventName;
  executions: HookExecutionResult[];
}> {
  return {
    event,
    executions: await emitHookEvent(event, {
      test: true,
      generatedAt: Date.now(),
    }),
  };
}
