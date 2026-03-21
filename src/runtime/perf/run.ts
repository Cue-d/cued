import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildNormalizedRawEventSchema,
  type ProviderRawEventInput,
} from "../../core/types/provider.js";
import { CuedDatabase } from "../../db/database.js";
import { buildIMessageSyncBundle } from "../../platforms/imessage/sync.js";
import type {
  Connection,
  Conversation,
  Message,
  MessagingParticipant,
} from "../../platforms/linkedin/api/index.js";
import { buildLinkedInSyncBundle } from "../../platforms/linkedin/sync/bundle.js";
import { buildSlackSyncBundle } from "../../platforms/slack/sync/bundle.js";
import type { SlackConversation, SlackMessage, SlackUser } from "../../platforms/slack/types.js";
import {
  projectDeferredRange,
  projectPendingRawEvents,
  projectRealtimeRange,
} from "../projection/projector.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const ITERATIONS = 5;

type BenchmarkResult = {
  name: string;
  samplesMs: number[];
  medianMs: number;
  peakRssBytes: number;
};

type BaselineFile = Record<string, { medianMs: number }>;

function perfRawEvent(input: ProviderRawEventInput): ProviderRawEventInput {
  return {
    ...input,
    normalizedSchema: buildNormalizedRawEventSchema(input.entityKind, input.eventKind),
    provenance: {
      sourceVersion: input.sourceVersion ?? "perf-v1",
      adapterVersion: "perf-harness@1",
    },
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function measureRun<T>(execute: () => Promise<T> | T): Promise<{
  result: T;
  durationMs: number;
  peakRssBytes: number;
}> {
  const beforeRss = process.memoryUsage().rss;
  const startedAt = performance.now();
  const result = await execute();
  const durationMs = performance.now() - startedAt;
  const afterRss = process.memoryUsage().rss;
  return {
    result,
    durationMs,
    peakRssBytes: Math.max(beforeRss, afterRss),
  };
}

async function benchmarkScenario(
  name: string,
  execute: () => Promise<void> | void,
): Promise<BenchmarkResult> {
  const samplesMs: number[] = [];
  let peakRssBytes = 0;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const { durationMs, peakRssBytes: observedPeakRss } = await measureRun(execute);
    samplesMs.push(durationMs);
    peakRssBytes = Math.max(peakRssBytes, observedPeakRss);
  }

  return {
    name,
    samplesMs,
    medianMs: median(samplesMs),
    peakRssBytes,
  };
}

function createSyntheticIMessageChatDb(): { dir: string; dbPath: string } {
  const dir = createTempDir("cued-perf-imessage-");
  const dbPath = join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE handle (
      id TEXT NOT NULL,
      service TEXT NOT NULL
    );
    CREATE TABLE chat (
      chat_identifier TEXT NOT NULL,
      display_name TEXT
    );
    CREATE TABLE chat_handle_join (
      chat_id INTEGER NOT NULL,
      handle_id INTEGER NOT NULL
    );
    CREATE TABLE message (
      guid TEXT NOT NULL,
      handle_id INTEGER,
      text TEXT,
      attributedBody BLOB,
      date INTEGER,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      is_sent INTEGER NOT NULL DEFAULT 1,
      is_delivered INTEGER NOT NULL DEFAULT 1,
      is_read INTEGER NOT NULL DEFAULT 0,
      date_read INTEGER,
      error INTEGER NOT NULL DEFAULT 0,
      cache_has_attachments INTEGER NOT NULL DEFAULT 0,
      item_type INTEGER NOT NULL DEFAULT 0,
      associated_message_type INTEGER NOT NULL DEFAULT 0,
      associated_message_emoji TEXT,
      associated_message_guid TEXT
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL
    );
    CREATE TABLE attachment (
      guid TEXT NOT NULL,
      filename TEXT,
      uti TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      is_sticker INTEGER NOT NULL DEFAULT 0,
      hide_attachment INTEGER NOT NULL DEFAULT 0,
      ck_record_id TEXT
    );
    CREATE TABLE message_attachment_join (
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL
    );
  `);

  const insertHandle = db.prepare("INSERT INTO handle (id, service) VALUES (?, ?)");
  const insertChat = db.prepare("INSERT INTO chat (chat_identifier, display_name) VALUES (?, ?)");
  const insertChatHandle = db.prepare(
    "INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)",
  );
  const insertMessage = db.prepare(`
    INSERT INTO message (
      guid,
      handle_id,
      text,
      attributedBody,
      date,
      is_from_me,
      is_sent,
      is_delivered,
      is_read,
      date_read,
      error,
      cache_has_attachments,
      item_type,
      associated_message_type,
      associated_message_emoji,
      associated_message_guid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChatJoin = db.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)",
  );

  let rowId = 0;
  for (let chatIndex = 1; chatIndex <= 200; chatIndex += 1) {
    insertHandle.run(`+1415555${String(chatIndex).padStart(4, "0")}`, "iMessage");
    insertChat.run(`chat-${chatIndex}`, `Chat ${chatIndex}`);
    insertChatHandle.run(chatIndex, chatIndex);

    for (let messageIndex = 1; messageIndex <= 10; messageIndex += 1) {
      rowId += 1;
      insertMessage.run(
        `message-${rowId}`,
        chatIndex,
        `hello ${chatIndex}-${messageIndex}`,
        null,
        rowId * 1_000_000_000,
        0,
        1,
        1,
        0,
        null,
        0,
        0,
        0,
        0,
        null,
        null,
      );
      insertChatJoin.run(chatIndex, rowId);
    }
  }

  insertMessage.run(
    "message-seed",
    1,
    "seed message",
    null,
    1,
    0,
    1,
    1,
    0,
    null,
    0,
    0,
    0,
    0,
    null,
    null,
  );
  insertChatJoin.run(1, 2001);

  db.close();
  return { dir, dbPath };
}

