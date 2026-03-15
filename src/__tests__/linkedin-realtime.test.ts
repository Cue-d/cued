import { describe, expect, it, vi } from "vitest";
import { LinkedInRealtimeSession } from "../integrations/linkedin-realtime.js";

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
});
