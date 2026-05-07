import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";

const { connectOverCDPMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  connectOverCDPMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    spawn: spawnMock,
  };
});

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: connectOverCDPMock,
  },
}));

import { importSlackDesktopAuth } from "../../slack/auth/desktop-import.js";

describe("slack desktop import removal tombstones", () => {
  const tempDirs: string[] = [];
  const originalSlackAppBinary = process.env.CUED_SLACK_APP_BINARY;
  const originalSlackUserDataDir = process.env.CUED_SLACK_USER_DATA_DIR;

  afterEach(() => {
    restoreEnv("CUED_SLACK_APP_BINARY", originalSlackAppBinary);
    restoreEnv("CUED_SLACK_USER_DATA_DIR", originalSlackUserDataDir);
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createDb(): CuedDatabase {
    const db = new CuedDatabase(join(createTempDir("cued-slack-import-db-"), "local.db"));
    db.initializeSchema();
    return db;
  }

  function installFakeSlackDesktop(): void {
    const appBinary = join(createTempDir("cued-slack-app-"), "Slack");
    writeFileSync(appBinary, "#!/bin/sh\nexit 0\n");
    chmodSync(appBinary, 0o755);
    const userDataDir = createTempDir("cued-slack-user-data-");
    mkdirSync(userDataDir, { recursive: true });
    process.env.CUED_SLACK_APP_BINARY = appBinary;
    process.env.CUED_SLACK_USER_DATA_DIR = userDataDir;
  }

  it("imports unrelated teams without resurrecting a removed workspace", async () => {
    installFakeSlackDesktop();
    execFileSyncMock.mockReturnValue(Buffer.from(""));

    const closeMock = vi.fn();
    connectOverCDPMock.mockResolvedValue({
      contexts: () => [
        {
          pages: () => [
            {
              url: () => "https://app.slack.com/client/T_ACTIVE",
              evaluate: vi.fn().mockResolvedValue(
                JSON.stringify({
                  teams: {
                    T_REMOVED: {
                      id: "T_REMOVED",
                      name: "Removed Workspace",
                      token: "xoxc-removed",
                      user_id: "U_REMOVED",
                    },
                    T_ACTIVE: {
                      id: "T_ACTIVE",
                      name: "Active Workspace",
                      token: "xoxc-active",
                      user_id: "U_ACTIVE",
                    },
                  },
                }),
              ),
            },
          ],
          cookies: vi.fn().mockResolvedValue([
            {
              name: "d",
              value: "desktop-cookie",
              domain: ".slack.com",
            },
          ]),
        },
      ],
      close: closeMock,
    });

    const db = createDb();
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T_REMOVED",
      displayName: "Removed Workspace",
      authState: "cancelled",
      enabled: false,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "slack-desktop-cdp",
      metadata: {
        userRemoved: true,
        removedAt: 123,
      },
    });

    const imported = await importSlackDesktopAuth(db);

    expect(imported).toEqual([
      {
        platform: "slack",
        accountKey: "T_REMOVED",
        sourcePath: process.env.CUED_SLACK_USER_DATA_DIR,
        imported: false,
      },
      {
        platform: "slack",
        accountKey: "T_ACTIVE",
        sourcePath: process.env.CUED_SLACK_USER_DATA_DIR,
        imported: true,
      },
    ]);
    expect(db.getIntegrationState("slack", "T_REMOVED")).toMatchObject({
      auth_state: "cancelled",
      enabled: 0,
      sync_capable: 0,
    });
    expect(JSON.parse(db.getIntegrationState("slack", "T_REMOVED")?.metadata_json ?? "{}")).toEqual(
      expect.objectContaining({ userRemoved: true }),
    );
    expect(db.getIntegrationState("slack", "T_ACTIVE")).toMatchObject({
      auth_state: "authenticated",
      enabled: 1,
      display_name: "Active Workspace",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      expect.arrayContaining(["-a", "T_ACTIVE"]),
      expect.any(Object),
    );
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      "security",
      expect.arrayContaining(["-a", "T_REMOVED"]),
      expect.any(Object),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);

    db.close();
  });
});
