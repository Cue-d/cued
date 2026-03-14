import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  CUED_ATTACHMENTS_OBJECTS_DIR,
  CUED_ATTACHMENTS_TMP_DIR,
  ensureCuedDirs,
} from "../config.js";
import type { AttachmentCacheRow, CuedDatabase, MessageAttachmentRow } from "../db/database.js";
import { loadIntegrationSecret } from "../integrations/keychain.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ATTACHMENT_CACHE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_ATTACHMENT_FETCH_MAX_BYTES = 100 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/x-ndjson",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

export interface ListedAttachment {
  attachment: MessageAttachmentRow;
  cache: AttachmentCacheRow | null;
  content: {
    status: string;
    extractedAt: number | null;
    hasText: boolean;
    lastError: string | null;
  } | null;
}

export interface AttachmentFetchResult {
  attachment: MessageAttachmentRow;
  cache: AttachmentCacheRow | null;
  content: {
    status: string;
    extractedAt: number | null;
    hasText: boolean;
    lastError: string | null;
  } | null;
  localPath: string | null;
  cacheHit: boolean;
}

export interface AttachmentSearchResult {
  attachmentId: string;
  messageId: string;
  filename: string | null;
  title: string | null;
  platform: string;
  accountKey: string;
  conversationId: string;
  conversationName: string | null;
  senderName: string | null;
  sentAt: number;
  snippet: string;
  rank: number;
}

type ProviderFetchHandlers = Partial<
  Record<
    string,
    (attachment: MessageAttachmentRow) => Promise<{
      buffer: Buffer;
      mimeType?: string | null;
      filename?: string | null;
    }>
  >
>;

function now(): number {
  return Date.now();
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expandHomePath(candidate: string | null): string | null {
  if (!candidate) {
    return null;
  }
  if (candidate.startsWith("~/")) {
    return join(process.env.HOME ?? "", candidate.slice(2));
  }
  return candidate;
}

function normalizeTextExtractorMimeType(mimeType: string | null, filename: string | null): boolean {
  const normalizedMime = mimeType?.trim().toLowerCase() ?? "";
  if (normalizedMime.startsWith("text/") || TEXT_MIME_TYPES.has(normalizedMime)) {
    return true;
  }

  const extension = extname(filename ?? "").toLowerCase();
  return [".txt", ".md", ".markdown", ".json", ".csv", ".html", ".xml", ".log"].includes(extension);
}

function isPdf(mimeType: string | null, filename: string | null): boolean {
  return (
    (mimeType?.trim().toLowerCase() ?? "") === "application/pdf" ||
    extname(filename ?? "").toLowerCase() === ".pdf"
  );
}

function preferredExtension(attachment: MessageAttachmentRow, mimeType: string | null): string {
  const fromName = extname(
    attachment.filename ?? attachment.local_path ?? attachment.remote_url ?? "",
  );
  if (fromName) {
    return fromName.toLowerCase();
  }
  switch ((mimeType ?? attachment.mime_type ?? "").toLowerCase()) {
    case "application/pdf":
      return ".pdf";
    case "application/json":
      return ".json";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function writeTempBuffer(buffer: Buffer): string {
  ensureCuedDirs();
  const tempPath = join(CUED_ATTACHMENTS_TMP_DIR, `${randomUUID()}.part`);
  writeFileSync(tempPath, buffer);
  return tempPath;
}

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const buffer = readFileSync(path);
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.byteLength,
  };
}

function materializeObjectPath(sha256: string, extension: string): string {
  ensureCuedDirs();
  const normalizedExtension = extension && !extension.startsWith(".") ? `.${extension}` : extension;
  return join(CUED_ATTACHMENTS_OBJECTS_DIR, `${sha256}${normalizedExtension}`);
}

function ensureWithinLimit(
  db: CuedDatabase,
  limitBytes = DEFAULT_ATTACHMENT_CACHE_LIMIT_BYTES,
): void {
  const entries = db.listReadyAttachmentCacheEntries();
  let totalBytes = entries.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0);
  if (totalBytes <= limitBytes) {
    return;
  }

  for (const entry of entries) {
    if (totalBytes <= limitBytes) {
      break;
    }
    if (entry.cache_path && existsSync(entry.cache_path)) {
      rmSync(entry.cache_path, { force: true });
    }
    totalBytes -= entry.size_bytes ?? 0;
    db.upsertAttachmentCacheEntry({
      attachmentId: entry.attachment_id,
      variant: entry.variant,
      status: "evicted",
      cachePath: null,
      mimeType: entry.mime_type,
      sizeBytes: entry.size_bytes,
      sha256: entry.sha256,
      fetchedAt: entry.fetched_at,
      lastAccessedAt: now(),
      expiresAt: entry.expires_at,
      lastError: null,
    });
  }
}

