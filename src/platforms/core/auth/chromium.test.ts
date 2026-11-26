import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import { connectIntegration, markAuthSessionInProgress } from "../state/mutations.js";
import { getAuthSessionSummary } from "../state/status.js";
import { parseBrowserDownloadProgress, recordBrowserDownloadProgress } from "./chromium.js";

describe("parseBrowserDownloadProgress", () => {
  it("reads the worker's Chromium download progress lines", () => {
    expect(
      parseBrowserDownloadProgress(
        '{"browserDownload":{"stage":"downloading","receivedBytes":10,"totalBytes":100}}',
      ),
    ).toEqual({ stage: "downloading", receivedBytes: 10, totalBytes: 100 });
  });

  it("ignores other worker output", () => {
    expect(parseBrowserDownloadProgress('{"provider":"slack","captureDiagnostic":"x"}')).toBeNull();
    expect(parseBrowserDownloadProgress('{"browserDownload":')).toBeNull();
    expect(parseBrowserDownloadProgress("Error: something")).toBeNull();
  });
});

describe("recordBrowserDownloadProgress", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("exposes download progress on the in-progress auth session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-chromium-progress-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    const { authSession } = connectIntegration(db, "linkedin", "default");
    const running = markAuthSessionInProgress(db, authSession.id, 1);

    recordBrowserDownloadProgress(db, running, {
      stage: "downloading",
      receivedBytes: 50,
      totalBytes: 100,
    });

    expect(getAuthSessionSummary(db, running.id)).toMatchObject({
      state: "in_progress",
      resultSummary: {
        stage: "browser_download",
        browserDownload: { stage: "downloading", receivedBytes: 50, totalBytes: 100 },
      },
    });
    db.close();
  });
});
