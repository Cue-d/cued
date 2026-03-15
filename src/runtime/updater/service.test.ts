import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import {
  checkForUpdates,
  compareVersions,
  isUpdateCheckDue,
  pickReleaseForChannel,
} from "./service.js";

describe("updater service", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-updater-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  it("compares semver releases including prereleases", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.0-internal.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-internal.2", "0.2.0-internal.1")).toBeGreaterThan(0);
  });

  it("picks the correct release for each channel", () => {
    const releases = [
      {
        tag_name: "v0.2.0-internal.1",
        prerelease: true,
        html_url: "https://example.com/internal",
        assets: [
          {
            name: "cued-macos-arm64.tar.gz",
            browser_download_url: "https://example.com/internal.tgz",
          },
        ],
      },
      {
        tag_name: "v0.1.9",
        prerelease: false,
        html_url: "https://example.com/stable",
        assets: [
          {
            name: "cued-macos-arm64.tar.gz",
            browser_download_url: "https://example.com/stable.tgz",
          },
        ],
      },
    ];

    expect(pickReleaseForChannel(releases, "stable")?.version).toBe("0.1.9");
    expect(pickReleaseForChannel(releases, "internal")?.version).toBe("0.2.0-internal.1");
    expect(pickReleaseForChannel(releases, "dev")).toBeNull();
  });

  it("reuses cached update metadata on 304 responses", async () => {
    vi.stubEnv("CUED_APP_VERSION", "0.1.0");
    vi.stubEnv("CUED_RELEASE_CHANNEL", "stable");
    const db = createDb();
    db.setUpdateReleaseState({
      checkedAt: 1,
      channel: "stable",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      availableVersion: "0.2.0",
      releaseUrl: "https://example.com/release",
      tarballUrl: "https://example.com/release.tgz",
      etag: "etag-1",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { etag: "etag-1" },
      }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const status = await checkForUpdates(db, { force: true, fetchImpl });
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers?: Headers } | undefined)?.headers;

    expect(status.available).toBe(true);
    expect(status.availableVersion).toBe("0.2.0");
    expect(headers?.get("If-None-Match")).toBe("etag-1");

    db.close();
  });

  it("skips remote checks on dev channel", async () => {
    vi.stubEnv("CUED_APP_VERSION", "0.1.3");
    vi.stubEnv("CUED_RELEASE_CHANNEL", "dev");
    const db = createDb();
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const status = await checkForUpdates(db, { force: true, fetchImpl });

    expect(status.available).toBe(false);
    expect(status.latestVersion).toBe("0.1.3");
    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(isUpdateCheckDue(status.lastCheckedAt, (status.lastCheckedAt ?? 0) + 1_000)).toBe(false);

    db.close();
  });
});
