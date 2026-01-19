import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatTime, formatRelativeTime, formatTimestamp } from "../time";

describe("formatTime", () => {
  it("formats timestamp as localized time string", () => {
    // Create a specific date: 3:45 PM
    const date = new Date(2026, 0, 15, 15, 45, 0);
    const result = formatTime(date.getTime());
    // Locale-dependent output, but should contain hour and minutes
    expect(result).toMatch(/3:45/);
  });

  it("formats morning time", () => {
    const date = new Date(2026, 0, 15, 9, 30, 0);
    const result = formatTime(date.getTime());
    expect(result).toMatch(/9:30/);
  });

  it("formats midnight time", () => {
    const date = new Date(2026, 0, 15, 0, 0, 0);
    const result = formatTime(date.getTime());
    expect(result).toMatch(/12:00/);
  });

  it("formats noon time", () => {
    const date = new Date(2026, 0, 15, 12, 0, 0);
    const result = formatTime(date.getTime());
    expect(result).toMatch(/12:00/);
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    // Mock Date.now() to a fixed time: Jan 15, 2026, 12:00:00 PM
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than 60 seconds ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe("just now");
    expect(formatRelativeTime(now - 30000)).toBe("just now"); // 30 seconds ago
    expect(formatRelativeTime(now - 59000)).toBe("just now"); // 59 seconds ago
  });

  it("returns minutes ago for timestamps 1-59 minutes ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60000)).toBe("1m ago"); // 1 minute
    expect(formatRelativeTime(now - 300000)).toBe("5m ago"); // 5 minutes
    expect(formatRelativeTime(now - 3540000)).toBe("59m ago"); // 59 minutes
  });

  it("returns hours ago for timestamps 1-23 hours ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3600000)).toBe("1h ago"); // 1 hour
    expect(formatRelativeTime(now - 7200000)).toBe("2h ago"); // 2 hours
    expect(formatRelativeTime(now - 82800000)).toBe("23h ago"); // 23 hours
  });

  it("returns days ago for timestamps 1-6 days ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 86400000)).toBe("1d ago"); // 1 day
    expect(formatRelativeTime(now - 172800000)).toBe("2d ago"); // 2 days
    expect(formatRelativeTime(now - 518400000)).toBe("6d ago"); // 6 days
  });

  it("returns localized date string for timestamps 7+ days ago", () => {
    const now = Date.now();
    const sevenDaysAgo = now - 604800000; // 7 days
    const result = formatRelativeTime(sevenDaysAgo);
    // Should be a date string, not relative
    expect(result).not.toContain("ago");
    expect(result).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // matches date format
  });
});

describe("formatTimestamp", () => {
  beforeEach(() => {
    // Mock Date.now() to Jan 15, 2026, 3:00:00 PM
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 15, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("style: time", () => {
    it("returns formatted time string", () => {
      const date = new Date(2026, 0, 15, 9, 30, 0);
      expect(formatTimestamp(date.getTime(), { style: "time" })).toMatch(
        /9:30/
      );
    });
  });

  describe("style: relative", () => {
    it("returns relative time string", () => {
      const now = Date.now();
      expect(formatTimestamp(now - 300000, { style: "relative" })).toBe(
        "5m ago"
      );
    });
  });

  describe("style: smart (default)", () => {
    it("returns time for timestamps today", () => {
      // Same day: 9:30 AM today
      const today = new Date(2026, 0, 15, 9, 30, 0);
      const result = formatTimestamp(today.getTime());
      expect(result).toMatch(/9:30/);
    });

    it("returns 'Yesterday' for timestamps yesterday", () => {
      // Yesterday at 3:00 PM
      const yesterday = new Date(2026, 0, 14, 15, 0, 0);
      expect(formatTimestamp(yesterday.getTime())).toBe("Yesterday");
    });

    it("returns weekday for timestamps 2-6 days ago", () => {
      // Tuesday, Jan 13 (2 days before Jan 15 which is Thursday)
      const twoDaysAgo = new Date(2026, 0, 13, 12, 0, 0);
      const result = formatTimestamp(twoDaysAgo.getTime());
      expect(result).toBe("Tue");

      // Monday, Jan 12 (3 days before)
      const threeDaysAgo = new Date(2026, 0, 12, 12, 0, 0);
      expect(formatTimestamp(threeDaysAgo.getTime())).toBe("Mon");
    });

    it("returns month and day for timestamps 7+ days ago", () => {
      // Jan 5 (10 days before Jan 15)
      const tenDaysAgo = new Date(2026, 0, 5, 12, 0, 0);
      expect(formatTimestamp(tenDaysAgo.getTime())).toBe("Jan 5");

      // Dec 1, 2025
      const lastMonth = new Date(2025, 11, 1, 12, 0, 0);
      expect(formatTimestamp(lastMonth.getTime())).toBe("Dec 1");
    });

    it("defaults to smart style when no options provided", () => {
      const now = Date.now();
      const resultDefault = formatTimestamp(now);
      const resultSmart = formatTimestamp(now, { style: "smart" });
      expect(resultDefault).toBe(resultSmart);
    });
  });
});
