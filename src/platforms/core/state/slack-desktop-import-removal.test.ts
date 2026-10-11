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

vi.mock("../../slack/auth/verify-session.js", () => ({
  verifySlackSession: async (
    _token: string,
    teamId: string,
    cookies: Array<{ value: string }>,
  ) => ({
    teamId,
    teamName:
      teamId === "T_ACTIVE"
        ? "Active Workspace"
        : teamId === "T_RECOVERED"
          ? "Recovered Workspace"
          : teamId,
    userId: "U_TEST",
    cookie: cookies[0]?.value,
  }),
}));

import { importSlackDesktopAuth } from "../../slack/auth/desktop-import.js";
import * as sessionVerification from "../../slack/auth/verify-session.js";

describe("slack desktop import removal tombstones", () => {
  const tempDirs: string[] = [];
  const originalSlackAppBinary = process.env.CUED_SLACK_APP_BINARY;
  const originalSlackUserDataDir = process.env.CUED_SLACK_USER_DATA_DIR;
  const originalSlackDesktopImportTimeout = process.env.CUED_SLACK_DESKTOP_IMPORT_TIMEOUT_MS;

  afterEach(() => {
    restoreEnv("CUED_SLACK_APP_BINARY", originalSlackAppBinary);
    restoreEnv("CUED_SLACK_USER_DATA_DIR", originalSlackUserDataDir);
    restoreEnv("CUED_SLACK_DESKTOP_IMPORT_TIMEOUT_MS", originalSlackDesktopImportTimeout);
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
    db.migrate();
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

    const beforeRejectedImport = db.listIntegrationStates();
    const keychainWrites = () =>
      execFileSyncMock.mock.calls.filter(
        ([command, args]) => command === "security" && args[0] === "add-generic-password",
      ).length;
    const beforeWrites = keychainWrites();
    const verify = vi.spyOn(sessionVerification, "verifySlackSession").mockResolvedValue(null);
    const rejected = await importSlackDesktopAuth(db, { skipWhenAnyAuthenticated: false });
    expect(rejected.every((entry) => !entry.imported)).toBe(true);
    expect(db.listIntegrationStates()).toEqual(beforeRejectedImport);
    expect(keychainWrites()).toBe(beforeWrites);
    verify.mockRestore();

    db.close();
  });

  it("relaunches Slack once when an existing desktop debugger is wedged", async () => {
    installFakeSlackDesktop();
    process.env.CUED_SLACK_DESKTOP_IMPORT_TIMEOUT_MS = "500";

    const debuggerReachable = [true, true, false, true];
    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "curl") {
        if (debuggerReachable.shift()) {
          return Buffer.from("");
        }
        throw new Error("debugger unavailable");
      }
      if (command === "osascript") {
        return Buffer.from("");
      }
      if (command === "security") {
        return Buffer.from("");
      }
      throw new Error(`unexpected command: ${command} ${args?.join(" ") ?? ""}`);
    });
    spawnMock.mockReturnValue({ pid: 12345 });

    const closeMock = vi.fn();
    connectOverCDPMock
      .mockRejectedValueOnce(new Error("stale Slack CDP session"))
      .mockResolvedValueOnce({
        contexts: () => [
          {
            pages: () => [
              {
                url: () => "https://app.slack.com/client/T_RECOVERED",
                evaluate: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    teams: {
                      T_RECOVERED: {
                        id: "T_RECOVERED",
                        name: "Recovered Workspace",
                        token: "xoxc-recovered",
                        user_id: "U_RECOVERED",
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

    const imported = await importSlackDesktopAuth(db);

    expect(imported).toEqual([
      {
        platform: "slack",
        accountKey: "T_RECOVERED",
        sourcePath: process.env.CUED_SLACK_USER_DATA_DIR,
        imported: true,
      },
    ]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "osascript",
      expect.any(Array),
      expect.any(Object),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(connectOverCDPMock).toHaveBeenCalledTimes(2);
    expect(db.getIntegrationState("slack", "T_RECOVERED")).toMatchObject({
      auth_state: "authenticated",
      enabled: 1,
      display_name: "Recovered Workspace",
    });

    db.close();
  });

  it("does not reconnect when the stale Slack debugger keeps the port", async () => {
    installFakeSlackDesktop();
    process.env.CUED_SLACK_DESKTOP_IMPORT_TIMEOUT_MS = "500";

    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "curl") {
        return Buffer.from("");
      }
      if (command === "osascript") {
        return Buffer.from("");
      }
      if (command === "security") {
        return Buffer.from("");
      }
      throw new Error(`unexpected command: ${command} ${args?.join(" ") ?? ""}`);
    });
    spawnMock.mockReturnValue({ pid: 12345 });

    const closeMock = vi.fn();
    connectOverCDPMock
      .mockRejectedValueOnce(new Error("stale Slack CDP session"))
      .mockResolvedValueOnce({
        contexts: () => [
          {
            pages: () => [
              {
                url: () => "https://app.slack.com/client/T_RECOVERED",
                evaluate: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    teams: {
                      T_RECOVERED: {
                        id: "T_RECOVERED",
                        name: "Recovered Workspace",
                        token: "xoxc-recovered",
                        user_id: "U_RECOVERED",
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

    await expect(importSlackDesktopAuth(db)).rejects.toThrow(
      "stayed reachable after quitting Slack",
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "osascript",
      expect.any(Array),
      expect.any(Object),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);

    db.close();
  });
});
