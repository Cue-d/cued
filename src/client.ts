import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { CUED_SOCKET_PATH } from "./core/config.js";
import type { DaemonRequest, DaemonResponse } from "./runtime/ipc.js";

const DAEMON_CONNECT_RETRY_DELAYS_MS = [100, 250, 500] as const;
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 10_000;

export class DaemonRequestTimeoutError extends Error {
  constructor(
    readonly command: DaemonRequest["command"],
    readonly timeoutMs: number,
  ) {
    super(`Cued daemon did not respond to '${command}' within ${timeoutMs}ms`);
    this.name = "DaemonRequestTimeoutError";
  }
}

export type DaemonRequestInput = {
  [K in DaemonRequest["command"]]: Omit<Extract<DaemonRequest, { command: K }>, "id">;
}[DaemonRequest["command"]];

export async function sendDaemonRequest(request: DaemonRequestInput): Promise<DaemonResponse> {
  const withId = { ...request, id: randomUUID() } as DaemonRequest;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= DAEMON_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await sendSingleDaemonRequest(withId);
    } catch (error) {
      if (!isRetriableDaemonConnectionError(error)) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= DAEMON_CONNECT_RETRY_DELAYS_MS.length) {
        break;
      }
      await sleep(DAEMON_CONNECT_RETRY_DELAYS_MS[attempt]!);
    }
  }

  throw lastError ?? new Error("Failed to connect to daemon");
}

function sendSingleDaemonRequest(request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(CUED_SOCKET_PATH);
    let buffer = "";
    let settled = false;
    const timeoutMs = getDaemonRequestTimeoutMs();
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new DaemonRequestTimeoutError(request.command, timeoutMs));
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        finish(() => {
          try {
            resolve(JSON.parse(line) as DaemonResponse);
          } catch (error) {
            reject(
              new Error(
                `Invalid daemon response: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      }
    });

    socket.on("error", (error) => {
      finish(() => reject(error));
    });
  });
}

function getDaemonRequestTimeoutMs(): number {
  const configured = Number(process.env.CUED_DAEMON_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
}

function isRetriableDaemonConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
