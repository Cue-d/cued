import { describe, it, expect } from "vitest";
import {
  calculateTimePriority,
  calculateContactBoost,
  calculateGroupPenalty,
  calculatePriority,
} from "./priority";

describe("calculateTimePriority", () => {
  it("returns low priority for very fresh messages (0-2h)", () => {
    expect(calculateTimePriority(0)).toBe(20);
    expect(calculateTimePriority(1)).toBe(20);
    expect(calculateTimePriority(1.9)).toBe(20);
  });

  it("ramps up priority from 2-24 hours", () => {
    expect(calculateTimePriority(2)).toBe(40);
    expect(calculateTimePriority(13)).toBeGreaterThan(50);
    // At 23.9h: still in ramp zone, close to 70
    expect(calculateTimePriority(23.9)).toBeLessThan(80);
  });

  it("returns peak priority in 24-72 hour window", () => {
    // At 24h, enters peak zone (80)
    expect(calculateTimePriority(24)).toBe(80);
    expect(calculateTimePriority(48)).toBe(80);
    expect(calculateTimePriority(72)).toBe(80);
  });

  it("decays priority from 72-168 hours", () => {
    expect(calculateTimePriority(72)).toBe(80);
    expect(calculateTimePriority(120)).toBeLessThan(80);
    expect(calculateTimePriority(120)).toBeGreaterThan(40);
    // At 167.9h: still in decay zone
    expect(calculateTimePriority(167.9)).toBeGreaterThan(30);
  });

  it("returns low priority for very old messages (168h+)", () => {
    // At exactly 168h, falls into "very old" zone
    expect(calculateTimePriority(168)).toBe(30);
    expect(calculateTimePriority(200)).toBe(30);
    expect(calculateTimePriority(500)).toBe(30);
  });
});

describe("calculateContactBoost", () => {
  it("returns 0 for null/undefined contact", () => {
    expect(calculateContactBoost(null)).toBe(0);
    expect(calculateContactBoost(undefined)).toBe(0);
  });

  it("adds +10 for saved contacts", () => {
    expect(calculateContactBoost({ isContact: true })).toBe(10);
    expect(calculateContactBoost({ isContact: false })).toBe(0);
  });

  it("adds +10 for contacts with company", () => {
    expect(calculateContactBoost({ company: "Acme Corp" })).toBe(10);
    expect(calculateContactBoost({ company: null })).toBe(0);
  });

  it("adds +5 for contacts with notes", () => {
    expect(calculateContactBoost({ notes: "Met at conference" })).toBe(5);
    expect(calculateContactBoost({ notes: null })).toBe(0);
  });

  it("stacks all boosts", () => {
    const fullContact = {
      isContact: true,
      company: "Acme Corp",
      notes: "Important client",
    };
    expect(calculateContactBoost(fullContact)).toBe(25);
  });
});

describe("calculateGroupPenalty", () => {
  it("returns -15 for group chats", () => {
    expect(calculateGroupPenalty(true)).toBe(-15);
  });

  it("returns 0 for direct messages", () => {
    expect(calculateGroupPenalty(false)).toBe(0);
  });
});

describe("calculatePriority", () => {
  it("calculates base priority from time only", () => {
    expect(calculatePriority({ hoursSince: 48 })).toBe(80);
    expect(calculatePriority({ hoursSince: 0 })).toBe(20);
  });

  it("adds contact boost", () => {
    const result = calculatePriority({
      hoursSince: 48,
      contact: { isContact: true, company: "Acme" },
    });
    expect(result).toBe(100); // 80 + 10 + 10 = 100
  });

  it("applies group penalty", () => {
    const result = calculatePriority({
      hoursSince: 48,
      isGroup: true,
    });
    expect(result).toBe(65); // 80 - 15 = 65
  });

  it("clamps to minimum of 10", () => {
    const result = calculatePriority({
      hoursSince: 200, // Very old: 30
      isGroup: true, // -15
      contact: undefined, // +0
    });
    expect(result).toBe(15); // 30 - 15 = 15
  });

  it("clamps to maximum of 100", () => {
    const result = calculatePriority({
      hoursSince: 48, // Peak: 80
      contact: { isContact: true, company: "X", notes: "Y" }, // +25
    });
    expect(result).toBe(100); // Would be 105, clamped to 100
  });

  it("handles real-world scenarios", () => {
    // Saved contact with company, 48h ago
    expect(
      calculatePriority({
        hoursSince: 48,
        contact: { isContact: true, company: "Acme Corp" },
      })
    ).toBe(100);

    // Unknown number, 6h ago
    expect(
      calculatePriority({
        hoursSince: 6,
        contact: undefined,
      })
    ).toBe(45);

    // Group chat, 24h ago
    expect(
      calculatePriority({
        hoursSince: 24,
        isGroup: true,
      })
    ).toBe(65); // 80 - 15
  });
});
