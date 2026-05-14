import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type { SyncProofInput } from "../../core/types/provider.js";
import type { SyncBundle } from "../core/sync.js";
import { buildWhatsAppRawEventsFromSnapshot, normalizeWhatsAppJid } from "./sync/events.js";
import type {
  WhatsAppChatSnapshot,
  WhatsAppContactSnapshot,
  WhatsAppMessageSnapshot,
  WhatsAppSnapshot,
} from "./types.js";

const CHAT_DB_NAME = "ChatStorage.sqlite";
const CONTACTS_DB_NAME = "ContactsV2.sqlite";
const APPLE_EPOCH_SECONDS = 978_307_200;

type DesktopChatRow = {
  jid: string;
  name: string;
  last_message_date: number | null;
  unread_count: number;
  raw_session_type: number;
};

type DesktopContactRow = {
  jid: string;
  phone: string;
  full_name: string;
  given_name: string;
  business_name: string;
  username: string;
};

type DesktopParticipantRow = {
  group_jid: string;
  user_jid: string;
};

type DesktopMessageRow = {
  source_pk: number;
  chat_jid: string;
  chat_name: string;
  message_id: string;
  from_me: number;
  message_date: number | null;
  text: string;
  raw_type: number;
  from_jid: string;
  to_jid: string;
  push_name: string;
  member_jid: string;
  member_name: string;
  member_first_name: string;
  media_path: string;
  media_url: string;
  media_title: string;
  vcard_name: string;
  media_size: number;
};

export interface WhatsAppDesktopSourceStatus {
  path: string;
  available: boolean;
  chatDbPath: string;
  contactsDbPath: string;
  mediaDirPath: string;
  chatRows: number;
  contactRows: number;
  messageRows: number;
  oldestMessageAt: number | null;
  newestMessageAt: number | null;
}

export interface WhatsAppDesktopImportOptions {
  sourcePath?: string;
  accountKey?: string;
  observedBase?: number;
}

export function defaultWhatsAppDesktopSourcePath(): string {
  return join(homedir(), "Library", "Group Containers", "group.net.whatsapp.WhatsApp.shared");
}

export function inspectWhatsAppDesktopSource(sourcePath = defaultWhatsAppDesktopSourcePath()) {
  const chatDbPath = join(sourcePath, CHAT_DB_NAME);
  const contactsDbPath = join(sourcePath, CONTACTS_DB_NAME);
  const mediaDirPath = join(sourcePath, "Message", "Media");
  const status: WhatsAppDesktopSourceStatus = {
    path: sourcePath,
    available: existsSync(chatDbPath),
    chatDbPath,
    contactsDbPath,
    mediaDirPath,
    chatRows: 0,
    contactRows: 0,
    messageRows: 0,
    oldestMessageAt: null,
    newestMessageAt: null,
  };
  if (!status.available) {
    return status;
  }

  const chatDb = openReadonlyDatabase(chatDbPath);
  try {
    status.chatRows = scalarNumber(chatDb, "SELECT COUNT(*) FROM ZWACHATSESSION");
    status.messageRows = scalarNumber(chatDb, "SELECT COUNT(*) FROM ZWAMESSAGE");
    const range = chatDb
      .prepare("SELECT MIN(ZMESSAGEDATE) AS oldest, MAX(ZMESSAGEDATE) AS newest FROM ZWAMESSAGE")
      .get() as { oldest: number | null; newest: number | null };
    status.oldestMessageAt = appleSecondsToUnixMs(range.oldest);
    status.newestMessageAt = appleSecondsToUnixMs(range.newest);
  } finally {
    chatDb.close();
  }

  if (existsSync(contactsDbPath)) {
    const contactsDb = openReadonlyDatabase(contactsDbPath);
    try {
      status.contactRows = scalarNumber(contactsDb, "SELECT COUNT(*) FROM ZWAADDRESSBOOKCONTACT");
    } finally {
      contactsDb.close();
    }
  }

  return status;
}

