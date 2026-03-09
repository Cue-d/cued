import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname } from "node:path";
import { stringify, parse } from "smol-toml";
import { CUED_HOOKS_PATH, ensureCuedDirs } from "../config.js";
export const HOOK_EVENT_NAMES = [
    "integration.authenticated",
    "sync.completed",
    "sync.failed",
    "message.received",
];
function isHookEventName(value) {
    return HOOK_EVENT_NAMES.includes(value);
}
function commandExists(command) {
    try {
        execFileSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    }
    catch {
        return false;
    }
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function detectOpenClaw() {
    try {
        execFileSync("sh", ["-lc", "command -v openclaw"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
    }
    catch {
        return false;
    }
}
function normalizeHook(raw) {
    const event = typeof raw.event === "string" && isHookEventName(raw.event)
        ? raw.event
        : null;
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
        args: Array.isArray(raw.args) ? raw.args.filter((value) => typeof value === "string") : [],
        cwd: typeof raw.cwd === "string" ? raw.cwd : null,
        env: typeof raw.env === "object" && raw.env
            ? Object.fromEntries(Object.entries(raw.env).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []))
            : {},
    };
}
export function loadHooksConfig() {
    ensureCuedDirs();
    if (!existsSync(CUED_HOOKS_PATH)) {
        return { path: CUED_HOOKS_PATH, exists: false, hooks: [] };
    }
    const raw = parse(readFileSync(CUED_HOOKS_PATH, "utf8"));
    const hooks = Array.isArray(raw.hooks)
        ? raw.hooks.map((hook) => normalizeHook(hook))
        : [];
    return { path: CUED_HOOKS_PATH, exists: true, hooks };
}
function buildSampleHooks(openClawDetected) {
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
                event: "message.received",
                enabled: false,
                command: "/bin/sh",
                args: ["-lc", "cat >/tmp/cued-hook-message-received.json"],
            },
        ],
    };
    const header = [
        "# Cued local hook configuration",
        "# Hooks are disabled by default. Each hook receives a JSON payload on stdin.",
        openClawDetected
            ? "# OpenClaw detected on PATH. Add your own disabled openclaw subprocess hook here if you want one."
            : "# OpenClaw not detected on PATH. You can still add your own subprocess hooks here later.",
        "",
    ].join("\n");
    return `${header}${stringify(config)}`;
}
export function initHooksConfig(force = false) {
    ensureCuedDirs();
    const openClawDetected = detectOpenClaw();
    if (existsSync(CUED_HOOKS_PATH) && !force) {
        return { path: CUED_HOOKS_PATH, created: false, openClawDetected };
    }
    writeFileSync(CUED_HOOKS_PATH, buildSampleHooks(openClawDetected), "utf8");
    return { path: CUED_HOOKS_PATH, created: true, openClawDetected };
}
export function doctorHooksConfig() {
    try {
        const config = loadHooksConfig();
        return {
            path: config.path,
            exists: config.exists,
            valid: true,
            openClawDetected: detectOpenClaw(),
            hooks: config.hooks.map((hook) => ({
                event: hook.event,
                enabled: hook.enabled,
                command: hook.command,
                commandExists: commandExists(hook.command),
            })),
        };
    }
    catch (error) {
        return {
            path: CUED_HOOKS_PATH,
            exists: existsSync(CUED_HOOKS_PATH),
            valid: false,
            openClawDetected: detectOpenClaw(),
            hooks: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function emitHookEvent(event, payload) {
    const config = loadHooksConfig();
    const matchingHooks = config.hooks.filter((hook) => hook.enabled && hook.event === event);
    const body = JSON.stringify({ event, payload }, null, 2);
    const executions = matchingHooks.map((hook) => new Promise((resolve) => {
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
    }));
    return Promise.all(executions);
}
export async function testHookEvent(event) {
    return {
        event,
        executions: await emitHookEvent(event, {
            test: true,
            generatedAt: Date.now(),
        }),
    };
}
//# sourceMappingURL=service.js.map