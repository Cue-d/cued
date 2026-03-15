import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CUED_WHATSAPP_DIR, ensureCuedDirs } from "../../../core/config.js";
import type { WhatsAppHelperEventEnvelope } from "../types.js";

const execFileAsync = promisify(execFile);

function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function getWhatsAppStoreDir(accountKey: string): string {
  ensureCuedDirs();
  const dir = join(CUED_WHATSAPP_DIR, accountKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getWhatsAppHelperBinaryCandidates(repoRoot = resolveRepoRoot()): string[] {
  const helperRoot = join(repoRoot, "native", "helpers", "whatsapp-go");
  return [
    join(helperRoot, ".build", "cued-whatsapp-helper"),
    join(helperRoot, ".build", "CuedWhatsAppHelper"),
    join(helperRoot, "cued-whatsapp-helper"),
  ];
}

export function resolveWhatsAppHelperBinary(
  envVarValue = process.env.CUED_WHATSAPP_HELPER_BINARY,
  repoRoot = resolveRepoRoot(),
): string | null {
  if (envVarValue) {
    return envVarValue;
  }

  return (
    getWhatsAppHelperBinaryCandidates(repoRoot).find((candidate) => existsSync(candidate)) ?? null
  );
}

export interface WhatsAppHelperInspection {
  helperPath: string | null;
  version: string | null;
}

export interface WhatsAppHelperStatus {
  authenticated: boolean;
  accountJid: string | null;
  pushName: string | null;
  helperVersion: string | null;
  lastHistorySyncAt: number | null;
  lastHistorySyncType: string | null;
  lastHistoryChunkOrder: number | null;
  lastHistoryProgress: number | null;
  queuedHistorySyncCount: number | null;
  lastHistorySyncError: string | null;
  lastHistoryNotificationAt: number | null;
}

export function inspectWhatsAppHelper(): WhatsAppHelperInspection {
  const helperPath = resolveWhatsAppHelperBinary();
  if (!helperPath) {
    return {
      helperPath: null,
      version: null,
    };
  }

  try {
    const stdout = execFileSync(helperPath, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as { version?: unknown };
    return {
      helperPath,
      version: typeof parsed.version === "string" ? parsed.version : null,
    };
  } catch {
    return {
      helperPath,
      version: null,
    };
  }
}

export async function readWhatsAppHelperStatus(storeDir: string): Promise<WhatsAppHelperStatus> {
  const helperPath = resolveWhatsAppHelperBinary();
  if (!helperPath) {
    return {
      authenticated: false,
      accountJid: null,
      pushName: null,
      helperVersion: null,
      lastHistorySyncAt: null,
      lastHistorySyncType: null,
      lastHistoryChunkOrder: null,
      lastHistoryProgress: null,
      queuedHistorySyncCount: null,
      lastHistorySyncError: null,
      lastHistoryNotificationAt: null,
    };
  }

  const { stdout } = await execFileAsync(helperPath, ["status", "--store-dir", storeDir], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    authenticated?: unknown;
    accountJid?: unknown;
    pushName?: unknown;
    helperVersion?: unknown;
    lastHistorySyncAt?: unknown;
    lastHistorySyncType?: unknown;
    lastHistoryChunkOrder?: unknown;
    lastHistoryProgress?: unknown;
    queuedHistorySyncCount?: unknown;
    lastHistorySyncError?: unknown;
    lastHistoryNotificationAt?: unknown;
  };
  return {
    authenticated: parsed.authenticated === true,
    accountJid: typeof parsed.accountJid === "string" ? parsed.accountJid : null,
    pushName: typeof parsed.pushName === "string" ? parsed.pushName : null,
    helperVersion: typeof parsed.helperVersion === "string" ? parsed.helperVersion : null,
    lastHistorySyncAt:
      typeof parsed.lastHistorySyncAt === "number" ? parsed.lastHistorySyncAt : null,
    lastHistorySyncType:
      typeof parsed.lastHistorySyncType === "string" ? parsed.lastHistorySyncType : null,
    lastHistoryChunkOrder:
      typeof parsed.lastHistoryChunkOrder === "number" ? parsed.lastHistoryChunkOrder : null,
    lastHistoryProgress:
      typeof parsed.lastHistoryProgress === "number" ? parsed.lastHistoryProgress : null,
    queuedHistorySyncCount:
      typeof parsed.queuedHistorySyncCount === "number" ? parsed.queuedHistorySyncCount : null,
    lastHistorySyncError:
      typeof parsed.lastHistorySyncError === "string" ? parsed.lastHistorySyncError : null,
    lastHistoryNotificationAt:
      typeof parsed.lastHistoryNotificationAt === "number"
        ? parsed.lastHistoryNotificationAt
        : null,
  };
}

export interface WhatsAppPairResult {
  accountJid: string;
  pushName?: string | null;
  helperVersion?: string | null;
}

export interface WhatsAppPairHandle {
  child: ChildProcess;
  qrCode: Promise<string>;
  completion: Promise<WhatsAppPairResult>;
  cancel: () => void;
}

export function startWhatsAppPairSession(options: {
  helperPath: string;
  storeDir: string;
  deviceName: string;
}): WhatsAppPairHandle {
  const child = spawn(
    options.helperPath,
    ["pair", "--store-dir", options.storeDir, "--device-name", options.deviceName],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let qrResolved = false;
  let qrRejected = false;
  let completionSettled = false;
  let connectedResult: WhatsAppPairResult | null = null;
  let resolveQr!: (value: string) => void;
  let rejectQr!: (reason: Error) => void;
  let resolveCompletion!: (value: WhatsAppPairResult) => void;
  let rejectCompletion!: (reason: Error) => void;

  const qrCode = new Promise<string>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  const completion = new Promise<WhatsAppPairResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const rejectPending = (error: Error) => {
    if (!qrResolved && !qrRejected) {
      qrRejected = true;
      rejectQr(error);
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(error);
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseWhatsAppPairLine(line);
      if (!parsed) {
        continue;
      }
      if (parsed.event === "qr" && typeof parsed.data.code === "string") {
        if (!qrResolved && !qrRejected) {
          qrResolved = true;
          resolveQr(parsed.data.code);
        }
        continue;
      }
      if (parsed.event === "connected") {
        const data = parsed.data as WhatsAppHelperEventEnvelope<"connected">["data"];
        connectedResult = {
          accountJid: data.accountJid,
          pushName: data.pushName ?? null,
          helperVersion: data.helperVersion ?? null,
        };
        continue;
      }
      if (parsed.event === "error") {
        const data = parsed.data as WhatsAppHelperEventEnvelope<"error">["data"];
        rejectPending(new Error(data.message));
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });
  child.once("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });
  child.once("exit", (code) => {
    if (code && code !== 0) {
      rejectPending(new Error(stderrBuffer.trim() || `WhatsApp helper exited with code ${code}`));
      return;
    }
    if (!completionSettled && connectedResult) {
      completionSettled = true;
      resolveCompletion(connectedResult);
      return;
    }
    if (!completionSettled) {
      rejectPending(
        new Error(stderrBuffer.trim() || "WhatsApp helper exited before pairing completed"),
      );
    }
  });

  qrCode.catch(() => {});
  completion.catch(() => {});

  return {
    child,
    qrCode,
    completion,
    cancel: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

function parseWhatsAppPairLine(
  line: string,
):
  | WhatsAppHelperEventEnvelope<"connected" | "error">
  | { event: "qr"; data: { code: string } }
  | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.event === "qr" && typeof (parsed.data as { code?: unknown })?.code === "string") {
      return {
        event: "qr",
        data: {
          code: (parsed.data as { code: string }).code,
        },
      };
    }
    if (
      (parsed.event === "connected" || parsed.event === "error") &&
      typeof parsed.data === "object" &&
      parsed.data !== null
    ) {
      return parsed as unknown as WhatsAppHelperEventEnvelope<"connected" | "error">;
    }
    return null;
  } catch {
    return null;
  }
}