export function buildWhatsAppDesktopSyncBundle(
  options: WhatsAppDesktopImportOptions = {},
): SyncBundle {
  const sourcePath = options.sourcePath ?? defaultWhatsAppDesktopSourcePath();
  const accountKey = options.accountKey ?? "default";
  const observedBase = options.observedBase ?? Date.now();
  const inspected = inspectWhatsAppDesktopSource(sourcePath);
  if (!inspected.available) {
    throw new Error(`WhatsApp Desktop database not found: ${inspected.chatDbPath}`);
  }

  const snapshotDir = snapshotWhatsAppDesktopDatabases(sourcePath);
  try {
    const snapshot = readWhatsAppDesktopSnapshot({
      snapshotPath: snapshotDir,
      sourcePath,
    });
    const rawEvents = buildWhatsAppRawEventsFromSnapshot({
      accountKey,
      snapshot,
      observedBase,
    }).map((event) => ({
      ...event,
      provenance: {
        ...event.provenance,
        acquisitionMode: "sync" as const,
        adapterVersion: "whatsapp-desktop-db",
      },
    }));

    const stats = {
      contacts: snapshot.contacts?.length ?? 0,
      chats: snapshot.chats?.length ?? 0,
      messages: snapshot.messages?.length ?? 0,
      rawEvents: rawEvents.length,
      desktopChatRows: inspected.chatRows,
      desktopContactRows: inspected.contactRows,
      desktopMessageRows: inspected.messageRows,
    };
    const completedAt = Date.now();
    const proof: SyncProofInput = {
      scope: {
        kind: "account",
        key: accountKey,
        displayName: "WhatsApp Desktop",
        metadata: {
          source: "desktop_db",
          sourcePath,
        },
      },
      proofKind: "messages",
      status: "complete",
      syncMode: "full",
      observedAt: observedBase,
      runStartedAt: observedBase,
      completedAt,
      coverage: {
        source: "desktop_db",
        oldestMessageAt: inspected.oldestMessageAt,
        newestMessageAt: inspected.newestMessageAt,
        snapshotCompletedAt: completedAt,
      },
      stats,
    };

    return {
      sourceAccounts: [{ platform: "whatsapp", accountKey, displayName: "WhatsApp Desktop" }],
      rawEvents,
      sourceCursor: {
        desktopDb: {
          sourcePath,
          importedAt: completedAt,
          chatRows: inspected.chatRows,
          contactRows: inspected.contactRows,
          messageRows: inspected.messageRows,
          oldestMessageAt: inspected.oldestMessageAt,
          newestMessageAt: inspected.newestMessageAt,
        },
      },
      syncMode: "full",
      hasMore: false,
      proofs: [proof],
      diagnostics: {
        source: "desktop_db",
        sourcePath,
        stats,
      },
    };
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function readWhatsAppDesktopSnapshot(input: {
  snapshotPath: string;
  sourcePath: string;
}): WhatsAppSnapshot {
  const chatDb = openReadonlyDatabase(join(input.snapshotPath, CHAT_DB_NAME));
  const contactsDbPath = join(input.snapshotPath, CONTACTS_DB_NAME);
  const contactsDb = existsSync(contactsDbPath) ? openReadonlyDatabase(contactsDbPath) : null;
  try {
    const contacts = contactsDb ? readContacts(contactsDb) : [];
    const contactNames = new Map<string, string>();
    for (const contact of contacts) {
      const name = contact.name?.trim() || contact.pushName?.trim() || contact.phone?.trim();
      if (name) {
        contactNames.set(normalizeWhatsAppJid(contact.jid), name);
      }
    }
    const participants = readParticipants(chatDb);
    const chats = readChats(chatDb, participants);
    const messages = readMessages(chatDb, input.sourcePath, contactNames);
    return { contacts, chats, messages };
  } finally {
    chatDb.close();
    contactsDb?.close();
  }
}

function readContacts(db: Database.Database): WhatsAppContactSnapshot[] {
  const rows = db
    .prepare(`
      SELECT
        COALESCE(ZWHATSAPPID, '') AS jid,
        COALESCE(ZPHONENUMBER, '') AS phone,
        COALESCE(ZFULLNAME, '') AS full_name,
        COALESCE(ZGIVENNAME, '') AS given_name,
        COALESCE(ZBUSINESSNAME, '') AS business_name,
        COALESCE(ZUSERNAME, '') AS username
      FROM ZWAADDRESSBOOKCONTACT
    `)
    .all() as DesktopContactRow[];
  return rows
    .filter((row) => row.jid.trim().length > 0)
    .map((row) => ({
      jid: normalizeWhatsAppJid(row.jid),
      phone: row.phone || extractPhoneFromJid(row.jid),
      name: firstNonEmpty(row.full_name, row.business_name, row.username, row.given_name),
      pushName: null,
    }));
}

function readParticipants(db: Database.Database): Map<string, Set<string>> {
  if (!tableExists(db, "ZWAGROUPMEMBER")) {
    return new Map();
  }
  const rows = db
    .prepare(`
      SELECT
        COALESCE(c.ZCONTACTJID, '') AS group_jid,
        COALESCE(gm.ZMEMBERJID, '') AS user_jid
      FROM ZWAGROUPMEMBER gm
      JOIN ZWACHATSESSION c ON c.Z_PK = gm.ZCHATSESSION
    `)
    .all() as DesktopParticipantRow[];
  const byGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    const groupJid = normalizeWhatsAppJid(row.group_jid);
    const userJid = normalizeWhatsAppJid(row.user_jid);
    if (!groupJid || !userJid) {
      continue;
    }
    const existing = byGroup.get(groupJid) ?? new Set<string>();
    existing.add(userJid);
    byGroup.set(groupJid, existing);
  }
  return byGroup;
}

function readChats(
  db: Database.Database,
  participantsByGroup: Map<string, Set<string>>,
): WhatsAppChatSnapshot[] {
  const rows = db
    .prepare(`
      SELECT
        COALESCE(ZCONTACTJID, '') AS jid,
        COALESCE(ZPARTNERNAME, '') AS name,
        ZLASTMESSAGEDATE AS last_message_date,
        COALESCE(ZUNREADCOUNT, 0) AS unread_count,
        COALESCE(ZSESSIONTYPE, 0) AS raw_session_type
      FROM ZWACHATSESSION
    `)
    .all() as DesktopChatRow[];
  const byJid = new Map<string, WhatsAppChatSnapshot>();
  for (const row of rows) {
    const jid = normalizeWhatsAppJid(row.jid);
    if (!jid) {
      continue;
    }
    const isGroup = jid.endsWith("@g.us");
    const participants = isGroup ? [...(participantsByGroup.get(jid) ?? new Set<string>())] : [jid];
    const existing = byJid.get(jid);
    if (existing) {
      if (!existing.name && row.name) {
        existing.name = row.name;
      }
      for (const participant of participants) {
        if (!existing.participants?.includes(participant)) {
          existing.participants?.push(participant);
        }
      }
      continue;
    }
    byJid.set(jid, {
      jid,
      name: row.name || null,
      isGroup,
      participants,
    });
  }
  return [...byJid.values()];
}

function readMessages(
  db: Database.Database,
  sourcePath: string,
  contactNames: Map<string, string>,
): WhatsAppMessageSnapshot[] {
  const rows = db
    .prepare(`
      SELECT
        m.Z_PK AS source_pk,
        COALESCE(c.ZCONTACTJID, '') AS chat_jid,
        COALESCE(c.ZPARTNERNAME, '') AS chat_name,
        COALESCE(m.ZSTANZAID, '') AS message_id,
        COALESCE(m.ZISFROMME, 0) AS from_me,
        m.ZMESSAGEDATE AS message_date,
        COALESCE(m.ZTEXT, '') AS text,
        COALESCE(m.ZMESSAGETYPE, 0) AS raw_type,
        COALESCE(m.ZFROMJID, '') AS from_jid,
        COALESCE(m.ZTOJID, '') AS to_jid,
        COALESCE(m.ZPUSHNAME, '') AS push_name,
        COALESCE(gm.ZMEMBERJID, '') AS member_jid,
        COALESCE(gm.ZCONTACTNAME, '') AS member_name,
        COALESCE(gm.ZFIRSTNAME, '') AS member_first_name,
        COALESCE(mi.ZMEDIALOCALPATH, '') AS media_path,
        COALESCE(mi.ZMEDIAURL, '') AS media_url,
        COALESCE(mi.ZTITLE, '') AS media_title,
        COALESCE(mi.ZVCARDNAME, '') AS vcard_name,
        COALESCE(mi.ZFILESIZE, 0) AS media_size
      FROM ZWAMESSAGE m
      LEFT JOIN ZWACHATSESSION c ON c.Z_PK = m.ZCHATSESSION
      LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
      LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
      ORDER BY m.ZMESSAGEDATE ASC, m.Z_PK ASC
    `)
    .all() as DesktopMessageRow[];
  return rows.flatMap((row) => {
    const chatJID = normalizeWhatsAppJid(row.chat_jid);
    const messageID = row.message_id.trim();
    if (!chatJID || !messageID) {
      return [];
    }
    const fromMe = row.from_me !== 0;
    const senderJID = fromMe
      ? null
      : normalizeWhatsAppJid(firstNonEmpty(row.member_jid, row.from_jid, chatJID) ?? chatJID);
    const text = firstNonEmpty(row.text, row.media_title, row.vcard_name) ?? "";
    const mediaTitle = firstNonEmpty(row.media_title, row.vcard_name);
    const mediaPath = row.media_path
      ? join(sourcePath, ...row.media_path.split("/").filter(Boolean))
      : null;
    return [
      {
        messageID,
        chatJID,
        senderJID,
        participantJID: row.member_jid ? normalizeWhatsAppJid(row.member_jid) : null,
        fromMe,
        timestamp: appleSecondsToUnixMs(row.message_date) ?? 0,
        text,
        pushName:
          firstNonEmpty(
            row.member_name,
            row.member_first_name,
            row.push_name,
            senderJID ? contactNames.get(senderJID) : null,
            row.chat_name,
          ) ?? null,
        status: fromMe ? "sent" : "delivered",
        attachments:
          mediaPath || row.media_url || mediaTitle
            ? [
                {
                  sourceAttachmentKey: `whatsapp-desktop:${chatJID}:${messageID}:media`,
                  kind: mediaKind(row.raw_type),
                  title: mediaTitle,
                  local_path: mediaPath,
                  remote_url: row.media_url || null,
                  size_bytes: row.media_size || null,
                  availability_status: mediaPath ? "available" : "metadata_only",
                  provider_metadata: {
                    source: "desktop_db",
                    rawType: row.raw_type,
                  },
                },
              ]
            : [],
      } satisfies WhatsAppMessageSnapshot,
    ];
  });
}

function snapshotWhatsAppDesktopDatabases(sourcePath: string): string {
  const snapshotDir = mkdtempSync(join(tmpdir(), "cued-whatsapp-desktop-"));
  try {
    copySqliteTriad(sourcePath, snapshotDir, CHAT_DB_NAME, true);
    copySqliteTriad(sourcePath, snapshotDir, CONTACTS_DB_NAME, false);
    return snapshotDir;
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

function copySqliteTriad(sourceDir: string, destDir: string, filename: string, required: boolean) {
  const source = join(sourceDir, filename);
  if (!existsSync(source)) {
    if (required) {
      throw new Error(`WhatsApp Desktop database not found: ${source}`);
    }
    return;
  }
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${source}${suffix}`;
    if (!existsSync(from)) {
      continue;
    }
    const to = join(destDir, `${filename}${suffix}`);
    copyFileSync(from, to);
  }
}

function openReadonlyDatabase(path: string): Database.Database {
  return new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
}

function scalarNumber(db: Database.Database, query: string): number {
  try {
    const row = db.prepare(query).pluck().get() as number | bigint | null | undefined;
    return typeof row === "bigint" ? Number(row) : typeof row === "number" ? row : 0;
  } catch {
    return 0;
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

function appleSecondsToUnixMs(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc((value + APPLE_EPOCH_SECONDS) * 1000);
}

function extractPhoneFromJid(jid: string): string | null {
  const [user, server] = normalizeWhatsAppJid(jid).split("@");
  return user && /^\d+$/.test(user) && server?.includes("whatsapp.net") ? `+${user}` : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function mediaKind(rawType: number): string {
  switch (rawType) {
    case 1:
      return "image";
    case 2:
      return "video";
    case 3:
      return "audio";
    case 8:
      return "file";
    case 15:
      return "sticker";
    default:
      return "file";
  }
}
