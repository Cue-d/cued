import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContactMatchInput, FuzzyMatchDecision } from "./llm-match";

// Mock the 'ai' module
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// Import after mocking
import { generateObject } from "ai";
import {
  decideFuzzyMatch,
  decideFuzzyMatchWithRetry,
  LLM_CONFIDENCE_THRESHOLD,
} from "./llm-match";

const mockedGenerateObject = vi.mocked(generateObject);

describe("decideFuzzyMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseInput: ContactMatchInput = {
    contact1: {
      displayName: "John Smith",
      company: "Acme Corp",
      handles: ["john@acme.com", "+1234567890"],
    },
    contact2: {
      displayName: "Jon Smith",
      company: "Acme Corporation",
      handles: ["jsmith@acme.com"],
    },
    fuzzyScore: 0.85,
  };

  it("returns samePerson=true with high confidence for same person", async () => {
    const mockDecision: FuzzyMatchDecision = {
      samePerson: true,
      confidence: 0.9,
      reasoning: "Names are very similar (John vs Jon), both work at Acme.",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGenerateObject.mockResolvedValue({ object: mockDecision } as any);

    const result = await decideFuzzyMatch(baseInput);

    expect(result).toEqual(mockDecision);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("returns samePerson=false for different people", async () => {
    const differentInput: ContactMatchInput = {
      contact1: {
        displayName: "John Smith",
        company: "Acme Corp",
        handles: ["john@acme.com"],
      },
      contact2: {
        displayName: "John Smythe",
        company: "Beta Inc",
        handles: ["jsmythe@beta.com"],
      },
      fuzzyScore: 0.82,
    };

    const mockDecision: FuzzyMatchDecision = {
      samePerson: false,
      confidence: 0.85,
      reasoning: "Different companies (Acme vs Beta) and different email domains suggest these are different people.",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGenerateObject.mockResolvedValue({ object: mockDecision } as any);

    const result = await decideFuzzyMatch(differentInput);

    expect(result.samePerson).toBe(false);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toBeTruthy();
  });

  it("handles empty/missing company gracefully", async () => {
    const inputNoCompany: ContactMatchInput = {
      contact1: {
        displayName: "Alice Johnson",
        handles: ["alice@gmail.com"],
      },
      contact2: {
        displayName: "Alice M Johnson",
        handles: ["alicej@yahoo.com"],
      },
      fuzzyScore: 0.78,
    };

    const mockDecision: FuzzyMatchDecision = {
      samePerson: true,
      confidence: 0.75,
      reasoning: "Names match with middle initial difference. No company info to compare.",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGenerateObject.mockResolvedValue({ object: mockDecision } as any);

    const result = await decideFuzzyMatch(inputNoCompany);

    expect(result.samePerson).toBe(true);
    // Call was made without throwing
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("handles empty handles array", async () => {
    const inputNoHandles: ContactMatchInput = {
      contact1: {
        displayName: "Bob Williams",
        company: "Tech Co",
        handles: [],
      },
      contact2: {
        displayName: "Robert Williams",
        company: "Tech Co",
        handles: [],
      },
      fuzzyScore: 0.92,
    };

    const mockDecision: FuzzyMatchDecision = {
      samePerson: true,
      confidence: 0.88,
      reasoning: "Bob is a nickname for Robert. Same company (Tech Co).",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGenerateObject.mockResolvedValue({ object: mockDecision } as any);

    const result = await decideFuzzyMatch(inputNoHandles);

    expect(result.samePerson).toBe(true);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });
});

describe("decideFuzzyMatchWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const baseInput: ContactMatchInput = {
    contact1: {
      displayName: "John Smith",
      handles: ["john@example.com"],
    },
    contact2: {
      displayName: "Jon Smith",
      handles: ["jsmith@example.com"],
    },
    fuzzyScore: 0.85,
  };

  it("returns result on first successful call", async () => {
    const mockDecision: FuzzyMatchDecision = {
      samePerson: true,
      confidence: 0.9,
      reasoning: "Names match.",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGenerateObject.mockResolvedValue({ object: mockDecision } as any);

    const promise = decideFuzzyMatchWithRetry(baseInput);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(mockDecision);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns safe default after all retries exhausted", async () => {
    mockedGenerateObject.mockRejectedValue(new Error("API rate limited"));

    const promise = decideFuzzyMatchWithRetry(baseInput, 2);
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should have tried 3 times (1 initial + 2 retries)
    expect(mockedGenerateObject).toHaveBeenCalledTimes(3);

    // Should return safe default
    expect(result.samePerson).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("LLM analysis failed");
  });

  it("succeeds on retry after initial failure", async () => {
    const mockDecision: FuzzyMatchDecision = {
      samePerson: true,
      confidence: 0.85,
      reasoning: "Match found.",
    };

    // First call fails, second succeeds
    mockedGenerateObject
      .mockRejectedValueOnce(new Error("Temporary error"))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ object: mockDecision } as any);

    const promise = decideFuzzyMatchWithRetry(baseInput, 2);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockedGenerateObject).toHaveBeenCalledTimes(2);
    expect(result).toEqual(mockDecision);
  });
});

describe("LLM_CONFIDENCE_THRESHOLD", () => {
  it("is set to 0.70", () => {
    expect(LLM_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
