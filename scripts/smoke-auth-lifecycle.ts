import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

type PlatformCase = {
  platform: "discord" | "linkedin" | "signal" | "slack" | "whatsapp";
  initialAccount: string;
  finalAccount: string;
  runtime: "chromium" | "qr_native";
  fakeResult: Json;
  artifactMetadataKey: "browserProfileDir" | "configDir" | "storeDir";
};

type IntegrationRow = {
  platform: string;
  account_key: string;
  auth_state: string;
  enabled: number;
  sync_capable: number;
  metadata_json: string | null;
};

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const cuedHome =
  process.env.CUED_AUTH_SMOKE_HOME || mkdtempSync(join(tmpdir(), "cued-auth-smoke-"));
const shadowKeychainService = `dev.cued.smoke.auth.${runId}`;
const cleanup = process.env.CUED_AUTH_SMOKE_KEEP_HOME !== "1";

const cases: PlatformCase[] = [
  {
    platform: "slack",
    initialAccount: `pending-slack-${runId}`,
    finalAccount: `T_SMOKE_${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`,
    runtime: "chromium",
    artifactMetadataKey: "browserProfileDir",
    fakeResult: {
      resultSummary: {
        provider: "slack",
        teamName: "Smoke Slack",
        userId: "U_SMOKE",
      },
    },
  },
  {
    platform: "discord",
    initialAccount: "default",
    finalAccount: "default",
    runtime: "chromium",
    artifactMetadataKey: "browserProfileDir",
    fakeResult: {
      resultSummary: {
        provider: "discord",
        userId: "discord-smoke-user",
        username: "cued-smoke",
        displayName: "Cued Smoke",
      },
    },
  },
  {
    platform: "linkedin",
    initialAccount: "default",
    finalAccount: "default",
    runtime: "chromium",
    artifactMetadataKey: "browserProfileDir",
    fakeResult: {
      resultSummary: {
        provider: "linkedin",
        cookieCount: 3,
        realtimeReady: true,
        pageInstanceCaptured: true,
        xLiTrackCaptured: true,
        realtimeQueryMapCaptured: true,
        realtimeRecipeMapCaptured: true,
      },
    },
  },
  {
    platform: "signal",
    initialAccount: "default",
    finalAccount: "default",
    runtime: "qr_native",
    artifactMetadataKey: "configDir",
    fakeResult: {
      resultSummary: {
        linkedAccount: "+15555550123",
      },
    },
  },
  {
    platform: "whatsapp",
    initialAccount: "default",
    finalAccount: "default",
    runtime: "qr_native",
    artifactMetadataKey: "storeDir",
    fakeResult: {
      resultSummary: {
        accountJid: "15555550123:1@s.whatsapp.net",
        pushName: "Cued Smoke",
      },
    },
  },
];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);
  if (start === -1) {
    fail(`Command did not return JSON: ${trimmed}`);
  }
  return JSON.parse(trimmed.slice(start));
}

function runCued(args: string[], extraEnv: Record<string, string> = {}): unknown {
  const stdout = execFileSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CUED_HOME: cuedHome,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return extractJson(stdout);
}

