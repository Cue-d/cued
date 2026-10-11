import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { GmailClient, GmailRefreshError, isGmailAuthInvalidationError } from "./client.js";

const credentials = {
  clientId: "client",
  clientSecret: "secret",
  tokenUri: "https://oauth2.googleapis.com/token",
  accessToken: "old",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3600_000,
  scope: "gmail",
  emailAddress: "test@example.com",
};
afterEach(() => vi.unstubAllGlobals());

describe("Gmail credential recovery", () => {
  it("refreshes rejected access tokens once before retrying the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ emailAddress: credentials.emailAddress }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GmailClient(credentials, "test").getProfile()).resolves.toMatchObject({
      emailAddress: credentials.emailAddress,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1].headers.authorization).toBe("Bearer new");
  });
  it("propagates revoked refresh credentials as an auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    const error = await new GmailClient({ ...credentials, expiresAt: 0 }, "test")
      .getProfile()
      .catch((error) => error);
    expect(isGmailAuthInvalidationError(error)).toBe(true);
  });
  it.each([
    [429, "invalid_grant"],
    [503, "temporarily_unavailable"],
    [400, "invalid_client"],
  ])("does not invalidate on %s %s", (status, code) => {
    expect(isGmailAuthInvalidationError(new GmailRefreshError(Number(status), String(code)))).toBe(
      false,
    );
  });
  it("does not loop when the refreshed access token is also rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new" }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GmailClient(credentials, "test").getProfile()).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
