/* eslint-disable import-x/order */
import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
// Hoist mock functions - must be declared before vi.mock() calls
const mockConvexMutation = vi.hoisted(() => vi.fn());

// Mock environment variables before importing route
vi.mock("@prm/env/server", () => ({
  env: {
    NEXT_PUBLIC_CONVEX_URL: "https://test.convex.cloud",
    NANGO_SECRET_KEY: "test-nango-key",
    AI_GATEWAY_API_KEY: "test-ai-gateway-key",
  },
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    mutation: mockConvexMutation,
  })),
}));

vi.mock("@prm/convex", () => ({
  api: {
    integrations: {
      connectNango: "integrations:connectNango",
      disconnectNango: "integrations:disconnectNango",
    },
  },
}));

// Mock fetch for internal API calls
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", mockFetch);

import { POST } from "../../app/api/nango/webhook/route";

function createRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/nango/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/nango/webhook - Auth Events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles connection creation successfully", async () => {
    mockConvexMutation.mockResolvedValue({ success: true });

    const payload = {
      type: "auth",
      operation: "creation",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: {
        endUserId: "user_abc",
        endUserEmail: "test@example.com",
      },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(true);
    expect(mockConvexMutation).toHaveBeenCalledWith("integrations:connectNango", {
      workosUserId: "user_abc",
      nangoIntegrationId: "google",
      nangoConnectionId: "conn_123",
      email: "test@example.com",
    });
  });

  it("handles connection deletion", async () => {
    mockConvexMutation.mockResolvedValue({ success: true });

    const payload = {
      type: "auth",
      operation: "deletion",
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(true);
    expect(mockConvexMutation).toHaveBeenCalledWith("integrations:disconnectNango", {
      workosUserId: "user_abc",
      nangoConnectionId: "conn_123",
    });
  });

  it("returns 400 when required fields are missing", async () => {
    const payload = {
      type: "auth",
      operation: "creation",
      success: true,
      connectionId: "conn_123",
      // Missing providerConfigKey and endUser
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Missing required fields");
  });

  it("acknowledges but does not process refresh events", async () => {
    const payload = {
      type: "auth",
      operation: "refresh",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.received).toBe(true);
    expect(data.processed).toBe(false);
    expect(mockConvexMutation).not.toHaveBeenCalled();
  });

  it("handles null email in connection creation", async () => {
    mockConvexMutation.mockResolvedValue({ success: true });

    const payload = {
      type: "auth",
      operation: "creation",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: {
        endUserId: "user_abc",
        endUserEmail: null,
      },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    expect(mockConvexMutation).toHaveBeenCalledWith("integrations:connectNango", {
      workosUserId: "user_abc",
      nangoIntegrationId: "google",
      nangoConnectionId: "conn_123",
      email: undefined,
    });
  });
});

describe("POST /api/nango/webhook - Sync Events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("triggers Gmail and Google Contacts pull on successful Google sync", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: { messagesCount: 5 } }),
    });

    const payload = {
      type: "sync",
      operation: "success",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(true);

    // Should call both pull-gmail and pull-google-contacts
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/nango/pull-gmail"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          connectionId: "conn_123",
          workosUserId: "user_abc",
        }),
      })
    );
  });

  it("does not process unsuccessful syncs", async () => {
    const payload = {
      type: "sync",
      operation: "success",
      success: false,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(false);
    expect(data.reason).toBe("Sync not successful");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns errors for unknown integrations", async () => {
    const payload = {
      type: "sync",
      operation: "success",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "unknown-provider",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(false);
    expect(data.reason).toBe("Unknown integration");
  });

  it("handles pull endpoint failures gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Pull failed" }),
    });

    const payload = {
      type: "sync",
      operation: "success",
      success: true,
      connectionId: "conn_123",
      providerConfigKey: "google",
      endUser: { endUserId: "user_abc" },
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.processed).toBe(false);
    expect(data.errors).toBeDefined();
  });

  it("returns 400 when required fields are missing", async () => {
    const payload = {
      type: "sync",
      operation: "success",
      success: true,
      // Missing connectionId, providerConfigKey, endUser
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(400);
  });
});

describe("POST /api/nango/webhook - Unknown Types", () => {
  it("acknowledges unknown webhook types without processing", async () => {
    const payload = {
      type: "unknown",
      operation: "something",
    };

    const response = await POST(createRequest(payload));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.received).toBe(true);
    expect(data.processed).toBe(false);
    expect(data.reason).toBe("Unknown type");
  });
});
