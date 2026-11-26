import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authBrowserProfileDir,
  getAuthBrowserStatus,
  installedBrowserCandidates,
  listAuthBrowsers,
  readAppVersion,
} from "./browser-resolver.js";
import { managedChromiumInstallDir, readChromiumRuntimeManifest } from "./managed-browser.js";

const home = "/Users/example";
// tests/setup.ts points CUED_HOME at a per-run temporary directory.
const env = { CUED_HOME: process.env.CUED_HOME };
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userEdge = `${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`;
const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

function existing(...paths: string[]) {
  const present = new Set(paths);
  return (path: string) => present.has(path);
}

describe("listAuthBrowsers", () => {
  it("looks in /Applications and ~/Applications for each supported browser, in order", () => {
    expect(installedBrowserCandidates(home).map((candidate) => candidate.executablePath)).toEqual([
      chrome,
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      userEdge,
      brave,
      `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ]);
  });

  it("returns only installed browsers, Chrome first", () => {
    const browsers = listAuthBrowsers({ env, home, exists: existing(brave, userEdge, chrome) });
    expect(browsers.map((browser) => [browser.id, browser.source])).toEqual([
      ["google-chrome", "installed"],
      ["microsoft-edge", "installed"],
      ["brave-browser", "installed"],
    ]);
  });

  it("returns nothing when no browser is installed and Chromium was not downloaded", () => {
    expect(listAuthBrowsers({ env, home, exists: existing() })).toEqual([]);
    const status = getAuthBrowserStatus({ env, home, exists: existing() });
    expect(status.selected).toBeNull();
    expect(status.fallback).toMatchObject({ available: true, installed: false });
  });

  it("tries an already downloaded Chromium after installed browsers", () => {
    const manifest = readChromiumRuntimeManifest(env);
    if (!manifest) throw new Error("manifest missing");
    const arch = process.arch === "arm64" ? manifest.arm64 : manifest.x64;
    const managed = join(managedChromiumInstallDir(manifest, env), arch.executable);

    expect(
      listAuthBrowsers({ env, home, exists: existing(managed, brave) }).map(
        (browser) => browser.id,
      ),
    ).toEqual(["brave-browser", "managed-chromium"]);
    expect(listAuthBrowsers({ env, home, exists: existing(managed) })[0]).toMatchObject({
      source: "managed",
      version: manifest.browserVersion,
    });
  });

  it("uses only an explicitly configured browser, with no download fallback", () => {
    const configuredEnv = { ...env, CUED_CHROMIUM_EXECUTABLE_PATH: "/opt/browser" };
    expect(listAuthBrowsers({ env: configuredEnv, home, exists: existing(chrome) })).toEqual([
      {
        id: "configured",
        name: "Configured browser",
        executablePath: "/opt/browser",
        source: "configured",
        version: null,
      },
    ]);
    expect(getAuthBrowserStatus({ env: configuredEnv, home }).fallback.available).toBe(false);
  });

  it("gives each browser its own profile inside the account's profile directory", () => {
    const [first, second] = listAuthBrowsers({ env, home, exists: existing(chrome, brave) });
    if (!first || !second) throw new Error("expected two browsers");
    expect(authBrowserProfileDir("/profiles/slack/T1", first)).toBe(
      "/profiles/slack/T1/google-chrome",
    );
    expect(authBrowserProfileDir("/profiles/slack/T1", second)).toBe(
      "/profiles/slack/T1/brave-browser",
    );
  });
});

describe("readAppVersion", () => {
  it("reads the version from the app's Info.plist", () => {
    const root = join(String(env.CUED_HOME), "Fake.app", "Contents");
    const executable = join(root, "MacOS", "Fake");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(
      join(root, "Info.plist"),
      "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>150.0.1.2</string></dict></plist>",
    );
    expect(readAppVersion(executable)).toBe("150.0.1.2");
    expect(readAppVersion("/nonexistent/MacOS/Fake")).toBeNull();
  });
});
