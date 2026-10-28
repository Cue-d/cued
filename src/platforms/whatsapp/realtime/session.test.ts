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
  parseWhatsAppHelperLine,
  WhatsAppRealtimeSession,
  type WhatsAppRealtimeSessionLike,
  WhatsAppRealtimeSupervisor,
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

describe("whatsapp realtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parses helper events and routes resync over the session", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const onEvent = vi.fn();

    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
      onEvent,
    });

    session.start();
    child.emit("spawn");
    expect(session.getStatus().state).toBe("connecting");

    child.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567@s.whatsapp.net",
        },
      })}\n`,
    );

    child.stdout.write(
      `${JSON.stringify({
        event: "message_upsert",
        data: {
          messageID: "wamid-1",
          chatJID: "12016824050@s.whatsapp.net",
          senderJID: "12016824050@s.whatsapp.net",
          fromMe: false,
          timestamp: 1_710_000_000_000,
          text: "hello",
        },
      })}\n`,
    );

    expect(onEvent).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        event: "message_upsert",
      }),
    );

    const resyncPromise = session.resync({ sinceMs: 123, limit: 20 });
    expect(JSON.parse(child.stdinWrites[0]!.trim())).toEqual({
      id: 1,
      command: "resync",
      sinceMs: 123,
      limit: 20,
    });

    child.stdout.write(
      `${JSON.stringify({
        id: 1,
        ok: true,
        result: {
          contacts: [],
          chats: [],
          messages: [],
          hasMore: false,
          completedAt: 123,
        },
      })}\n`,
    );

    await expect(resyncPromise).resolves.toEqual({
      contacts: [],
      chats: [],
      messages: [],
      hasMore: false,
      completedAt: 123,
    });
    expect(parseWhatsAppHelperLine('{"event":"connected","data":{"accountJid":"x"}}')).toEqual({
      event: "connected",
      data: {
        accountJid: "x",
      },
    });
    expect(parseWhatsAppHelperLine("not json")).toBeNull();

    session.stop();
  });

  it("waits for helper connected before marking the session connected", async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);

    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
      connectTimeoutMs: 1_000,
    });

    session.start();
    child.emit("spawn");
    expect(session.getStatus().state).toBe("connecting");
    await expect(session.resync()).rejects.toThrowError(
      "WhatsApp realtime session is not connected",
    );

    child.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567@s.whatsapp.net",
        },
      })}\n`,
    );

    expect(session.getStatus().state).toBe("connected");
    session.stop();
  });

  it("reconnects after the helper exits", () => {
    vi.useFakeTimers();
    const firstChild = new MockChild();
    const secondChild = new MockChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
    });

    session.start();
    firstChild.emit("spawn");
    expect(session.getStatus().state).toBe("connecting");
    firstChild.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567@s.whatsapp.net",
        },
      })}\n`,
    );
    expect(session.getStatus().state).toBe("connected");

    firstChild.emit("exit", 1, null);
    expect(session.getStatus().state).toBe("reconnecting");

    vi.advanceTimersByTime(1_000);
    secondChild.emit("spawn");
    expect(session.getStatus().state).toBe("reconnecting");
    secondChild.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567@s.whatsapp.net",
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

    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
      connectTimeoutMs: 25,
    });

    session.start();
    child.emit("spawn");
    vi.advanceTimersByTime(25);
    expect(session.getStatus().state).toBe("reconnecting");
    expect(session.getStatus().lastSessionError).toContain("did not emit connected");
    session.stop();
  });

  it("preserves the disconnect reason on the first disconnected status update", () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const onStatusChange = vi.fn();

    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/cued-whatsapp-helper",
      storeDir: "/tmp/cued-whatsapp/default",
      onStatusChange,
    });

    session.start();
    child.emit("spawn");
    child.stdout.write(
      `${JSON.stringify({
        event: "connected",
        data: {
          accountJid: "15551234567@s.whatsapp.net",
        },
      })}\n`,
    );

    onStatusChange.mockClear();
    child.stdout.write(
      `${JSON.stringify({
        event: "disconnected",
        data: {
          reason: "network lost",
        },
      })}\n`,
    );

    expect(onStatusChange).toHaveBeenCalled();
    expect(onStatusChange.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        state: "reconnecting",
        lastSessionError: "network lost",
      }),
    );

    session.stop();
  });

  it.each(["disconnected", "error"])("restarts a live helper stuck after %s", async (event) => {
    vi.useFakeTimers();
    const first = new MockChild();
    const replacement = new MockChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/helper",
      storeDir: "/tmp/store",
      connectTimeoutMs: 100,
      reconnectBaseMs: 10,
    });
    session.start();
    first.emit("spawn");
    if (event === "disconnected") {
      first.stdout.write('{"event":"connected","data":{"accountJid":"test"}}\n');
    }
    const line = JSON.stringify({ event, data: { reason: "lost", message: "failed" } }) + "\n";
    first.stdout.write(line);
    vi.advanceTimersByTime(50);
    first.stdout.write(line);
    vi.advanceTimersByTime(50);
    expect(first.kill).toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    replacement.emit("spawn");
    replacement.stdout.write('{"event":"connected","data":{"accountJid":"test"}}\n');
    expect(session.isConnected()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it("allows helper self-reconnect before the deadline and rejects interrupted requests", async () => {
    vi.useFakeTimers();
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const session = new WhatsAppRealtimeSession({
      accountKey: "default",
      helperPath: "/tmp/helper",
      storeDir: "/tmp/store",
      connectTimeoutMs: 100,
    });
    session.start();
    child.emit("spawn");
    const connected = '{"event":"connected","data":{"accountJid":"test"}}\n';
    child.stdout.write(connected);
    const request = session.resync();
    child.stdout.write('{"event":"disconnected","data":{"reason":"lost"}}\n');
    await expect(request).rejects.toThrow("session disconnected");
    vi.advanceTimersByTime(50);
    child.stdout.write(connected);
    vi.advanceTimersByTime(100);
    expect(session.isConnected()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    session.stop();
  });

  it("awaits recovery after a failed startup probe, including concurrent waiters", async () => {
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    let finishProbe!: () => void;
    const pendingProbe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    const recover = vi.fn(async () => {
      await pendingProbe;
      supervisor.reconcile([
        { accountKey: "default", helperPath: "/tmp/helper", storeDir: "/tmp/store" },
      ]);
    });
    const supervisor = new WhatsAppRealtimeSupervisor({ recoverMissingSession: recover });
    supervisor.reconcile(
      [],
      [
        {
          accountKey: "default",
          helperPath: "/tmp/helper",
          storeDir: "/tmp/store",
          state: "degraded",
          accountJid: null,
          connectedAt: null,
          lastEventAt: null,
          lastHistorySyncAt: null,
          lastReconnectAt: null,
          reconnectAttempts: 0,
          lastSessionError: "Unexpected end of JSON input",
        },
      ],
    );
    const first = supervisor.waitForConnected("default", 100);
    const second = supervisor.waitForConnected("default", 100);
    expect(spawnMock).not.toHaveBeenCalled();
    finishProbe();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.emit("spawn");
    child.stdout.write('{"event":"connected","data":{"accountJid":"test"}}\n');
    expect((await first)?.isConnected()).toBe(true);
    expect(await second).toBe(await first);
    expect(supervisor.getStatuses()).toHaveLength(1);
    await supervisor.waitForConnected("default", 100);
    expect(recover).toHaveBeenCalledTimes(2);
    supervisor.stopAll();
  });

  it("starts and stops managed sessions through the supervisor", async () => {
    const started: string[] = [];
    const stopped: string[] = [];

    const supervisor = new WhatsAppRealtimeSupervisor({
      createSession: (input): WhatsAppRealtimeSessionLike => ({
        start() {
          started.push(input.accountKey);
        },
        stop() {
          stopped.push(input.accountKey);
        },
        getStatus() {
          return {
            platform: "whatsapp",
            accountKey: input.accountKey,
            helperPath: input.helperPath,
            storeDir: input.storeDir,
            state: "connected",
            accountJid: "15551234567@s.whatsapp.net",
            connectedAt: 1,
            lastEventAt: null,
            lastHistorySyncAt: null,
            lastReconnectAt: null,
            reconnectAttempts: 0,
            lastSessionError: null,
          };
        },
        isConnected() {
          return true;
        },
        async downloadMedia() {
          return {
            dataBase64: Buffer.from("hello").toString("base64"),
            mimeType: "text/plain",
            filename: "hello.txt",
            sizeBytes: 5,
          };
        },
        async resync() {
          return { contacts: [], chats: [], messages: [], hasMore: false, completedAt: 1 };
        },
        async requestHistoryBackfill() {
          return { requested: 0, failed: 0, queuedHistorySyncCount: 0 };
        },
      }),
    });

    supervisor.reconcile([
      {
        accountKey: "default",
        helperPath: "/tmp/cued-whatsapp-helper",
        storeDir: "/tmp/cued-whatsapp/default",
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
