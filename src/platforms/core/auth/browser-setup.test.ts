import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import {
  completeAuthSession,
  connectIntegration,
  markAuthSessionInProgress,
} from "../state/mutations.js";
import {
  BrowserUnavailableError,
  describeBrowserSetupFailure,
  launchFirstAvailableBrowser,
} from "./browser-launch.js";
import {
  type BrowserSetupProgress,
  browserSetupFromDownload,
  createBrowserSetupReporter,
  describeBrowserSetup,
  formatBrowserSetupLine,
  parseBrowserSetupLine,
  readSignInBrowserState,
  SIGN_IN_BROWSER_FAILURE_VISIBLE_MS,
  type SignInBrowserState,
} from "./browser-setup.js";
import { createBrowserSetupRecorder } from "./chromium.js";
import { type ChromiumRuntimeManifest, installManagedChromium } from "./managed-browser.js";

const MB = 1024 * 1024;
const executable =
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function manifestFor(bytes: Buffer, sha256 = createHash("sha256").update(bytes).digest("hex")) {
  const archive = { url: "https://cdn.example.test/chromium.zip", sha256, executable };
  return {
    source: "playwright",
    playwrightRevision: "1",
    browserVersion: "1.0.0.0",
    arm64: archive,
    x64: archive,
  } satisfies ChromiumRuntimeManifest;
}

/** A download source that serves `bytes` in `chunks` pieces with a Content-Length. */
function fakeDownload(bytes: Buffer, chunks: number): typeof fetch {
  return (async () => {
    const size = Math.ceil(bytes.length / chunks);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    });
    return new Response(body, { headers: { "content-length": String(bytes.length) } });
  }) as unknown as typeof fetch;
}

async function fakeExtract(_archive: string, destination: string): Promise<void> {
  const path = join(destination, executable);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
}

describe("describeBrowserSetup", () => {
  it("says how much of the download is done in plain words", () => {
    expect(
      describeBrowserSetup({
        stage: "downloading",
        receivedBytes: 42 * MB,
        totalBytes: 150 * MB,
        error: null,
      }),
    ).toBe("Downloading sign-in browser, 42 of 150 MB");
    expect(
      describeBrowserSetup({
        stage: "downloading",
        receivedBytes: 3 * MB,
        totalBytes: null,
        error: null,
      }),
    ).toBe("Downloading sign-in browser, 3 MB");
  });
});

describe("createBrowserSetupReporter", () => {
  it("drops repeats of a stage inside the interval and never drops a new stage", () => {
    const sent: BrowserSetupProgress[] = [];
    let clock = 0;
    const report = createBrowserSetupReporter((progress) => sent.push(progress), {
      now: () => clock,
    });
    for (let received = 1; received <= 50; received += 1) {
      clock += 50;
      report({ stage: "downloading", receivedBytes: received, totalBytes: 50, error: null });
    }
    report({ stage: "verifying", receivedBytes: null, totalBytes: null, error: null });
    expect(sent.map((progress) => [progress.stage, progress.receivedBytes])).toEqual([
      ["downloading", 1],
      ["downloading", 21],
      ["downloading", 41],
      ["verifying", null],
    ]);
  });
});

describe("parseBrowserSetupLine", () => {
  it("reads the worker's setup lines and nothing else", () => {
    const progress: BrowserSetupProgress = {
      stage: "downloading",
      receivedBytes: 10,
      totalBytes: 100,
      error: null,
    };
    expect(parseBrowserSetupLine(formatBrowserSetupLine(progress))).toEqual(progress);
    expect(parseBrowserSetupLine('{"provider":"slack","captureDiagnostic":"x"}')).toBeNull();
    expect(parseBrowserSetupLine('{"browserSetup":{"stage":"bogus"}}')).toBeNull();
    expect(parseBrowserSetupLine('{"browserSetup":')).toBeNull();
  });
});

