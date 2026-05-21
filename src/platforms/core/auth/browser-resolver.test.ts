import { describe, expect, it } from "vitest";
import {
  type BrowserCandidate,
  formatMissingChromiumAuthBrowserError,
  listInstalledChromiumAuthBrowsers,
  resolveChromiumAuthBrowser,
} from "./browser-resolver.js";

describe("resolveChromiumAuthBrowser", () => {
  const candidates: BrowserCandidate[] = [
    {
      name: "Missing",
      executablePath: "/definitely/not/installed",
      appBundleIdentifier: "missing.browser",
    },
    {
      name: "Shell",
      executablePath: "/bin/sh",
      appBundleIdentifier: "test.shell",
    },
  ];

  it("uses an explicit executable path override", () => {
    expect(
      resolveChromiumAuthBrowser(
        {
          CUED_CHROMIUM_EXECUTABLE_PATH: "/custom/browser",
          CUED_CHROMIUM_APP_BUNDLE_IDENTIFIER: "custom.browser",
        },
        candidates,
      ),
    ).toEqual({
      name: "Configured Chromium browser",
      executablePath: "/custom/browser",
      appBundleIdentifier: "custom.browser",
    });
  });

  it("falls back to the first installed candidate", () => {
    expect(resolveChromiumAuthBrowser({}, candidates)).toEqual(candidates[1]);
  });

  it("lists every installed fallback candidate in order", () => {
    const installedCandidates = [
      candidates[0]!,
      candidates[1]!,
      {
        name: "Also Shell",
        executablePath: "/bin/sh",
        appBundleIdentifier: "test.shell-alt",
      },
    ];

    expect(listInstalledChromiumAuthBrowsers({}, installedCandidates)).toEqual([
      candidates[1],
      installedCandidates[2],
    ]);
  });

  it("returns null when no candidate exists", () => {
    expect(resolveChromiumAuthBrowser({}, [candidates[0]!])).toBeNull();
    expect(formatMissingChromiumAuthBrowserError()).toContain("No supported browser");
  });
});
