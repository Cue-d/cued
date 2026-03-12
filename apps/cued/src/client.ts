import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { CUED_SOCKET_PATH } from "./config.js";
import type { DaemonRequest, DaemonResponse } from "./ipc/protocol.js";

const DAEMON_CONNECT_RETRY_DELAYS_MS = [100, 250, 500] as const;

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

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line) as DaemonResponse);
      }
    });

    socket.on("error", (error) => {
      reject(error);
    });
  });
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
