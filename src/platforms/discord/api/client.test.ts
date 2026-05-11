import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordApiClient,
  DiscordApiError,
  type DiscordRateLimitError,
  isDiscordAuthInvalidationError,
  isDiscordOverflowError,
} from "./client.js";

describe("DiscordApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries overflow responses with backoff", async () => {
    vi.useFakeTimers();

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          "upstream connect error or disconnect/reset before headers. reset reason: overflow",
          {
            status: 503,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "u-self", username: "avery" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = new DiscordApiClient({ token: "discord-token" }, { fetchImpl });
    const promise = client.getCurrentUser();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toEqual({
      id: "u-self",
      username: "avery",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("detects overflow errors from Discord API responses", () => {
    expect(
      isDiscordOverflowError(
        new Error(
          "Discord API GET /users/@me failed (503): upstream connect error or disconnect/reset before headers. reset reason: overflow",
        ),
      ),
    ).toBe(true);
  });

  it("preserves retry-after metadata when rate limits keep failing", async () => {
    vi.useFakeTimers();

    const rateLimitResponse = () =>
      new Response(JSON.stringify({ retry_after: 1.25 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimitResponse())
      .mockResolvedValueOnce(rateLimitResponse());

    const client = new DiscordApiClient({ token: "discord-token" }, { fetchImpl });
    const promise = client.getCurrentUser();
    const handled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_250);
    await expect(handled).resolves.toMatchObject({
      name: "DiscordRateLimitError",
      retryAfterMs: 1_250,
    } satisfies Partial<DiscordRateLimitError>);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not treat generic 403 permission errors as auth invalidation", () => {
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError("GET", "/channels/dm-1/messages", 403, '{"message":"Missing Access"}'),
      ),
    ).toBe(false);
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError(
          "GET",
          "/channels/dm-1/messages",
          403,
          '{"message":"Unauthorized to access this channel"}',
        ),
      ),
    ).toBe(false);
  });

  it("treats account-level 403 responses as auth invalidation", () => {
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError(
          "GET",
          "/users/@me",
          403,
          '{"message":"Your account has limited access due to suspicious activity"}',
        ),
      ),
    ).toBe(true);
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError(
          "GET",
          "/users/@me",
          403,
          '{"message":"Your account has been disabled"}',
        ),
      ),
    ).toBe(true);
  });

  it("does not treat transient 5xx responses as auth invalidation even if the body contains auth-like keywords", () => {
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError(
          "GET",
          "/users/@me",
          503,
          '{"message":"Service temporarily disabled for maintenance"}',
        ),
      ),
    ).toBe(false);
    expect(
      isDiscordAuthInvalidationError(new Error("Service temporarily disabled for maintenance")),
    ).toBe(false);
    expect(isDiscordAuthInvalidationError(new Error("connect ECONNREFUSED 127.0.0.1:4010"))).toBe(
      false,
    );
  });

  it("does not treat structured rate-limit responses as auth invalidation", () => {
    expect(
      isDiscordAuthInvalidationError(
        new DiscordApiError(
          "GET",
          "/users/@me",
          429,
          '{"message":"You are being rate limited after unauthorized-looking traffic"}',
        ),
      ),
    ).toBe(false);
  });

  it("detects specific fallback auth invalidation messages", () => {
    expect(
      isDiscordAuthInvalidationError(new Error("Discord auth verification failed (401)")),
    ).toBe(true);
    expect(isDiscordAuthInvalidationError(new Error("Your account has been disabled"))).toBe(true);
    expect(isDiscordAuthInvalidationError(new Error("Please reset your password"))).toBe(true);
  });
});
