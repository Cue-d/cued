import { describe, expect, it } from "vitest";
import { isSlackApiTokenRequest, SlackRequestTokenCapture } from "./request-capture.js";

const token = "xoxc-test-observed-token";
const base = {
  url: "https://app.slack.com/api/client.boot",
  method: "POST",
  contentType: "application/x-www-form-urlencoded",
  body: `token=${token}`,
};
describe("passive Slack API token capture", () => {
  it("captures GET and form POST only in memory", async () => {
    const capture = new SlackRequestTokenCapture();
    await capture.observe({
      ...base,
      url: `https://slack.com/api/auth.test?token=${token}`,
      method: "GET",
      body: null,
    });
    await capture.observe(base);
    expect(capture.candidates()).toEqual([token]);
    capture.stop();
    expect(capture.candidates()).toEqual([]);
  });
  it.each([
    "client.userBoot",
    "client.init",
  ])("parses multipart enterprise API token from %s", async (method) => {
    const capture = new SlackRequestTokenCapture();
    await capture.observe({
      ...base,
      url: `https://harvard.enterprise.slack.com/api/${method}`,
      contentType: "multipart/form-data; boundary=cued-test-boundary-long",
      body: `--cued-test-boundary-long\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n--cued-test-boundary-long--\r\n`,
    });
    expect(capture.candidates()).toEqual([token]);
  });
  it.each([
    "http://slack.com/api/auth.test",
    "https://slack.com.evil.test/api/auth.test",
    "https://notslack.com/api/auth.test",
    "https://slack.com/signin",
  ])("ignores non API/official HTTPS URL %s", async (url) => {
    const capture = new SlackRequestTokenCapture();
    await capture.observe({ ...base, url });
    expect(capture.candidates()).toEqual([]);
  });
  it("guards before a caller reads any request body", () => {
    expect(
      isSlackApiTokenRequest("https://login.harvard.edu/api/login", "POST", base.contentType),
    ).toBe(false);
    expect(isSlackApiTokenRequest("https://slack.com/signin", "POST", base.contentType)).toBe(
      false,
    );
    expect(isSlackApiTokenRequest(base.url, "POST", base.contentType, "65537")).toBe(false);
    expect(isSlackApiTokenRequest(base.url, "POST", "application/json")).toBe(false);
    expect(
      isSlackApiTokenRequest("https://slack.com/api/auth.signin", "POST", base.contentType),
    ).toBe(false);
    expect(isSlackApiTokenRequest(base.url, "POST", base.contentType, "25")).toBe(true);
  });
  it("cannot repopulate tokens after stopping while multipart parsing is pending", async () => {
    const capture = new SlackRequestTokenCapture();
    const pending = capture.observe({
      ...base,
      contentType: "multipart/form-data; boundary=cued-test-boundary-long",
      body: `--cued-test-boundary-long\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n--cued-test-boundary-long--\r\n`,
    });
    capture.stop();
    await pending;
    await capture.observe(base);
    expect(capture.candidates()).toEqual([]);
  });
  it("bounds body size and retains only five newest unique candidates", async () => {
    const capture = new SlackRequestTokenCapture();
    await capture.observe({ ...base, body: "x".repeat(65_537) });
    for (let i = 0; i < 8; i++) await capture.observe({ ...base, body: `token=${token}-${i}` });
    expect(capture.candidates()).toEqual([7, 6, 5, 4, 3].map((i) => `${token}-${i}`));
  });
});
