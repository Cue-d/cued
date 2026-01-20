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
      syncGmailMessages: "sync:syncGmailMessages",
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

  it("syncs Gmail emails successfully", async () => {
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

    mockListRecords.mockResolvedValue({ records: mockEmails });
    mockConvexMutation.mockResolvedValue({
      messagesCount: 2,
      conversationsCount: 2,
      skippedNewsletters: 0,
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
      providerConfigKey: "google",
      connectionId: "conn_123",
      model: "GmailEmail",
    });

    // Verify Convex mutation was called with cleaned records (no _nango_metadata)
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
    });
  });

  it("returns 500 on Nango error", async () => {
    mockListRecords.mockRejectedValue(new Error("Nango API error"));

    const response = await POST(createRequest({
      connectionId: "conn_123",
      workosUserId: "user_abc",
    }));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Nango API error");
  });

  it("returns 500 on Convex mutation error", async () => {
    mockListRecords.mockResolvedValue({
      records: [{ id: "email_1", sender: "a@b.com", date: "2024-01-15", subject: "Test", attachments: [], threadId: "t1" }],
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
});
