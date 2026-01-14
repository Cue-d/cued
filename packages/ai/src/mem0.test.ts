import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMem0Provider } from "./mem0.js";

// Mock the @mem0/vercel-ai-provider module
vi.mock("@mem0/vercel-ai-provider", () => ({
  createMem0: vi.fn(() => {
    const provider = (modelId: string, settings?: { user_id?: string }) => ({
      modelId,
      settings,
      type: "mock-model",
    });
    return provider;
  }),
  addMemories: vi.fn(),
  getMemories: vi.fn(),
  retrieveMemories: vi.fn(),
  searchMemories: vi.fn(),
}));

describe("createMem0Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates provider without user_id in config", async () => {
    const { createMem0 } = await import("@mem0/vercel-ai-provider");
    const mockCreateMem0 = vi.mocked(createMem0);

    createMem0Provider();

    expect(mockCreateMem0).toHaveBeenCalledWith({
      provider: "openai",
    });
  });

  it("returns a callable provider that accepts per-request user_id", () => {
    const provider = createMem0Provider();
    const model = provider("gpt-4o", { user_id: "user-123" });

    expect(model).toHaveProperty("modelId", "gpt-4o");
    expect(model).toHaveProperty("settings", { user_id: "user-123" });
  });

  it("works without user_id when not needed", () => {
    const provider = createMem0Provider();
    const model = provider("gpt-4o");

    expect(model).toHaveProperty("modelId", "gpt-4o");
    expect(model).toHaveProperty("settings", undefined);
  });
});
