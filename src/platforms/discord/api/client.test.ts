import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordApiClient, isDiscordOverflowError } from "./client.js";

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
        new Response(JSON.stringify({ id: "u-self", username: "theo" }), {
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
      username: "theo",
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
});