async function fetchSlackRemote(url: string, accountKey: string): Promise<Response> {
  const secret = loadIntegrationSecret("slack", accountKey).secret;
  const token = typeof secret.token === "string" ? secret.token : null;
  const cookie = typeof secret.cookie === "string" ? secret.cookie : null;
  if (!token) {
    throw new Error(`Slack credentials missing token for '${accountKey}'`);
  }

  const authResponse = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(cookie ? { Cookie: `d=${cookie}` } : {}),
    },
  });
  if (authResponse.ok) {
    return authResponse;
  }
  if (!cookie) {
    return authResponse;
  }

  return await fetch(url, {
    headers: {
      Cookie: `d=${cookie}`,
    },
  });
}

async function fetchLinkedInRemote(url: string, accountKey: string): Promise<Response> {
  const secret = loadIntegrationSecret("linkedin", accountKey).secret;
  const cookies = Array.isArray(secret.cookies)
    ? secret.cookies.filter(
        (cookie): cookie is { name: string; value: string } =>
          typeof cookie === "object" &&
          cookie !== null &&
          typeof (cookie as { name?: unknown }).name === "string" &&
          typeof (cookie as { value?: unknown }).value === "string",
      )
    : [];
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return await fetch(url, {
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });
}

async function downloadRemoteAttachment(
  attachment: MessageAttachmentRow,
  url: string,
): Promise<{ tempPath: string; mimeType: string | null; filename: string | null }> {
  const response =
    attachment.platform === "slack"
      ? await fetchSlackRemote(url, attachment.account_key)
      : attachment.platform === "linkedin"
        ? await fetchLinkedInRemote(url, attachment.account_key)
        : await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const tempPath = writeTempBuffer(buffer);
  let remoteFilename: string | null = null;
  try {
    remoteFilename = basename(new URL(url).pathname) || null;
  } catch {
    remoteFilename = null;
  }
  return {
    tempPath,
    mimeType: response.headers.get("content-type") ?? attachment.mime_type ?? null,
    filename: attachment.filename ?? remoteFilename,
  };
}

