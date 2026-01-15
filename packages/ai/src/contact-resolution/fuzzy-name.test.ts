import { describe, it, expect } from "vitest";
import {
  normalizeName,
  jaroWinklerSimilarity,
  nameSimilarity,
  namesMatch,
  getNameMatchResult,
  NAME_MATCH_THRESHOLDS,
} from "./fuzzy-name";

describe("normalizeName", () => {
  it("lowercases and trims", () => {
    expect(normalizeName("  John DOE  ")).toBe("john doe");
  });

  it("removes titles", () => {
    expect(normalizeName("Dr. John Smith")).toBe("john smith");
    expect(normalizeName("Mr. Bob Jones")).toBe("bob jones");
    expect(normalizeName("Mrs. Jane Doe")).toBe("jane doe");
  });

  it("removes suffixes", () => {
    expect(normalizeName("John Smith Jr.")).toBe("john smith");
    expect(normalizeName("Robert Brown III")).toBe("robert brown");
  });
});

describe("jaroWinklerSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinklerSimilarity("john", "john")).toBe(1);
  });

  it("returns 0 for empty strings", () => {
    expect(jaroWinklerSimilarity("", "john")).toBe(0);
    expect(jaroWinklerSimilarity("john", "")).toBe(0);
  });

  it("returns high score for similar strings", () => {
    const score = jaroWinklerSimilarity("john", "jon");
    expect(score).toBeGreaterThan(0.9);
  });

  it("returns low score for very different strings", () => {
    const score = jaroWinklerSimilarity("john", "xyz");
    expect(score).toBeLessThan(0.5);
  });
});

describe("nameSimilarity", () => {
  it("returns 1 for exact match", () => {
    expect(nameSimilarity("John Smith", "John Smith")).toBe(1);
  });

  it("returns 1 for case-insensitive match", () => {
    expect(nameSimilarity("john smith", "JOHN SMITH")).toBe(1);
  });

  it("handles nickname matching", () => {
    const score = nameSimilarity("Bob Smith", "Robert Smith");
    expect(score).toBe(1); // Should be exact match after nickname normalization
  });

  it("handles common nickname variants", () => {
    expect(nameSimilarity("Mike Johnson", "Michael Johnson")).toBe(1);
    expect(nameSimilarity("Bill Williams", "William Williams")).toBe(1);
    expect(nameSimilarity("Liz Taylor", "Elizabeth Taylor")).toBe(1);
  });

  it("handles initial + last name format", () => {
    const score = nameSimilarity("J. Smith", "John Smith");
    expect(score).toBeGreaterThan(0.85); // 0.87 achieved via initial detection
  });

  it("returns high score for similar names", () => {
    const score = nameSimilarity("John Smith", "Jon Smith");
    expect(score).toBeGreaterThan(0.85);
  });

  it("returns low score for different names", () => {
    const score = nameSimilarity("John Smith", "Alice Johnson");
    expect(score).toBeLessThan(0.5);
  });
});

describe("namesMatch", () => {
  it("matches exact names", () => {
    expect(namesMatch("John Smith", "John Smith")).toBe(true);
  });

  it("matches with default threshold (0.85)", () => {
    expect(namesMatch("John Smith", "Jon Smith")).toBe(true);
  });

  it("does not match very different names", () => {
    expect(namesMatch("John Smith", "Alice Johnson")).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(namesMatch("John Smith", "Jon Smith", 0.99)).toBe(false);
  });
});

describe("getNameMatchResult", () => {
  it("returns detailed match information", () => {
    const result = getNameMatchResult("Bob Smith", "Robert Smith");
    expect(result.matches).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.normalizedName1).toBe("robert smith");
    expect(result.normalizedName2).toBe("robert smith");
  });
});

describe("NAME_MATCH_THRESHOLDS", () => {
  it("has correct threshold values", () => {
    expect(NAME_MATCH_THRESHOLDS.AUTO_MERGE).toBe(0.95);
    expect(NAME_MATCH_THRESHOLDS.SUGGEST_MERGE).toBe(0.80);
    expect(NAME_MATCH_THRESHOLDS.MINIMUM).toBe(0.60);
  });
});