function createSlackClientFixture(conversationCount: number, messagesPerConversation: number) {
  const pageSize = 25;
  const users: SlackUser[] = Array.from({ length: conversationCount + 1 }, (_, index) => ({
    id: index === 0 ? "U_SELF" : `U_${index}`,
    team_id: "T_PERF",
    name: index === 0 ? "self" : `user-${index}`,
    real_name: index === 0 ? "Perf Self" : `Perf User ${index}`,
    profile: {
      email: index === 0 ? "self@example.com" : `user-${index}@example.com`,
      image_192: `https://img.example.com/${index}.png`,
    },
  }));
  const conversations: SlackConversation[] = Array.from(
    { length: conversationCount },
    (_, index) => ({
      id: `C_${index + 1}`,
      is_im: index % 2 === 0,
      is_group: index % 2 === 1,
      user: index % 2 === 0 ? `U_${index + 1}` : undefined,
      name: index % 2 === 1 ? `group-${index + 1}` : undefined,
      latest: undefined,
    }),
  );

  const membersByConversation = new Map<string, string[]>();
  const messagesByConversation = new Map<string, SlackMessage[]>();
  for (const conversation of conversations) {
    membersByConversation.set(
      conversation.id,
      conversation.is_im
        ? [conversation.user!]
        : [
            `U_${((Number(conversation.id.split("_")[1]) + 1) % conversationCount) + 1}`,
            `U_${Number(conversation.id.split("_")[1])}`,
          ],
    );
    messagesByConversation.set(
      conversation.id,
      Array.from({ length: messagesPerConversation }, (_, messageIndex) => ({
        type: "message",
        user: membersByConversation.get(conversation.id)?.[0] ?? "U_1",
        text: `message ${conversation.id}-${messageIndex + 1}`,
        ts: `${1_710_000_000 + messageIndex}.${String(messageIndex).padStart(6, "0")}`,
        reactions:
          messageIndex % 10 === 0 ? [{ name: "thumbsup", count: 1, users: ["U_SELF"] }] : [],
        files:
          messageIndex % 20 === 0
            ? [{ id: `F_${conversation.id}_${messageIndex}`, name: `file-${messageIndex}.txt` }]
            : [],
      })),
    );
  }

  return {
    async testAuth() {
      return {
        ok: true,
        team_id: "T_PERF",
        user_id: "U_SELF",
        team: "Perf Slack",
        user: "Perf Self",
      };
    },
    async listUsers(cursor?: string) {
      const offset = cursor ? Number(cursor) : 0;
      return {
        users: users.slice(offset, offset + pageSize),
        nextCursor: offset + pageSize < users.length ? String(offset + pageSize) : undefined,
      };
    },
    async listConversations(types: string, cursor?: string) {
      const requestedTypes = new Set(types.split(","));
      const filtered = conversations.filter((conversation) => {
        if (conversation.is_im) {
          return requestedTypes.has("im");
        }
        if (conversation.is_mpim) {
          return requestedTypes.has("mpim");
        }
        if (conversation.is_group) {
          return requestedTypes.has("private_channel");
        }
        if (conversation.is_channel) {
          return requestedTypes.has("public_channel");
        }
        return false;
      });
      const offset = cursor ? Number(cursor) : 0;
      return {
        conversations: filtered.slice(offset, offset + pageSize),
        nextCursor: offset + pageSize < filtered.length ? String(offset + pageSize) : undefined,
      };
    },
    async getConversationMembers(conversationId: string, cursor?: string) {
      const members = membersByConversation.get(conversationId) ?? [];
      const offset = cursor ? Number(cursor) : 0;
      return {
        members: members.slice(offset, offset + pageSize),
        nextCursor: offset + pageSize < members.length ? String(offset + pageSize) : undefined,
      };
    },
    async getHistory(conversationId: string, options?: { cursor?: string }) {
      const messages = messagesByConversation.get(conversationId) ?? [];
      const offset = options?.cursor ? Number(options.cursor) : 0;
      return {
        messages: messages.slice(offset, offset + pageSize),
        hasMore: offset + pageSize < messages.length,
        nextCursor: offset + pageSize < messages.length ? String(offset + pageSize) : undefined,
      };
    },
    async getReplies() {
      return {
        messages: [],
        hasMore: false,
        nextCursor: undefined,
      };
    },
  };
}

