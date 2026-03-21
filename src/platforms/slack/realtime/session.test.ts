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
  parseSlackRealtimeHelperLine,
  SlackRealtimeSession,
  type SlackRealtimeSessionLike,
  SlackRealtimeSupervisor,
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

describe("slack realtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parses helper events and starts the polling session", () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const onEvent = vi.fn();

    const session = new SlackRealtimeSession({
      accountKey: "workspace-a",
      helperPath: "/tmp/cued-slack-helper",
      credentials: {
        token: "xoxc-test",
        cookie: "cookie-test",
      },
      pollIntervalMs: 250,
      onEvent,
    });

    session.start();
    child.emit("spawn");
    expect(JSON.parse(child.stdinWrites[0] ?? "{}")).toEqual(
      expect.objectContaining({
        credentials: {
          token: "xoxc-test",
          cookie: "cookie-test",
        },
        pollIntervalMs: 250,
      }),
    );

    child.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          teamId: "T123",
          userId: "U_SELF",
          transport: "polling",
        },
      })}\n`,
    );
    expect(session.getStatus()).toEqual(
      expect.objectContaining({
        state: "connected",
        teamId: "T123",
        userId: "U_SELF",
        transport: "polling",
      }),
    );

    child.stdout.write(
      `${JSON.stringify({
        event: "message_upsert",
        data: {
          teamId: "T123",
          selfUserId: "U_SELF",
          conversationId: "C123",
          message: {
            type: "message",
            user: "U_BEN",
            text: "hello",
            ts: "1710000000.000100",
          },
        },
      })}\n`,
    );

    expect(onEvent).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        event: "message_upsert",
      }),
    );
    expect(parseSlackRealtimeHelperLine('{"event":"connected","data":{"teamId":"T1"}}')).toEqual({
      event: "connected",
      data: {
        teamId: "T1",
      },
    });
    expect(parseSlackRealtimeHelperLine("not json")).toBeNull();

    session.stop();
  });

  it("reconnects after the helper exits", () => {
    vi.useFakeTimers();
    const firstChild = new MockChild();
    const secondChild = new MockChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const session = new SlackRealtimeSession({
      accountKey: "workspace-a",
      helperPath: "/tmp/cued-slack-helper",
      credentials: {
        token: "xoxc-test",
        cookie: "cookie-test",
      },
    });

    session.start();
    firstChild.emit("spawn");
    firstChild.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          teamId: "T123",
          userId: "U_SELF",
          transport: "polling",
        },
      })}\n`,
    );
    expect(session.getStatus().state).toBe("connected");

    firstChild.emit("exit", 1, null);
    expect(session.getStatus().state).toBe("reconnecting");

    vi.advanceTimersByTime(1_000);
    secondChild.emit("spawn");
    secondChild.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          teamId: "T123",
          userId: "U_SELF",
          transport: "polling",
        },
      })}\n`,
    );

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(session.getStatus().state).toBe("connected");

    session.stop();
  });

  it("times out when the helper never emits connected", () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const session = new SlackRealtimeSession({
      accountKey: "workspace-a",
      helperPath: "/tmp/cued-slack-helper",
      credentials: {
        token: "xoxc-test",
        cookie: "cookie-test",
      },
      connectTimeoutMs: 25,
    });

    session.start();
    child.emit("spawn");
    vi.advanceTimersByTime(25);
    expect(session.getStatus().state).toBe("reconnecting");
    expect(session.getStatus().lastSessionError).toContain("did not emit connected");
    session.stop();
  });

  it("starts and stops managed sessions through the supervisor", () => {
    const started: string[] = [];
    const stopped: string[] = [];

    const supervisor = new SlackRealtimeSupervisor({
      createSession: (input): SlackRealtimeSessionLike => ({
        start() {
          started.push(input.accountKey);
        },
        stop() {
          stopped.push(input.accountKey);
        },
        getStatus() {
          return {
            platform: "slack",
            accountKey: input.accountKey,
            helperPath: input.helperPath,
            state: "connected",
            teamId: "T123",
            userId: "U_SELF",
            transport: "polling",
            connectedAt: 1,
            lastEventAt: 2,
            lastReconnectAt: null,
            reconnectAttempts: 0,
            lastSessionError: null,
          };
        },
        isConnected() {
          return true;
        },
      }),
    });

    supervisor.reconcile([
      {
        accountKey: "workspace-a",
        helperPath: "/tmp/cued-slack-helper",
        credentials: {
          token: "xoxc-test",
          cookie: "cookie-test",
        },
      },
    ]);

    expect(started).toEqual(["workspace-a"]);
    expect(supervisor.getStatuses()).toEqual([
      expect.objectContaining({
        accountKey: "workspace-a",
        state: "connected",
      }),
    ]);

    supervisor.reconcile([]);
    expect(stopped).toEqual(["workspace-a"]);
  });
});
