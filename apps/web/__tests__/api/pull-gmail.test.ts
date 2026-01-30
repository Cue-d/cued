/* eslint-disable import-x/order */
import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
// Hoist mock functions - must be declared before vi.mock() calls
const mockListRecords = vi.hoisted(() => vi.fn());
const mockGetConnection = vi.hoisted(() => vi.fn());
const mockConvexMutation = vi.hoisted(() => vi.fn());
const mockConvexQuery = vi.hoisted(() => vi.fn());

// Mock environment variables before importing route
vi.mock("@cued/env/server", () => ({
  env: {
    NEXT_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
    NANGO_SECRET_KEY: "test-nango-key",
    AI_GATEWAY_API_KEY: "test-ai-gateway-key",
  },
}));

vi.mock("@nangohq/node", () => ({
  Nango: vi.fn().mockImplementation(() => ({
    listRecords: mockListRecords,
    getConnection: mockGetConnection,
  })),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    mutation: mockConvexMutation,
    query: mockConvexQuery,
  })),
}));

vi.mock("@cued/convex", () => ({
  api: {
    sync: {
      syncGmailMessages: "sync:syncGmailMessages",
      getGmailCursor: "sync:getGmailCursor",
    },
  },
}));

import { POST } from "../../app/api/nango/pull-gmail/route";

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/nango/pull-gmail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/nango/pull-gmail", () => {
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
    mockGetConnection.mockResolvedValue({
      credentials: { raw: { email: "test@example.com" } },
    });
    mockConvexQuery.mockResolvedValue(null); // No existing cursor
    mockListRecords.mockResolvedValue({ records: [] });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.count).toBe(0);
    expect(data.message).toBe("No new records to sync");
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("syncs Gmail emails successfully with full sync (no existing cursor)", async () => {
    const mockEmails = [
      {
        id: "email_1",
        sender: "sender@example.com",
        recipients: "recipient@example.com",
        date: "2024-01-15T10:00:00Z",
        subject: "Test Email",
        body: "Hello, this is a test.",
        attachments: [],
        threadId: "thread_1",
        _nango_metadata: { cursor: "abc123" },
      },
      {
        id: "email_2",
        sender: "another@example.com",
        date: "2024-01-15T11:00:00Z",
        subject: "Another Email",
        attachments: [{ filename: "doc.pdf", mimeType: "application/pdf", size: 1024, attachmentId: "att_1" }],
        threadId: "thread_2",
        _nango_metadata: { cursor: "def456" },
      },
    ];

    mockGetConnection.mockResolvedValue({
      credentials: { raw: { email: "test@example.com" } },
    });
    mockConvexQuery.mockResolvedValue(null); // No existing cursor = full sync
    mockListRecords.mockResolvedValue({ records: mockEmails });
    mockConvexMutation.mockResolvedValue({
      messagesCount: 2,
      conversationsCount: 2,
      skippedFiltered: 0,
    });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.recordsProcessed).toBe(2);
    expect(data.accountEmail).toBe("test@example.com");
    expect(data.syncMode).toBe("full");

    // Verify Nango getConnection was called
    expect(mockGetConnection).toHaveBeenCalledWith("google", "conn_123");

    // Verify Convex query was called to check for existing cursor
    expect(mockConvexQuery).toHaveBeenCalledWith("sync:getGmailCursor", {
      accountEmail: "test@example.com",
      workosUserId: "user_abc",
    });

    // Verify Nango listRecords was called WITHOUT cursor (full sync)
    expect(mockListRecords).toHaveBeenCalledWith({
      providerConfigKey: "google",
      connectionId: "conn_123",
      model: "GmailEmail",
    });

    // Verify Convex mutation was called with cleaned records, accountEmail, nangoCursor, and syncMode
    expect(mockConvexMutation).toHaveBeenCalledWith("sync:syncGmailMessages", {
      workosUserId: "user_abc",
      emails: [
        {
          id: "email_1",
          sender: "sender@example.com",
          recipients: "recipient@example.com",
          date: "2024-01-15T10:00:00Z",
          subject: "Test Email",
          body: "Hello, this is a test.",
          attachments: [],
          threadId: "thread_1",
        },
        {
          id: "email_2",
          sender: "another@example.com",
          date: "2024-01-15T11:00:00Z",
          subject: "Another Email",
          attachments: [{ filename: "doc.pdf", mimeType: "application/pdf", size: 1024, attachmentId: "att_1" }],
          threadId: "thread_2",
        },
      ],
      accountEmail: "test@example.com",
      nangoCursor: "def456", // Cursor from last record
      syncMode: "full",
    });
  });

  it("syncs Gmail emails with incremental sync (has existing cursor)", async () => {
    const mockEmails = [
      {
        id: "email_3",
        sender: "new@example.com",
        date: "2024-01-16T10:00:00Z",
        subject: "New Email",
        attachments: [],
        threadId: "thread_3",
        _nango_metadata: { cursor: "ghi789" },
      },
    ];

    mockGetConnection.mockResolvedValue({
      credentials: { raw: { email: "test@example.com" } },
    });
    mockConvexQuery.mockResolvedValue({
      cursorData: { nangoCursor: "existing_cursor" },
      lastSyncAt: 1234567890,
      syncMode: "incremental",
    });
    mockListRecords.mockResolvedValue({ records: mockEmails });
    mockConvexMutation.mockResolvedValue({
      messagesCount: 1,
      conversationsCount: 1,
      skippedFiltered: 0,
    });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.syncMode).toBe("incremental");

    // Verify Nango listRecords was called WITH cursor (incremental sync)
    expect(mockListRecords).toHaveBeenCalledWith({
      providerConfigKey: "google",
      connectionId: "conn_123",
      model: "GmailEmail",
      cursor: "existing_cursor",
    });

    // Verify Convex mutation was called with incremental syncMode
    expect(mockConvexMutation).toHaveBeenCalledWith("sync:syncGmailMessages", {
      workosUserId: "user_abc",
      emails: [
        {
          id: "email_3",
          sender: "new@example.com",
          date: "2024-01-16T10:00:00Z",
          subject: "New Email",
          attachments: [],
          threadId: "thread_3",
        },
      ],
      accountEmail: "test@example.com",
      nangoCursor: "ghi789",
      syncMode: "incremental",
    });
  });

  it("returns 500 on Nango getConnection error", async () => {
    mockGetConnection.mockRejectedValue(new Error("Nango API error"));

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Nango API error");
  });

  it("returns 500 on Convex mutation error", async () => {
    mockGetConnection.mockResolvedValue({
      credentials: { raw: { email: "test@example.com" } },
    });
    mockConvexQuery.mockResolvedValue(null);
    mockListRecords.mockResolvedValue({
      records: [{ id: "email_1", sender: "a@b.com", date: "2024-01-15", subject: "Test", attachments: [], threadId: "t1", _nango_metadata: { cursor: "abc" } }],
    });
    mockConvexMutation.mockRejectedValue(new Error("Convex mutation failed"));

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Convex mutation failed");
  });

  it("handles missing accountEmail gracefully", async () => {
    mockGetConnection.mockResolvedValue({
      credentials: { raw: {} }, // No email in credentials
    });
    mockListRecords.mockResolvedValue({
      records: [{ id: "email_1", sender: "a@b.com", date: "2024-01-15", subject: "Test", attachments: [], threadId: "t1", _nango_metadata: { cursor: "abc" } }],
    });
    mockConvexMutation.mockResolvedValue({
      messagesCount: 1,
      conversationsCount: 1,
      skippedFiltered: 0,
    });

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.accountEmail).toBeUndefined();

    // Should NOT have queried for cursor since no accountEmail
    expect(mockConvexQuery).not.toHaveBeenCalled();

    // Mutation should be called without accountEmail
    expect(mockConvexMutation).toHaveBeenCalledWith("sync:syncGmailMessages", {
      workosUserId: "user_abc",
      emails: [{ id: "email_1", sender: "a@b.com", date: "2024-01-15", subject: "Test", attachments: [], threadId: "t1" }],
      accountEmail: undefined,
      nangoCursor: "abc",
      syncMode: "full",
    });
  });
});