function createLinkedInClientFixture(conversationCount: number, messagesPerConversation: number) {
  const connections: Connection[] = Array.from({ length: conversationCount }, (_, index) => ({
    profileId: `ACo${String(index + 1).padStart(5, "0")}`,
    profileUrl: `https://www.linkedin.com/in/perf-${index + 1}`,
    firstName: "Perf",
    lastName: `User ${index + 1}`,
    headline: "Performance Engineer",
    picture: { url: `https://cdn.example.com/${index + 1}.jpg` },
  }));

  const conversations: Conversation[] = Array.from({ length: conversationCount }, (_, index) => ({
    title: `Perf User ${index + 1}`,
    entityURN: `urn:li:fsd_conversation:CONV_${index + 1}`,
    lastActivityAt: 1_710_000_000_000 + index,
    lastReadAt: 1_710_000_000_000 + index,
    groupChat: false,
    read: true,
    categories: ["PRIMARY_INBOX"],
    unreadCount: 0,
    conversationParticipants: [
      {
        entityURN: "urn:li:fsd_profile:SELF",
        participantType: {
          member: {
            firstName: "Perf",
            lastName: "Self",
            profileUrl: "https://www.linkedin.com/in/perf-self",
          },
        },
      },
      {
        entityURN: `urn:li:fsd_profile:${connections[index]!.profileId}`,
        participantType: {
          member: {
            firstName: "Perf",
            lastName: `User ${index + 1}`,
            headline: "Performance Engineer",
            profileUrl: connections[index]!.profileUrl,
            picture: connections[index]!.picture,
          },
        },
      },
    ] satisfies MessagingParticipant[],
    messages: {
      elements: [] as Message[],
    },
  }));

  const messagesByConversation = new Map<string, Message[]>();
  for (const conversation of conversations) {
    messagesByConversation.set(
      conversation.entityURN,
      Array.from({ length: messagesPerConversation }, (_, messageIndex) => ({
        entityURN: `urn:li:fsd_message:${conversation.entityURN}:${messageIndex + 1}`,
        body: { text: `linkedin ${conversation.entityURN}-${messageIndex + 1}` },
        deliveredAt: 1_710_000_000_000 + messageIndex,
        sender: conversation.conversationParticipants[1],
        messageBodyRenderFormat: "DEFAULT" as const,
        renderContent: [],
        reactionSummaries: [],
        conversationURN: conversation.entityURN,
      })),
    );
  }

  return {
    async fetchSelf() {
      return "urn:li:fsd_profile:SELF";
    },
    async getConnections(cursor?: string) {
      const offset = cursor ? Number(cursor) : 0;
      return {
        connections: connections.slice(offset, offset + 25),
        cursor: offset + 25 < connections.length ? String(offset + 25) : undefined,
      };
    },
    async getConversations(_syncToken?: string) {
      return {
        conversations,
        syncToken: "perf-sync-token",
      };
    },
    async getConversationsBefore() {
      return {
        conversations: [],
      };
    },
    async getMessages(conversationUrn: string) {
      return {
        messages: messagesByConversation.get(conversationUrn) ?? [],
      };
    },
    async getMessagesBefore() {
      return {
        messages: [],
      };
    },
    async getMessagesWithPrevCursor() {
      return {
        messages: [],
        prevCursor: null,
      };
    },
    async getReactors() {
      return [];
    },
  };
}

