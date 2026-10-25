import { describe, expect, it } from "vitest";
import { AutoSyncPacing } from "./sync-pacing.js";

describe("adaptive sync pacing", () => {
  it("bounds quiet pull-only latency and resets on activity, continuation and failure", () => {
    const pacing = new AutoSyncPacing();
    for (let i = 0; i < 20; i++) pacing.record("gmail:a", 0, false);
    expect(pacing.interval("gmail:a", 60_000, false)).toBe(120_000);
    expect(pacing.interval("slack:b", 60_000, true)).toBe(60_000);
    pacing.record("gmail:a", 1, false);
    expect(pacing.interval("gmail:a", 60_000, false)).toBe(60_000);
    pacing.record("gmail:a", 0, false);
    pacing.record("gmail:a", 0, true);
    expect(pacing.interval("gmail:a", 60_000, false)).toBe(60_000);
    pacing.record("gmail:a", 0, false);
    pacing.reset("gmail:a");
    expect(pacing.interval("gmail:a", 60_000, false)).toBe(60_000);
  });

  it("reduces catch-up frequency only while realtime covers new messages", () => {
    const pacing = new AutoSyncPacing();
    for (let i = 0; i < 3; i++) pacing.record("slack:a", 0, false);
    expect(pacing.interval("slack:a", 60_000, true)).toBe(480_000);
    expect(pacing.interval("slack:a", 60_000, false)).toBe(120_000);
  });
});
