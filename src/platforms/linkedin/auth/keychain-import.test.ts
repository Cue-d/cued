import { afterEach, describe, expect, it, vi } from "vitest";

const loadKeychainSecretMock = vi.hoisted(() => vi.fn());

vi.mock("../../core/secrets/keychain.js", () => ({
  authKeychainService: (platform: string) => `so.cued.desktop.auth.${platform}`,
  legacyAuthKeychainService: (platform: string) => `so.cued.auth.${platform}`,
  loadKeychainSecret: loadKeychainSecretMock,
  storeKeychainSecret: vi.fn(),
}));

import { validateLinkedInStoredAuth } from "./keychain-import.js";

const storedSession = {
  cookies: [
    { name: "li_at", value: "token", domain: ".linkedin.com", path: "/" },
    { name: "JSESSIONID", value: '"ajax:123"', domain: ".linkedin.com", path: "/" },
  ],
  userAgent: "Cued LinkedIn Test/1.0",
  pageInstance: "urn:li:page:messaging_thread;test",
  xLiTrack: '{"clientVersion":"1.0.0"}',
  realtimeQueryMap: "{}",
  realtimeRecipeMap: "{}",
};

describe("LinkedIn stored auth validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.CUED_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS;
  });

  it("returns valid for a successful authenticated request", async () => {
    loadKeychainSecretMock.mockReturnValue(storedSession);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await expect(validateLinkedInStoredAuth("default")).resolves.toEqual({ status: "valid" });
  });

  it("returns invalid only for an explicit LinkedIn auth failure", async () => {
    loadKeychainSecretMock.mockReturnValue(storedSession);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://www.linkedin.com/login" },
          }),
      ),
    );

    await expect(validateLinkedInStoredAuth("default")).resolves.toEqual({
      status: "invalid",
    });
  });

  it("rejects sessions that cannot start realtime before probing LinkedIn", async () => {
    loadKeychainSecretMock.mockReturnValue({
      ...storedSession,
      realtimeQueryMap: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateLinkedInStoredAuth("default")).resolves.toEqual({
      status: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns indeterminate for transient network failures", async () => {
    loadKeychainSecretMock.mockReturnValue(storedSession);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network unavailable"))),
    );

    await expect(validateLinkedInStoredAuth("default")).resolves.toEqual({
      status: "indeterminate",
      errorSummary: "network unavailable",
    });
  });

  it("bounds validation timeouts without invalidating the session", async () => {
    process.env.CUED_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS = "10";
    loadKeychainSecretMock.mockReturnValue(storedSession);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );

    await expect(validateLinkedInStoredAuth("default")).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("does not retry rate limits or server failures during the bounded probe", async () => {
    process.env.CUED_LINKEDIN_AUTH_VALIDATION_TIMEOUT_MS = "10";
    loadKeychainSecretMock.mockReturnValue(storedSession);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateLinkedInStoredAuth("default")).resolves.toMatchObject({
      status: "indeterminate",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
