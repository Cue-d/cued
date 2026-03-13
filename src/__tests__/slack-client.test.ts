import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "../adapters/slack/api/client.js";

describe("slack client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not ask Slack to exclude archived conversations", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SlackClient({ token: "xoxc-test", cookie: "cookie-test" });
    await client.listConversations(undefined, 200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const params = new URLSearchParams(String(init?.body ?? ""));
    expect(params.get("types")).toBe("im,mpim,private_channel,public_channel");
    expect(params.get("limit")).toBe("200");
    expect(params.has("exclude_archived")).toBe(false);
  });
});
