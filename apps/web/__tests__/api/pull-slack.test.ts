/* eslint-disable import-x/order */
import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
// Hoist mock functions - must be declared before vi.mock() calls
const mockListRecords = vi.hoisted(() => vi.fn());
const mockConvexMutation = vi.hoisted(() => vi.fn());

// Mock environment variables before importing route
vi.mock("@prm/env/server", () => ({
  env: {
    NEXT_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
    NANGO_SECRET_KEY: "test-nango-key",
    OPENAI_API_KEY: "test-openai-key",
  },
}));

vi.mock("@nangohq/node", () => ({
  Nango: vi.fn().mockImplementation(() => ({
    listRecords: mockListRecords,
  })),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    mutation: mockConvexMutation,
  })),
}));

vi.mock("@prm/convex", () => ({
  api: {
    sync: {
      syncSlackMessages: "sync:syncSlackMessages",
    },
  },
}));

import { POST } from "../../app/api/nango/pull-slack/route";

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/nango/pull-slack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/nango/pull-slack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when connectionId is missing", async () => {
    const response = await POST(createRequest({ workosUserId: "user_123" }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing connectionId or workosUserId");
  });

  it("returns 400 when workosUserId is missing", async () => {
    const response = await POST(createRequest({ connectionId: "conn_123" }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing connectionId or workosUserId");
  });

  it("returns success with zero count when no records", async () => {
    mockListRecords.mockResolvedValue({ records: [] });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.count).toBe(0);
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("syncs Slack messages successfully", async () => {
    const mockMessages = [
      {
        id: "msg_1",
        channelId: "C123",
        channelType: "im",
        channelName: "John Doe",
        userId: "U123",
        userName: "John Doe",
        text: "Hello!",
        ts: "1705320000.000000",
        isThreadParent: false,
        isBot: false,
        sentAt: "2024-01-15T10:00:00Z",
        _nango_metadata: { cursor: "abc" },
      },
      {
        id: "msg_2",
        channelId: "C456",
        channelType: "channel",
        channelName: "general",
        userId: "U456",
        userName: "Jane Smith",
        text: "Hi everyone",
        ts: "1705320060.000000",
        threadTs: "1705320000.000000",
        isThreadParent: true,
        reactions: [{ name: "thumbsup", count: 2, users: ["U123", "U789"] }],
        isBot: false,
        sentAt: "2024-01-15T10:01:00Z",
        _nango_metadata: { cursor: "def" },
      },
    ];

    mockListRecords.mockResolvedValue({ records: mockMessages });
    mockConvexMutation.mockResolvedValue({
      messagesCount: 2,
      conversationsCount: 2,
    });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.recordsProcessed).toBe(2);

    // Verify Nango was called correctly
    expect(mockListRecords).toHaveBeenCalledWith({
      providerConfigKey: "slack",
      connectionId: "conn_123",
      model: "SlackSyncMessage",
    });

    // Verify Convex mutation was called with cleaned records
    expect(mockConvexMutation).toHaveBeenCalledWith("sync:syncSlackMessages", {
      workosUserId: "user_abc",
      messages: [
        {
          id: "msg_1",
          channelId: "C123",
          channelType: "im",
          channelName: "John Doe",
          userId: "U123",
          userName: "John Doe",
          text: "Hello!",
          ts: "1705320000.000000",
          isThreadParent: false,
          isBot: false,
          sentAt: "2024-01-15T10:00:00Z",
        },
        {
          id: "msg_2",
          channelId: "C456",
          channelType: "channel",
          channelName: "general",
          userId: "U456",
          userName: "Jane Smith",
          text: "Hi everyone",
          ts: "1705320060.000000",
          threadTs: "1705320000.000000",
          isThreadParent: true,
          reactions: [{ name: "thumbsup", count: 2, users: ["U123", "U789"] }],
          isBot: false,
          sentAt: "2024-01-15T10:01:00Z",
        },
      ],
    });
  });

  it("handles DM messages correctly", async () => {
    const mockDMs = [
      {
        id: "dm_1",
        channelId: "D123",
        channelType: "im",
        channelName: "Direct Message",
        text: "Private message",
        ts: "1705320000.000000",
        isThreadParent: false,
        isBot: false,
        sentAt: "2024-01-15T10:00:00Z",
      },
    ];

    mockListRecords.mockResolvedValue({ records: mockDMs });
    mockConvexMutation.mockResolvedValue({ messagesCount: 1, conversationsCount: 1 });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalled();
  });

  it("handles group DMs (mpim) correctly", async () => {
    const mockGroupDMs = [
      {
        id: "mpim_1",
        channelId: "G123",
        channelType: "mpim",
        channelName: "John, Jane, Bob",
        text: "Group discussion",
        ts: "1705320000.000000",
        isThreadParent: false,
        isBot: false,
        sentAt: "2024-01-15T10:00:00Z",
      },
    ];

    mockListRecords.mockResolvedValue({ records: mockGroupDMs });
    mockConvexMutation.mockResolvedValue({ messagesCount: 1, conversationsCount: 1 });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
  });

  it("passes bot messages to Convex for filtering", async () => {
    const mockMessages = [
      {
        id: "bot_msg",
        channelId: "C123",
        channelType: "channel",
        text: "Automated notification",
        ts: "1705320000.000000",
        isThreadParent: false,
        isBot: true,
        sentAt: "2024-01-15T10:00:00Z",
      },
    ];

    mockListRecords.mockResolvedValue({ records: mockMessages });
    mockConvexMutation.mockResolvedValue({ messagesCount: 0, conversationsCount: 0 });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    // Bot filtering happens in Convex mutation, we just pass all messages
    expect(mockConvexMutation).toHaveBeenCalled();
  });

  it("returns 500 on Nango error", async () => {
    mockListRecords.mockRejectedValue(new Error("Slack API rate limited"));

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Slack API rate limited");
  });

  it("returns 500 on Convex mutation error", async () => {
    mockListRecords.mockResolvedValue({
      records: [{ id: "msg_1", channelId: "C123", channelType: "im", text: "Test", ts: "123", isThreadParent: false, isBot: false, sentAt: "2024-01-15" }],
    });
    mockConvexMutation.mockRejectedValue(new Error("Convex sync failed"));

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Convex sync failed");
  });
});
