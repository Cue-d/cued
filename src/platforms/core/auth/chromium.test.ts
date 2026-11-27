import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import { connectIntegration, markAuthSessionInProgress } from "../state/mutations.js";
import { getAuthSessionSummary } from "../state/status.js";
import type { BrowserSetupProgress } from "./browser-setup.js";
import { createBrowserSetupRecorder } from "./chromium.js";

const downloading = (receivedBytes: number): BrowserSetupProgress => ({
  stage: "downloading",
  receivedBytes,
  totalBytes: 100,
  error: null,
});

describe("createBrowserSetupRecorder", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function openDb() {
    const dir = mkdtempSync(join(tmpdir(), "cued-chromium-progress-"));
    dirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("keeps browser setup progress on the in-progress auth session and announces it", () => {
    const db = openDb();
    const { authSession } = connectIntegration(db, "linkedin", "default");
    const running = markAuthSessionInProgress(db, authSession.id, 1);
    const onProgress = vi.fn();

    createBrowserSetupRecorder(db, running, { onProgress })(downloading(50));

    expect(getAuthSessionSummary(db, running.id)).toMatchObject({
      state: "in_progress",
      resultSummary: {
        stage: "browser_setup",
        browserSetup: { stage: "downloading", receivedBytes: 50, totalBytes: 100 },
      },
    });
    expect(onProgress).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("writes at most twice a second per stage, but always records a new stage", () => {
    const db = openDb();
    const { authSession } = connectIntegration(db, "linkedin", "default");
    const running = markAuthSessionInProgress(db, authSession.id, 1);
    const writes = vi.spyOn(db, "updateAuthSessionState");
    let clock = 0;
    const record = createBrowserSetupRecorder(db, running, {}, () => clock);

    for (let received = 1; received <= 100; received += 1) {
      clock += 10;
      record(downloading(received));
    }
    record({ stage: "verifying", receivedBytes: null, totalBytes: null, error: null });

    // 100 chunks over one second: the first, one 500 ms later, and the stage change.
    expect(writes).toHaveBeenCalledTimes(3);
    expect(getAuthSessionSummary(db, running.id)?.resultSummary).toMatchObject({
      browserSetup: { stage: "verifying" },
    });
    db.close();
  });

  it("leaves a finished session alone", () => {
    const db = openDb();
    const { authSession } = connectIntegration(db, "linkedin", "default");
    const onProgress = vi.fn();

    createBrowserSetupRecorder(db, authSession, { onProgress })(downloading(50));

    expect(getAuthSessionSummary(db, authSession.id)?.resultSummary).toBeNull();
    expect(onProgress).not.toHaveBeenCalled();
    db.close();
  });
});