function buildProjectionReplayEvents(): ProviderRawEventInput[] {
  const rawEvents: ProviderRawEventInput[] = [];
  const baseObservedAt = 1_771_000_000_000;
  for (let conversationIndex = 1; conversationIndex <= 100; conversationIndex += 1) {
    rawEvents.push(
      perfRawEvent({
        id: `contact-${conversationIndex}`,
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: baseObservedAt + conversationIndex,
        dedupeKey: `contacts:${conversationIndex}`,
        payload: {
          sourceEntityKey: `contacts:${conversationIndex}`,
          fields: {
            display_name: `Perf Contact ${conversationIndex}`,
          },
          handles: [
            { type: "email", value: `perf-${conversationIndex}@example.com`, deterministic: true },
          ],
        },
        sourceVersion: "perf-v1",
      }),
    );
    rawEvents.push(
      perfRawEvent({
        id: `conversation-${conversationIndex}`,
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: baseObservedAt + 10_000 + conversationIndex,
        dedupeKey: `conversation:${conversationIndex}`,
        payload: {
          sourceConversationKey: `perf-conversation-${conversationIndex}`,
          conversationType: "dm",
          service: "linkedin",
          participants: [{ sourceEntityKey: `contacts:${conversationIndex}` }],
        },
        sourceVersion: "perf-v1",
      }),
    );

    for (let messageIndex = 1; messageIndex <= 98; messageIndex += 1) {
      rawEvents.push(
        perfRawEvent({
          id: `message-${conversationIndex}-${messageIndex}`,
          platform: "linkedin",
          accountKey: "default",
          entityKind: "message",
          eventKind: "created",
          observedAt: baseObservedAt + 20_000 + conversationIndex * 100 + messageIndex,
          dedupeKey: `message:${conversationIndex}:${messageIndex}`,
          payload: {
            sourceMessageKey: `perf-message-${conversationIndex}-${messageIndex}`,
            sourceConversationKey: `perf-conversation-${conversationIndex}`,
            senderSourceKey: `contacts:${conversationIndex}`,
            sentAt: baseObservedAt + conversationIndex * 100 + messageIndex,
            content: `Projection perf message ${conversationIndex}-${messageIndex}`,
            service: "linkedin",
            isFromMe: false,
          },
          sourceVersion: "perf-v1",
        }),
      );
    }
  }

  return rawEvents;
}

