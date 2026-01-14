import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchActionsTool } from "./search-actions.js";
import type { ToolExecutionOptions } from "../types";

describe("searchActionsTool", () => {
  const mockQuery = vi.fn();

  const mockContext: ToolExecutionOptions = {
    toolCallId: "test-call-id",
    context: {
      userId: "user-123",
      query: mockQuery,
      mutation: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(searchActionsTool.name).toBe("search_actions");
    expect(searchActionsTool.description).toContain("action queue");
  });

  it("returns actions when found", async () => {
    const mockActions = [
      {
        _id: "action-1",
        type: "follow_up",
        status: "pending",
        priority: 75,
        draftMessage: "Hey, checking in!",
        reason: "No reply in 3 days",
        createdAt: Date.now() - 86400000,
        completedAt: null,
        snoozedUntil: null,
        conversationId: "conv-1",
        contactId: "contact-1",
        contactName: "John Doe",
        platform: "imessage",
      },
    ];

    mockQuery.mockResolvedValue({ actions: mockActions });

    const result = await searchActionsTool.execute(
      { status: "pending" },
      mockContext
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].type).toBe("follow_up");
      expect(result.data[0].contactName).toBe("John Doe");
    }

    expect(mockQuery).toHaveBeenCalledWith("actions:searchActions", {
      status: "pending",
      type: undefined,
      contactId: undefined,
      conversationId: undefined,
      createdAfter: undefined,
      snoozedUntilBefore: undefined,
      limit: undefined,
    });
  });

  it("filters by type", async () => {
    mockQuery.mockResolvedValue({ actions: [] });

    await searchActionsTool.execute({ type: "respond" }, mockContext);

    expect(mockQuery).toHaveBeenCalledWith("actions:searchActions", {
      status: undefined,
      type: "respond",
      contactId: undefined,
      conversationId: undefined,
      createdAfter: undefined,
      snoozedUntilBefore: undefined,
      limit: undefined,
    });
  });

  it("filters by contactId", async () => {
    mockQuery.mockResolvedValue({ actions: [] });

    await searchActionsTool.execute({ contactId: "contact-456" }, mockContext);

    expect(mockQuery).toHaveBeenCalledWith("actions:searchActions", {
      status: undefined,
      type: undefined,
      contactId: "contact-456",
      conversationId: undefined,
      createdAfter: undefined,
      snoozedUntilBefore: undefined,
      limit: undefined,
    });
  });

  it("filters by date range", async () => {
    const createdAfter = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    mockQuery.mockResolvedValue({ actions: [] });

    await searchActionsTool.execute({ createdAfter }, mockContext);

    expect(mockQuery).toHaveBeenCalledWith("actions:searchActions", {
      status: undefined,
      type: undefined,
      contactId: undefined,
      conversationId: undefined,
      createdAfter,
      snoozedUntilBefore: undefined,
      limit: undefined,
    });
  });

  it("filters snoozed actions due before timestamp", async () => {
    const snoozedUntilBefore = Date.now();
    mockQuery.mockResolvedValue({ actions: [] });

    await searchActionsTool.execute(
      { status: "snoozed", snoozedUntilBefore },
      mockContext
    );

    expect(mockQuery).toHaveBeenCalledWith("actions:searchActions", {
      status: "snoozed",
      type: undefined,
      contactId: undefined,
      conversationId: undefined,
      createdAfter: undefined,
      snoozedUntilBefore,
      limit: undefined,
    });
  });

  it("handles query errors gracefully", async () => {
    mockQuery.mockRejectedValue(new Error("Database unavailable"));

    const result = await searchActionsTool.execute(
      { status: "pending" },
      mockContext
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Database unavailable");
    }
  });

  it("returns empty array when no actions found", async () => {
    mockQuery.mockResolvedValue({ actions: [] });

    const result = await searchActionsTool.execute({}, mockContext);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });
});