async function acquireAttachmentPayload(
  attachment: MessageAttachmentRow,
  providerFetchers: ProviderFetchHandlers,
): Promise<{ tempPath: string; mimeType: string | null; filename: string | null }> {
  const accessRef = parseJsonRecord(attachment.access_ref_json);
  const localPath =
    typeof accessRef?.path === "string"
      ? expandHomePath(accessRef.path)
      : expandHomePath(attachment.local_path);
  if ((attachment.access_kind === "local_path" || localPath) && localPath) {
    if (!existsSync(localPath)) {
      throw new Error(`Attachment source path does not exist: ${localPath}`);
    }
    const tempPath = join(CUED_ATTACHMENTS_TMP_DIR, `${randomUUID()}${extname(localPath)}`);
    mkdirSync(CUED_ATTACHMENTS_TMP_DIR, { recursive: true, mode: 0o700 });
    copyFileSync(localPath, tempPath);
    return {
      tempPath,
      mimeType: attachment.mime_type,
      filename: attachment.filename ?? basename(localPath),
    };
  }

  const remoteUrl = typeof accessRef?.url === "string" ? accessRef.url : attachment.remote_url;
  if (attachment.access_kind === "remote_url" && remoteUrl) {
    return await downloadRemoteAttachment(attachment, remoteUrl);
  }

  if (attachment.access_kind === "provider_fetch") {
    const handler = providerFetchers[attachment.platform];
    if (!handler) {
      throw new Error(`Attachment fetch is not supported yet for ${attachment.platform}`);
    }
    const result = await handler(attachment);
    return {
      tempPath: writeTempBuffer(result.buffer),
      mimeType: result.mimeType ?? attachment.mime_type ?? null,
      filename: result.filename ?? attachment.filename ?? null,
    };
  }

  throw new Error(`Attachment does not have a fetchable source: ${attachment.id}`);
}

