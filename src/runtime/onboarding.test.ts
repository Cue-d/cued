import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IMESSAGE_CONFIG,
  NATIVE_RUNTIME_CONFIG,
  SIGNAL_CLI_CONFIG,
  SLACK_DESKTOP_IMPORT_CONFIG,
} from "../core/config.js";
import { CuedDatabase } from "../db/database.js";
import { WHATSAPP_HELPER_CONFIG } from "../platforms/whatsapp/helper/pair.js";
import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding snapshot", () => {
  const tempDirs: string[] = [];
  const originalIMessageDbPath = IMESSAGE_CONFIG.chatDbPath;
  const originalNativeRepoRoot = NATIVE_RUNTIME_CONFIG.repoRoot;
  const originalSignalRepoRoot = SIGNAL_CLI_CONFIG.repoRoot;
  const originalSlackAppBinary = SLACK_DESKTOP_IMPORT_CONFIG.appBinary;
  const originalWhatsAppHelperBinary = WHATSAPP_HELPER_CONFIG.helperBinary;

  afterEach(() => {
    WHATSAPP_HELPER_CONFIG.helperBinary = originalWhatsAppHelperBinary;
    IMESSAGE_CONFIG.chatDbPath = originalIMessageDbPath;
    NATIVE_RUNTIME_CONFIG.repoRoot = originalNativeRepoRoot;
    SIGNAL_CLI_CONFIG.repoRoot = originalSignalRepoRoot;
    SLACK_DESKTOP_IMPORT_CONFIG.appBinary = originalSlackAppBinary;

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
    const dir = createTempDir("cued-onboarding-db-");
    const db = new CuedDatabase(join(dir, "local.db"));
    db.migrate();
    return db;
  }

  function installSignalHelper(version = "0.12.9"): void {
    const repoRoot = createTempDir("cued-signal-repo-");
    SIGNAL_CLI_CONFIG.repoRoot = repoRoot;
    const helperPath = join(
      repoRoot,
      "native",
      "helpers",
      "signal-cli",
      ".build",
      "cued-signal-cli",
      "cued-signal-cli",
    );
    mkdirSync(join(helperPath, ".."), { recursive: true });
    writeFileSync(helperPath, `#!/bin/sh\necho "signal-cli ${version}"\n`);
    chmodSync(helperPath, 0o755);
  }

  function installNativeBinary(contents: string): string {
    const repoRoot = createTempDir("cued-native-repo-");
    NATIVE_RUNTIME_CONFIG.repoRoot = repoRoot;
    const nativeBinaryPath = join(
      repoRoot,
      "native",
      "macos",
      "CuedNative",
      ".build",
      "release",
      "CuedNative",
    );
    mkdirSync(join(nativeBinaryPath, ".."), { recursive: true });
    writeFileSync(nativeBinaryPath, contents);
    chmodSync(nativeBinaryPath, 0o755);
    return nativeBinaryPath;
  }

  it("builds one snapshot with fresh permissions and onboarding integrations", async () => {
    installNativeBinary(
      '#!/bin/sh\nif [ "$1" = "contacts" ] && [ "$2" = "status" ]; then\n  echo \'{"status":"authorized"}\'\n  exit 0\nfi\nexit 1\n',
    );

    IMESSAGE_CONFIG.chatDbPath = join(createTempDir("cued-imessage-"), "missing.db");
    SLACK_DESKTOP_IMPORT_CONFIG.appBinary = join(createTempDir("cued-no-slack-app-"), "Slack");
    installSignalHelper();
    WHATSAPP_HELPER_CONFIG.helperBinary = join(
      createTempDir("cued-no-whatsapp-helper-"),
      "cued-whatsapp-helper",
    );

    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db, { refreshManagedIntegrations: true });

    expect(snapshot.permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
      "diagnostics",
    ]);
    expect(snapshot.globalSkill).toEqual(
      expect.objectContaining({
        installed: expect.any(Boolean),
        status: expect.any(String),
      }),
    );
    expect(snapshot.permissions.find((permission) => permission.key === "contacts")).toEqual(
      expect.objectContaining({
        status: process.platform === "darwin" ? "granted" : "unknown",
      }),
    );
    expect(snapshot.permissions.find((permission) => permission.key === "diagnostics")).toEqual(
      expect.objectContaining({
        status: "disabled",
        summary: "Redacted diagnostic reporting is disabled",
      }),
    );
    expect(snapshot.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "contacts",
          accountKey: "local",
          authState: "authorized",
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
    expect(snapshot.setupIntegrations.map((integration) => integration.platform)).toEqual([
      "contacts",
      "imessage",
      "slack",
      "discord",
      "gmail",
      "linkedin",
      "whatsapp",
      "signal",
    ]);

    db.close();
  });

  it("ignores unsupported persisted integrations when building the snapshot", async () => {
    const db = createDb();
    db.upsertIntegrationState({
      platform: "telegram" as never,
      accountKey: "default",
      displayName: "Telegram",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://web.telegram.org",
      importedFrom: "local-cli",
    });

    const snapshot = await buildOnboardingSnapshot(db);

    expect(
      snapshot.integrations.some((integration) => String(integration.platform) === "telegram"),
    ).toBe(false);
    expect(snapshot.setupIntegrations.map((integration) => integration.platform)).toEqual([
      "contacts",
      "imessage",
      "slack",
      "discord",
      "gmail",
      "linkedin",
      "whatsapp",
      "signal",
    ]);

    db.close();
  });

  it("keeps the Signal setup row connectable before helper diagnostics are refreshed", async () => {
    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db, { refreshManagedIntegrations: false });
    const signal = snapshot.setupIntegrations.find(
      (integration) => integration.platform === "signal",
    );

    expect(signal).toEqual(
      expect.objectContaining({
        accountKey: "default",
        authState: "missing",
        capability: expect.objectContaining({
          availability: "available",
          onboardingVisible: true,
        }),
      }),
    );

    db.close();
  });

  it("includes a relationship summary for the onboarding application page", async () => {
    const db = createDb();
    const snapshot = await buildOnboardingSnapshot(db);

    expect(snapshot.relationshipSummary).toEqual({
      messages: 0,
      contacts: 0,
      phoneCalls: 0,
      pendingProjectionEvents: 0,
      lastUpdatedAt: null,
      source: "database",
    });

    db.close();
  });
});
