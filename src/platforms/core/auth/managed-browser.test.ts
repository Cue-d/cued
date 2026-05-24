import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getManagedChromiumBrowser,
  getManagedChromiumStatus,
  installManagedChromiumBrowser,
} from "./managed-browser.js";

describe("managed Chromium browser", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function installFakeBrowser(root: string, executableName = "Chromium") {
    let installCalls = 0;
    const browser = await installManagedChromiumBrowser({
      env: { CUED_MANAGED_BROWSER_DIR: root },
      installChromium: async ({ destinationRoot }) => {
        installCalls += 1;
        const executablePath = join(
          destinationRoot,
          "chromium",
          "Chromium.app",
          "Contents",
          "MacOS",
          executableName,
        );
        mkdirSync(dirname(executablePath), { recursive: true });
        writeFileSync(executablePath, "");
      },
      resolveExecutablePath: async ({ browserRoot }) =>
        join(browserRoot, "chromium", "Chromium.app", "Contents", "MacOS", executableName),
    });
    return { browser, installCalls };
  }

  it("reports the pinned Playwright Chromium spec before install", () => {
    const root = tempDir("cued-managed-browser-status-");
    const status = getManagedChromiumStatus({ CUED_MANAGED_BROWSER_DIR: root });

    expect(status.installed).toBe(false);
    expect(status.root).toContain(root);
    expect(status.spec.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.spec.revision).toMatch(/^\d+$/);
  });

  it("installs into the managed root and writes metadata", async () => {
    const root = tempDir("cued-managed-browser-install-");
    const { browser, installCalls } = await installFakeBrowser(root);
    const status = getManagedChromiumStatus({ CUED_MANAGED_BROWSER_DIR: root });

    expect(installCalls).toBe(1);
    expect(browser.name).toBe("Managed Chromium");
    expect(browser.appBundleIdentifier).toBe("com.google.chrome.for.testing");
    expect(browser.executablePath).toContain(status.root);
    expect(existsSync(browser.executablePath)).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.metadata?.executablePath).toBe(browser.executablePath);
    expect(readFileSync(join(status.root, "metadata.json"), "utf8")).toContain(
      '"provider": "playwright"',
    );
  });

  it("reuses a valid managed browser without reinstalling", async () => {
    const root = tempDir("cued-managed-browser-reuse-");
    const first = await installFakeBrowser(root);
    let installCalls = 0;
    const second = await installManagedChromiumBrowser({
      env: { CUED_MANAGED_BROWSER_DIR: root },
      installChromium: async () => {
        installCalls += 1;
      },
      resolveExecutablePath: async () => {
        throw new Error("should not resolve on reuse");
      },
    });

    expect(second).toEqual(first.browser);
    expect(installCalls).toBe(0);
    expect(getManagedChromiumBrowser({ CUED_MANAGED_BROWSER_DIR: root })).toEqual(first.browser);
  });

  it("forces reinstall when the managed browser should be refreshed", async () => {
    const root = tempDir("cued-managed-browser-force-");
    const first = await installFakeBrowser(root, "OldChromium");
    const second = await installManagedChromiumBrowser({
      env: { CUED_MANAGED_BROWSER_DIR: root },
      force: true,
      installChromium: async ({ destinationRoot }) => {
        const executablePath = join(
          destinationRoot,
          "chromium",
          "Chromium.app",
          "Contents",
          "MacOS",
          "NewChromium",
        );
        mkdirSync(dirname(executablePath), { recursive: true });
        writeFileSync(executablePath, "");
      },
      resolveExecutablePath: async ({ browserRoot }) =>
        join(browserRoot, "chromium", "Chromium.app", "Contents", "MacOS", "NewChromium"),
    });

    expect(second.executablePath).not.toBe(first.browser.executablePath);
    expect(existsSync(second.executablePath)).toBe(true);
    expect(existsSync(first.browser.executablePath)).toBe(false);
  });

  it("keeps the existing managed browser when a forced replacement fails", async () => {
    const root = tempDir("cued-managed-browser-force-failure-");
    const first = await installFakeBrowser(root, "StableChromium");

    await expect(
      installManagedChromiumBrowser({
        env: { CUED_MANAGED_BROWSER_DIR: root },
        force: true,
        installChromium: async ({ destinationRoot }) => {
          mkdirSync(destinationRoot, { recursive: true });
        },
        resolveExecutablePath: async ({ browserRoot }) =>
          join(browserRoot, "chromium", "Chromium.app", "Contents", "MacOS", "BrokenChromium"),
      }),
    ).rejects.toThrow("Managed Chromium executable was not found");

    expect(existsSync(first.browser.executablePath)).toBe(true);
    expect(getManagedChromiumBrowser({ CUED_MANAGED_BROWSER_DIR: root })).toEqual(first.browser);
  });

  it("does not trust metadata pointing outside the managed browser root", async () => {
    const root = tempDir("cued-managed-browser-outside-");
    const outsideExecutable = join(root, "outside-chromium");
    writeFileSync(outsideExecutable, "");

    await installManagedChromiumBrowser({
      env: { CUED_MANAGED_BROWSER_DIR: root },
      installChromium: async ({ destinationRoot }) => {
        const executablePath = join(
          destinationRoot,
          "chromium",
          "Chromium.app",
          "Contents",
          "MacOS",
          "Chromium",
        );
        mkdirSync(dirname(executablePath), { recursive: true });
        writeFileSync(executablePath, "");
      },
      resolveExecutablePath: async () => outsideExecutable,
    }).catch(() => null);

    expect(getManagedChromiumBrowser({ CUED_MANAGED_BROWSER_DIR: root })).toBeNull();
  });
});
