/**
 * Daemon responsiveness benchmark.
 *
 * Starts an isolated daemon against a synthetic real-scale database and measures what the
 * desktop UI actually feels:
 *
 *   1. Event-loop stall: a persistent socket pings the daemon continuously; the worst ping
 *      latency during a scenario is how long the daemon was unable to answer anything.
 *   2. Request round trip: latency of the requests the UI sends, over a persistent socket.
 *   3. Legacy transport: the same request by spawning the CLI, which is what the UI paid
 *      before it spoke to the socket directly.
 *
 * Usage:
 *   pnpm build && pnpm test:perf:responsiveness [--assert] [--scale 0.1] [--cli path/to/cli.js]
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  FAKE_HELPER_IMESSAGE_LINES,
  fillLargeConversation,
  IMESSAGE_BATCH_ENV,
  largeConversationDeliveryBatch,
  largeConversationRenameBatch,
  ProjectionWorkerMemorySampler,
  SEARCH_REINDEX_COUNTER_SQL,
  seedLargeConversation,
} from "./large-conversation.js";

const FIXTURE_VERSION = 3;
const FIXTURE_DB_KEY = "cued-perf-fixture-key";
const REAL_SCALE = {
  syncRuns: 1_800_000,
  syncRunErrors: 58_700,
  authSessions: 1_000,
  contacts: 17_600,
  conversations: 65_500,
  messages: 500_000,
  rawEvents: 400_000,
};
const REMOVE_TARGET = { platform: "slack", accountKey: "T0PERF0001" };
const TOGGLE_TARGET = { platform: "gmail", accountKey: "perf-b@example.com" };
const SYNC_CONTACT_COUNT = 3_000;
// Keeps the benchmark daemon out of the real keychain: every lookup reports "not found".
const FAKE_SECURITY_CLI = "#!/bin/sh\nexit 44\n";
// Stands in for the packaged native helper: same interface, and about as slow to spawn, so the
// daemon pays what it pays in the installed app for every Contacts/Messages access probe.
const FAKE_NATIVE_HELPER = `#!/bin/sh
sleep 0.02
${FAKE_HELPER_IMESSAGE_LINES}if [ "$1" = "contacts" ] && [ "$2" = "status" ]; then
  echo '{"status":"authorized"}'
  exit 0
fi
exit 1
`;
const TARGETS = {
  stallMaxMs: 50,
  roundTripP95Ms: 20,
};
// Migrations that fix what this benchmark measures. The fixture is rewound to before them so
// a run always exercises the upgrade path a real long-lived database takes.
const REWOUND_MIGRATION_IDS = ["0026_sync_run_errors_run_index"];
const REWOUND_INDEXES = [
  "idx_sync_run_errors_sync_run_id",
  "idx_sync_run_errors_platform_account_created",
];

type Options = {
  cliPath: string;
  nodePath: string;
  scale: number;
  assert: boolean;
  keep: boolean;
  jsonPath: string | null;
  requestTimeoutMs: number;
  label: string;
  /**
   * Shell command to run against the live benchmark daemon (its socket is in
   * CUED_PERF_DAEMON_SOCKET), for clients in other languages. Must exit 0.
   */
  exec: string | null;
  /**
   * Benchmark a copy of this database instead of the synthetic fixture: real data has shapes
   * a fixture only approximates. The copy is private to the run and deleted afterwards. The
   * database key is read from CUED_PERF_DB_KEY.
   */
  dbPath: string | null;
  /** `platform:accountKey` overrides for the accounts the scenarios act on. */
  removeTarget: IntegrationTarget;
  toggleTarget: IntegrationTarget;
  syncScenario: boolean;
};

type IntegrationTarget = { platform: string; accountKey: string };

type ScenarioReport = { failed: boolean; notes: string[] };

