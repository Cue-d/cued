import { describe, it, expect, vi, beforeEach } from "vitest";
import { openai, DEFAULT_MODEL, FAST_MODEL } from "./openai.js";

// Mock the createOpenAI function since we don't want real API calls in tests
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    // Return a mock provider function that returns model config
    const mockProvider = (modelId: string) => ({
      modelId,
      specificationVersion: "v1",
      provider: "openai",
    });
    return mockProvider;
  }),
}));

describe("openai provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports openai provider", () => {
    expect(openai).toBeDefined();
    expect(typeof openai).toBe("function");
  });

  it("exports DEFAULT_MODEL as gpt-5-mini", () => {
    expect(DEFAULT_MODEL).toBe("gpt-5-mini");
  });

  it("exports FAST_MODEL as gpt-5-nano", () => {
    expect(FAST_MODEL).toBe("gpt-5-nano");
  });

  it("creates model with correct ID", () => {
    const model = openai("gpt-4o");
    expect(model).toBeDefined();
    expect(model.modelId).toBe("gpt-4o");
  });
});
