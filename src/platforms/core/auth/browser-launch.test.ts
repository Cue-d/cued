import { describe, expect, it, vi } from "vitest";
import { BrowserUnavailableError, launchFirstAvailableBrowser } from "./browser-launch.js";
import type { AuthBrowser } from "./browser-resolver.js";

function browser(id: string, source: AuthBrowser["source"] = "installed"): AuthBrowser {
  return { id, name: id, executablePath: `/browsers/${id}`, source, version: null };
}

describe("launchFirstAvailableBrowser", () => {
  it("falls through to the next browser when one fails to launch", async () => {
    const launch = vi.fn(async (candidate: AuthBrowser) => {
      if (candidate.id === "google-chrome") throw new Error("Browser closed\nlong log");
      return `context:${candidate.id}`;
    });
    const installManaged = vi.fn();

    const launched = await launchFirstAvailableBrowser({
      candidates: [browser("google-chrome"), browser("microsoft-edge"), browser("brave-browser")],
      launch,
      installManaged,
    });

    expect(launched.result).toBe("context:microsoft-edge");
    expect(launched.attempts).toEqual([{ browser: "google-chrome", error: "Browser closed" }]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(installManaged).not.toHaveBeenCalled();
  });

  it("downloads Chromium only when no installed browser launches", async () => {
    const managed = browser("managed-chromium", "managed");
    const launched = await launchFirstAvailableBrowser({
      candidates: [browser("google-chrome")],
      launch: async (candidate) => {
        if (candidate.source !== "managed") throw new Error("crashed");
        return "ok";
      },
      installManaged: async () => managed,
    });
    expect(launched.browser).toBe(managed);
  });

  it("downloads Chromium when no browser is installed", async () => {
    const installManaged = vi.fn(async () => browser("managed-chromium", "managed"));
    const launched = await launchFirstAvailableBrowser({
      candidates: [],
      launch: async () => "ok",
      installManaged,
    });
    expect(installManaged).toHaveBeenCalledOnce();
    expect(launched.browser.id).toBe("managed-chromium");
  });

  it("says which browser to install when the download fails", async () => {
    const failure = launchFirstAvailableBrowser({
      candidates: [],
      launch: async () => "ok",
      installManaged: async () => {
        throw new Error("Chromium download failed checksum verification");
      },
    });
    await expect(failure).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(failure).rejects.toThrow(/could not be downloaded\. Install Google Chrome/);
    await expect(failure).rejects.toMatchObject({
      attempts: [
        { browser: "Chromium download", error: "Chromium download failed checksum verification" },
      ],
    });
  });

  it("does not download when a configured browser fails", async () => {
    await expect(
      launchFirstAvailableBrowser({
        candidates: [browser("configured", "configured")],
        launch: async () => {
          throw new Error("ENOENT");
        },
        installManaged: null,
      }),
    ).rejects.toThrow(/CUED_CHROMIUM_EXECUTABLE_PATH could not be opened.*Fix or unset/);
  });
});
