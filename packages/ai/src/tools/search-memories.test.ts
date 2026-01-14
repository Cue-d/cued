import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchMemoriesTool } from "./search-memories.js";
import type { ToolExecutionOptions } from "../types.js";

// Mock the @mem0/vercel-ai-provider module
vi.mock("@mem0/vercel-ai-provider", () => ({
  getMemories: vi.fn(),
}));

describe("searchMemoriesTool", () => {
  const mockContext: ToolExecutionOptions = {
    toolCallId: "test-call-id",
    context: {
      userId: "user-123",
      query: vi.fn(),
      mutation: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(searchMemoriesTool.name).toBe("search_memories");
    expect(searchMemoriesTool.description).toContain("memories");
  });

  it("returns memories when found", async () => {
    const { getMemories } = await import("@mem0/vercel-ai-provider");
    const mockGetMemories = vi.mocked(getMemories);

    mockGetMemories.mockResolvedValue([
      {
        id: "mem-1",
        memory: "User prefers email over phone calls",
        score: 0.95,
        created_at: "2024-01-15T10:00:00Z",
      },
      {
        id: "mem-2",
        memory: "Works at Acme Corp",
        score: 0.85,
      },
    ]);

    const result = await searchMemoriesTool.execute(
      { query: "communication preferences" },
      mockContext
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].memory).toBe("User prefers email over phone calls");
      expect(result.data[0].score).toBe(0.95);
    }

    expect(mockGetMemories).toHaveBeenCalledWith("communication preferences", {
      user_id: "user-123",
      filters: undefined,
    });
  });

  it("filters memories by contactId when provided", async () => {
    const { getMemories } = await import("@mem0/vercel-ai-provider");
    const mockGetMemories = vi.mocked(getMemories);
    mockGetMemories.mockResolvedValue([]);

    await searchMemoriesTool.execute(
      { query: "test", contactId: "contact-456" },
      mockContext
    );

    expect(mockGetMemories).toHaveBeenCalledWith("test", {
      user_id: "user-123",
      filters: { contact_id: "contact-456" },
    });
  });

  it("filters out memories without content", async () => {
    const { getMemories } = await import("@mem0/vercel-ai-provider");
    const mockGetMemories = vi.mocked(getMemories);

    mockGetMemories.mockResolvedValue([
      { id: "mem-1", memory: "Valid memory" },
      { id: "mem-2", memory: undefined },
      { id: "mem-3", memory: "" },
      { id: "mem-4", memory: "Another valid" },
    ]);

    const result = await searchMemoriesTool.execute(
      { query: "test" },
      mockContext
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data.map((m) => m.id)).toEqual(["mem-1", "mem-4"]);
    }
  });

  it("handles API errors gracefully", async () => {
    const { getMemories } = await import("@mem0/vercel-ai-provider");
    const mockGetMemories = vi.mocked(getMemories);
    mockGetMemories.mockRejectedValue(new Error("API rate limit exceeded"));

    const result = await searchMemoriesTool.execute(
      { query: "test" },
      mockContext
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("API rate limit exceeded");
    }
  });

  it("handles missing API key error", async () => {
    const { getMemories } = await import("@mem0/vercel-ai-provider");
    const mockGetMemories = vi.mocked(getMemories);
    mockGetMemories.mockRejectedValue(new Error("MEM0_API_KEY not set"));

    const result = await searchMemoriesTool.execute(
      { query: "test" },
      mockContext
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("MEM0_API_KEY");
    }
  });
});