function parseIntegrationTarget(value: string): IntegrationTarget {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Expected platform:accountKey, got ${value}`);
  }
  return { platform: value.slice(0, separator), accountKey: value.slice(separator + 1) };
}

type Stats = { count: number; p50: number; p95: number; max: number };

type ScenarioResult = {
  name: string;
  roundTrip: Stats | null;
  stall: Stats;
  timedOut: boolean;
  gated: boolean;
  /** False for requests no UI waits on (CLI diagnostics): only their stall is held to target. */
  roundTripGated: boolean;
  /** Set when a scenario's own check failed (see the scenario's notes). */
  checkFailed?: boolean;
  notes?: string[];
};

type FixtureAccount = {
  platform: string;
  accountKey: string;
  authState: string;
  enabled: boolean;
  connectionKind: string;
  launchStrategy: string | null;
  runWeight: number;
};

function parseOptions(argv: string[]): Options {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const options: Options = {
    cliPath: join(repoRoot, "dist", "cli.js"),
    nodePath: process.execPath,
    scale: 1,
    assert: false,
    keep: false,
    jsonPath: null,
    requestTimeoutMs: 60_000,
    label: "current",
    exec: null,
    dbPath: null,
    removeTarget: REMOVE_TARGET,
    toggleTarget: TOGGLE_TARGET,
    syncScenario: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null) {
        throw new Error(`Missing value for ${flag}`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--cli":
        options.cliPath = resolve(value());
        break;
      case "--node":
        options.nodePath = resolve(value());
        break;
      case "--scale":
        options.scale = Number(value());
        break;
      case "--json":
        options.jsonPath = resolve(value());
        break;
      case "--request-timeout-ms":
        options.requestTimeoutMs = Number(value());
        break;
      case "--label":
        options.label = value();
        break;
      case "--exec":
        options.exec = value();
        break;
      case "--db":
        options.dbPath = resolve(value());
        break;
      case "--remove":
        options.removeTarget = parseIntegrationTarget(value());
        break;
      case "--toggle":
        options.toggleTarget = parseIntegrationTarget(value());
        break;
      case "--no-sync":
        options.syncScenario = false;
        break;
      case "--assert":
        options.assert = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!Number.isFinite(options.scale) || options.scale <= 0) {
    throw new Error("--scale must be a positive number");
  }
  if (!existsSync(options.cliPath)) {
    throw new Error(`CLI entrypoint not found at ${options.cliPath}. Run pnpm build first.`);
  }
  return options;
}

function summarize(samples: number[]): Stats {
  if (samples.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function scaled(count: number, scale: number): number {
  return Math.max(1, Math.round(count * scale));
}

function fixtureAccounts(): FixtureAccount[] {
  const gmail = (accountKey: string, runWeight: number): FixtureAccount => ({
    platform: "gmail",
    accountKey,
    authState: "authenticated",
    enabled: true,
    connectionKind: "local-cli",
    launchStrategy: "native-auth",
    runWeight,
  });
  const slack = (accountKey: string, authState: string, runWeight: number): FixtureAccount => ({
    platform: "slack",
    accountKey,
    authState,
    enabled: true,
    connectionKind: "browser-session",
    launchStrategy: "chromium-auth",
    runWeight,
  });
  const pending = (platform: "gmail" | "slack", index: number): FixtureAccount => ({
    platform,
    accountKey: `pending-${platform}-perf${index.toString(16).padStart(4, "0")}`,
    authState: "cancelled",
    enabled: false,
    connectionKind: platform === "gmail" ? "local-cli" : "browser-session",
    launchStrategy: platform === "gmail" ? "native-auth" : "chromium-auth",
    runWeight: 0,
  });
  return [
    gmail("perf-a@example.com", 21),
    gmail("perf-b@example.com", 20),
    gmail("perf-c@example.com", 19),
    gmail("perf-d@example.com", 19),
    slack("T0PERF0001", "needs_auth", 19),
    slack("T0PERF0002", "needs_auth", 18),
    slack("T0PERF0003", "failed", 17),
    {
      platform: "linkedin",
      accountKey: "default",
      authState: "needs_auth",
      enabled: true,
      connectionKind: "browser-session",
      launchStrategy: "chromium-auth",
      runWeight: 19,
    },
    {
      platform: "discord",
      accountKey: "default",
      authState: "needs_auth",
      enabled: true,
      connectionKind: "browser-session",
      launchStrategy: "chromium-auth",
      runWeight: 1,
    },
    ...Array.from({ length: 9 }, (_, index) => pending("gmail", index)),
    ...Array.from({ length: 8 }, (_, index) => pending("slack", index)),
  ];
}

async function buildFixture(dbPath: string, scale: number): Promise<void> {
  const home = dirname(dbPath);
  mkdirSync(home, { recursive: true });
  process.env.CUED_HOME = home;
  process.env.CUED_DB_PATH = dbPath;
  process.env.CUED_DB_KEY = FIXTURE_DB_KEY;
  const { openCuedDatabase } = await import("../../db/database.js");
  const { openSqliteDatabase } = await import("../../db/sqlite.js");
  const { setTelemetryEnabled } = await import("../../telemetry/client.js");

  const startedAt = performance.now();
  const db = openCuedDatabase(dbPath);
  setTelemetryEnabled(db, false);
  const accounts = fixtureAccounts();
  for (const account of accounts) {
    db.upsertIntegrationState({
      platform: account.platform as never,
      accountKey: account.accountKey,
      displayName: account.accountKey,
      authState: account.authState as never,
      enabled: account.enabled,
      connectionKind: account.connectionKind as never,
      syncCapable: true,
      launchStrategy: account.launchStrategy as never,
      metadata: {
        supportedByDaemon: true,
        keychainService: null,
        keychainAccount: null,
        browserProfileDir: null,
      },
    });
  }
  db.upsertIntegrationState({
    platform: "imessage",
    accountKey: "local",
    displayName: "Messages",
    authState: "authorized",
    enabled: true,
    connectionKind: "native",
    syncCapable: true,
    launchStrategy: "system-settings",
    metadata: { supportedByDaemon: true },
  });
  await seedLargeConversation({ db, workDir: home, scale });
  db.close();

  const sqlite = openSqliteDatabase(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = OFF");
  sqlite.pragma("foreign_keys = ON");
  const dayMs = 86_400_000;
  const horizonMs = 240 * dayMs;
  const nowMs = Date.now();
  const details = JSON.stringify({
    source: "perf",
    trigger: "scheduler",
    diagnostics: { pages: 1, fetched: 0, inserted: 0, note: "x".repeat(170) },
  });
  const runAccounts = accounts.filter((account) => account.runWeight > 0);
  // Interleaved weighted cycle: per-account run counts follow the real distribution.
  const runCycle: FixtureAccount[] = [];
  const maxWeight = Math.max(...runAccounts.map((account) => account.runWeight));
  for (let round = 0; round < maxWeight; round += 1) {
    for (const account of runAccounts) {
      if (round < account.runWeight) {
        runCycle.push(account);
      }
    }
  }
  const totalRuns = scaled(REAL_SCALE.syncRuns, scale);
  const totalErrors = scaled(REAL_SCALE.syncRunErrors, scale);
  const errorEvery = Math.max(1, Math.floor(totalRuns / totalErrors));

  const insertRun = sqlite.prepare(
    `INSERT INTO sync_runs (id, platform, account_key, run_type, status, trigger, queued_at,
       scheduled_at, started_at, finished_at, attempt, details_json)
     VALUES (?, ?, ?, 'sync', ?, 'scheduler', ?, ?, ?, ?, 1, ?)`,
  );
  const insertRunError = sqlite.prepare(
    `INSERT INTO sync_run_errors (id, sync_run_id, platform, account_key, error_code,
       error_message, created_at)
     VALUES (?, ?, ?, ?, 'perf_error', ?, ?)`,
  );
  const errorMessage = "Synthetic sync failure for the responsiveness benchmark fixture.";
  let runIndex = 0;
  const insertRuns = sqlite.transaction((count: number) => {
    for (let inserted = 0; inserted < count; inserted += 1) {
      const target = runCycle[runIndex % runCycle.length];
      if (!target) {
        throw new Error("Fixture has no accounts to attribute sync runs to");
      }
      const failed = runIndex % errorEvery === 0;
      const queuedAt = nowMs - horizonMs + Math.floor((runIndex / totalRuns) * horizonMs);
      const id = `perf-run-${runIndex.toString(16).padStart(12, "0")}-0000-0000-0000`;
      insertRun.run(
        id,
        target.platform,
        target.accountKey,
        failed ? "failed" : "completed",
        queuedAt,
        queuedAt,
        queuedAt + 5,
        queuedAt + 120,
        details,
      );
      if (failed) {
        insertRunError.run(
          `perf-err-${runIndex.toString(16).padStart(12, "0")}`,
          id,
          target.platform,
          target.accountKey,
          errorMessage,
          queuedAt + 120,
        );
      }
      runIndex += 1;
    }
  });
  for (let remaining = totalRuns; remaining > 0; remaining -= 50_000) {
    insertRuns(Math.min(50_000, remaining));
  }

  const insertAuthSession = sqlite.prepare(
    `INSERT INTO auth_sessions (id, platform, account_key, integration_state_id, state,
       requested_at, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    const total = scaled(REAL_SCALE.authSessions, scale);
    for (let index = 0; index < total; index += 1) {
      const account = accounts[index % accounts.length];
      if (!account) {
        continue;
      }
      const requestedAt = nowMs - horizonMs + index * 1_000;
      insertAuthSession.run(
        `perf-auth-${index}`,
        account.platform,
        account.accountKey,
        `${account.platform}:${account.accountKey}`,
        index % 3 === 0 ? "failed" : "authenticated",
        requestedAt,
        requestedAt + 10,
        requestedAt + 20_000,
        requestedAt,
        requestedAt + 20_000,
      );
    }
  })();

  const insertContact = sqlite.prepare(
    `INSERT INTO contacts (id, kind, name, archived, created_at, updated_at)
     VALUES (?, 'person', ?, 0, ?, ?)`,
  );
  const insertConversation = sqlite.prepare(
    `INSERT INTO conversations (id, platform, account_key, source_conversation_key, type,
       is_active, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'dm', 1, 0, ?, ?)`,
  );
  const insertMessage = sqlite.prepare(
    `INSERT INTO messages (id, platform, account_key, platform_message_id, conversation_id,
       sender_contact_id, sent_at, is_from_me, content, is_deleted, is_edited, attachment_count,
       reaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, ?, ?)`,
  );
  const insertRawEvent = sqlite.prepare(
    `INSERT INTO raw_events (id, platform, account_key, entity_kind, event_kind, observed_at,
       dedupe_key, payload_json, normalized_schema)
     VALUES (?, ?, ?, 'message', 'observed', ?, ?, ?, 'message.observed@1')`,
  );
  const contactCount = scaled(REAL_SCALE.contacts, scale);
  const conversationCount = scaled(REAL_SCALE.conversations, scale);
  const messageCount = scaled(REAL_SCALE.messages, scale);
  const rawEventCount = scaled(REAL_SCALE.rawEvents, scale);
  const contentAccounts = runAccounts.slice(0, 7);
  const accountAt = (index: number) => {
    const account = contentAccounts[index % contentAccounts.length];
    if (!account) {
      throw new Error("Fixture has no accounts to attribute content to");
    }
    return account;
  };
  sqlite.transaction(() => {
    for (let index = 0; index < contactCount; index += 1) {
      insertContact.run(`perf-contact-${index}`, `Perf Contact ${index}`, nowMs, nowMs);
    }
    for (let index = 0; index < conversationCount; index += 1) {
      const account = accountAt(index);
      insertConversation.run(
        `perf-conversation-${index}`,
        account.platform,
        account.accountKey,
        `perf-conversation-key-${index}`,
        nowMs,
        nowMs,
      );
    }
  })();
  const messageBody = "Synthetic message body for the responsiveness benchmark. ".repeat(2);
  const insertMessages = sqlite.transaction((start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      const conversationIndex = index % conversationCount;
      const account = accountAt(conversationIndex);
      insertMessage.run(
        `perf-message-${index}`,
        account.platform,
        account.accountKey,
        `perf-platform-message-${index}`,
        `perf-conversation-${conversationIndex}`,
        `perf-contact-${index % contactCount}`,
        nowMs - index * 1_000,
        messageBody,
        nowMs,
        nowMs,
      );
    }
  });
  for (let start = 0; start < messageCount; start += 50_000) {
    insertMessages(start, Math.min(messageCount, start + 50_000));
  }
  const largeConversationMessages = fillLargeConversation(sqlite, scale);
  const payload = JSON.stringify({ text: "y".repeat(600) });
  const insertRawEvents = sqlite.transaction((start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      const account = accountAt(index);
      insertRawEvent.run(
        `perf-raw-${index}`,
        account.platform,
        account.accountKey,
        nowMs - index * 500,
        `perf-dedupe-${index}`,
        payload,
      );
    }
  });
  for (let start = 0; start < rawEventCount; start += 50_000) {
    insertRawEvents(start, Math.min(rawEventCount, start + 50_000));
  }

  // Everything above is already "projected"; the daemon must not start replaying it.
  const maxRawEventRowid = (
    sqlite.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM raw_events").get() as {
      value: number;
    }
  ).value;
  sqlite
    .prepare(
      `INSERT INTO projection_state (singleton_key, projection_watermark, last_projected_at, updated_at)
       VALUES ('global', ?, ?, ?)
       ON CONFLICT(singleton_key) DO UPDATE SET projection_watermark = excluded.projection_watermark`,
    )
    .run(maxRawEventRowid, nowMs, nowMs);

  // A real database has every message in its search index; the seed's are still queued.
  sqlite.exec(`
    DELETE FROM messages_fts;
    INSERT INTO messages_fts (rowid, message_id, sender_name, conversation_name,
      participant_names, attachment_text, content)
    SELECT message_rowid, message_id, sender_name, conversation_name, participant_names,
      attachment_text, content
    FROM message_fts_source;
    DELETE FROM message_fts_index_queue;
  `);

  for (const indexName of REWOUND_INDEXES) {
    sqlite.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
  const forgetMigration = sqlite.prepare("DELETE FROM schema_migrations WHERE id = ?");
  for (const migrationId of REWOUND_MIGRATION_IDS) {
    forgetMigration.run(migrationId);
  }
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  sqlite.close();
  console.error(
    `Built fixture in ${((performance.now() - startedAt) / 1000).toFixed(1)}s: ${totalRuns} sync runs, ${messageCount} messages (${largeConversationMessages} in one conversation), ${rawEventCount} raw events`,
  );
}

