import { describe, expect, it } from "vitest";
import type { AuthBrowserStatus } from "../platforms/core/auth/browser-resolver.js";
import { getAuthBrowserCheck } from "./doctor.js";

const fallback = { available: true, installed: false, version: "143.0.0.0", directory: "/x" };

function status(overrides: Partial<AuthBrowserStatus>): AuthBrowserStatus {
  return { selected: null, candidates: [], fallback, ...overrides };
}

describe("getAuthBrowserCheck", () => {
  it("names the browser sign-in windows will open in", () => {
    const chrome = {
      id: "google-chrome",
      name: "Google Chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      source: "installed" as const,
      version: "150.0.1.2",
    };
    expect(getAuthBrowserCheck(status({ selected: chrome, candidates: [chrome] }))).toMatchObject({
      name: "auth_browser",
      status: "ok",
      summary: "Sign-in windows open in Google Chrome 150.0.1.2",
    });
  });

  it("warns that Chromium will be downloaded when no browser is installed", () => {
    const check = getAuthBrowserCheck(status({}));
    expect(check.status).toBe("warning");
    expect(check.summary).toContain("download Chromium 143.0.0.0");
    expect(check.remediation).toContain("Install Google Chrome");
  });

  it("reports an error when there is no browser and no download fallback", () => {
    expect(
      getAuthBrowserCheck(status({ fallback: { ...fallback, available: false } })).status,
    ).toBe("error");
  });

  it("reports a configured browser path that does not exist", () => {
    const configured = {
      id: "configured",
      name: "Configured browser",
      executablePath: "/missing",
      source: "configured" as const,
      version: null,
    };
    expect(
      getAuthBrowserCheck(status({ selected: configured, candidates: [configured] }), () => false)
        .status,
    ).toBe("error");
  });
});