async function extractTextContent(
  localPath: string,
  attachment: MessageAttachmentRow,
): Promise<{ extractor: string; text: string } | null> {
  if (normalizeTextExtractorMimeType(attachment.mime_type, attachment.filename)) {
    const content = readFileSync(localPath, "utf8");
    return {
      extractor: "utf8",
      text: content,
    };
  }

  if (isPdf(attachment.mime_type, attachment.filename) && process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("mdls", [
        "-raw",
        "-name",
        "kMDItemTextContent",
        localPath,
      ]);
      const normalized = stdout.trim();
      if (!normalized || normalized === "(null)") {
        return null;
      }
      return {
        extractor: "mdls",
        text: normalized,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function buildListedAttachment(
  db: CuedDatabase,
  attachment: MessageAttachmentRow,
): ListedAttachment {
  const cache = db.getAttachmentCacheEntry(attachment.id, "original");
  const content = db.getAttachmentContent(attachment.id);
  return {
    attachment,
    cache,
    content: content
      ? {
          status: content.status,
          extractedAt: content.extracted_at,
          hasText: Boolean(content.text_content && content.text_content.length > 0),
          lastError: content.last_error,
        }
      : null,
  };
}

export function listAttachments(
  db: CuedDatabase,
  input: {
    messageId?: string;
    conversationId?: string;
    platform?: string;
    accountKey?: string;
    limit?: number;
  } = {},
): ListedAttachment[] {
  const attachments = db.listMessageAttachments({
    messageId: input.messageId,
    conversationId: input.conversationId,
    platform: input.platform as never,
    accountKey: input.accountKey,
    limit: input.limit,
  });
  return attachments.map((attachment) => buildListedAttachment(db, attachment));
}

export async function fetchAttachment(
  db: CuedDatabase,
  input: {
    attachmentId: string;
    variant?: string;
    maxBytes?: number;
    allowLarge?: boolean;
    extractText?: boolean;
    providerFetchers?: ProviderFetchHandlers;
  },
): Promise<AttachmentFetchResult> {
  ensureCuedDirs();
  const variant = input.variant ?? "original";
  const attachment = db.getMessageAttachment(input.attachmentId);
  if (!attachment) {
    throw new Error(`Attachment not found: ${input.attachmentId}`);
  }

  const existing = db.getAttachmentCacheEntry(attachment.id, variant);
  if (existing?.status === "ready" && existing.cache_path && existsSync(existing.cache_path)) {
    db.touchAttachmentCacheEntry(attachment.id, variant, now());
    if (input.extractText !== false && !db.getAttachmentContent(attachment.id)) {
      const extracted = await extractTextContent(existing.cache_path, attachment);
      db.upsertAttachmentContent({
        attachmentId: attachment.id,
        extractor: extracted?.extractor ?? null,
        status: extracted ? "ready" : "unsupported",
        textContent: extracted?.text ?? null,
        mimeType: existing.mime_type ?? attachment.mime_type,
        extractedAt: extracted ? now() : null,
        lastError: null,
        filename: attachment.filename,
        title: attachment.title,
      });
    }
    return {
      ...buildListedAttachment(db, attachment),
      localPath: existing.cache_path,
      cacheHit: true,
    };
  }

  db.upsertAttachmentCacheEntry({
    attachmentId: attachment.id,
    variant,
    status: "fetching",
    cachePath: existing?.cache_path ?? null,
    mimeType: existing?.mime_type ?? attachment.mime_type,
    sizeBytes: existing?.size_bytes ?? attachment.size_bytes,
    sha256: existing?.sha256 ?? null,
    fetchedAt: existing?.fetched_at ?? null,
    lastAccessedAt: now(),
    expiresAt: existing?.expires_at ?? null,
    lastError: null,
  });

  const { tempPath, mimeType, filename } = await acquireAttachmentPayload(
    attachment,
    input.providerFetchers ?? {},
  );

  try {
    const { sizeBytes, sha256 } = hashFile(tempPath);
    const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_FETCH_MAX_BYTES;
    if (!input.allowLarge && sizeBytes > maxBytes) {
      throw new Error(`Attachment exceeds fetch limit (${sizeBytes} bytes > ${maxBytes} bytes)`);
    }

    const objectPath = materializeObjectPath(sha256, preferredExtension(attachment, mimeType));
    if (!existsSync(objectPath)) {
      renameSync(tempPath, objectPath);
    } else {
      rmSync(tempPath, { force: true });
    }

    db.upsertAttachmentCacheEntry({
      attachmentId: attachment.id,
      variant,
      status: "ready",
      cachePath: objectPath,
      mimeType: mimeType ?? attachment.mime_type,
      sizeBytes,
      sha256,
      fetchedAt: now(),
      lastAccessedAt: now(),
      expiresAt: null,
      lastError: null,
    });

    if (input.extractText !== false) {
      const extracted = await extractTextContent(objectPath, attachment);
      db.upsertAttachmentContent({
        attachmentId: attachment.id,
        extractor: extracted?.extractor ?? null,
        status: extracted ? "ready" : "unsupported",
        textContent: extracted?.text ?? null,
        mimeType: mimeType ?? attachment.mime_type,
        extractedAt: extracted ? now() : null,
        lastError: null,
        filename,
        title: attachment.title,
      });
    }

    ensureWithinLimit(db);
    const cache = db.getAttachmentCacheEntry(attachment.id, variant);
    return {
      ...buildListedAttachment(db, attachment),
      localPath: cache?.cache_path ?? null,
      cacheHit: false,
    };
  } catch (error) {
    db.upsertAttachmentCacheEntry({
      attachmentId: attachment.id,
      variant,
      status: "failed",
      cachePath: null,
      mimeType: mimeType ?? attachment.mime_type,
      sizeBytes: null,
      sha256: null,
      fetchedAt: null,
      lastAccessedAt: now(),
      expiresAt: null,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
  }
}

export function searchAttachments(
  db: CuedDatabase,
  input: {
    query: string;
    limit?: number;
    platform?: string;
    accountKey?: string;
    conversationId?: string;
  },
): AttachmentSearchResult[] {
  return db
    .searchAttachmentContent({
      query: input.query,
      limit: input.limit,
      platform: input.platform as never,
      accountKey: input.accountKey,
      conversationId: input.conversationId,
    })
    .map((row) => ({
      attachmentId: row.attachment_id,
      messageId: row.message_id,
      filename: row.filename,
      title: row.title,
      platform: row.platform,
      accountKey: row.account_key,
      conversationId: row.conversation_id,
      conversationName: row.conversation_name,
      senderName: row.sender_name,
      sentAt: row.sent_at,
      snippet: row.snippet,
      rank: row.rank,
    }));
}
