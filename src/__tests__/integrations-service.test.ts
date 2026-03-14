import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import {
  buildIntegrationStatus,
  completeAuthSession,
  getAuthSessionSummary,
  listIntegrationStates,
  listRequestableIntegrationPlatforms,
  markAuthSessionInProgress,
  refreshManagedIntegrationStates,
  requestIntegrationAccess,
  setIntegrationEnabled,
} from "../integrations/service.js";
import { resolveHostOS } from "../platform-capabilities.js";

describe("integration state management", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_DB_PATH;
    delete process.env.CUED_SLACK_APP_BINARY;
    delete process.env.CUED_SIGNAL_CLI_PATH;
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

  it("refreshes managed integrations and creates managed auth sessions for browser platforms", async () => {
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
    process.env.CUED_SIGNAL_CLI_PATH = join(createTempDir("cued-no-signal-cli-"), "signal-cli");
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
      keychainAccount: requested.integration.accountKey,
      resultSummary: { teamId: "T123", teamName: "Acme" },
    });
    expect(completed.integration.authState).toBe("authenticated");
    expect(completed.authSession.keychainService).toBe("dev.cued.auth.slack");

    const disabled = setIntegrationEnabled(db, "slack", requested.integration.accountKey, false);
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
      ]),
    );
    db.close();
  });

  it("repairs stale linkedin sync capability on refresh", async () => {
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
