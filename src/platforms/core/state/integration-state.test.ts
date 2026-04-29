import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostOS } from "../../../core/platform-capabilities.js";
import { CuedDatabase } from "../../../db/database.js";
import { refreshLocalIntegrationStates } from "./local-refresh.js";
import {
  completeAuthSession,
  markAuthSessionInProgress,
  removeIntegration,
  requestIntegrationAccess,
  setIntegrationEnabled,
} from "./mutations.js";
import { refreshManagedIntegrationStates } from "./refresh.js";
import {
  buildIntegrationStatus,
  getAuthSessionSummary,
  listIntegrationStates,
  listRequestableIntegrationPlatforms,
} from "./status.js";

describe("integration state management", () => {
  const tempDirs: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_DB_PATH;
    delete process.env.CUED_SIGNAL_CLI_PATH;
    delete process.env.CUED_SLACK_APP_BINARY;
    delete process.env.CUED_SLACK_HELPER_BINARY;
    delete process.env.CUED_APP_PATH;
    delete process.env.CUED_WHATSAPP_HELPER_BINARY;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createDb(): CuedDatabase {
    const dir = createTempDir("cued-integrations-db-");
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function createPackagedSignalHelper(version = "0.12.9"): string {
    const appPath = join(createTempDir("cued-app-"), "Cued.app");
    const helperPath = join(
      appPath,
      "Contents",
      "Resources",
      "helpers",
      "signal-cli",
      "cued-signal-cli",
    );
    mkdirSync(join(helperPath, ".."), { recursive: true });
    writeFileSync(helperPath, `#!/bin/sh\necho "signal-cli ${version}"\n`);
    chmodSync(helperPath, 0o755);
    return appPath;
  }

  function createSlackHelper(version = "0.1.0"): string {
    const helperPath = join(createTempDir("cued-slack-helper-bin-"), "cued-slack-helper");
    writeFileSync(
      helperPath,
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo '{"version":"${version}","protocolVersion":1}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '{"helperVersion":"${version}","protocolVersion":1}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(helperPath, 0o755);
    return helperPath;
  }

  function createSecurityTool(
    secretByServiceAndAccount: Record<string, Record<string, unknown>>,
  ): string {
    const binDir = createTempDir("cued-security-bin-");
    const securityPath = join(binDir, "security");
    writeFileSync(
      securityPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const entries = ${JSON.stringify(secretByServiceAndAccount)};
if (args[0] === "find-generic-password" && args[1] === "-s" && args[3] === "-a" && args[5] === "-w") {
  const service = args[2];
  const account = args[4];
  const entry = entries[\`\${service}:\${account}\`];
  if (!entry) process.exit(44);
  process.stdout.write(JSON.stringify(entry));
  process.exit(0);
}
process.exit(44);
`,
    );
    chmodSync(securityPath, 0o755);
    return binDir;
  }

  function installSecurityTool(
    secretByServiceAndAccount: Record<string, Record<string, unknown>>,
  ): void {
    process.env.PATH = `${createSecurityTool(secretByServiceAndAccount)}:${originalPath ?? ""}`;
  }

  it("refreshes managed integrations and creates managed auth sessions for browser platforms", async () => {
    installSecurityTool({});
    const nativeBinaryDir = createTempDir("cued-native-binary-");
    const nativeBinaryPath = join(nativeBinaryDir, "CuedNative");
    writeFileSync(
      nativeBinaryPath,
      '#!/bin/sh\nif [ "$1" = "contacts" ] && [ "$2" = "status" ]; then\n  echo \'{"status":"authorized"}\'\n  exit 0\nfi\nexit 1\n',
    );
    chmodSync(nativeBinaryPath, 0o755);

    process.env.CUED_CONTACTS_NATIVE_BINARY = nativeBinaryPath;
    process.env.CUED_IMESSAGE_DB_PATH = join(createTempDir("cued-imessage-"), "missing.db");
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");
    process.env.CUED_APP_PATH = createPackagedSignalHelper();
    process.env.CUED_WHATSAPP_HELPER_BINARY = join(
      createTempDir("cued-no-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );

    const db = createDb();
    const refreshed = await refreshManagedIntegrationStates(db);
    expect(refreshed.refreshed).toBe(4);
    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          accountKey: "local",
          authState: "authorized",
        }),
        expect.objectContaining({
          platform: "imessage",
          accountKey: "local",
          authState: "missing",
        }),
        expect.objectContaining({
          platform: "signal",
          accountKey: "default",
          authState: "outdated",
        }),
        expect.objectContaining({
          platform: "whatsapp",
          accountKey: "default",
          authState: "blocked",
        }),
      ]),
    );

    const requested = requestIntegrationAccess(db, "slack");
    expect(requested.integration.platform).toBe("slack");
    expect(requested.integration.authState).toBe("requested");
    expect(requested.integration.accountKey).toBe("default");
    expect(requested.integration.runtimeKind).toBe("chromium");
    expect(requested.integration.metadata).toEqual(
      expect.objectContaining({
        authManagedBy: "chromium-runtime",
      }),
    );
    expect(requested.authSession.state).toBe("requested");
    expect(requested.authSession.platform).toBe("slack");

    const running = markAuthSessionInProgress(db, requested.authSession.id, 12345);
    expect(running.state).toBe("in_progress");
    expect(getAuthSessionSummary(db, requested.authSession.id)?.nativePid).toBe(12345);

    const completed = completeAuthSession(db, requested.authSession.id, {
      state: "authenticated",
      keychainService: "dev.cued.auth.slack",
      keychainAccount: "T123",
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(completed.integration).not.toBeNull();
    expect(completed.authSession).not.toBeNull();
    expect(completed.integration?.authState).toBe("authenticated");
    expect(completed.integration?.accountKey).toBe("T123");
    expect(completed.integration?.displayName).toBe("Acme");
    expect(completed.authSession?.keychainService).toBe("dev.cued.auth.slack");
    expect(completed.authSession?.accountKey).toBe("T123");
    expect(db.getIntegrationState("slack", requested.integration.accountKey)).toBeNull();

    const disabled = setIntegrationEnabled(db, "slack", completed.integration!.accountKey, false);
    expect(disabled.enabled).toBe(false);
    expect(listRequestableIntegrationPlatforms()).toEqual([
      "slack",
      "linkedin",
      "whatsapp",
      "signal",
    ]);
    expect(() => requestIntegrationAccess(db, "gmail")).toThrow(
      "Unsupported integration platform: gmail",
    );
    expect(() => requestIntegrationAccess(db, "discord")).toThrow(
      "Unsupported integration platform: discord",
    );
    const expectedContactsAvailability = resolveHostOS() === "macos" ? "available" : "unsupported";
    expect(buildIntegrationStatus(db).setupIntegrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          capability: expect.objectContaining({
            availability: expectedContactsAvailability,
          }),
        }),
        expect.objectContaining({
          platform: "linkedin",
          capability: expect.objectContaining({
            availability: "available",
          }),
        }),
        expect.objectContaining({
          platform: "signal",
          metadata: expect.objectContaining({
            authManagedBy: "signal-helper-runtime",
          }),
        }),
      ]),
    );
    expect(
      buildIntegrationStatus(db).setupIntegrations.map((integration) => integration.platform),
    ).toEqual(["contacts", "imessage", "slack", "linkedin", "whatsapp", "signal"]);
    db.close();
  });

  it("includes local native integrations in setup status before the first refresh", () => {
    process.env.CUED_IMESSAGE_DB_PATH = join(createTempDir("cued-imessage-"), "missing.db");

    const db = createDb();

    expect(
      buildIntegrationStatus(db).setupIntegrations.map((integration) => integration.platform),
    ).toEqual(["contacts", "imessage", "slack", "linkedin", "whatsapp", "signal"]);

    db.close();
  });

  it("can build setup status without live local permission probes", () => {
    const db = createDb();

    expect(
      buildIntegrationStatus(db, {
        includeLiveLocalIntegrations: false,
      }).setupIntegrations.map((integration) => ({
        platform: integration.platform,
        authState: integration.authState,
      })),
    ).toEqual([
      { platform: "contacts", authState: "unknown" },
      { platform: "imessage", authState: "unknown" },
      { platform: "slack", authState: "missing" },
      { platform: "linkedin", authState: "missing" },
      { platform: "whatsapp", authState: "missing" },
      { platform: "signal", authState: "missing" },
    ]);

    db.close();
  });

  it("refreshes only local integrations when using the local refresh path", () => {
    const nativeBinaryDir = createTempDir("cued-native-binary-");
    const nativeBinaryPath = join(nativeBinaryDir, "CuedNative");
    writeFileSync(
      nativeBinaryPath,
      '#!/bin/sh\nif [ "$1" = "contacts" ] && [ "$2" = "status" ]; then\n  echo \'{"status":"authorized"}\'\n  exit 0\nfi\nexit 1\n',
    );
    chmodSync(nativeBinaryPath, 0o755);

    process.env.CUED_CONTACTS_NATIVE_BINARY = nativeBinaryPath;
    process.env.CUED_IMESSAGE_DB_PATH = join(createTempDir("cued-imessage-"), "missing.db");
    process.env.CUED_APP_PATH = createPackagedSignalHelper();
    process.env.CUED_WHATSAPP_HELPER_BINARY = join(
      createTempDir("cued-no-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );

    const db = createDb();

    const refreshed = refreshLocalIntegrationStates(db);

    expect(refreshed.refreshed).toBe(2);
    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          authState: "authorized",
        }),
        expect.objectContaining({
          platform: "imessage",
          authState: "missing",
        }),
      ]),
    );
    expect(listIntegrationStates(db).some((integration) => integration.platform === "signal")).toBe(
      false,
    );
    expect(
      listIntegrationStates(db).some((integration) => integration.platform === "whatsapp"),
    ).toBe(false);

    db.close();
  });

  it("repairs stale linkedin sync capability on refresh", async () => {
    installSecurityTool({});
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");

    const db = createDb();
    db.upsertIntegrationState({
      platform: "linkedin",
      accountKey: "default",
      displayName: "LinkedIn",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "chromium-auth",
      launchTarget: "https://www.linkedin.com/login",
      importedFrom: "local-cli",
      metadata: {
        supportedByDaemon: false,
      },
    });

    await refreshManagedIntegrationStates(db);

    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "linkedin",
          accountKey: "default",
          authState: "authenticated",
          syncCapable: true,
          metadata: expect.objectContaining({
            supportedByDaemon: true,
          }),
        }),
      ]),
    );
    db.close();
  });

  it("imports stored LinkedIn auth into a fresh database on refresh", async () => {
    installSecurityTool({
      "dev.cued.auth.linkedin:default": {
        cookies: [
          { name: "li_at", value: "li_at-token" },
          { name: "JSESSIONID", value: '"ajax:123"' },
        ],
        savedAt: 1234,
      },
    });
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");

    const db = createDb();
    await refreshManagedIntegrationStates(db);

    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "linkedin",
          accountKey: "default",
          authState: "authenticated",
          syncCapable: true,
          metadata: expect.objectContaining({
            keychainService: "dev.cued.auth.linkedin",
            keychainAccount: "default",
            importedSavedAt: 1234,
          }),
        }),
      ]),
    );
    expect(db.getLatestAuthSession("linkedin", "default")).toMatchObject({
      state: "authenticated",
      keychain_service: "dev.cued.auth.linkedin",
      keychain_account: "default",
    });

    db.close();
  });

  it("repairs stale slack sync capability only when the helper is available", async () => {
    installSecurityTool({});
    process.env.CUED_SLACK_HELPER_BINARY = createSlackHelper();

    const db = createDb();
    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T123",
      displayName: "Acme",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: false,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "slack-desktop-cdp",
      metadata: {
        authManagedBy: "chromium-runtime",
      },
    });

    await refreshManagedIntegrationStates(db);

    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "slack",
          accountKey: "T123",
          authState: "authenticated",
          syncCapable: true,
          metadata: expect.objectContaining({
            syncTransport: "slack-helper",
            slackHelperVersion: "0.1.0",
            slackHelperVersionSupported: true,
          }),
        }),
      ]),
    );
    db.close();
  });

  it("uses the linked Signal account as the display label after auth", () => {
    const db = createDb();
    const requested = requestIntegrationAccess(db, "signal");

    const completed = completeAuthSession(db, requested.authSession.id, {
      state: "authenticated",
      resultSummary: { linkedAccount: "+15551234567" },
    });

    expect(completed.integration?.platform).toBe("signal");
    expect(completed.integration?.displayName).toBe("+15551234567");
    db.close();
  });

  it("prefers the WhatsApp push name as the display label after auth", () => {
    const db = createDb();
    const requested = requestIntegrationAccess(db, "whatsapp");

    const completed = completeAuthSession(db, requested.authSession.id, {
      state: "authenticated",
      resultSummary: {
        accountJid: "15551234567@s.whatsapp.net",
        pushName: "Theo",
      },
    });

    expect(completed.integration?.platform).toBe("whatsapp");
    expect(completed.integration?.displayName).toBe("Theo");
    db.close();
  });

  it("removes a requestable integration and its local browser profile", () => {
    const db = createDb();
    const profileDir = createTempDir("cued-slack-profile-");

    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T123",
      displayName: "Acme",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "local-cli",
      metadata: {
        browserProfileDir: profileDir,
      },
    });

    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "slack",
          accountKey: "T123",
        }),
      ]),
    );

    const removed = removeIntegration(db, "slack", "T123");
    expect(removed).toEqual({
      platform: "slack",
      accountKey: "T123",
      removed: true,
    });
    expect(db.getIntegrationState("slack", "T123")).toMatchObject({
      platform: "slack",
      account_key: "T123",
      auth_state: "cancelled",
      enabled: 0,
      sync_capable: 0,
    });
    expect(listIntegrationStates(db)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "slack",
          accountKey: "T123",
        }),
      ]),
    );

    db.close();
  });

  it("removes a signal integration and its local config directory", () => {
    const db = createDb();
    const configDir = createTempDir("cued-signal-config-");
    mkdirSync(configDir, { recursive: true });

    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
      authState: "authenticated",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {
        configDir,
      },
    });

    const removed = removeIntegration(db, "signal", "default");
    expect(removed).toEqual({
      platform: "signal",
      accountKey: "default",
      removed: true,
    });
    expect(existsSync(configDir)).toBe(false);
    expect(db.getIntegrationState("signal", "default")).toMatchObject({
      platform: "signal",
      account_key: "default",
      auth_state: "cancelled",
      enabled: 0,
      sync_capable: 0,
    });
    expect(listIntegrationStates(db)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "signal",
          accountKey: "default",
        }),
      ]),
    );

    db.close();
  });

  it("does not resurrect a removed signal integration during managed helper refresh", async () => {
    installSecurityTool({});
    process.env.CUED_APP_PATH = createPackagedSignalHelper("0.14.1");
    process.env.CUED_WHATSAPP_HELPER_BINARY = join(
      createTempDir("cued-missing-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");

    const db = createDb();
    const configDir = createTempDir("cued-signal-config-");
    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
      authState: "authenticated",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: { configDir },
    });

    removeIntegration(db, "signal", "default");
    await refreshManagedIntegrationStates(db);

    expect(db.getIntegrationState("signal", "default")).toMatchObject({
      platform: "signal",
      account_key: "default",
      auth_state: "cancelled",
      enabled: 0,
      sync_capable: 0,
    });
    expect(listIntegrationStates(db)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: "signal" })]),
    );

    db.close();
  });

  it("clears account-scoped sync state when removing an integration", () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
      authState: "authenticated",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {},
    });
    db.upsertSourceAccount({
      platform: "signal",
      accountKey: "default",
      displayName: "Signal",
    });
    db.upsertCheckpoint({
      platform: "signal",
      accountKey: "default",
      syncMode: "incremental",
      sourceCursor: { cursor: "stale" },
      lastSuccessAt: Date.now(),
    });
    db.upsertSyncProof({
      platform: "signal",
      accountKey: "default",
      proof: {
        scope: { kind: "account", key: "default" },
        proofKind: "messages",
        status: "complete",
        syncMode: "incremental",
        observedAt: Date.now(),
      },
    });
    db.queueSyncRun({
      platform: "signal",
      accountKey: "default",
      runType: "sync",
      trigger: "test",
    });

    expect(db.getOverview().sourceAccounts).toBe(1);
    expect(db.getCheckpoint("signal", "default")).not.toBeNull();
    expect(db.listSyncProofs("signal", "default")).toHaveLength(1);
    expect(db.hasQueuedOrRunningRun("signal", "default")).toBe(true);

    removeIntegration(db, "signal", "default");

    expect(db.getOverview().sourceAccounts).toBe(0);
    expect(db.getCheckpoint("signal", "default")).toBeNull();
    expect(db.listSyncProofs("signal", "default")).toHaveLength(0);
    expect(db.hasQueuedOrRunningRun("signal", "default")).toBe(false);

    db.close();
  });

  it("reuses the same stable slack workspace key after remove and reconnect", () => {
    const db = createDb();

    const firstRequest = requestIntegrationAccess(db, "slack");
    const firstCompleted = completeAuthSession(db, firstRequest.authSession.id, {
      state: "authenticated",
      keychainService: "dev.cued.auth.slack",
      keychainAccount: "T123",
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(firstCompleted.integration?.accountKey).toBe("T123");

    const removed = removeIntegration(db, "slack", "T123");
    expect(removed.accountKey).toBe("T123");

    const secondRequest = requestIntegrationAccess(db, "slack");
    expect(secondRequest.integration.accountKey).toBe("default");

    const secondCompleted = completeAuthSession(db, secondRequest.authSession.id, {
      state: "authenticated",
      keychainService: "dev.cued.auth.slack",
      keychainAccount: "T123",
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(secondCompleted.integration?.accountKey).toBe("T123");
    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "slack",
          accountKey: "T123",
          authState: "authenticated",
        }),
      ]),
    );
    db.close();
  });

  it("cancels an in-flight auth session before removing the integration", () => {
    const db = createDb();
    const requested = requestIntegrationAccess(db, "slack");

    markAuthSessionInProgress(db, requested.authSession.id, 12345);

    const removed = removeIntegration(db, "slack", requested.integration.accountKey);
    expect(removed).toEqual({
      platform: "slack",
      accountKey: requested.integration.accountKey,
      removed: true,
    });

    const completed = completeAuthSession(db, requested.authSession.id, {
      state: "authenticated",
      keychainService: "dev.cued.auth.slack",
      keychainAccount: "T123",
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(completed.integration).toBeNull();
    expect(completed.authSession).toBeNull();
    expect(db.getIntegrationState("slack", requested.integration.accountKey)).toMatchObject({
      auth_state: "cancelled",
      enabled: 0,
      sync_capable: 0,
    });

    db.close();
  });

  it("refreshes signal and whatsapp managed states for every persisted account", async () => {
    installSecurityTool({});
    process.env.CUED_SIGNAL_CLI_PATH = join(
      createTempDir("cued-missing-signal-cli-"),
      "signal-cli",
    );
    process.env.CUED_WHATSAPP_HELPER_BINARY = join(
      createTempDir("cued-missing-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );
    process.env.CUED_SLACK_APP_BINARY = join(createTempDir("cued-no-slack-app-"), "Slack");

    const db = createDb();
    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "signal-a",
      displayName: "Signal A",
      authState: "authenticated",
      enabled: true,
      connectionKind: "local-cli",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {
        configDir: "/tmp/old-signal-a",
      },
    });
    db.upsertIntegrationState({
      platform: "signal",
      accountKey: "signal-b",
      displayName: "Signal B",
      authState: "authenticated",
      enabled: false,
      connectionKind: "local-cli",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "local-cli",
      metadata: {
        configDir: "/tmp/old-signal-b",
      },
    });
    db.upsertIntegrationState({
      platform: "whatsapp",
      accountKey: "whatsapp-a",
      displayName: "WhatsApp A",
      authState: "authenticated",
      enabled: true,
      connectionKind: "qr-link",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "bundled-helper",
      metadata: {
        storeDir: "/tmp/old-whatsapp-a",
      },
    });
    db.upsertIntegrationState({
      platform: "whatsapp",
      accountKey: "whatsapp-b",
      displayName: "WhatsApp B",
      authState: "authenticated",
      enabled: false,
      connectionKind: "qr-link",
      syncCapable: true,
      launchStrategy: "qr-native",
      launchTarget: null,
      importedFrom: "bundled-helper",
      metadata: {
        storeDir: "/tmp/old-whatsapp-b",
      },
    });

    const refreshed = await refreshManagedIntegrationStates(db);

    expect(refreshed.refreshed).toBe(10);
    expect(listIntegrationStates(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "signal",
          accountKey: "signal-a",
          enabled: true,
          metadata: expect.objectContaining({
            configDir: expect.stringContaining("/signal-a"),
          }),
        }),
        expect.objectContaining({
          platform: "signal",
          accountKey: "signal-b",
          enabled: false,
          metadata: expect.objectContaining({
            configDir: expect.stringContaining("/signal-b"),
          }),
        }),
        expect.objectContaining({
          platform: "whatsapp",
          accountKey: "whatsapp-a",
          enabled: true,
          metadata: expect.objectContaining({
            storeDir: expect.stringContaining("/whatsapp-a"),
          }),
        }),
        expect.objectContaining({
          platform: "whatsapp",
          accountKey: "whatsapp-b",
          enabled: false,
          metadata: expect.objectContaining({
            storeDir: expect.stringContaining("/whatsapp-b"),
          }),
        }),
      ]),
    );
    expect(listIntegrationStates(db)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "signal",
          accountKey: "default",
        }),
        expect.objectContaining({
          platform: "whatsapp",
          accountKey: "default",
        }),
      ]),
    );
    db.close();
  });

  it("falls back safely when persisted integration and auth JSON is malformed", () => {
    const db = createDb();

    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "T123",
      displayName: "Acme",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "local-cli",
      artifactPaths: ["/tmp/profile"],
      metadata: { browserProfileDir: "/tmp/profile", supportedByDaemon: true },
    });

    const sessionId = db.createAuthSession({
      platform: "slack",
      accountKey: "T123",
      integrationStateId: "slack:T123",
      state: "requested",
    });
    db.updateAuthSessionState({
      id: sessionId,
      state: "authenticated",
      resultSummary: { teamId: "T123" },
    });

    const sqlite = (
      db as unknown as {
        sqlite: {
          prepare: (sql: string) => {
            run: (...params: unknown[]) => void;
          };
        };
      }
    ).sqlite;
    sqlite
      .prepare(
        `
          UPDATE integration_states
          SET metadata_json = ?, artifact_paths_json = ?
          WHERE platform = ? AND account_key = ?
        `,
      )
      .run("{", '{"not":"an-array"}', "slack", "T123");
    sqlite
      .prepare("UPDATE auth_sessions SET result_summary_json = ? WHERE id = ?")
      .run("{", sessionId);

    const integration = buildIntegrationStatus(db).integrations.find(
      (entry) => entry.platform === "slack" && entry.accountKey === "T123",
    );
    const authSession = getAuthSessionSummary(db, sessionId);

    expect(integration).toEqual(
      expect.objectContaining({
        platform: "slack",
        accountKey: "T123",
        metadata: null,
        artifactPaths: [],
      }),
    );
    expect(authSession).toEqual(
      expect.objectContaining({
        id: sessionId,
        resultSummary: null,
      }),
    );
    db.close();
  });

  it("cancels older pending auth sessions before creating a new request", () => {
    const db = createDb();

    const first = requestIntegrationAccess(db, "whatsapp");
    const second = requestIntegrationAccess(db, "whatsapp");

    expect(db.getAuthSession(first.authSession.id)?.state).toBe("cancelled");
    expect(db.getAuthSession(first.authSession.id)?.error_summary).toBe(
      "Superseded by a newer auth session request",
    );
    expect(second.authSession.state).toBe("requested");
    db.close();
  });
});
