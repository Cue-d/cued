import { describe, expect, it } from "vitest";
import { selectSlackWorkspaceCredentials as select } from "./workspace-selection.js";

const config = JSON.stringify({
  teams: {
    TOTHER: { token: "xoxc-other", name: "Other", user_id: "U1" },
    TTARGET: { token: "xoxc-target", name: "Target", user_id: "U2" },
  },
});

describe("Slack browser workspace selection", () => {
  it("reconnects the requested workspace regardless of entry order or visible enterprise route", () => {
    expect(select(config, "TTARGET", "https://app.slack.com/client/E123/C123")).toMatchObject({
      teamId: "TTARGET",
      token: "xoxc-target",
    });
  });
  it("allows one enterprise token candidate only under the requested workspace identity", () => {
    const enterprise = JSON.stringify({ teams: { EORG: { token: "xoxc-enterprise" } } });
    expect(select(enterprise, "TTARGET", "https://app.slack.com/client/EORG/C123")).toMatchObject({
      teamId: "TTARGET",
      token: "xoxc-enterprise",
    });
    expect(
      select(
        JSON.stringify({ teams: { EONE: { token: "xoxc-one" }, ETWO: { token: "xoxc-two" } } }),
        "TTARGET",
        "https://app.slack.com/client/EORG",
      ),
    ).toBeNull();
  });
  it("waits when requested credentials are unavailable rather than completing another account", () => {
    expect(select(config, "TMISSING", "https://app.slack.com/client/TOTHER")).toBeNull();
    expect(
      select(
        JSON.stringify({ teams: { TTARGET: {}, TOTHER: { token: "xoxc-other" } } }),
        "TTARGET",
        "https://app.slack.com/client/TTARGET",
      ),
    ).toBeNull();
  });
  it.each(["default", "pending-slack-123"])("discovers the visible workspace for %s", (key) => {
    expect(select(config, key, "https://app.slack.com/client/TTARGET/C123")?.teamId).toBe(
      "TTARGET",
    );
    expect(select(config, key, "https://app.slack.com/client/E123/C123")).toBeNull();
    expect(select(config, key, "https://app.slack.com/client/TMISSING/C123")).toBeNull();
  });
  it("allows unambiguous discovery without assuming enterprise token structure", () => {
    expect(
      select(
        JSON.stringify({ teams: { TTARGET: { token: "xoxc-target" } } }),
        "default",
        "https://app.slack.com/client/E123/C123",
      )?.teamId,
    ).toBe("TTARGET");
  });
  it.each([
    "null",
    "[]",
    "{",
    '{"teams":[{}]}',
    '{"teams":{"TTARGET":null}}',
    '{"teams":{"TTARGET":{"token":42}}}',
  ])("ignores malformed config %s", (raw) => {
    expect(select(raw, "TTARGET", "https://app.slack.com/client/TTARGET")).toBeNull();
  });
});