function buildIncrementalProjectionEvents(
  conversationCount: number,
  messagesPerConversation: number,
): ProviderRawEventInput[] {
  const rawEvents: ProviderRawEventInput[] = [];
  const baseObservedAt = 1_772_000_000_000;
  for (let conversationIndex = 1; conversationIndex <= conversationCount; conversationIndex += 1) {
    rawEvents.push(
      perfRawEvent({
        id: `incremental-contact-${conversationIndex}`,
        platform: "contacts",
        accountKey: "local",
        entityKind: "contact",
        eventKind: "observed",
        observedAt: baseObservedAt + conversationIndex,
        dedupeKey: `incremental-contact:${conversationIndex}`,
        payload: {
          sourceEntityKey: `contacts:${conversationIndex}`,
          fields: {
            display_name: `Incremental Contact ${conversationIndex}`,
          },
          handles: [
            {
              type: "email",
              value: `incremental-${conversationIndex}@example.com`,
              deterministic: true,
            },
          ],
        },
        sourceVersion: "perf-v1",
      }),
    );
    rawEvents.push(
      perfRawEvent({
        id: `incremental-conversation-${conversationIndex}`,
        platform: "linkedin",
        accountKey: "default",
        entityKind: "conversation",
        eventKind: "observed",
        observedAt: baseObservedAt + 10_000 + conversationIndex,
        dedupeKey: `incremental-conversation:${conversationIndex}`,
        payload: {
          sourceConversationKey: `incremental-conversation-${conversationIndex}`,
          conversationType: "dm",
          participants: [{ sourceEntityKey: `contacts:${conversationIndex}` }],
        },
        sourceVersion: "perf-v1",
      }),
    );

    for (let messageIndex = 1; messageIndex <= messagesPerConversation; messageIndex += 1) {
      rawEvents.push(
        perfRawEvent({
          id: `incremental-message-${conversationIndex}-${messageIndex}`,
          platform: "linkedin",
          accountKey: "default",
          entityKind: "message",
          eventKind: "created",
          observedAt: baseObservedAt + 20_000 + conversationIndex * 100 + messageIndex,
          dedupeKey: `incremental-message:${conversationIndex}:${messageIndex}`,
          payload: {
            sourceMessageKey: `incremental-message-${conversationIndex}-${messageIndex}`,
            sourceConversationKey: `incremental-conversation-${conversationIndex}`,
            senderSourceKey: `contacts:${conversationIndex}`,
            sentAt: baseObservedAt + conversationIndex * 100 + messageIndex,
            content: `Incremental message ${conversationIndex}-${messageIndex}`,
            service: "linkedin",
            isFromMe: false,
          },
          sourceVersion: "perf-v1",
        }),
      );
    }
  }

  return rawEvents;
}

