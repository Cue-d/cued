import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  parseSignalJsonRpcLine,
  SignalRealtimeSession,
  type SignalRealtimeSessionLike,
  SignalRealtimeSupervisor,
} from "./session.js";

class MockChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinWrites: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinWrites.push(chunk.toString());
      callback(null);
    },
  });
  killed = false;

  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

describe("signal realtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parses JSON-RPC notifications and routes sends over the session", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const onMessage = vi.fn();

    const session = new SignalRealtimeSession({
      accountKey: "default",
      account: "+14155550000",
      cliPath: "/opt/homebrew/bin/signal-cli",
      configDir: "/tmp/cued-signal/default",
      onMessage,
    });

    session.start();
    child.emit("spawn");

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "receive",
        params: {
          envelope: {
            source: "+14155550123",
            sourceName: "Ben",
            timestamp: 1_710_000_000_000,
            serverGuid: "msg-1",
            dataMessage: {
              message: "Hello from Signal",
            },
          },
        },
      })}\n`,
    );

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-1",
        threadId: "dm:+14155550123",
        text: "Hello from Signal",
      }),
    );

    const sendPromise = session.sendMessage("Ping", { recipient: "+14155550123" });
    expect(child.stdinWrites).toHaveLength(1);
    expect(JSON.parse(child.stdinWrites[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "send",
      params: {
        message: "Ping",
        recipient: ["+14155550123"],
      },
    });

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { timestamp: 123 },
      })}\n`,
    );

    await expect(sendPromise).resolves.toEqual({ timestamp: 123 });
    expect(parseSignalJsonRpcLine('{"jsonrpc":"2.0","method":"receive"}')).toEqual({
      jsonrpc: "2.0",
      method: "receive",
    });
    expect(parseSignalJsonRpcLine("not json")).toBeNull();

    session.stop();
  });

  it("reconnects after the JSON-RPC process exits", () => {
    vi.useFakeTimers();
    const firstChild = new MockChild();
    const secondChild = new MockChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const onConnected = vi.fn();

    const session = new SignalRealtimeSession({
      accountKey: "default",
      account: "+14155550000",
      cliPath: "/opt/homebrew/bin/signal-cli",
      configDir: "/tmp/cued-signal/default",
      onConnected,
    });

    session.start();
    firstChild.emit("spawn");
    expect(session.getStatus().state).toBe("connected");

    firstChild.emit("exit", 1, null);
    expect(session.getStatus().state).toBe("reconnecting");

    vi.advanceTimersByTime(1_000);
    secondChild.emit("spawn");

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(session.getStatus().state).toBe("connected");
    expect(onConnected).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        state: "connected",
      }),
      true,
    );

    session.stop();
  });

  it("starts and stops managed sessions through the supervisor", async () => {
    const started: string[] = [];
    const stopped: string[] = [];

    const supervisor = new SignalRealtimeSupervisor({
      createSession: (input): SignalRealtimeSessionLike => ({
        start() {
          started.push(input.accountKey);
        },
        stop() {
          stopped.push(input.accountKey);
        },
        getStatus() {
          return {
            platform: "signal",
            accountKey: input.accountKey,
            account: input.account,
            cliPath: input.cliPath,
            configDir: input.configDir,
            state: "connected",
            connectedAt: 1,
            lastNotificationAt: null,
            lastReconnectAt: null,
            reconnectAttempts: 0,
            lastSessionError: null,
          };
        },
        isConnected() {
          return true;
        },
        async sendMessage() {
          return { timestamp: 1 };
        },
      }),
    });

    supervisor.reconcile([
      {
        accountKey: "default",
        account: "+14155550000",
        cliPath: "/opt/homebrew/bin/signal-cli",
        configDir: "/tmp/cued-signal/default",
      },
    ]);
    expect(started).toEqual(["default"]);
    expect(supervisor.getStatuses()).toEqual([
      expect.objectContaining({
        accountKey: "default",
        state: "connected",
      }),
    ]);

    const session = await supervisor.waitForConnected("default", 10);
    expect(session?.isConnected()).toBe(true);

    supervisor.reconcile([]);
    expect(stopped).toEqual(["default"]);
  });
});