describe("sign-in browser state", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "cued-browser-setup-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    const { authSession } = connectIntegration(db, "linkedin", "default");
    const running = markAuthSessionInProgress(db, authSession.id, 1);
    return { db, running, env: { CUED_HOME: join(dir, "home") } };
  }

  it("is finding a browser until the worker says otherwise, and hidden once the window is open", () => {
    const { db, running } = setup();
    expect(readSignInBrowserState(db)).toMatchObject({
      platform: "linkedin",
      accountKey: "default",
      stage: "finding",
    });
    const record = createBrowserSetupRecorder(db, running);
    record({ stage: "launching", receivedBytes: null, totalBytes: null, error: null });
    expect(readSignInBrowserState(db)?.stage).toBe("launching");
    record({ stage: "ready", receivedBytes: null, totalBytes: null, error: null });
    expect(readSignInBrowserState(db)).toBeNull();
    db.close();
  });

  it("shows the fallback download from a fake source with bytes done and total", async () => {
    const { db, running, env } = setup();
    const archive = Buffer.alloc(4 * MB, 7);
    let clock = 0;
    const seen: SignInBrowserState[] = [];
    const writes: string[] = [];
    const record = createBrowserSetupRecorder(
      db,
      running,
      {
        onProgress: () => {
          const state = readSignInBrowserState(db);
          if (state) seen.push(state);
        },
      },
      () => clock,
    );
    // The same path the worker takes: reporter -> stderr line -> daemon recorder.
    const report = createBrowserSetupReporter(
      (progress) => {
        const line = formatBrowserSetupLine(progress);
        writes.push(line);
        const parsed = parseBrowserSetupLine(line);
        if (parsed) record(parsed);
      },
      { now: () => clock },
    );

    const { browser } = await launchFirstAvailableBrowser({
      candidates: [],
      installManaged: () =>
        installManagedChromium({
          env,
          manifest: manifestFor(archive),
          arch: "arm64",
          fetchImpl: fakeDownload(archive, 64),
          extract: fakeExtract,
          onProgress: (progress) => {
            clock += 40;
            report(browserSetupFromDownload(progress));
          },
        }),
      launch: async (candidate) => {
        report({ stage: "launching", receivedBytes: null, totalBytes: null, error: null });
        return candidate.id;
      },
    });
    report({ stage: "ready", receivedBytes: null, totalBytes: null, error: null });

    expect(browser.source).toBe("managed");
    const downloads = seen.filter((state) => state.stage === "downloading");
    expect(downloads.length).toBeGreaterThan(1);
    expect(downloads.every((state) => state.totalBytes === archive.length)).toBe(true);
    expect(downloads.at(-1)?.receivedBytes).toBeGreaterThan(downloads[0]?.receivedBytes ?? 0);
    expect(seen.map((state) => state.stage)).toEqual(
      expect.arrayContaining(["verifying", "extracting", "launching"]),
    );
    // 64 chunks, throttled to a handful of progress lines.
    expect(writes.length).toBeLessThan(15);
    expect(readSignInBrowserState(db)).toBeNull();
    db.close();
  });

  it("reports a checksum failure with the reason until it is old or superseded", async () => {
    const { db, running, env } = setup();
    const archive = Buffer.from("not the pinned build");
    const error = await launchFirstAvailableBrowser({
      candidates: [],
      installManaged: () =>
        installManagedChromium({
          env,
          manifest: manifestFor(archive, "0".repeat(64)),
          arch: "arm64",
          fetchImpl: fakeDownload(archive, 2),
          extract: fakeExtract,
        }),
      launch: async () => "unused",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserUnavailableError);
    const reason = describeBrowserSetupFailure(error as BrowserUnavailableError);
    expect(reason).toMatch(/checksum/);

    completeAuthSession(db, running.id, {
      state: "failed",
      resultSummary: {
        errorCode: "browser_unavailable",
        browserSetup: { stage: "failed", receivedBytes: null, totalBytes: null, error: reason },
      },
      errorSummary: (error as Error).message,
    });
    expect(readSignInBrowserState(db)).toMatchObject({ stage: "failed", error: reason });
    expect(readSignInBrowserState(db, Date.now() + SIGN_IN_BROWSER_FAILURE_VISIBLE_MS)).toBeNull();

    // Trying again starts a new session, which replaces the failure.
    const retry = connectIntegration(db, "linkedin", "default");
    markAuthSessionInProgress(db, retry.authSession.id, 1);
    expect(readSignInBrowserState(db)).toMatchObject({
      sessionId: retry.authSession.id,
      stage: "finding",
    });
    db.close();
  });

  it("names a failed download and keeps other failures as they are", () => {
    expect(
      describeBrowserSetupFailure(
        new BrowserUnavailableError(
          [{ browser: "Chromium download", error: "Chromium download failed (HTTP 503)" }],
          "No supported browser was found, and Chromium could not be downloaded.",
        ),
      ),
    ).toBe(
      "The sign-in browser could not be downloaded (Chromium download failed (HTTP 503)). Try again, or install Google Chrome, Microsoft Edge, Brave Browser or Chromium.",
    );
    const other = new BrowserUnavailableError(
      [{ browser: "Google Chrome", error: "crashed" }],
      "No browser could be opened for the sign-in window.",
    );
    expect(describeBrowserSetupFailure(other)).toBe(other.message);
  });
});
