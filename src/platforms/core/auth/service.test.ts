import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import type { SlackHelperInspection } from "../../slack/helper/binary.js";
import { IntegrationAuthService } from "./service.js";

const importSlackDesktopAuthMock = vi.hoisted(() => vi.fn());
const inspectSlackHelperMock = vi.hoisted(() =>
  vi.fn<() => SlackHelperInspection>(() => ({
    helperPath: "/tmp/cued-slack-helper",
    version: "0.1.0",
    protocolVersion: 1,
    versionSupported: true,
  })),
);
const runAuthSessionSyncMock = vi.hoisted(() => vi.fn());
const startAuthSessionMock = vi.hoisted(() =>
  vi.fn(() => ({
    child: { pid: 12345 } as ChildProcess,
    completion: new Promise(() => {}),
  })),
);

vi.mock("../../slack/auth/desktop-import.js", () => ({
  importSlackDesktopAuth: importSlackDesktopAuthMock,
}));

vi.mock("../../slack/helper/binary.js", () => ({
  inspectSlackHelper: inspectSlackHelperMock,
}));

vi.mock("../../linkedin/auth/keychain-import.js", () => ({
  importLinkedInStoredAuth: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  runAuthSessionSync: runAuthSessionSyncMock,
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
        keychainService: "so.cued.desktop.auth.slack",
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

  it("returns an active managed auth session instead of launching the same account twice", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "discord",
      accountKey: "default",
      displayName: "Discord",
      authState: "in_progress",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "chromium-auth",
      launchTarget: "https://discord.com/login",
      importedFrom: "local-cli",
      metadata: {
        browserProfileDir: "/tmp/cued/discord/default",
        runtimeKind: "chromium",
      },
    });
    const sessionId = db.createAuthSession({
      platform: "discord",
      accountKey: "default",
      integrationStateId: "discord:default",
      state: "in_progress",
    });
    db.updateAuthSessionState({
      id: sessionId,
      state: "in_progress",
      nativePid: process.pid,
      startedAt: Date.now(),
    });
    const service = new IntegrationAuthService(db);
    const activeAuthSessions = new Map<
      string,
      { child: ChildProcess; platform: "discord"; accountKey: string }
    >([
      [
        sessionId,
        {
          child: { pid: process.pid, exitCode: null, signalCode: null } as ChildProcess,
          platform: "discord",
          accountKey: "default",
        },
      ],
    ]);

    const result = await service.connectManaged("discord", undefined, activeAuthSessions);

    expect(result.integration.accountKey).toBe("default");
    expect(result.integration.authState).toBe("in_progress");
    expect(result.authSession?.id).toBe(sessionId);
    expect(activeAuthSessions.size).toBe(1);
    expect(startAuthSessionMock).not.toHaveBeenCalled();
    expect(db.listAuthSessions(10)).toHaveLength(1);

    db.close();
  });

  it("reuses an active generated Gmail auth session instead of launching duplicate OAuth", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "gmail",
      accountKey: "pending-gmail-first",
      displayName: "Gmail",
      authState: "in_progress",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: false,
      launchStrategy: "native-auth",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {
        runtimeKind: "oauth",
      },
    });
    const sessionId = db.createAuthSession({
      platform: "gmail",
      accountKey: "pending-gmail-first",
      integrationStateId: "gmail:pending-gmail-first",
      state: "in_progress",
    });
    db.updateAuthSessionState({
      id: sessionId,
      state: "in_progress",
      nativePid: process.pid,
      startedAt: Date.now(),
    });
    const service = new IntegrationAuthService(db);
    const activeAuthSessions = new Map<
      string,
      { child: ChildProcess; platform: "gmail"; accountKey: string }
    >([
      [
        sessionId,
        {
          child: { pid: process.pid, exitCode: null, signalCode: null } as ChildProcess,
          platform: "gmail",
          accountKey: "pending-gmail-first",
        },
      ],
    ]);

    const result = await service.connectManaged(
      "gmail",
      "pending-gmail-second",
      activeAuthSessions,
    );

    expect(result.integration.accountKey).toBe("pending-gmail-first");
    expect(result.authSession?.id).toBe(sessionId);
    expect(startAuthSessionMock).not.toHaveBeenCalled();
    expect(db.listAuthSessions(10)).toHaveLength(1);

    db.close();
  });

  it("reuses a persisted generated Gmail auth session after UI refresh", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "gmail",
      accountKey: "pending-gmail-existing",
      displayName: "Gmail",
      authState: "in_progress",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: false,
      launchStrategy: "native-auth",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {
        runtimeKind: "oauth",
      },
    });
    const sessionId = db.createAuthSession({
      platform: "gmail",
      accountKey: "pending-gmail-existing",
      integrationStateId: "gmail:pending-gmail-existing",
      state: "in_progress",
    });
    db.updateAuthSessionState({
      id: sessionId,
      state: "in_progress",
      nativePid: process.pid,
      startedAt: Date.now(),
    });

    const service = new IntegrationAuthService(db);
    const result = await service.connectManaged("gmail", "pending-gmail-new", new Map());

    expect(result.integration.accountKey).toBe("pending-gmail-existing");
    expect(result.authSession?.id).toBe(sessionId);
    expect(startAuthSessionMock).not.toHaveBeenCalled();
    expect(db.listAuthSessions(10)).toHaveLength(1);

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

  it("does not queue a Slack sync when reusable auth is not helper-ready", async () => {
    const db = createDb();
    upsertAuthenticatedSlack(db, "T_EXISTING", "Existing");
    importSlackDesktopAuthMock.mockResolvedValue([]);
    inspectSlackHelperMock.mockReturnValue({
      helperPath: null,
      version: null,
      protocolVersion: null,
      versionSupported: false,
    });
    const wakeIngest = vi.fn();

    const service = new IntegrationAuthService(db);
    const result = await service.connectManaged("slack", "T_EXISTING", new Map(), {
      wakeIngest,
    });

    expect(result.integration.accountKey).toBe("T_EXISTING");
    expect(result.integration.authState).toBe("authenticated");
    expect(result.integration.syncCapable).toBe(false);
    expect(db.listRecentRuns(1)).toEqual([]);
    expect(wakeIngest).not.toHaveBeenCalled();

    db.close();
  });

  it("does not queue post-auth sync when the lifecycle gate rejects it", async () => {
    const db = createDb();
    runAuthSessionSyncMock.mockResolvedValue({
      state: "authenticated",
      keychainService: null,
      keychainAccount: null,
      resultSummary: {
        runtime: "qr_native",
        helper: "cued-whatsapp-helper",
        durableStatusVerified: true,
      },
      errorSummary: null,
    });
    const shouldQueueAuthenticatedSync = vi.fn(() => false);
    const wakeIngest = vi.fn();

    const service = new IntegrationAuthService(db);
    const result = await service.connectLocally("whatsapp", undefined, {
      shouldQueueAuthenticatedSync,
      wakeIngest,
    });

    expect(result.integration?.platform).toBe("whatsapp");
    expect(result.integration?.authState).toBe("authenticated");
    expect(result.integration?.syncCapable).toBe(true);
    expect(shouldQueueAuthenticatedSync).toHaveBeenCalledWith("whatsapp", "default");
    expect(db.listRecentRuns(1)).toEqual([]);
    expect(wakeIngest).not.toHaveBeenCalled();

    db.close();
  });
});
