import { describe, expect, it, vi } from "vitest";
import { SlackHelperError } from "../helper/client.js";
import { SlackCaptureConfirmation } from "./capture-confirmation.js";
import { SlackVerificationState, verifySlackSession } from "./verify-session.js";

const session = { cookie: "secret-cookie", teamId: "T1", teamName: "One", userId: "U1" };
const helper = () => Promise.resolve({ ok: true, team_id: "T1", user_id: "U1" });
describe("Slack runtime capture confirmation", () => {
  it("requires actual-helper and fresh browser/provider proof before persistence", async () => {
    const recheck = vi.fn(async () => true);
    const confirm = new SlackCaptureConfirmation();
    expect(await confirm.confirm("token", session, recheck, helper)).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
  it("does not accept a helper-valid pair when fresh browser/provider proof fails", async () => {
    expect(
      await new SlackCaptureConfirmation().confirm("token", session, async () => false, helper),
    ).toBe(false);
  });
  it.each([
    true,
    false,
  ])("diagnoses helper rejection then Node proof=%s without secrets", async (accepted) => {
    const events: string[] = [];
    const reject = vi.fn();
    const confirm = new SlackCaptureConfirmation((event) => events.push(event));
    expect(
      await confirm.confirm(
        "token",
        session,
        async () => accepted,
        async () => {
          throw new SlackHelperError("secret-cookie token", { slackCode: "invalid_auth" });
        },
        reject,
      ),
    ).toBe(false);
    expect(events).toEqual([
      "helper_rejected",
      accepted ? "node_recheck_accepted" : "node_recheck_rejected",
    ]);
    expect(reject).toHaveBeenCalledTimes(1);
  });
  it("respects helper rate limits without permanently rejecting credentials", async () => {
    let now = 0;
    const reject = vi.fn();
    const confirm = new SlackCaptureConfirmation(
      () => {},
      () => now,
    );
    const recheck = vi.fn(async () => true);
    await confirm.confirm(
      "token",
      session,
      recheck,
      async () => {
        throw new SlackHelperError("rate", { retryAfterMs: 120000 });
      },
      reject,
    );
    now = 119999;
    expect(confirm.ready()).toBe(false);
    now++;
    expect(confirm.ready()).toBe(true);
    expect(reject).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });
  it("rejects helper identity mismatch", async () => {
    const reject = vi.fn();
    expect(
      await new SlackCaptureConfirmation().confirm(
        "token",
        session,
        async () => true,
        async () => ({ ok: true, team_id: "OTHER", user_id: "U1" }),
        reject,
      ),
    ).toBe(false);
    expect(reject).toHaveBeenCalledTimes(1);
  });
});

it("skips a helper-rejected first pair and allows a later captured token", async () => {
  let now = 0;
  const state = new SlackVerificationState(() => now);
  const confirmation = new SlackCaptureConfirmation(
    () => {},
    () => now,
  );
  const cookies = [{ name: "d", domain: ".slack.com", value: session.cookie }];
  const request = vi.fn(async () =>
    Response.json({ ok: true, team_id: "T1", user_id: "U1", team: "One" }),
  );
  const first = await verifySlackSession("bad-token", "T1", cookies, request, state);
  expect(first).not.toBeNull();
  await confirmation.confirm(
    "bad-token",
    first!,
    async () => true,
    async () => {
      throw new SlackHelperError("invalid", { slackCode: "invalid_auth" });
    },
    () => state.rejectPair("bad-token", session.cookie, "T1"),
  );
  now = 30000;
  expect(await verifySlackSession("bad-token", "T1", cookies, request, state)).toBeNull();
  const next = await verifySlackSession("good-token", "T1", cookies, request, state);
  expect(await confirmation.confirm("good-token", next!, async () => true, helper)).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
