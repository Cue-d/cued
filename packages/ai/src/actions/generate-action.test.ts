import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateAction, generateActionWithRetry } from "./generate-action";
import type { GenerateActionInput } from "./generate-action";

// Mock the AI SDK
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";

const mockGenerateObject = vi.mocked(generateObject);

describe("generateAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseInput: GenerateActionInput = {
    contact: {
      displayName: "John Doe",
      company: "Acme Corp",
      isKnownContact: true,
    },
    messages: [
      {
        content: "Hey, can you send me that report?",
        isFromMe: false,
        sentAt: Date.now() - 3600000,
        senderName: "John Doe",
      },
    ],
    platform: "imessage",
    hoursSinceLastMessage: 24,
  };

  it("returns no action for empty conversations", async () => {
    const result = await generateAction({
      ...baseInput,
      messages: [],
    });

    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toContain("Empty conversation");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("returns no action when user sent last message", async () => {
    const result = await generateAction({
      ...baseInput,
      messages: [
        {
          content: "I'll send it tomorrow",
          isFromMe: true,
          sentAt: Date.now(),
        },
      ],
    });

    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toContain("User sent the last message");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("calls LLM for valid conversation needing analysis", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        shouldCreateAction: true,
        type: "respond",
        priority: 70,
        reason: "Direct question asking for report",
        suggestedResponse: "Sure, I'll send it over shortly!",
      },
    } as never);

    const result = await generateAction(baseInput);

    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(result.shouldCreateAction).toBe(true);
    expect(result.type).toBe("respond");
    expect(result.priority).toBe(70);
    expect(result.suggestedResponse).toBeDefined();
  });

  it("passes correct context to LLM", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { shouldCreateAction: false },
    } as never);

    await generateAction(baseInput);

    const call = mockGenerateObject.mock.calls[0];
    const prompt = (call as unknown[])[0] as { prompt: string };

    expect(prompt.prompt).toContain("John Doe");
    expect(prompt.prompt).toContain("Acme Corp");
    expect(prompt.prompt).toContain("imessage");
    expect(prompt.prompt).toContain("can you send me that report");
  });

  it("includes recent actions in context when provided", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { shouldCreateAction: false },
    } as never);

    await generateAction({
      ...baseInput,
      recentActions: [
        { type: "respond", status: "discarded", createdAt: Date.now() - 86400000 },
        { type: "follow_up", status: "completed", createdAt: Date.now() - 172800000 },
      ],
    });

    const call = mockGenerateObject.mock.calls[0];
    const prompt = (call as unknown[])[0] as { prompt: string };

    expect(prompt.prompt).toContain("Recent Actions");
    expect(prompt.prompt).toContain("respond (discarded");
    expect(prompt.prompt).toContain("follow_up (completed");
  });

  it("omits recent actions section when none provided", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { shouldCreateAction: false },
    } as never);

    await generateAction(baseInput);

    const call = mockGenerateObject.mock.calls[0];
    const prompt = (call as unknown[])[0] as { prompt: string };

    expect(prompt.prompt).not.toContain("Recent Actions");
  });

  it("skips LLM when pending action exists", async () => {
    const result = await generateAction({
      ...baseInput,
      recentActions: [
        { type: "respond", status: "pending", createdAt: Date.now() - 3600000 },
      ],
    });

    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toContain("Pending action already exists");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("skips LLM when no new messages since last action", async () => {
    const messageTime = Date.now() - 7200000; // 2 hours ago
    const actionTime = Date.now() - 3600000; // 1 hour ago (after message)

    const result = await generateAction({
      ...baseInput,
      messages: [
        {
          content: "Hey, can you send me that report?",
          isFromMe: false,
          sentAt: messageTime,
          senderName: "John Doe",
        },
      ],
      recentActions: [
        { type: "respond", status: "discarded", createdAt: actionTime },
      ],
    });

    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toContain("No new messages since last action");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("calls LLM when there are new messages since last action", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { shouldCreateAction: true, type: "respond", priority: 50 },
    } as never);

    const actionTime = Date.now() - 7200000; // 2 hours ago
    const messageTime = Date.now() - 3600000; // 1 hour ago (after action)

    await generateAction({
      ...baseInput,
      messages: [
        {
          content: "Hey, can you send me that report?",
          isFromMe: false,
          sentAt: messageTime,
          senderName: "John Doe",
        },
      ],
      recentActions: [
        { type: "respond", status: "discarded", createdAt: actionTime },
      ],
    });

    expect(mockGenerateObject).toHaveBeenCalledOnce();
  });

  it("handles LLM returning no action needed", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        shouldCreateAction: false,
        reason: "Conversation ended naturally",
      },
    } as never);

    const result = await generateAction(baseInput);

    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toBe("Conversation ended naturally");
  });
});

describe("generateActionWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseInput: GenerateActionInput = {
    contact: {
      displayName: "Jane Smith",
      isKnownContact: false,
    },
    messages: [
      {
        content: "Are you available for a call tomorrow?",
        isFromMe: false,
        sentAt: Date.now() - 7200000,
      },
    ],
    platform: "slack",
    hoursSinceLastMessage: 2,
  };

  it("returns result on first success", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        shouldCreateAction: true,
        type: "respond",
        priority: 60,
      },
    } as never);

    const result = await generateActionWithRetry(baseInput);

    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(result.shouldCreateAction).toBe(true);
  });

  it("retries on failure and succeeds", async () => {
    mockGenerateObject
      .mockRejectedValueOnce(new Error("Rate limited"))
      .mockResolvedValueOnce({
        object: {
          shouldCreateAction: true,
          type: "follow_up",
        },
      } as never);

    const result = await generateActionWithRetry(baseInput, 1);

    expect(mockGenerateObject).toHaveBeenCalledTimes(2);
    expect(result.shouldCreateAction).toBe(true);
  });

  it("returns safe default after max retries", async () => {
    mockGenerateObject.mockRejectedValue(new Error("API Error"));

    const result = await generateActionWithRetry(baseInput, 1);

    expect(mockGenerateObject).toHaveBeenCalledTimes(2);
    expect(result.shouldCreateAction).toBe(false);
    expect(result.reason).toContain("LLM analysis failed");
  });

  it("skips LLM call for edge cases even with retry wrapper", async () => {
    const result = await generateActionWithRetry({
      ...baseInput,
      messages: [],
    });

    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(result.shouldCreateAction).toBe(false);
  });
});
