import { describe, it, expect, vi, beforeEach } from "vitest";
import { gateway, MODEL } from "./gateway.js";

// Mock the createGateway function since we don't want real API calls in tests
vi.mock("@ai-sdk/gateway", () => ({
  createGateway: vi.fn(() => {
    // Return a mock provider function that returns model config
    const mockProvider = (modelId: string) => ({
      modelId,
      specificationVersion: "v1",
      provider: "gateway",
    });
    return mockProvider;
  }),
}));

describe("gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports gateway provider", () => {
    expect(gateway).toBeDefined();
    expect(typeof gateway).toBe("function");
  });

  it("exports MODEL as kimi-k2.5", () => {
    expect(MODEL).toBe("moonshotai/kimi-k2.5");
  });

  it("creates model with correct ID", () => {
    const model = gateway("moonshotai/kimi-k2.5");
    expect(model).toBeDefined();
    expect(model.modelId).toBe("moonshotai/kimi-k2.5");
  });
});
