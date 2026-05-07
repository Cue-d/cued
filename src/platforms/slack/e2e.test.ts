import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CuedDatabase } from "../../db/database.js";
import { projectPendingRawEvents } from "../../runtime/projection/projector.js";
import { runAdapter } from "../core/runner.js";

type SlackPhase = "bootstrap" | "rerun" | "expand";

describe("slack e2e", () => {
  const tempDirs: string[] = [];
  let helperBinaryPath = "";
  const baseSeconds = Math.floor(Date.now() / 1000);

  function slackTs(offsetSeconds: number, micros: number): string {
    return `${baseSeconds + offsetSeconds}.${String(micros).padStart(6, "0")}`;
  }

  const selfUser = {
    id: "U_SELF",
    team_id: "T123",
    name: "ava",
    real_name: "Ava Chen",
    profile: {
      email: "ava@example.com",
      image_192: "https://img/ava.png",
    },
  };
  const benUser = {
    id: "U_BEN",
    team_id: "T123",
    name: "ben",
    real_name: "Ben Ortiz",
    profile: {
      email: "ben@example.com",
    },
  };
  const caraUser = {
    id: "U_CARA",
    team_id: "T123",
    name: "cara",
    real_name: "Cara Diaz",
    profile: {
      email: "cara@example.com",
    },
  };
  const drewUser = {
    id: "U_DREW",
    team_id: "T123",
    name: "drew",
    real_name: "Drew Park",
    profile: {
      email: "drew@example.com",
    },
  };

  const dmBenMessage = {
    type: "message",
    user: "U_BEN",
    text: "Hi Ava",
    ts: slackTs(-180, 100),
  };
  const groupMessage = {
    type: "message",
    user: "U_CARA",
    text: "Kickoff notes",
    ts: slackTs(-170, 100),
  };
  const channelRootMessage = {
    type: "message",
    user: "U_BEN",
    text: "Weekly sync",
    ts: slackTs(-160, 100),
    reply_count: 2,
    reactions: [{ name: "thumbsup", count: 1, users: ["U_SELF"] }],
    files: [
      {
        id: "F1",
        name: "notes.pdf",
        pretty_type: "PDF",
        url_private_download: "https://files/notes.pdf",
      },
    ],
    attachments: [
      {
        text: "agenda attachment",
        thumb_url: "https://img/agenda.png",
        ts: String(baseSeconds - 160),
      },
    ],
  };
  const channelOlderMessage = {
    type: "message",
    user: "U_SELF",
    text: "Older context",
    ts: slackTs(-190, 100),
  };
  const threadReplyOne = {
    type: "message",
    user: "U_CARA",
    text: "Reply one",
    ts: slackTs(-159, 200),
    thread_ts: slackTs(-160, 100),
  };
  const threadReplyTwo = {
    type: "message",
    user: "U_SELF",
    text: "Reply two",
    ts: slackTs(-158, 300),
    thread_ts: slackTs(-160, 100),
  };

  beforeAll(() => {
    const outDir = mkdtempSync(join(tmpdir(), "cued-slack-helper-bin-"));
    tempDirs.push(outDir);
    helperBinaryPath = join(outDir, "cued-slack-helper");
    execFileSync("go", ["build", "-o", helperBinaryPath, "."], {
      cwd: join(process.cwd(), "native", "helpers", "slack-go"),
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  afterAll(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("syncs full history, stays idempotent, and discovers new channels, DMs, and MPDMs", async () => {
    const envDir = mkdtempSync(join(tmpdir(), "cued-slack-e2e-"));
    tempDirs.push(envDir);
    const db = new CuedDatabase(join(envDir, "local.db"));
    db.initializeSchema();
    const originalExecArgv = [...process.execArgv];
    process.execArgv = ["--import", "tsx"];

    const securityDir = join(envDir, "bin");
    const securityPath = join(securityDir, "security");
    mkdirSync(securityDir, { recursive: true });
    writeFileSync(
      securityPath,
      `#!/bin/sh
echo '{"token":"xoxc-test","cookie":"cookie-test","teamId":"T123","teamName":"Acme","userId":"U_SELF","savedAt":1710000000000}'
`,
    );
    chmodSync(securityPath, 0o755);

    db.upsertIntegrationState({
      platform: "slack",
      accountKey: "workspace-a",
      displayName: "Acme",
      authState: "authenticated",
      enabled: true,
      connectionKind: "browser-session",
      syncCapable: true,
      launchStrategy: "chromium-auth",
      launchTarget: "https://slack.com/signin",
      importedFrom: "slack-desktop-cdp",
      metadata: {
        keychainService: "so.cued.desktop.auth.slack",
        keychainAccount: "workspace-a",
        authManagedBy: "chromium-runtime",
      },
    });

    let phase: SlackPhase = "bootstrap";

    const server = await import("node:http").then(({ createServer }) =>
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const path = req.url ?? "/";
          res.setHeader("content-type", "application/json");

          if (path === "/auth.test") {
            res.end(
              JSON.stringify({
                ok: true,
                team: "Acme",
                user: "Ava Chen",
                team_id: "T123",
                user_id: "U_SELF",
              }),
            );
            return;
          }

          if (path === "/users.list") {
            res.end(
              JSON.stringify({
                ok: true,
                members: [selfUser, benUser, caraUser, ...(phase === "expand" ? [drewUser] : [])],
                response_metadata: { next_cursor: "" },
              }),
            );
            return;
          }

          if (path === "/conversations.list") {
            const types = params.get("types");
            if (types === "im,mpim") {
              const direct: Array<Record<string, unknown>> = [
                {
                  id: "D_BEN",
                  is_im: true,
                  user: "U_BEN",
                  latest: dmBenMessage,
                },
                {
                  id: "G_TEAM",
                  name: "Launch Team",
                  is_mpim: true,
                  is_group: true,
                  is_private: true,
                  latest: groupMessage,
                },
              ];
              if (phase === "expand") {
                direct.unshift(
                  {
                    id: "D_DREW",
                    is_im: true,
                    user: "U_DREW",
                    latest: {
                      type: "message",
                      user: "U_DREW",
                      text: "New DM hello",
                      ts: slackTs(-420, 100),
                    },
                  },
                  {
                    id: "G_NEW",
                    name: "War Room",
                    is_mpim: true,
                    is_group: true,
                    is_private: true,
                    latest: {
                      type: "message",
                      user: "U_CARA",
                      text: "New group hello",
                      ts: slackTs(-419, 100),
                    },
                  },
                );
              }
              res.end(
                JSON.stringify({
                  ok: true,
                  channels: direct,
                  response_metadata: { next_cursor: "" },
                }),
              );
              return;
            }

            const channels: Array<Record<string, unknown>> = [
              {
                id: "C_ENG",
                name: "eng",
                is_channel: true,
                latest: channelRootMessage,
                num_members: 3,
                topic: { value: "engineering" },
                purpose: { value: "build cued" },
              },
            ];
            if (phase === "expand") {
              channels.unshift({
                id: "C_NEW",
                name: "product",
                is_channel: true,
                latest: {
                  type: "message",
                  user: "U_SELF",
                  text: "New channel kickoff",
                  ts: slackTs(-418, 100),
                },
                num_members: 2,
              });
            }
            res.end(
              JSON.stringify({
                ok: true,
                channels,
                response_metadata: { next_cursor: "" },
              }),
            );
          }

          if (path === "/conversations.members") {
            const channel = params.get("channel");
            const members =
              channel === "C_NEW"
                ? ["U_SELF", "U_BEN"]
                : channel === "C_ENG"
                  ? ["U_SELF", "U_BEN", "U_CARA"]
                  : channel === "G_NEW"
                    ? ["U_SELF", "U_CARA", "U_DREW"]
                    : ["U_SELF", "U_CARA"];
            res.end(
              JSON.stringify({
                ok: true,
                members,
                response_metadata: { next_cursor: "" },
              }),
            );
            return;
          }

          if (path === "/conversations.history") {
            const channel = params.get("channel");
            const cursor = params.get("cursor") ?? "";

            if (phase === "bootstrap" && channel === "C_ENG") {
              if (!cursor) {
                res.end(
                  JSON.stringify({
                    ok: true,
                    messages: [channelRootMessage],
                    has_more: true,
                    response_metadata: { next_cursor: "history-2" },
                  }),
                );
                return;
              }
              res.end(
                JSON.stringify({
                  ok: true,
                  messages: [channelOlderMessage],
                  has_more: false,
                  response_metadata: { next_cursor: "" },
                }),
              );
              return;
            }

            if (phase === "expand") {
              if (channel === "D_DREW") {
                res.end(
                  JSON.stringify({
                    ok: true,
                    messages: [
                      {
                        type: "message",
                        user: "U_DREW",
                        text: "New DM hello",
                        ts: slackTs(-420, 100),
                      },
                    ],
                    has_more: false,
                    response_metadata: { next_cursor: "" },
                  }),
                );
                return;
              }
              if (channel === "G_NEW") {
                res.end(
                  JSON.stringify({
                    ok: true,
                    messages: [
                      {
                        type: "message",
                        user: "U_CARA",
                        text: "New group hello",
                        ts: slackTs(-419, 100),
                      },
                    ],
                    has_more: false,
                    response_metadata: { next_cursor: "" },
                  }),
                );
                return;
              }
              if (channel === "C_NEW") {
                res.end(
                  JSON.stringify({
                    ok: true,
                    messages: [
                      {
                        type: "message",
                        user: "U_SELF",
                        text: "New channel kickoff",
                        ts: slackTs(-418, 100),
                      },
                    ],
                    has_more: false,
                    response_metadata: { next_cursor: "" },
                  }),
                );
                return;
              }
            }

            const messages =
              channel === "D_BEN" ? [dmBenMessage] : channel === "G_TEAM" ? [groupMessage] : [];
            res.end(
              JSON.stringify({
                ok: true,
                messages: phase === "rerun" ? [] : messages,
                has_more: false,
                response_metadata: { next_cursor: "" },
              }),
            );
            return;
          }

          if (path === "/conversations.replies") {
            const cursor = params.get("cursor") ?? "";
            if (phase !== "bootstrap") {
              res.end(
                JSON.stringify({
                  ok: true,
                  messages: [],
                  has_more: false,
                  response_metadata: { next_cursor: "" },
                }),
              );
              return;
            }

            if (!cursor) {
              res.end(
                JSON.stringify({
                  ok: true,
                  messages: [channelRootMessage, threadReplyOne],
                  has_more: true,
                  response_metadata: { next_cursor: "replies-2" },
                }),
              );
              return;
            }
            res.end(
              JSON.stringify({
                ok: true,
                messages: [threadReplyTwo],
                has_more: false,
                response_metadata: { next_cursor: "" },
              }),
            );
          }
        });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected test server address");
    }
    const apiURL = `http://127.0.0.1:${address.port}/`;

    try {
      const first = await runSlackPhase(db, {
        dbPath: db.dbPath,
        helperBinaryPath,
        apiURL,
        securityDir,
      });

      expect(first.bundle.syncMode).toBe("full");
      expect(first.bundle.hasMore).toBe(false);
      expect(first.totalInsertedCount).toBeGreaterThan(0);

      const firstConversations = db.orm().all<{ source_conversation_key: string }>(sql`
        SELECT source_conversation_key
        FROM conversations
        ORDER BY source_conversation_key ASC
      `);
      expect(firstConversations).toEqual([
        { source_conversation_key: "slack:T123:C_ENG" },
        { source_conversation_key: "slack:T123:D_BEN" },
        { source_conversation_key: "slack:T123:G_TEAM" },
      ]);

      const firstMessages = db.orm().all<{ content: string | null; reaction_count: number }>(sql`
        SELECT content, reaction_count
        FROM messages
        ORDER BY content ASC
      `);
      expect(firstMessages).toEqual([
        { content: "Hi Ava", reaction_count: 0 },
        { content: "Kickoff notes", reaction_count: 0 },
        { content: "Older context", reaction_count: 0 },
        { content: "Reply one", reaction_count: 0 },
        { content: "Reply two", reaction_count: 0 },
        { content: "Weekly sync", reaction_count: 1 },
      ]);

      const attachmentRows = db.orm().all<{ source_attachment_key: string }>(sql`
        SELECT source_attachment_key
        FROM message_attachments
        ORDER BY source_attachment_key ASC
      `);
      expect(attachmentRows.length).toBe(2);

      const firstCheckpoint = db.getCheckpoint("slack", "workspace-a");
      expect(firstCheckpoint?.sync_mode).toBe("incremental");
      expect(JSON.parse(firstCheckpoint?.source_cursor_json ?? "{}")).toEqual(
        expect.objectContaining({
          teamId: "T123",
          selfUserId: "U_SELF",
          lastSyncAt: expect.any(Number),
        }),
      );

      expect(db.listSyncProofs("slack", "workspace-a")).toEqual([
        expect.objectContaining({
          scope_key: "C_ENG",
          proof_kind: "messages",
          status: "complete",
          stats_json: expect.stringContaining('"threadRootCount":1'),
        }),
        expect.objectContaining({
          scope_key: "C_ENG",
          proof_kind: "replies",
          status: "complete",
          stats_json: expect.stringContaining('"completedThreadCount":1'),
        }),
        expect.objectContaining({
          scope_key: "D_BEN",
          proof_kind: "messages",
          status: "complete",
        }),
        expect.objectContaining({
          scope_key: "G_TEAM",
          proof_kind: "messages",
          status: "complete",
        }),
      ]);

      phase = "rerun";
      const second = await runSlackPhase(db, {
        dbPath: db.dbPath,
        helperBinaryPath,
        apiURL,
        securityDir,
      });
      expect(second.bundle.syncMode).toBe("incremental");
      expect(second.totalInsertedCount).toBe(0);

      const secondMessageCount = db.orm().get<{ count: number }>(sql`
        SELECT COUNT(*) as count
        FROM messages
      `);
      expect(secondMessageCount).toEqual({ count: 6 });

      phase = "expand";
      const third = await runSlackPhase(db, {
        dbPath: db.dbPath,
        helperBinaryPath,
        apiURL,
        securityDir,
      });
      expect(third.bundle.syncMode).toBe("incremental");
      expect(third.totalInsertedCount).toBeGreaterThan(0);

      const finalConversations = db.orm().all<{ source_conversation_key: string }>(sql`
        SELECT source_conversation_key
        FROM conversations
        ORDER BY source_conversation_key ASC
      `);
      expect(finalConversations).toEqual([
        { source_conversation_key: "slack:T123:C_ENG" },
        { source_conversation_key: "slack:T123:C_NEW" },
        { source_conversation_key: "slack:T123:D_BEN" },
        { source_conversation_key: "slack:T123:D_DREW" },
        { source_conversation_key: "slack:T123:G_NEW" },
        { source_conversation_key: "slack:T123:G_TEAM" },
      ]);

      const finalMessageRows = db.orm().all<{ content: string | null }>(sql`
        SELECT content
        FROM messages
        ORDER BY content ASC
      `);
      expect(finalMessageRows).toEqual(
        expect.arrayContaining([
          { content: "New DM hello" },
          { content: "New group hello" },
          { content: "New channel kickoff" },
        ]),
      );

      const finalCheckpoint = db.getCheckpoint("slack", "workspace-a");
      expect(finalCheckpoint?.sync_mode).toBe("incremental");
      expect(finalCheckpoint?.raw_ingest_watermark).toBe(
        db.getProjectionBacklog().max_raw_event_rowid,
      );
      expect(JSON.parse(finalCheckpoint?.source_cursor_json ?? "{}")).toEqual(
        expect.objectContaining({
          knownConversationIds: expect.arrayContaining([
            "C_ENG",
            "C_NEW",
            "D_BEN",
            "D_DREW",
            "G_NEW",
            "G_TEAM",
          ]),
        }),
      );

      expect(db.listSyncProofs("slack", "workspace-a")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope_key: "C_NEW",
            proof_kind: "messages",
            status: "complete",
          }),
          expect.objectContaining({
            scope_key: "D_DREW",
            proof_kind: "messages",
            status: "complete",
          }),
          expect.objectContaining({
            scope_key: "G_NEW",
            proof_kind: "messages",
            status: "complete",
          }),
        ]),
      );
    } finally {
      process.execArgv = originalExecArgv;
      db.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15_000);
});

async function runSlackCycle(
  db: CuedDatabase,
  options: {
    dbPath: string;
    helperBinaryPath: string;
    apiURL: string;
    securityDir: string;
    apiPageBudget?: number;
  },
) {
  const checkpoint = db.getCheckpoint("slack", "workspace-a");
  const envOverrides: Record<string, string> = {
    CUED_DB_PATH: options.dbPath,
    CUED_SLACK_HELPER_BINARY: options.helperBinaryPath,
    CUED_SLACK_HELPER_API_URL: options.apiURL,
    PATH: `${options.securityDir}:${process.env.PATH ?? ""}`,
  };
  if (checkpoint?.source_cursor_json) {
    envOverrides.CUED_SYNC_SOURCE_CURSOR = checkpoint.source_cursor_json;
  }
  if (typeof options.apiPageBudget === "number") {
    envOverrides.CUED_SLACK_API_PAGE_BUDGET = String(options.apiPageBudget);
  }

  const bundle = await runAdapter("slack", "workspace-a", envOverrides);
  const insertResult = db.insertRawEvents(bundle.rawEvents);
  db.upsertSourceAccounts(bundle.sourceAccounts ?? []);
  for (const proof of bundle.proofs ?? []) {
    db.upsertSyncProof({
      platform: "slack",
      accountKey: "workspace-a",
      proof,
    });
  }
  const projection = projectPendingRawEvents(db);
  const resolvedSyncMode = resolveCheckpointSyncMode(
    checkpoint?.sync_mode ?? null,
    bundle.syncMode ?? null,
    bundle.hasMore ?? false,
  );
  db.upsertCheckpoint({
    platform: "slack",
    accountKey: "workspace-a",
    syncMode: resolvedSyncMode,
    sourceCursor: bundle.sourceCursor,
    rawIngestWatermark: db.getProjectionBacklog().max_raw_event_rowid,
    lastSuccessAt: Date.now(),
  });

  return {
    bundle,
    insertResult,
    projection,
  };
}

async function runSlackPhase(
  db: CuedDatabase,
  options: {
    dbPath: string;
    helperBinaryPath: string;
    apiURL: string;
    securityDir: string;
  },
) {
  let result = await runSlackCycle(db, options);
  let totalInsertedCount = result.insertResult.insertedCount;
  while (result.bundle.hasMore) {
    result = await runSlackCycle(db, options);
    totalInsertedCount += result.insertResult.insertedCount;
  }

  return {
    ...result,
    totalInsertedCount,
  };
}

function resolveCheckpointSyncMode(
  priorSyncMode: string | null,
  bundleSyncMode: string | null,
  hasMore: boolean,
): "full" | "incremental" {
  if (hasMore) {
    return "full";
  }
  if (priorSyncMode === "full") {
    return "incremental";
  }
  return bundleSyncMode === "incremental" ? "incremental" : "full";
}
