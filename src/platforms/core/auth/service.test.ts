import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import { IntegrationAuthService } from "./service.js";

const importSlackDesktopAuthMock = vi.hoisted(() => vi.fn());
const startAuthSessionMock = vi.hoisted(() =>
  vi.fn(() => ({
    child: { pid: 12345 } as ChildProcess,
    completion: new Promise(() => {}),
  })),
);

vi.mock("../../slack/auth/desktop-import.js", () => ({
  importSlackDesktopAuth: importSlackDesktopAuthMock,
}));

vi.mock("../../linkedin/auth/keychain-import.js", () => ({
  importLinkedInStoredAuth: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  runAuthSessionSync: vi.fn(),
  startAuthSession: startAuthSessionMock,
}));

describe("IntegrationAuthService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createDb(): CuedDatabase {
    const dir = mkdtempSync(join(tmpdir(), "cued-auth-service-db-"));
    tempDirs.push(dir);
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function upsertAuthenticatedSlack(db: CuedDatabase, accountKey: string, displayName: string) {
    db.upsertIntegrationState({
      platform: "slack",
      accountKey,
      displayName,
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "slack-desktop-cdp",
      metadata: {
        keychainService: "dev.cued.auth.slack",
        keychainAccount: accountKey,
        authResult: { teamId: accountKey, teamName: displayName },
        browserProfileDir: `/tmp/cued/slack/${accountKey}`,
        runtimeKind: "chromium",
      },
    });
  }

  it("includes the capabilities subcommand in usage text", () => {
    expect(IntegrationAuthService.usageText()).toContain("status | capabilities | refresh");
  });

  it("falls through to managed browser when slack pending discovery finds no new workspace", async () => {
    const db = createDb();
    upsertAuthenticatedSlack(db, "T_EXISTING", "Existing");
    importSlackDesktopAuthMock.mockResolvedValue([]);

    const service = new IntegrationAuthService(db);
    const activeAuthSessions = new Map<
      string,
      { child: ChildProcess; platform: "slack"; accountKey: string }
    >();

    const result = await service.connectManaged("slack", "pending-slack-new", activeAuthSessions);

    expect(result.integration.accountKey).toBe("pending-slack-new");
    expect(result.integration.authState).toBe("in_progress");
    expect(result.authSession?.accountKey).toBe("pending-slack-new");
    expect(activeAuthSessions.size).toBe(1);
    expect(startAuthSessionMock).toHaveBeenCalledTimes(1);

    db.close();
  });

  it("reuses slack pending discovery only when desktop import authenticates a new workspace", async () => {
    const db = createDb();
    upsertAuthenticatedSlack(db, "T_EXISTING", "Existing");
    importSlackDesktopAuthMock.mockImplementation((mockDb: CuedDatabase) => {
      upsertAuthenticatedSlack(mockDb, "T_NEW", "New Workspace");
      return Promise.resolve([
        {
          platform: "slack",
          accountKey: "T_NEW",
          sourcePath: "/tmp/slack",
          imported: true,
        },
      ]);
    });

    const service = new IntegrationAuthService(db);
    const activeAuthSessions = new Map<
      string,
      { child: ChildProcess; platform: "slack"; accountKey: string }
    >();

    const result = await service.connectManaged("slack", "pending-slack-new", activeAuthSessions);

    expect(result.integration.accountKey).toBe("T_NEW");
    expect(result.integration.authState).toBe("authenticated");
    expect(result.authSession?.accountKey).toBe("T_NEW");
    expect(activeAuthSessions.size).toBe(0);
    expect(startAuthSessionMock).not.toHaveBeenCalled();

    db.close();
  });
});
