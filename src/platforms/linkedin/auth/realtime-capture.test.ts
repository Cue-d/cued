import type { Page, Request } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLinkedInSessionData, LinkedInRealtimeCaptureError } from "./realtime-capture.js";

function request(url: string, headers: Record<string, string>): Request {
  return { url: () => url, headers: () => headers } as Request;
}

function captureHarness(requests: Request[]) {
  let listener: ((request: Request) => void) | null = null;
  const page = {
    url: () => "https://www.linkedin.com/messaging/",
    on: vi.fn((_event: string, nextListener: (request: Request) => void) => {
      listener = nextListener;
      return page;
    }),
    off: vi.fn(() => page),
    goto: vi.fn(async () => {
      for (const nextRequest of requests) {
        listener?.(nextRequest);
      }
      return null;
    }),
  } as unknown as Page;
  return page;
}

describe("LinkedIn realtime auth capture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("navigates after subscribing when auth already landed on Messaging", async () => {
    const page = captureHarness([
      request("https://www.linkedin.com/voyager/api/me", {
        "x-li-page-instance": "urn:li:page:unrelated;wrong",
        "x-li-track": '{"clientVersion":"0.0.0"}',
      }),
      request("https://www.linkedin.com/realtime/connect?rc=1", {
        "x-li-page-instance": "urn:li:page:messaging;test",
        "x-li-track": '{"clientVersion":"1.2.3"}',
        "x-li-query-map": '{"query":"map"}',
        "x-li-recipe-map": '{"recipe":"map"}',
      }),
    ]);

    await expect(captureLinkedInSessionData(page)).resolves.toEqual({
      pageInstance: "urn:li:page:messaging;test",
      xLiTrack: '{"clientVersion":"1.2.3"}',
      serviceVersion: "1.2.3",
      realtimeQueryMap: '{"query":"map"}',
      realtimeRecipeMap: '{"recipe":"map"}',
    });
    expect(page.goto).toHaveBeenCalledWith("https://www.linkedin.com/messaging/", {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    expect(page.on).toHaveBeenCalledOnce();
    expect(page.off).toHaveBeenCalledOnce();
  });

  it("rejects incomplete captures instead of authenticating a degraded session", async () => {
    vi.useFakeTimers();
    const page = captureHarness([
      request("https://www.linkedin.com/realtime/connect?rc=1", {
        "x-li-page-instance": "urn:li:page:messaging;test",
        "x-li-track": "{}",
      }),
    ]);

    const capture = captureLinkedInSessionData(page);
    const rejected = expect(capture).rejects.toBeInstanceOf(LinkedInRealtimeCaptureError);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(page.off).toHaveBeenCalledOnce();
  });
});
