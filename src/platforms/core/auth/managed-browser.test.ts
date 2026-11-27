import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BrowserDownloadProgress,
  type ChromiumRuntimeManifest,
  getManagedChromium,
  installManagedChromium,
  managedBrowserRoot,
  readChromiumRuntimeManifest,
} from "./managed-browser.js";

const archiveBytes = Buffer.from("pretend this is a Chromium zip");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const executable =
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function testEnv() {
  // Each test installs into its own directory under the per-run test home.
  return { CUED_HOME: mkdtempSync(join(String(process.env.CUED_HOME), "managed-")) };
}

function manifest(sha256 = archiveSha256, url = "https://cdn.example.test/chromium.zip") {
  const archive = { url, sha256, executable };
  return {
    source: "playwright",
    playwrightRevision: "1",
    browserVersion: "1.0.0.0",
    arm64: archive,
    x64: archive,
  } satisfies ChromiumRuntimeManifest;
}

const fakeFetch = (async () => new Response(archiveBytes)) as unknown as typeof fetch;

async function fakeExtract(_archive: string, destination: string): Promise<void> {
  const path = join(destination, executable);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
}

describe("installManagedChromium", () => {
  it("installs a verified download into Cued's data directory and reports progress", async () => {
    const env = testEnv();
    const progress: BrowserDownloadProgress[] = [];
    const browser = await installManagedChromium({
      env,
      manifest: manifest(),
      arch: "arm64",
      fetchImpl: fakeFetch,
      extract: fakeExtract,
      onProgress: (event) => progress.push(event),
    });

    expect(browser).toMatchObject({
      id: "managed-chromium",
      source: "managed",
      version: "1.0.0.0",
    });
    expect(browser.executablePath.startsWith(managedBrowserRoot(env))).toBe(true);
    expect(existsSync(browser.executablePath)).toBe(true);
    expect(progress.map((event) => event.stage)).toEqual([
      "downloading",
      "verifying",
      "extracting",
      "installed",
    ]);
    expect(progress[0]).toMatchObject({ receivedBytes: archiveBytes.length });
    // Staging directories and the archive are gone; only the install remains.
    expect(readdirSync(managedBrowserRoot(env))).toEqual([
      expect.stringMatching(/^chromium-1\.0\.0\.0-arm64-/),
    ]);
  });

  it("refuses a download whose checksum does not match the pin and installs nothing", async () => {
    const env = testEnv();
    let extracted = false;
    await expect(
      installManagedChromium({
        env,
        manifest: manifest("0".repeat(64)),
        arch: "arm64",
        fetchImpl: fakeFetch,
        extract: async (archive, destination) => {
          extracted = true;
          await fakeExtract(archive, destination);
        },
      }),
    ).rejects.toThrow(/checksum verification/);
    expect(extracted).toBe(false);
    expect(readdirSync(managedBrowserRoot(env))).toEqual([]);
  });

  it("refuses non-HTTPS downloads", async () => {
    await expect(
      installManagedChromium({
        env: testEnv(),
        manifest: manifest(archiveSha256, "http://cdn.example.test/chromium.zip"),
        arch: "arm64",
        fetchImpl: fakeFetch,
        extract: fakeExtract,
      }),
    ).rejects.toThrow(/non-HTTPS/);
  });

  it("does not download again once installed", async () => {
    const env = testEnv();
    const options = { env, manifest: manifest(), arch: "arm64" as const, extract: fakeExtract };
    const first = await installManagedChromium({ ...options, fetchImpl: fakeFetch });
    const second = await installManagedChromium({
      ...options,
      fetchImpl: (async () => {
        throw new Error("should not download");
      }) as unknown as typeof fetch,
    });
    expect(second.executablePath).toBe(first.executablePath);
  });

  it("is not reported as installed before it is downloaded", () => {
    expect(getManagedChromium(testEnv())).toBeNull();
  });
});

describe("chromium-runtime.json", () => {
  it("pins the Chromium build that the bundled Playwright drives", () => {
    const pinned = readChromiumRuntimeManifest({});
    const require = createRequire(import.meta.url);
    const playwrightCore = dirname(require.resolve("playwright-core/package.json"));
    const browsers = JSON.parse(readFileSync(join(playwrightCore, "browsers.json"), "utf8")) as {
      browsers: Array<{ name: string; revision: string; browserVersion: string }>;
    };
    const chromium = browsers.browsers.find((entry) => entry.name === "chromium");

    expect(pinned).toMatchObject({
      playwrightRevision: chromium?.revision,
      browserVersion: chromium?.browserVersion,
    });
    for (const [arch, file] of [
      ["arm64", "chromium-mac-arm64.zip"],
      ["x64", "chromium-mac.zip"],
    ] as const) {
      expect(pinned?.[arch].url).toBe(
        `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${chromium?.revision}/${file}`,
      );
      expect(pinned?.[arch].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
