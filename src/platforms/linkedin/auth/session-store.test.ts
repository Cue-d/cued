import { describe, expect, it } from "vitest";
import {
  buildLinkedInRealtimeAuthResult,
  hasLinkedInRealtimeSessionHeaders,
  parseLinkedInSessionSecret,
} from "./session-store.js";

describe("LinkedIn session storage", () => {
  it("preserves the browser user agent with the captured session", () => {
    expect(
      parseLinkedInSessionSecret({
        cookies: [],
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
      }).userAgent,
    ).toBe("Mozilla/5.0 Chrome/150.0.0.0");
  });

  it("requires the complete realtime header tuple", () => {
    expect(
      hasLinkedInRealtimeSessionHeaders({
        pageInstance: "urn:li:page:messaging;test",
        xLiTrack: "{}",
        realtimeQueryMap: "{}",
        realtimeRecipeMap: "{}",
      }),
    ).toBe(true);
    expect(
      hasLinkedInRealtimeSessionHeaders({
        pageInstance: "urn:li:page:messaging;test",
        xLiTrack: "{}",
        realtimeQueryMap: null,
        realtimeRecipeMap: "{}",
      }),
    ).toBe(false);
  });

  it("builds readiness diagnostics from the same header invariant", () => {
    expect(
      buildLinkedInRealtimeAuthResult({
        pageInstance: "urn:li:page:messaging;test",
        xLiTrack: "{}",
        realtimeQueryMap: "{}",
        realtimeRecipeMap: "{}",
        serviceVersion: "1.2.3",
      }),
    ).toEqual({
      realtimeReady: true,
      pageInstanceCaptured: true,
      xLiTrackCaptured: true,
      realtimeQueryMapCaptured: true,
      realtimeRecipeMapCaptured: true,
      serviceVersion: "1.2.3",
    });
  });
});