/**
 * Takes a consistent private copy of a live database (the source is only read) and detaches
 * the accounts the scenarios will act on from anything outside the copy, so removing one in
 * the benchmark cannot delete a real browser profile or keychain entry.
 */
async function snapshotDatabase(
  sourcePath: string,
  destinationPath: string,
  key: string,
  home: string,
  targets: IntegrationTarget[],
): Promise<void> {
  process.env.CUED_HOME = home;
  process.env.CUED_DB_PATH = destinationPath;
  process.env.CUED_DB_KEY = key;
  const { openSqliteDatabase } = await import("../../db/sqlite.js");
  const startedAt = performance.now();
  const source = openSqliteDatabase(sourcePath, { readonly: true });
  try {
    source.exec(`VACUUM INTO '${destinationPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const copy = openSqliteDatabase(destinationPath);
  try {
    const detach = copy.prepare(
      `UPDATE integration_states
       SET metadata_json = json_set(
         COALESCE(metadata_json, '{}'),
         '$.keychainService', NULL, '$.keychainAccount', NULL,
         '$.browserProfileDir', NULL, '$.storeDir', NULL, '$.configDir', NULL
       )
       WHERE platform = ? AND account_key = ?`,
    );
    for (const target of targets) {
      detach.run(target.platform, target.accountKey);
    }
    // Work that was queued or running when the copy was taken must not run here: the daemon
    // would drain it at startup and sync from the live sources.
    copy
      .prepare(
        `UPDATE sync_runs
         SET status = 'failed', finished_at = ?, owner_id = NULL, lease_expires_at = NULL,
             error_code = 'benchmark_copy'
         WHERE status IN ('queued', 'ingesting', 'projecting')`,
      )
      .run(Date.now());
    // The copy must not report itself as the real install.
    copy
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('telemetry_enabled', '0', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(Date.now());
  } finally {
    copy.close();
  }
  console.error(
    `Copied ${sourcePath} for benchmarking in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

function readStallReports(daemonLogPath: string): string[] {
  if (!existsSync(daemonLogPath)) {
    return [];
  }
  return readFileSync(daemonLogPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("event loop stalled"))
    .map((line) => `  ${line.slice(0, 320)}`);
}

/**
 * The fixture cache lives under the temp directory, which other users can write to on some
 * systems. Keep it in a directory only this user owns, and refuse one that is not.
 */
function privateFixtureRoot(): string {
  const root = join(tmpdir(), `cued-perf-fixture-${userInfo().uid}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = statSync(root);
  if (stat.uid !== userInfo().uid || (stat.mode & 0o022) !== 0) {
    throw new Error(`Refusing to use fixture cache ${root}: not private to this user`);
  }
  return root;
}

async function ensureFixture(scale: number): Promise<string> {
  const fixtureDir = join(privateFixtureRoot(), `v${FIXTURE_VERSION}-scale${scale}`);
  const dbPath = join(fixtureDir, "local.db");
  const readyMarker = join(fixtureDir, "ready");
  if (existsSync(readyMarker) && existsSync(dbPath)) {
    return dbPath;
  }
  rmSync(fixtureDir, { recursive: true, force: true });
  await buildFixture(dbPath, scale);
  writeFileSync(readyMarker, `${new Date().toISOString()}\n`);
  return dbPath;
}

class DaemonConnection {
  private buffer = "";
  private eventWaiters: Array<() => void> = [];
  private readonly pending = new Map<
    string,
    { resolve: (response: DaemonResponseLike) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          const message = JSON.parse(line) as DaemonResponseLike & { event?: string };
          if (typeof message.event === "string") {
            const listeners = this.eventWaiters;
            this.eventWaiters = [];
            for (const listener of listeners) {
              listener();
            }
          } else {
            const waiter = this.pending.get(message.id);
            this.pending.delete(message.id);
            waiter?.resolve(message);
          }
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });
    const failAll = (error: Error) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(error);
      }
      this.pending.clear();
    };
    socket.on("error", failAll);
    socket.on("close", () => failAll(new Error("Daemon connection closed")));
  }

  static connect(socketPath: string): Promise<DaemonConnection> {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolveConnect(new DaemonConnection(socket)));
      socket.once("error", rejectConnect);
    });
  }

  request(command: string, fields: Record<string, unknown> = {}): Promise<DaemonResponseLike> {
    const id = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.socket.write(`${JSON.stringify({ id, command, ...fields })}\n`);
    });
  }

  /** Resolves when the daemon next pushes an event on this (subscribed) connection. */
  nextEvent(): Promise<void> {
    return new Promise((resolveEvent) => this.eventWaiters.push(resolveEvent));
  }

  close(): void {
    this.socket.destroy();
  }
}

type DaemonResponseLike = { id: string; ok: boolean; result?: unknown; error?: string };

/** Continuously pings the daemon; a slow pong means the event loop was blocked. */
class StallProbe {
  private samples: number[] = [];
  private running = true;
  private readonly loop: Promise<void>;
  private sampleWaiters: Array<() => void> = [];
  private pingStartedAt: number | null = null;
  /** Set once the daemon has gone a full timeout without answering, or hung up. */
  unresponsive = false;

  constructor(
    private readonly connection: DaemonConnection,
    private readonly sampleTimeoutMs: number,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.pingStartedAt = performance.now();
      try {
        await this.connection.request("ping");
      } catch {
        // The daemon hung up. There will be no more samples; nobody should wait for one.
        this.unresponsive = this.running;
        this.running = false;
        break;
      }
      this.samples.push(performance.now() - this.pingStartedAt);
      this.pingStartedAt = null;
      this.releaseWaiters();
      await sleep(2);
    }
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const waiters = this.sampleWaiters;
    this.sampleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  /**
   * Waits for the ping that is in flight right now to land, so a stall that just ended is
   * attributed to the scenario that caused it rather than dropped or leaked into the next.
   */
  async take(): Promise<Stats> {
    if (this.running) {
      const landed = await withTimeout(
        new Promise<void>((resolveSample) => this.sampleWaiters.push(resolveSample)),
        this.sampleTimeoutMs,
      );
      if (landed === "timeout") {
        // Still no pong: the stall is at least this long, and the run cannot go on.
        this.unresponsive = true;
        if (this.pingStartedAt != null) {
          this.samples.push(performance.now() - this.pingStartedAt);
        }
      }
    }
    const stats = summarize(this.samples);
    this.samples = [];
    return stats;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    task,
    new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function waitForDaemon(socketPath: string, child: ChildProcess): Promise<number> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 120_000) {
    if (child.exitCode != null) {
      throw new Error(`Daemon exited during startup with code ${child.exitCode}`);
    }
    try {
      const connection = await DaemonConnection.connect(socketPath);
      const response = await withTimeout(connection.request("ping"), 1_000);
      connection.close();
      if (response !== "timeout" && response.ok) {
        return performance.now() - startedAt;
      }
    } catch {
      // Socket is not listening yet.
    }
    await sleep(25);
  }
  throw new Error("Daemon did not become ready within 120s");
}

function formatMs(value: number): string {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}s`;
  }
  return value >= 100 ? `${value.toFixed(0)}ms` : `${value.toFixed(1)}ms`;
}

function printResults(
  options: Options,
  startupMs: number,
  results: ScenarioResult[],
  legacySpawn: Stats | null,
): boolean {
  const rows = results.map((result) => {
    const roundTripOk =
      !result.gated ||
      !result.roundTripGated ||
      !result.roundTrip ||
      result.roundTrip.p95 <= TARGETS.roundTripP95Ms;
    const stallOk = !result.gated || result.stall.max <= TARGETS.stallMaxMs;
    const ok = !result.timedOut && roundTripOk && stallOk && !result.checkFailed;
    return {
      name: result.name,
      roundTripP50: result.roundTrip ? formatMs(result.roundTrip.p50) : "-",
      roundTripP95: result.timedOut
        ? `>${formatMs(options.requestTimeoutMs)}`
        : result.roundTrip
          ? `${formatMs(result.roundTrip.p95)}${result.roundTripGated ? "" : "*"}`
          : "-",
      stallMax: result.timedOut
        ? `>${formatMs(options.requestTimeoutMs)}`
        : formatMs(result.stall.max),
      verdict: result.gated ? (ok ? "ok" : "MISS") : "info",
      ok: ok || !result.gated,
    };
  });
  const widths = {
    name: Math.max(8, ...rows.map((row) => row.name.length)),
    cell: 12,
  };
  const line = (cells: string[]) =>
    `${(cells[0] ?? "").padEnd(widths.name)}  ${cells
      .slice(1)
      .map((cell) => cell.padStart(widths.cell))
      .join("")}`;
  console.log(`\nDaemon responsiveness (${options.label}, scale ${options.scale})`);
  console.log(`startup to first pong: ${formatMs(startupMs)}`);
  console.log(line(["scenario", "rtt p50", "rtt p95", "stall max", "verdict"]));
  for (const row of rows) {
    console.log(line([row.name, row.roundTripP50, row.roundTripP95, row.stallMax, row.verdict]));
  }
  for (const result of results) {
    for (const note of result.notes ?? []) {
      console.log(`  ${result.name}: ${note}`);
    }
  }
  if (legacySpawn) {
    console.log(
      `\nlegacy transport (spawn CLI per request, onboarding snapshot): p50 ${formatMs(legacySpawn.p50)}, p95 ${formatMs(legacySpawn.p95)}`,
    );
  }
  console.log(
    `\ntargets: stall max <= ${TARGETS.stallMaxMs}ms, round trip p95 <= ${TARGETS.roundTripP95Ms}ms (* = not a UI request; only its stall is gated)`,
  );
  return rows.every((row) => row.ok);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const home = mkdtempSync(join(tmpdir(), "cued-perf-run-"));
  const dbPath = join(home, "local.db");
  let dbKey = FIXTURE_DB_KEY;
  if (options.dbPath) {
    const suppliedKey = process.env.CUED_PERF_DB_KEY?.trim();
    if (!suppliedKey) {
      throw new Error("--db needs the database key in CUED_PERF_DB_KEY");
    }
    dbKey = suppliedKey;
    await snapshotDatabase(options.dbPath, dbPath, dbKey, home, [
      options.removeTarget,
      options.toggleTarget,
    ]);
  } else {
    copyFileSync(await ensureFixture(options.scale), dbPath, constants.COPYFILE_FICLONE);
  }
  const socketPath = join(home, "cued.sock");
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CUED_HOME: home,
    CUED_DB_PATH: dbPath,
    CUED_DB_KEY: dbKey,
    CUED_AUTOSYNC_PLATFORMS: "none",
    CUED_REALTIME_PLATFORMS: "none",
    CUED_SLACK_APP_BINARY: join(home, "disabled", "Slack"),
    CUED_SLACK_USER_DATA_DIR: join(home, "disabled", "SlackData"),
    CUED_TELEMETRY_ENDPOINT: "http://127.0.0.1:9/disabled",
    // Have the daemon name anything that approaches the stall target (see daemon.log).
    CUED_STALL_THRESHOLD_MS: "40",
    CUED_STALL_SECTION_MS: "15",
    CUED_STALL_REPORT_INTERVAL_MS: "2000",
  };
  const fakeBinDir = join(home, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(fakeBinDir, "security"), FAKE_SECURITY_CLI);
  chmodSync(join(fakeBinDir, "security"), 0o755);
  daemonEnv.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
  const imessagePlaceholderPath = join(home, "imessage", "chat.db");
  const imessageBatchPath = join(home, "imessage", "batch.json");
  mkdirSync(dirname(imessagePlaceholderPath), { recursive: true });
  writeFileSync(imessagePlaceholderPath, "");
  process.env.CUED_DB_KEY = dbKey;
  {
    const { openSqliteDatabase } = await import("../../db/sqlite.js");
    const sqlite = openSqliteDatabase(dbPath);
    try {
      sqlite.exec(SEARCH_REINDEX_COUNTER_SQL);
    } finally {
      sqlite.close();
    }
  }
  const nativeHelperPath = join(home, "fake-native-helper");
  writeFileSync(nativeHelperPath, FAKE_NATIVE_HELPER);
  chmodSync(nativeHelperPath, 0o755);
  const contactsJsonPath = join(home, "contacts.json");
  writeFileSync(
    contactsJsonPath,
    JSON.stringify(
      Array.from({ length: SYNC_CONTACT_COUNT }, (_, index) => ({
        // Without a source id every contact projects onto the same identity.
        sourceId: `perf-sync-contact-${index}`,
        displayName: `Perf Sync Contact ${index}`,
        company: "Cued",
        phoneNumbers: [`+1415${String(5_550_000 + index).padStart(7, "0")}`],
        emails: [`perf-sync-${index}@example.com`],
      })),
    ),
  );
  Object.assign(daemonEnv, {
    CUED_NATIVE_BINARY: nativeHelperPath,
    CUED_IMESSAGE_NATIVE_BINARY: nativeHelperPath,
    CUED_CONTACTS_NATIVE_BINARY: nativeHelperPath,
    // Synthetic address book; the real one is never read.
    CUED_CONTACTS_JSON_PATH: contactsJsonPath,
    // Only has to exist: the fake helper serves the iMessage batches (see large-conversation).
    CUED_IMESSAGE_DB_PATH: imessagePlaceholderPath,
    [IMESSAGE_BATCH_ENV]: imessageBatchPath,
    // An inherited CUED_SIGNAL_DIR would otherwise win over the benchmark home, and removing
    // a Signal account in --db mode would delete the real account directory.
    CUED_SIGNAL_DIR: join(home, "integrations", "signal"),
    // Sign-in is launched for real, but against a browser that does not exist: the daemon's
    // part (everything up to spawning the sign-in process) is measured and no window opens.
    CUED_CHROMIUM_EXECUTABLE_PATH: join(home, "disabled", "chromium"),
  });
  delete daemonEnv.VITEST_WORKER_ID;

  const logPath = join(home, "daemon.out");
  const child = spawn(options.nodePath, [options.cliPath, "daemon"], {
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOutput = "";
  child.stdout?.on("data", (chunk) => {
    daemonOutput += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    daemonOutput += chunk.toString("utf8");
  });

  const results: ScenarioResult[] = [];
  let legacySpawn: Stats | null = null;
  let startupMs = 0;
  let aborted = false;
  let stallReports: string[] = [];
  let externalClientOutput = "";
  let externalClientPassed = true;
  try {
    startupMs = await waitForDaemon(socketPath, child);
    const probeConnection = await DaemonConnection.connect(socketPath);
    const requestConnection = await DaemonConnection.connect(socketPath);
    const probe = new StallProbe(probeConnection, options.requestTimeoutMs);

    const measure = async (
      name: string,
      run: (
        request: (command: string, fields?: Record<string, unknown>) => Promise<void>,
      ) => Promise<void>,
      scenarioOptions: {
        gated?: boolean;
        roundTripGated?: boolean;
        /** Filled in by the scenario: its own pass/fail check and what to print about it. */
        report?: ScenarioReport;
      } = {},
    ) => {
      if (aborted) {
        return;
      }
      await probe.take();
      const latencies: number[] = [];
      let timedOut = false;
      const request = async (command: string, fields: Record<string, unknown> = {}) => {
        const startedAt = performance.now();
        const response = await withTimeout(
          requestConnection.request(command, fields),
          options.requestTimeoutMs,
        );
        if (response === "timeout") {
          timedOut = true;
          throw new Error(`timeout:${command}`);
        }
        if (!response.ok) {
          throw new Error(`${command} failed: ${response.error ?? "unknown error"}`);
        }
        latencies.push(performance.now() - startedAt);
      };
      try {
        await run(request);
      } catch (error) {
        if (!timedOut) {
          throw error;
        }
        aborted = true;
      }
      // A timed-out daemon never answers the in-flight ping; do not wait on it.
      const stall = timedOut ? summarize([options.requestTimeoutMs]) : await probe.take();
      if (probe.unresponsive) {
        timedOut = true;
        aborted = true;
      }
      results.push({
        name,
        roundTrip: latencies.length > 0 ? summarize(latencies) : null,
        stall,
        timedOut,
        gated: scenarioOptions.gated ?? true,
        roundTripGated: scenarioOptions.roundTripGated ?? true,
        checkFailed: scenarioOptions.report?.failed,
        notes: scenarioOptions.report?.notes,
      });
    };

    await measure("startup settle (5s)", async () => sleep(5_000));
    await measure("idle (3s)", async () => sleep(3_000));
    // Enough samples that p95 is a percentile rather than the single slowest request.
    await measure("onboarding snapshot x100", async (request) => {
      for (let index = 0; index < 100; index += 1) {
        await request("onboarding-snapshot");
      }
    });
    await measure("snapshot + refresh x3", async (request) => {
      for (let index = 0; index < 3; index += 1) {
        await request("onboarding-snapshot", {
          refreshManagedIntegrations: true,
          refreshPermissions: true,
        });
      }
    });
    await measure(
      "integrations list x10",
      async (request) => {
        for (let index = 0; index < 10; index += 1) {
          await request("integrations-list");
        }
      },
      // `cued integrations list` computes per-account diagnostics for a person at a terminal.
      { roundTripGated: false },
    );
    await measure("status x10", async (request) => {
      for (let index = 0; index < 10; index += 1) {
        await request("status");
      }
    });
    await measure("disable + enable x5", async (request) => {
      for (let index = 0; index < 5; index += 1) {
        await request("integrations-disable", options.toggleTarget);
        await request("integrations-enable", options.toggleTarget);
      }
    });

    // How long after a mutation a subscribed UI learns it should re-read. Builds that predate
    // subscriptions reject the command; the UI then had to poll, so there is nothing to time.
    if (!aborted) {
      const subscriber = await DaemonConnection.connect(socketPath);
      await probe.take();
      const subscribed = await withTimeout(subscriber.request("subscribe"), 2_000);
      const notifyLatencies: number[] = [];
      // Only an explicit refusal means "this build cannot push"; silence is a failure.
      const supported = subscribed === "timeout" || subscribed.ok;
      if (subscribed !== "timeout" && subscribed.ok) {
        await sleep(200);
        for (let index = 0; index < 10; index += 1) {
          const notified = subscriber.nextEvent();
          const startedAt = performance.now();
          const changed = await withTimeout(
            requestConnection.request(
              index % 2 === 0 ? "integrations-disable" : "integrations-enable",
              options.toggleTarget,
            ),
            options.requestTimeoutMs,
          );
          if (changed === "timeout") {
            aborted = true;
            break;
          }
          if ((await withTimeout(notified, 5_000)) !== "timeout") {
            notifyLatencies.push(performance.now() - startedAt);
          }
          await sleep(50);
        }
      }
      if (supported) {
        const stall = await probe.take();
        aborted ||= probe.unresponsive;
        results.push({
          name: "change notification x10",
          roundTrip: notifyLatencies.length > 0 ? summarize(notifyLatencies) : null,
          stall,
          timedOut: notifyLatencies.length < 10,
          gated: true,
          roundTripGated: true,
        });
      }
      subscriber.close();
    }

    if (!aborted) {
      const spawnSamples: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const startedAt = performance.now();
        const completed = spawnSync(options.nodePath, [options.cliPath, "onboarding", "snapshot"], {
          env: daemonEnv,
          stdio: ["ignore", "ignore", "ignore"],
        });
        if (completed.status === 0) {
          spawnSamples.push(performance.now() - startedAt);
        }
      }
      legacySpawn = summarize(spawnSamples);
    }

    if (options.exec && !aborted) {
      const completed = spawnSync(options.exec, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, CUED_PERF_DAEMON_SOCKET: socketPath },
      });
      externalClientOutput = `${completed.stdout ?? ""}${completed.stderr ?? ""}`;
      externalClientPassed = completed.status === 0;
      await probe.take();
    }

    await measure("connect slack (launch sign-in)", async (request) => {
      await request("integrations-connect", {
        platform: "slack",
        accountKey: "pending-slack-perfconnect",
      });
    });

    // Ingest and projection are the daemon's heaviest writes, and they run while the UI is
    // showing progress. Only the stall is gated: the polling queries are not UI requests.
    if (options.syncScenario)
      await measure(
        `sync ${SYNC_CONTACT_COUNT} contacts (ingest + project)`,
        async (request) => {
          await request("sync-run", { source: "contacts" });
          const deadline = performance.now() + 120_000;
          while (performance.now() < deadline) {
            await sleep(250);
            const response = await withTimeout(
              requestConnection.request("sql", {
                query: `SELECT
              (SELECT COUNT(*) FROM sync_runs WHERE status IN ('queued', 'ingesting', 'projecting')) AS active,
              (SELECT COALESCE(MAX(rowid), 0) FROM raw_events)
                - (SELECT projection_watermark FROM projection_state) AS pending,
              (SELECT COUNT(*) FROM raw_events WHERE platform = 'contacts') AS ingested`,
              }),
              10_000,
            );
            if (response === "timeout") {
              continue;
            }
            const row = (response.result as Array<Record<string, number>> | undefined)?.[0];
            if (row && row.active === 0 && row.pending <= 0 && (row.ingested ?? 0) > 0) {
              return;
            }
          }
          throw new Error("Contacts sync did not finish within 120s");
        },
        { roundTripGated: false },
      );

    if (options.syncScenario && !options.dbPath) {
      const sqlRow = async (query: string): Promise<Record<string, number> | null> => {
        const response = await withTimeout(requestConnection.request("sql", { query }), 10_000);
        if (response === "timeout" || !response.ok) {
          return null;
        }
        return (response.result as Array<Record<string, number>> | undefined)?.[0] ?? null;
      };
      // Conversations queued for re-indexing as a whole; builds before that queue have none.
      let conversationQueue = "(SELECT COUNT(*) FROM message_fts_conversation_queue)";
      const quiet = async (sinceMs: number) => {
        const query = (conversations: string) => `SELECT
          (SELECT COUNT(*) FROM sync_runs WHERE status IN ('queued', 'ingesting', 'projecting')) AS active,
          (SELECT COALESCE(MAX(rowid), 0) FROM raw_events)
            - (SELECT projection_watermark FROM projection_state) AS pending,
          (SELECT COUNT(*) FROM message_fts_index_queue WHERE status IN ('queued', 'indexing'))
            + ${conversations} AS reindexing,
          (SELECT COUNT(*) FROM sync_runs WHERE platform = 'imessage' AND queued_at >= ${sinceMs}
             AND status NOT IN ('queued', 'ingesting', 'projecting')) AS finished`;
        let row = await sqlRow(query(conversationQueue));
        if (!row && conversationQueue !== "0") {
          row = await sqlRow(query("0"));
          if (row) {
            conversationQueue = "0";
          }
        }
        return row && row.active === 0 && row.pending <= 0 && row.reindexing === 0 ? row : null;
      };
      // Delivers one iMessage batch and waits for the daemon to project it and re-index search.
      const largeConversationSync = async (
        batch: object,
        report: ScenarioReport,
        maxQueuedPerEvent: number | null,
      ) => {
        const settleDeadline = performance.now() + 600_000;
        while (!(await quiet(0)) && performance.now() < settleDeadline) {
          await sleep(250);
        }
        const before =
          (await sqlRow(`SELECT
          (SELECT queued FROM perf_search_reindex_counter) AS queued,
          (SELECT COALESCE(MAX(rowid), 0) FROM raw_events) AS rowid`)) ?? {};
        const startedAt = Date.now();
        writeFileSync(imessageBatchPath, JSON.stringify(batch));
        const memory = new ProjectionWorkerMemorySampler(child.pid ?? -1);
        memory.start();
        try {
          await requestConnection.request("sync-run", { source: "imessage" });
          const deadline = performance.now() + 600_000;
          let finished = false;
          while (performance.now() < deadline) {
            await sleep(250);
            const row = await quiet(startedAt);
            if (row && row.finished > 0) {
              finished = true;
              break;
            }
          }
          if (!finished) {
            throw new Error("iMessage sync did not finish within 600s");
          }
        } finally {
          memory.stop();
          rmSync(imessageBatchPath, { force: true });
        }
        const after =
          (await sqlRow(`SELECT
          (SELECT queued FROM perf_search_reindex_counter) AS queued,
          (SELECT COUNT(*) FROM raw_events WHERE rowid > ${before.rowid ?? 0}) AS stored,
          (SELECT COALESCE(SUM(json_extract(details_json, '$.timings.projectionMs')), 0)
             FROM sync_runs WHERE run_type = 'project' AND queued_at >= ${startedAt}) AS projection_ms`)) ??
          {};
        const stored = after.stored ?? 0;
        const queued = (after.queued ?? 0) - (before.queued ?? 0);
        report.notes.push(
          `${stored} raw events stored, ${queued} messages queued for search re-indexing, projection ${formatMs(after.projection_ms ?? 0)}, projection worker peak RSS ${(memory.peakRssBytes / 1024 / 1024).toFixed(0)} MB, ${formatMs(Date.now() - startedAt)} until search caught up`,
        );
        if (maxQueuedPerEvent != null && queued > maxQueuedPerEvent * Math.max(1, stored)) {
          report.failed = true;
          report.notes.push(
            `MISS: re-indexed more than ${maxQueuedPerEvent} messages per event delivered`,
          );
        }
      };
      // A single message is few enough raw events that the daemon projects it on its own thread.
      // The first such projection after startup also loads the projection cache, a one-time
      // cost reported here but held to no target; the gated scenario below is the steady state.
      const firstReport: ScenarioReport = { failed: false, notes: [] };
      await measure(
        "first inline projection after startup (loads cache)",
        async () => largeConversationSync(largeConversationDeliveryBatch(1), firstReport, 3),
        { gated: false, roundTripGated: false, report: firstReport },
      );
      const singleReport: ScenarioReport = { failed: false, notes: [] };
      await measure(
        "deliver 1 message into a 110k-message conversation",
        async () => largeConversationSync(largeConversationDeliveryBatch(1), singleReport, 3),
        { roundTripGated: false, report: singleReport },
      );
      const deliveryReport: ScenarioReport = { failed: false, notes: [] };
      await measure(
        "deliver 20 messages into a 110k-message conversation",
        async () => largeConversationSync(largeConversationDeliveryBatch(20), deliveryReport, 3),
        { roundTripGated: false, report: deliveryReport },
      );
      const renameReport: ScenarioReport = { failed: false, notes: [] };
      await measure(
        "rename the 110k-message conversation",
        async () => largeConversationSync(largeConversationRenameBatch(), renameReport, null),
        { roundTripGated: false, report: renameReport },
      );
    }

    await measure(
      `remove ${options.removeTarget.platform} account with long history`,
      async (request) => {
        await request("integrations-remove", options.removeTarget);
      },
    );
    await measure("snapshot after remove x10", async (request) => {
      for (let index = 0; index < 10; index += 1) {
        await request("onboarding-snapshot");
        await sleep(100);
      }
    });
    await measure("post-remove settle (10s)", async () => sleep(10_000));

    // Close first: a hung daemon never answers the in-flight ping the probe is waiting on.
    probeConnection.close();
    requestConnection.close();
    await probe.stop();
  } finally {
    child.kill("SIGTERM");
    await withTimeout(
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      aborted ? 500 : 5_000,
    );
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
    writeFileSync(logPath, daemonOutput);
    stallReports = readStallReports(join(home, "logs", "daemon.log"));
    if (!options.keep) {
      rmSync(home, { recursive: true, force: true });
    } else {
      console.error(`Kept run directory: ${home}`);
    }
  }

  if (options.exec) {
    const summary = externalClientOutput
      .split("\n")
      .filter((line) => /round trip|change notification|error|failed/i.test(line))
      .join("\n");
    console.log(`\nexternal client (${externalClientPassed ? "ok" : "FAILED"}):\n${summary}`);
  }
  const passed = printResults(options, startupMs, results, legacySpawn) && externalClientPassed;
  if (stallReports.length > 0) {
    // The daemon's own account of where its event loop went, when it noticed a stall.
    console.log(`\ndaemon stall reports:\n${stallReports.join("\n")}`);
  }
  if (options.jsonPath) {
    writeFileSync(
      options.jsonPath,
      `${JSON.stringify({ label: options.label, scale: options.scale, startupMs, targets: TARGETS, results, legacySpawn, passed }, null, 2)}\n`,
    );
  }
  if (options.assert && !passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