function runSql(sql: string): unknown {
  return runCued(["sql", sql]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function metadata(row: IntegrationRow): Json {
  return row.metadata_json ? (JSON.parse(row.metadata_json) as Json) : {};
}

function integrationRow(platform: string, accountKey: string): IntegrationRow {
  const rows = runSql(
    `SELECT platform, account_key, auth_state, enabled, sync_capable, metadata_json
     FROM integration_states
     WHERE platform = '${platform}' AND account_key = '${accountKey}'`,
  ) as IntegrationRow[];
  assert(rows.length === 1, `Expected one integration row for ${platform}/${accountKey}`);
  return rows[0]!;
}

function latestAuthSession(platform: string, accountKey: string): Json {
  const rows = runSql(
    `SELECT platform, account_key, state, keychain_service, keychain_account, error_summary
     FROM auth_sessions
     WHERE platform = '${platform}' AND account_key = '${accountKey}'
     ORDER BY requested_at DESC, created_at DESC
     LIMIT 1`,
  ) as Json[];
  assert(rows.length === 1, `Expected latest auth session for ${platform}/${accountKey}`);
  return rows[0]!;
}

function queuedSyncRuns(platform: string, accountKey: string): Json[] {
  return runSql(
    `SELECT platform, account_key, run_type, status, trigger
     FROM sync_runs
     WHERE platform = '${platform}' AND account_key = '${accountKey}'
     ORDER BY queued_at DESC`,
  ) as Json[];
}

function security(args: string[]): spawnSync {
  return spawnSync("security", args, { stdio: ["ignore", "ignore", "ignore"] });
}

function seedShadowKeychain(service: string, account: string): void {
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      JSON.stringify({ smoke: true, runId, savedAt: Date.now() }),
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}

function keychainExists(service: string, account: string): boolean {
  return security(["find-generic-password", "-s", service, "-a", account, "-w"]).status === 0;
}

function deleteShadowKeychain(service: string, account: string): void {
  security(["delete-generic-password", "-s", service, "-a", account]);
}

function makeFakeEnv(testCase: PlatformCase, accountKey: string): Record<string, string> {
  const keychainAccount = testCase.runtime === "chromium" ? testCase.finalAccount : accountKey;
  const fake = {
    state: "authenticated",
    keychainService: testCase.runtime === "chromium" ? shadowKeychainService : null,
    keychainAccount: testCase.runtime === "chromium" ? keychainAccount : null,
    resultSummary: {
      provider: testCase.platform,
      ...(testCase.platform === "slack" ? { teamId: testCase.finalAccount } : {}),
      ...testCase.fakeResult.resultSummary,
    },
  };
  return testCase.runtime === "chromium"
    ? { CUED_FAKE_CHROMIUM_AUTH_RESULT: JSON.stringify(fake) }
    : { CUED_FAKE_QR_AUTH_RESULT: JSON.stringify(fake) };
}

function connect(testCase: PlatformCase, accountKey: string): Json {
  const result = runCued(
    ["integrations", "connect", testCase.platform, accountKey],
    makeFakeEnv(testCase, accountKey),
  ) as Json;
  const authSession = result.authSession as Json;
  const integration = result.integration as Json;
  assert(
    authSession?.state === "authenticated",
    `${testCase.platform} connect did not authenticate`,
  );
  assert(
    integration?.authState === "authenticated",
    `${testCase.platform} integration was not authenticated`,
  );
  assert(integration?.syncCapable === true, `${testCase.platform} was not sync-capable after auth`);
  const account = String(integration?.accountKey);
  assert(
    account === testCase.finalAccount,
    `${testCase.platform} account key mismatch: expected ${testCase.finalAccount}, got ${account}`,
  );
  assert(
    queuedSyncRuns(testCase.platform, account).some(
      (run) => run.trigger === "integration_authenticated",
    ),
    `${testCase.platform} auth did not queue a sync run`,
  );
  return integration;
}

function prepareArtifact(testCase: PlatformCase, row: IntegrationRow): string {
  const path = metadata(row)[testCase.artifactMetadataKey];
  assert(typeof path === "string" && path.length > 0, `${testCase.platform} artifact path missing`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".cued-auth-smoke"), runId);
  assert(existsSync(path), `${testCase.platform} artifact path was not created`);
  return path;
}

function assertDisconnected(testCase: PlatformCase, accountKey: string): void {
  const row = integrationRow(testCase.platform, accountKey);
  const meta = metadata(row);
  assert(row.auth_state === "cancelled", `${testCase.platform} disconnect did not cancel auth`);
  assert(row.enabled === 0, `${testCase.platform} disconnect did not disable integration`);
  assert(
    meta.keychainService == null,
    `${testCase.platform} kept keychain service after disconnect`,
  );
  assert(
    meta.keychainAccount == null,
    `${testCase.platform} kept keychain account after disconnect`,
  );
}

function assertRemoved(testCase: PlatformCase, accountKey: string, artifactPath: string): void {
  const row = integrationRow(testCase.platform, accountKey);
  const meta = metadata(row);
  assert(row.auth_state === "cancelled", `${testCase.platform} remove did not cancel auth`);
  assert(row.enabled === 0, `${testCase.platform} remove did not disable integration`);
  assert(row.sync_capable === 0, `${testCase.platform} remove left sync enabled`);
  assert(meta.userRemoved === true, `${testCase.platform} remove did not set tombstone`);
  assert(meta.removedAt != null, `${testCase.platform} remove did not persist removedAt`);
  assert(!existsSync(artifactPath), `${testCase.platform} remove did not delete ${artifactPath}`);
}

function smokeNativeLocalRows(): void {
  runCued(["integrations", "refresh"]);
  for (const platform of ["contacts", "imessage"]) {
    const rows = runSql(
      `SELECT platform, account_key, connection_kind, auth_state
       FROM integration_states
       WHERE platform = '${platform}' AND account_key = 'local'`,
    ) as Json[];
    assert(rows.length === 1, `${platform} local integration row missing`);
    assert(rows[0]?.connection_kind === "native", `${platform} was not native`);
    assert(
      typeof rows[0]?.auth_state === "string" && rows[0].auth_state !== "requested",
      `${platform} local auth state was not refreshed`,
    );
  }
  log("native local rows: contacts/imessage refreshed");
}

function smokePlatform(testCase: PlatformCase): void {
  log(`smoke ${testCase.platform}: connect`);
  connect(testCase, testCase.initialAccount);
  let row = integrationRow(testCase.platform, testCase.finalAccount);
  let artifactPath = prepareArtifact(testCase, row);
  if (testCase.runtime === "chromium") {
    seedShadowKeychain(shadowKeychainService, testCase.finalAccount);
    assert(
      keychainExists(shadowKeychainService, testCase.finalAccount),
      `${testCase.platform} shadow keychain seed failed`,
    );
  }

  log(`smoke ${testCase.platform}: disconnect`);
  runCued(["integrations", "disconnect", testCase.platform, testCase.finalAccount]);
  assertDisconnected(testCase, testCase.finalAccount);
  if (testCase.runtime === "chromium") {
    assert(
      !keychainExists(shadowKeychainService, testCase.finalAccount),
      `${testCase.platform} disconnect did not delete shadow keychain item`,
    );
  }

  log(`smoke ${testCase.platform}: reconnect after disconnect`);
  connect(testCase, testCase.finalAccount);
  row = integrationRow(testCase.platform, testCase.finalAccount);
  artifactPath = prepareArtifact(testCase, row);
  if (testCase.runtime === "chromium") {
    seedShadowKeychain(shadowKeychainService, testCase.finalAccount);
  }

  log(`smoke ${testCase.platform}: remove`);
  const removeResult = runCued([
    "integrations",
    "remove",
    testCase.platform,
    testCase.finalAccount,
  ]) as Json;
  assert(
    removeResult.removed === true,
    `${testCase.platform} remove command did not report removed`,
  );
  assertRemoved(testCase, testCase.finalAccount, artifactPath);
  if (testCase.runtime === "chromium") {
    assert(
      !keychainExists(shadowKeychainService, testCase.finalAccount),
      `${testCase.platform} remove did not delete shadow keychain item`,
    );
  }

  log(`smoke ${testCase.platform}: reconnect after remove`);
  connect(testCase, testCase.finalAccount);
  row = integrationRow(testCase.platform, testCase.finalAccount);
  assert(
    metadata(row).userRemoved !== true,
    `${testCase.platform} reconnect kept userRemoved tombstone`,
  );
  const latest = latestAuthSession(testCase.platform, testCase.finalAccount);
  assert(
    latest.state === "authenticated",
    `${testCase.platform} latest auth session is not authenticated`,
  );

  runCued(["integrations", "remove", testCase.platform, testCase.finalAccount]);
  if (testCase.runtime === "chromium") {
    deleteShadowKeychain(shadowKeychainService, testCase.finalAccount);
  }
}

try {
  log(`auth lifecycle smoke home: ${cuedHome}`);
  smokeNativeLocalRows();
  for (const testCase of cases) {
    smokePlatform(testCase);
  }
  log("auth lifecycle smoke passed");
} finally {
  for (const testCase of cases) {
    if (testCase.runtime === "chromium") {
      deleteShadowKeychain(shadowKeychainService, testCase.finalAccount);
    }
  }
  if (cleanup) {
    rmSync(cuedHome, { recursive: true, force: true });
  } else {
    log(`kept smoke home: ${cuedHome}`);
  }
}
