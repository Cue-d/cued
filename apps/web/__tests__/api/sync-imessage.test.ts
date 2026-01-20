/* eslint-disable import-x/order */
import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
// Hoist mock functions so they're available when vi.mock is executed
const mockConvexQuery = vi.hoisted(() => vi.fn());
const mockConvexMutation = vi.hoisted(() => vi.fn());
const mockSetAuth = vi.hoisted(() => vi.fn());

// Mock environment variables before importing route
vi.mock("@prm/env/server", () => ({
  env: {
    NEXT_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
    NANGO_SECRET_KEY: "test-nango-key",
    OPENAI_API_KEY: "test-openai-key",
  },
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    query: mockConvexQuery,
    mutation: mockConvexMutation,
    setAuth: mockSetAuth,
  })),
}));

vi.mock("@prm/convex", () => ({
  api: {
    sync: {
      getSyncCursor: "sync:getSyncCursor",
      syncMessages: "sync:syncMessages",
      updateSyncCursor: "sync:updateSyncCursor",
    },
  },
}));

// Import after mocks are set up
import { GET, POST } from "../../app/api/sync/imessage/route";

function createRequest(method: string, body?: unknown, authToken?: string): NextRequest {
  const headers = new Headers();
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  headers.set("Content-Type", "application/json");

  const request = new NextRequest("http://localhost:3000/api/sync/imessage", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return request;
}

describe("GET /api/sync/imessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const request = createRequest("GET");
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Missing or invalid Authorization header");
  });

  it("returns 401 when Authorization header is invalid format", async () => {
    const headers = new Headers();
    headers.set("Authorization", "InvalidFormat token123");
    const request = new NextRequest("http://localhost:3000/api/sync/imessage", {
      method: "GET",
      headers,
    });

    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns cursor when authenticated", async () => {
    mockConvexQuery.mockResolvedValue({ cursor: "12345", lastSyncAt: Date.now() });

    const request = createRequest("GET", undefined, "valid-token");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockSetAuth).toHaveBeenCalledWith("valid-token");
    const data = await response.json();
    expect(data.cursor).toBe("12345");
  });

  it("returns 401 when Convex returns null (auth failed)", async () => {
    mockConvexQuery.mockResolvedValue(null);

    const request = createRequest("GET", undefined, "invalid-token");
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Authentication failed");
  });

  it("returns 500 on Convex query error", async () => {
    mockConvexQuery.mockRejectedValue(new Error("Database error"));

    const request = createRequest("GET", undefined, "valid-token");
    const response = await GET(request);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Failed to fetch cursor");
  });
});

describe("POST /api/sync/imessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const request = createRequest("POST", { cursor: 0, chats: [], messages: [] });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 400 when cursor is missing", async () => {
    const request = createRequest("POST", { chats: [], messages: [] }, "valid-token");
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing or invalid cursor field");
  });

  it("returns 400 when chats/messages are invalid", async () => {
    const request = createRequest("POST", { cursor: 0, chats: "invalid", messages: [] }, "valid-token");
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing or invalid chats/messages arrays");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const headers = new Headers();
    headers.set("Authorization", "Bearer valid-token");
    headers.set("Content-Type", "application/json");

    const request = new NextRequest("http://localhost:3000/api/sync/imessage", {
      method: "POST",
      headers,
      body: "invalid json{",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid JSON body");
  });

  it("syncs messages successfully", async () => {
    const syncResult = {
      cursor: 100,
      messagesCount: 5,
      conversationsCount: 2,
    };
    mockConvexMutation.mockResolvedValue(syncResult);

    const batch = {
      cursor: 50,
      chats: [
        { id: "chat1", participants: ["+15551234567"], lastMessageDate: Date.now() },
      ],
      messages: [
        {
          id: "msg1",
          chatId: "chat1",
          text: "Hello",
          timestamp: Date.now(),
          isFromMe: false,
          isRead: true,
          hasAttachments: false,
          sender: "+15551234567",
        },
      ],
    };

    const request = createRequest("POST", batch, "valid-token");
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockSetAuth).toHaveBeenCalledWith("valid-token");
    expect(mockConvexMutation).toHaveBeenCalledTimes(2); // syncMessages + updateSyncCursor

    const data = await response.json();
    expect(data.cursor).toBe(100);
  });

  it("strips attachment data from messages before sending to Convex", async () => {
    mockConvexMutation.mockResolvedValue({ cursor: 100 });

    const batch = {
      cursor: 50,
      chats: [],
      messages: [
        {
          id: "msg1",
          chatId: "chat1",
          text: "With attachment",
          timestamp: Date.now(),
          isFromMe: false,
          isRead: true,
          hasAttachments: true,
          sender: "+15551234567",
          attachments: [{ path: "/local/path.jpg", mimeType: "image/jpeg" }],
        },
      ],
    };

    const request = createRequest("POST", batch, "valid-token");
    await POST(request);

    // Check that the mutation was called without attachments field
    const mutationCall = mockConvexMutation.mock.calls[0];
    const syncedMessages = mutationCall[1].batch.messages;
    expect(syncedMessages[0]).not.toHaveProperty("attachments");
    expect(syncedMessages[0].hasAttachments).toBe(true);
  });

  it("returns 500 on Convex mutation error", async () => {
    mockConvexMutation.mockRejectedValue(new Error("Mutation failed"));

    const batch = {
      cursor: 50,
      chats: [],
      messages: [],
    };

    const request = createRequest("POST", batch, "valid-token");
    const response = await POST(request);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Sync failed");
  });
});
