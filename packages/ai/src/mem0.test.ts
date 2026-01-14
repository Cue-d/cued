import { describe, it, expect, vi } from "vitest";
import { createMem0Provider } from "./mem0.js";

// Mock the @mem0/vercel-ai-provider module
vi.mock("@mem0/vercel-ai-provider", () => ({
  createMem0: vi.fn(() => {
    const provider = (modelId: string) => ({ modelId, type: "mock-model" });
    return provider;
  }),
  addMemories: vi.fn(),
  getMemories: vi.fn(),
  retrieveMemories: vi.fn(),
}));

describe("createMem0Provider", () => {
  it("creates provider with user_id", async () => {
    const { createMem0 } = await import("@mem0/vercel-ai-provider");
    const mockCreateMem0 = vi.mocked(createMem0);

    createMem0Provider("user-123");

    expect(mockCreateMem0).toHaveBeenCalledWith({
      provider: "openai",
      mem0Config: {
        user_id: "user-123",
      },
    });
  });

  it("creates provider with composite user:contact id", async () => {
    const { createMem0 } = await import("@mem0/vercel-ai-provider");
    const mockCreateMem0 = vi.mocked(createMem0);

    createMem0Provider("user-123", "contact-456");

    expect(mockCreateMem0).toHaveBeenCalledWith({
      provider: "openai",
      mem0Config: {
        user_id: "user-123:contact-456",
      },
    });
  });

  it("returns a callable provider", () => {
    const provider = createMem0Provider("user-123");
    const model = provider("gpt-4o");

    expect(model).toHaveProperty("modelId", "gpt-4o");
  });
});