function runProjectionReplayBenchmark(rawEvents: ProviderRawEventInput[]): void {
  const dir = createTempDir("cued-perf-projection-");
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    db.insertRawEvents(rawEvents);
    projectPendingRawEvents(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIncrementalInsertBenchmark(rawEvents: ProviderRawEventInput[]): void {
  const dir = createTempDir("cued-perf-incremental-insert-");
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    db.insertRawEvents(rawEvents);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIncrementalRealtimeBenchmark(rawEvents: ProviderRawEventInput[]): void {
  const dir = createTempDir("cued-perf-incremental-hot-");
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    const insertResult = db.insertRawEvents(rawEvents);
    if (insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null) {
      projectRealtimeRange(db, {
        startRowId: insertResult.firstInsertedRowId,
        endRowId: insertResult.lastInsertedRowId,
        batchSize: 1_000,
      });
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIncrementalCatchupBenchmark(rawEvents: ProviderRawEventInput[]): void {
  const dir = createTempDir("cued-perf-incremental-catchup-");
  const db = new CuedDatabase(join(dir, "local.db"));
  try {
    db.migrate();
    const insertResult = db.insertRawEvents(rawEvents);
    if (insertResult.firstInsertedRowId != null && insertResult.lastInsertedRowId != null) {
      projectRealtimeRange(db, {
        startRowId: insertResult.firstInsertedRowId,
        endRowId: insertResult.lastInsertedRowId,
        batchSize: 1_000,
      });
      projectDeferredRange(db, {
        startRowId: insertResult.firstInsertedRowId,
        endRowId: insertResult.lastInsertedRowId,
      });
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadBaseline(path: string | null): BaselineFile | null {
  if (!path || !existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
}

function maybeWriteBaseline(path: string | null, results: BenchmarkResult[]): void {
  if (!path) {
    return;
  }

  const baseline = Object.fromEntries(
    results.map((result) => [result.name, { medianMs: result.medianMs }]),
  );
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

function assertAgainstBaseline(baseline: BaselineFile | null, results: BenchmarkResult[]): void {
  if (!baseline) {
    return;
  }

  const regressions = results.filter((result) => {
    const baselineEntry = baseline[result.name];
    if (!baselineEntry) {
      return false;
    }
    return result.medianMs > baselineEntry.medianMs * 1.1;
  });

  if (regressions.length === 0) {
    return;
  }

  throw new Error(
    regressions
      .map((result) => {
        const baselineMedian = baseline[result.name]!.medianMs;
        return `${result.name} regressed from ${formatMs(baselineMedian)} to ${formatMs(result.medianMs)}`;
      })
      .join("\n"),
  );
}

async function main(): Promise<void> {
  const baselinePathArg = process.argv.find((arg) => arg.startsWith("--baseline="));
  const writeBaselineArg = process.argv.find((arg) => arg.startsWith("--write-baseline="));
  const baselinePath = baselinePathArg?.split("=")[1] ?? null;
  const writeBaselinePath = writeBaselineArg?.split("=")[1] ?? null;

  const imessageFixture = createSyntheticIMessageChatDb();
  const slackClient = createSlackClientFixture(100, 100);
  const linkedInClient = createLinkedInClientFixture(50, 100);
  const incrementalProjectionEvents = buildIncrementalProjectionEvents(20, 25);
  const projectionEvents = buildProjectionReplayEvents();

  try {
    const results = [
      await benchmarkScenario("imessage_incremental_sync", () => {
        buildIMessageSyncBundle({
          path: imessageFixture.dbPath,
          lastRowId: 1,
          limit: 2500,
          env: { CUED_IMESSAGE_DB_PATH: imessageFixture.dbPath },
          repoRoot: imessageFixture.dir,
        });
      }),
      await benchmarkScenario("slack_incremental_sync", async () => {
        await buildSlackSyncBundle({
          accountKey: "default",
          lastSyncAt: 1_709_999_000_000,
          client: slackClient,
          conversationPageLimit: 100,
          messagesPageLimit: 100,
        });
      }),
      await benchmarkScenario("linkedin_incremental_sync", async () => {
        await buildLinkedInSyncBundle({
          accountKey: "default",
          lastSyncAt: 1_709_999_000_000,
          client: linkedInClient,
          loadProjectedReactions: () => new Map(),
        });
      }),
      await benchmarkScenario("incremental_insert_only", () => {
        runIncrementalInsertBenchmark(incrementalProjectionEvents);
      }),
      await benchmarkScenario("incremental_webhook_ready", () => {
        runIncrementalRealtimeBenchmark(incrementalProjectionEvents);
      }),
      await benchmarkScenario("incremental_hot_plus_cold", () => {
        runIncrementalCatchupBenchmark(incrementalProjectionEvents);
      }),
      await benchmarkScenario("projection_replay_10k", () => {
        runProjectionReplayBenchmark(projectionEvents);
      }),
    ];

    console.log("Message sync performance benchmarks");
    for (const result of results) {
      console.log(
        `${result.name}: median=${formatMs(result.medianMs)} peak_rss=${formatBytes(result.peakRssBytes)} samples=[${result.samplesMs.map(formatMs).join(", ")}]`,
      );
    }

    maybeWriteBaseline(writeBaselinePath, results);
    assertAgainstBaseline(loadBaseline(baselinePath), results);
  } finally {
    rmSync(imessageFixture.dir, { recursive: true, force: true });
  }
}

void main();
