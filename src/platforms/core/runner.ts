import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AdapterPlatform } from "../../core/types/provider.js";
import { getAdapterDefinition } from "./registry.js";
import type { AdapterWorkerErrorCode, AdapterWorkerOutput, SyncBundle } from "./sync.js";

export class AdapterWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: AdapterWorkerErrorCode | null = null,
  ) {
    super(message);
    this.name = "AdapterWorkerError";
  }
}

export function isAdapterWorkerError(
  error: unknown,
  code: AdapterWorkerErrorCode,
): error is AdapterWorkerError {
  return error instanceof AdapterWorkerError && error.code === code;
}

export async function runAdapter(
  platform: AdapterPlatform,
  accountKey?: string,
  envOverrides?: Record<string, string>,
): Promise<SyncBundle> {
  const definition = getAdapterDefinition(platform);
  if (!definition) {
    throw new Error(`No adapter registered for platform '${platform}'`);
  }

  const workerEntrypoint = resolveWorkerEntrypoint(definition.workerEntrypoint);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, workerEntrypoint], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        ...(accountKey ? { CUED_ACCOUNT_KEY: accountKey } : {}),
        ...envOverrides,
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killAdapterProcessTree(child.pid, () => child.kill("SIGKILL"));
      reject(
        new Error(
          `Adapter worker timed out after ${definition.workerTimeoutMs}ms for platform '${platform}'${accountKey ? ` account '${accountKey}'` : ""}`,
        ),
      );
    }, definition.workerTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const parsedFailure = parseWorkerFailure(stdout);
        const workerError = parsedFailure?.message ?? stderr.trim();
        reject(
          new AdapterWorkerError(
            workerError || `Adapter worker exited with code ${code}`,
            parsedFailure?.code ?? null,
          ),
        );
        return;
      }

      let parsed: AdapterWorkerOutput;
      try {
        parsed = JSON.parse(stdout) as AdapterWorkerOutput;
      } catch (error) {
        reject(
          new Error(
            `Invalid adapter worker output: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      if (!parsed.ok || !parsed.bundle) {
        reject(
          new AdapterWorkerError(
            parsed.error ?? "Adapter worker failed without output",
            parsed.errorCode ?? null,
          ),
        );
        return;
      }

      resolve(parsed.bundle);
    });
  });
}

function killAdapterProcessTree(pid: number | undefined, fallback: () => void): void {
  if (typeof pid !== "number" || pid <= 0) {
    fallback();
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}

function parseWorkerFailure(
  stdout: string,
): { message: string; code: AdapterWorkerErrorCode | null } | null {
  if (!stdout.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as AdapterWorkerOutput;
    return typeof parsed.error === "string" && parsed.error.length > 0
      ? { message: parsed.error, code: parsed.errorCode ?? null }
      : null;
  } catch {
    return null;
  }
}

function resolveWorkerEntrypoint(entrypoint: string): string {
  if (existsSync(entrypoint)) {
    return entrypoint;
  }

  if (entrypoint.endsWith(".js")) {
    const tsEntrypoint = `${entrypoint.slice(0, -3)}.ts`;
    if (existsSync(tsEntrypoint)) {
      return tsEntrypoint;
    }
  }

  return entrypoint;
}
