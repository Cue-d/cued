import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CuedDatabase } from "../db/database.js";
import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding snapshot", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.CUED_CONTACTS_NATIVE_BINARY;
    delete process.env.CUED_IMESSAGE_DB_PATH;
    delete process.env.CUED_SLACK_APP_BINARY;
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
    const dir = createTempDir("cued-onboarding-db-");
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

  it("builds one snapshot with fresh permissions and onboarding integrations", async () => {
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
    const snapshot = await buildOnboardingSnapshot(db, { refreshManagedIntegrations: true });

    expect(snapshot.permissions.map((permission) => permission.key)).toEqual([
      "contacts",
      "full_disk_access",
      "messages_automation",
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
});
