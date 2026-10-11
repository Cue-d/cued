import { describe, expect, it, vi } from "vitest";
import { verifySlackSession } from "./verify-session.js";

const cookies = ["stale-cookie", "valid-cookie"].map((value) => ({
  name: "d",
  domain: ".slack.com",
  value,
}));
const success = { ok: true, team_id: "TTARGET", user_id: "U1", team: "Target" };
describe("Slack credential verification", () => {
  it("only returns the cookie that the provider accepts for the intended workspace", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "invalid_auth" }))
      .mockResolvedValueOnce(Response.json(success));
    await expect(verifySlackSession("xoxc-secret", "TTARGET", cookies, request)).resolves.toEqual({
      cookie: "valid-cookie",
      teamId: "TTARGET",
      userId: "U1",
      teamName: "Target",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1].body.get("team_id")).toBe("TTARGET");
  });
  it("never returns credentials from a different enterprise or workspace", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ...success, team_id: "EOTHER" }));
    expect(
      await verifySlackSession("xoxc-secret", "TTARGET", cookies.slice(0, 1), request),
    ).toBeNull();
  });
  it("returns no session when every credential pair is rejected", async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json({ ok: false, error: "invalid_auth" }));
    expect(await verifySlackSession("xoxc-secret", "TTARGET", cookies, request)).toBeNull();
  });
  it("does not expose tokens or cookies in network errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("xoxc-secret stale-cookie"));
    await expect(verifySlackSession("xoxc-secret", "TTARGET", cookies, request)).rejects.toThrow(
      "Slack credential verification request failed; retry connecting",
    );
  });
  it("stops on rate limiting without trying more cookies or marking a session valid", async () => {
    const request = vi.fn().mockResolvedValue(new Response("secret payload", { status: 429 }));
    await expect(verifySlackSession("xoxc-secret", "TTARGET", cookies, request)).rejects.toThrow(
      "HTTP 429",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("deduplicates cookies, rejects unrelated domains and bounds probes", async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json({ ok: false, error: "invalid_auth" }));
    await verifySlackSession(
      "xoxc-secret",
      "TTARGET",
      [
        { name: "d", domain: "notslack.com", value: "wrong-domain" },
        ...cookies,
        ...cookies,
        ...Array.from({ length: 10 }, (_, i) => ({
          name: "d",
          domain: ".slack.com",
          value: String(i),
        })),
      ],
      request,
    );
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[0]?.[1].headers.cookie).toBe("d=stale-cookie");
  });
});
