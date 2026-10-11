import type { Page, Request } from "playwright";
import {
  type CompleteLinkedInRealtimeSessionHeaders,
  hasLinkedInRealtimeSessionHeaders,
  type LinkedInRealtimeSessionHeaders,
} from "./session-store.js";

const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const LINKEDIN_REALTIME_CAPTURE_TIMEOUT_MS = 10_000;

export type LinkedInRealtimeCapture = CompleteLinkedInRealtimeSessionHeaders & {
  serviceVersion: string | null;
};

function header(headers: Record<string, string>, name: string): string | null {
  const value = headers[name]?.trim();
  return value ? value : null;
}

function parseServiceVersion(xLiTrack: string): string | null {
  try {
    const parsed = JSON.parse(xLiTrack) as Record<string, unknown>;
    if (typeof parsed.mpVersion === "string") {
      return parsed.mpVersion;
    }
    return typeof parsed.clientVersion === "string" ? parsed.clientVersion : null;
  } catch {
    return null;
  }
}

function captureLinkedInRealtimeRequest(request: Request): LinkedInRealtimeCapture | null {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return null;
  }
  if (url.hostname !== "www.linkedin.com" || url.pathname !== "/realtime/connect") {
    return null;
  }
  const headers = request.headers();
  const candidate = {
    pageInstance: header(headers, "x-li-page-instance"),
    xLiTrack: header(headers, "x-li-track"),
    realtimeQueryMap: header(headers, "x-li-query-map"),
    realtimeRecipeMap: header(headers, "x-li-recipe-map"),
  };
  if (!hasLinkedInRealtimeSessionHeaders(candidate)) {
    return null;
  }
  return {
    ...candidate,
    serviceVersion: parseServiceVersion(candidate.xLiTrack),
  };
}

export async function captureLinkedInSessionData(
  page: Page,
): Promise<LinkedInRealtimeSessionHeaders & { serviceVersion: string | null }> {
  let resolveReady: ((capture: LinkedInRealtimeCapture) => void) | null = null;
  const ready = new Promise<LinkedInRealtimeCapture>((resolve) => {
    resolveReady = resolve;
  });
  const onRequest = (request: Request) => {
    const capture = captureLinkedInRealtimeRequest(request);
    if (capture) {
      resolveReady?.(capture);
    }
  };
  page.on("request", onRequest);

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    // Always navigate after subscribing. If auth lands directly on Messaging, its
    // initial realtime request has already fired before extraction begins.
    void page
      .goto(LINKEDIN_MESSAGING_URL, {
        waitUntil: "domcontentloaded",
        timeout: LINKEDIN_REALTIME_CAPTURE_TIMEOUT_MS,
      })
      .catch(() => null);
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), LINKEDIN_REALTIME_CAPTURE_TIMEOUT_MS);
    });
    const capture = await Promise.race([ready, expired]);
    // Realtime is optional: cookies still support scheduled HTTP sync.
    return (
      capture ?? {
        pageInstance: null,
        xLiTrack: null,
        realtimeQueryMap: null,
        realtimeRecipeMap: null,
        serviceVersion: null,
      }
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    page.off("request", onRequest);
  }
}
