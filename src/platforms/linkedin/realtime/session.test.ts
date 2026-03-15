import { describe, expect, it, vi } from "vitest";
import { LinkedInRealtimeSession, LinkedInRealtimeSupervisor } from "./session.js";

type TestableRealtimeSession = {
  userEntityUrn: string | null;
  runHeartbeatLoop(signal: AbortSignal): Promise<void>;
  connectOnce(signal: AbortSignal): Promise<void>;
};

function createSession() {
  const session = new LinkedInRealtimeSession({
    accountKey: "default",
    cookies: [
      { name: "li_at", value: "token", domain: ".linkedin.com", path: "/" },
      { name: "JSESSIONID", value: '"ajax:123"', domain: ".linkedin.com", path: "/" },
    ],
    pageInstance: "urn:li:page:d_flagship3_messaging_conversation_detail;test",
    xLiTrack: '{"clientVersion":"1.0.0"}',
    realtimeQueryMap: "{}",
    realtimeRecipeMap: "{}",
  });
  const internals = session as unknown as TestableRealtimeSession;
  internals.userEntityUrn = "urn:li:member:SELF123";
  return { session, internals };
}

describe("LinkedInRealtimeSession", () => {
  it("aborts the heartbeat loop when the realtime stream closes", async () => {
    const { internals } = createSession();
    const heartbeatAborted = vi.fn();

    internals.runHeartbeatLoop = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              heartbeatAborted();
              resolve();
            },
            { once: true },
          );
        }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    await expect(internals.connectOnce(new AbortController().signal)).rejects.toThrow(
      "LinkedIn realtime stream closed",
    );
    expect(heartbeatAborted).toHaveBeenCalledTimes(1);
  });

  it("suppresses stream abort rejections after heartbeat failure wins the race", async () => {
    const { internals } = createSession();
    const controller = new AbortController();
    const unhandledRejection = vi.fn();

    internals.runHeartbeatLoop = vi.fn(async () => {
      throw new Error("heartbeat failed");
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {},
        });
        return new Response(stream, { status: 200 });
      }),
    );

    process.once("unhandledRejection", unhandledRejection);
    await expect(internals.connectOnce(controller.signal)).rejects.toThrow("heartbeat failed");
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.removeListener("unhandledRejection", unhandledRejection);

    expect(unhandledRejection).not.toHaveBeenCalled();
  });
});

describe("LinkedInRealtimeSupervisor", () => {
  it("replaces an existing session when auth material changes", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const createSession = vi.fn(() => ({
      start,
      stop,
      getStatus: () => ({
        platform: "linkedin" as const,
        accountKey: "default",
        state: "connected" as const,
        connectedAt: null,
        lastEventAt: null,
        lastReconnectAt: null,
        reconnectAttempts: 0,
        lastSessionError: null,
      }),
      isConnected: () => true,
    }));

    const supervisor = new LinkedInRealtimeSupervisor({ createSession });
    const baseInput = {
      accountKey: "default",
      cookies: [
        { name: "li_at", value: "token-a", domain: ".linkedin.com", path: "/" },
        { name: "JSESSIONID", value: '"ajax:123"', domain: ".linkedin.com", path: "/" },
      ],
      pageInstance: "urn:li:page:d_flagship3_messaging_conversation_detail;test",
      xLiTrack: '{"clientVersion":"1.0.0"}',
      realtimeQueryMap: '{"q":"a"}',
      realtimeRecipeMap: '{"r":"a"}',
    };

    supervisor.reconcile([baseInput], []);
    supervisor.reconcile(
      [
        {
          ...baseInput,
          cookies: [{ ...baseInput.cookies[0], value: "token-b" }, baseInput.cookies[1]!],
        },
      ],
      [],
    );

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
