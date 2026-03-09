import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { CUED_SOCKET_PATH } from "./config.js";
import type { DaemonRequest, DaemonResponse } from "./ipc/protocol.js";

export type DaemonRequestInput = {
  [K in DaemonRequest["command"]]: Omit<Extract<DaemonRequest, { command: K }>, "id">;
}[DaemonRequest["command"]];

export async function sendDaemonRequest(
  request: DaemonRequestInput,
): Promise<DaemonResponse> {
  const withId = { ...request, id: randomUUID() } as DaemonRequest;

  return new Promise((resolve, reject) => {
    const socket = createConnection(CUED_SOCKET_PATH);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(withId)}\n`);
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
