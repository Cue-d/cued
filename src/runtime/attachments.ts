import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  CUED_ATTACHMENTS_OBJECTS_DIR,
  CUED_ATTACHMENTS_TMP_DIR,
  CUED_SIGNAL_DIR,
  ensureCuedDirs,
} from "../core/config.js";
import type { AttachmentCacheRow, CuedDatabase, MessageAttachmentRow } from "../db/database.js";
import { loadIntegrationSecret } from "../platforms/core/secrets/keychain.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ATTACHMENT_CACHE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_ATTACHMENT_FETCH_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_ATTACHMENT_DISK_RESERVE_BYTES = 512 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS = 5 * 1024 * 1024;
const MAX_ATTACHMENT_REDIRECTS = 5;
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

export type RemoteFetchPolicy = "external" | "slack-authenticated" | "linkedin-authenticated";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type PinnedLookupAddress = { address: string; family: 4 | 6 };
type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | PinnedLookupAddress[],
  family?: number,
) => void;
type PinnedLookupFunction = (
  hostname: string,
  options: { all?: boolean } | PinnedLookupCallback,
  callback?: PinnedLookupCallback,
) => void;

interface DownloadedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  tempPath: string | null;
  sizeBytes: number;
}

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

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      hash.update(buffer);
    });
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return {
    sha256: hash.digest("hex"),
    sizeBytes,
  };
}

function materializeObjectPath(sha256: string, extension: string): string {
  ensureCuedDirs();
  const normalizedExtension = extension && !extension.startsWith(".") ? `.${extension}` : extension;
  return join(CUED_ATTACHMENTS_OBJECTS_DIR, `${sha256}${normalizedExtension}`);
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function attachmentDiskReserveBytes(): number {
  return (
    parsePositiveInteger(process.env.CUED_ATTACHMENT_DISK_RESERVE_BYTES) ??
    DEFAULT_ATTACHMENT_DISK_RESERVE_BYTES
  );
}

function availableBytesForPath(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function assertAttachmentDiskHeadroom(requiredBytes: number): void {
  ensureCuedDirs();
  const availableBytes = availableBytesForPath(CUED_ATTACHMENTS_TMP_DIR);
  if (availableBytes === null) {
    return;
  }
  const reserveBytes = attachmentDiskReserveBytes();
  if (availableBytes - reserveBytes < requiredBytes) {
    throw new Error(
      `Not enough free disk space to cache attachment (${requiredBytes} bytes required, ${availableBytes} bytes available, ${reserveBytes} bytes reserved)`,
    );
  }
}

function enforceAttachmentByteCeiling(sizeBytes: number, maxBytes: number | null): void {
  if (maxBytes !== null && sizeBytes > maxBytes) {
    throw new Error(`Attachment exceeds fetch limit (${sizeBytes} bytes > ${maxBytes} bytes)`);
  }
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pathIsInside(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

function allowedLocalAttachmentRoots(attachment: MessageAttachmentRow): string[] {
  if (attachment.platform === "imessage") {
    return [join(homedir(), "Library", "Messages")];
  }
  if (attachment.platform === "signal") {
    return [join(CUED_SIGNAL_DIR, attachment.account_key)];
  }
  return [];
}

function assertLocalAttachmentPathAllowed(
  attachment: MessageAttachmentRow,
  localPath: string,
): string {
  const roots = allowedLocalAttachmentRoots(attachment);
  if (roots.length === 0) {
    throw new Error(`Local attachment paths are not supported for ${attachment.platform}`);
  }
  const sourceRealPath = realpathSync(localPath);
  const allowed = roots.some((root) => {
    if (!existsSync(root)) {
      return false;
    }
    return pathIsInside(sourceRealPath, realpathSync(root));
  });
  if (!allowed) {
    throw new Error("Attachment source path is outside allowed platform roots");
  }
  const sourceStats = statSync(sourceRealPath);
  if (!sourceStats.isFile()) {
    throw new Error("Attachment source path is not a regular file");
  }
  return sourceRealPath;
}

function parseFetchUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Attachment URL is invalid");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Attachment URLs with embedded credentials are not supported");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Attachment URL must use http or https");
  }
  return parsed;
}

function ipv4ToNumber(host: string): number | null {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts.reduce((value, part) => value * 256 + part, 0);
}

function ipv4InRange(address: number, base: string, prefixLength: number): boolean {
  const baseAddress = ipv4ToNumber(base);
  if (baseAddress === null) {
    return false;
  }
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (baseAddress & mask);
}

function isPrivateIpv4(host: string): boolean {
  const address = ipv4ToNumber(host);
  if (address === null) {
    return false;
  }
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefixLength]) => ipv4InRange(address, base as string, prefixLength as number));
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff") ||
    (mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false)
  );
}

function isBlockedIpAddress(hostname: string): boolean {
  const ipVersion = isIP(hostname);
  return (
    (ipVersion === 4 && isPrivateIpv4(hostname)) || (ipVersion === 6 && isPrivateIpv6(hostname))
  );
}

function policyHostname(parsed: URL): string {
  return parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

async function resolveSafeExternalAttachmentAddress(parsed: URL): Promise<ResolvedAddress> {
  const hostname = policyHostname(parsed);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Attachment URL host is not allowed");
  }
  if (isBlockedIpAddress(hostname)) {
    throw new Error("Attachment URL host is not allowed");
  }
  const hostnameIpVersion = isIP(hostname);
  if (hostnameIpVersion !== 0) {
    return {
      address: hostname,
      family: hostnameIpVersion as 4 | 6,
    };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Attachment URL host could not be resolved");
  }
  if (addresses.some(({ address }) => isBlockedIpAddress(address))) {
    throw new Error("Attachment URL host is not allowed");
  }
  const firstAddress = addresses.find(({ family }) => family === 4 || family === 6);
  if (!firstAddress) {
    throw new Error("Attachment URL host could not be resolved");
  }
  return {
    address: firstAddress.address,
    family: firstAddress.family as 4 | 6,
  };
}

function isSlackCredentialHost(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}

function isLinkedInCredentialHost(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

export function resolveRemoteAttachmentFetchPolicy(
  platform: string,
  url: string,
): RemoteFetchPolicy {
  const hostname = policyHostname(parseFetchUrl(url));
  if (platform === "slack" && isSlackCredentialHost(hostname)) {
    return "slack-authenticated";
  }
  if (platform === "linkedin" && isLinkedInCredentialHost(hostname)) {
    return "linkedin-authenticated";
  }
  return "external";
}

async function assertFetchPolicy(url: string, policy: RemoteFetchPolicy): Promise<URL> {
  const parsed = parseFetchUrl(url);
  const hostname = policyHostname(parsed);
  if (policy === "external") {
    return parsed;
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Credentialed attachment URL must use https");
  }
  if (policy === "slack-authenticated" && !isSlackCredentialHost(hostname)) {
    throw new Error("Slack credentials can only be sent to Slack attachment URLs");
  }
  if (policy === "linkedin-authenticated" && !isLinkedInCredentialHost(hostname)) {
    throw new Error("LinkedIn credentials can only be sent to LinkedIn attachment URLs");
  }
  return parsed;
}

async function fetchWithPolicy(
  url: string,
  policy: RemoteFetchPolicy,
  init: RequestInit = {},
  maxBytes: number | null = DEFAULT_ATTACHMENT_FETCH_MAX_BYTES,
): Promise<DownloadedResponse> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_ATTACHMENT_REDIRECTS; redirectCount += 1) {
    const response = await downloadOnceWithPolicy(currentUrl, policy, init, maxBytes);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error("Attachment download followed too many redirects");
}

function normalizeRequestHeaders(
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(key, item);
      }
    } else if (value !== undefined) {
      normalized.set(key, value);
    }
  }
  return normalized;
}

export function buildPinnedLookup(pinnedAddress: ResolvedAddress): PinnedLookupFunction {
  const pinnedLookup = (
    _hostname: string,
    options: { all?: boolean } | PinnedLookupCallback,
    callback?: PinnedLookupCallback,
  ) => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) {
      throw new Error("Pinned lookup callback is required");
    }
    if (typeof options === "object" && options?.all) {
      cb(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
      return;
    }
    cb(null, pinnedAddress.address, pinnedAddress.family);
  };
  return pinnedLookup;
}

async function downloadOnceWithPolicy(
  url: string,
  policy: RemoteFetchPolicy,
  init: RequestInit,
  maxBytes: number | null,
): Promise<DownloadedResponse> {
  const parsed = await assertFetchPolicy(url, policy);
  const pinnedAddress =
    policy === "external" ? await resolveSafeExternalAttachmentAddress(parsed) : null;
  const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const requestHostname = policyHostname(parsed);

  return await new Promise<DownloadedResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let activeTempPath: string | null = null;
    let activeOutput: ReturnType<typeof createWriteStream> | null = null;
    const cleanupActiveTempPath = () => {
      if (activeTempPath) {
        rmSync(activeTempPath, { force: true });
        activeTempPath = null;
      }
    };
    const settleError = (error: Error) => {
      if (!settled) {
        settled = true;
        activeOutput?.destroy();
        cleanupActiveTempPath();
        rejectPromise(error);
      }
    };
    const settleSuccess = (response: DownloadedResponse) => {
      if (!settled) {
        settled = true;
        resolvePromise(response);
      }
    };

    const request = transport(
      {
        protocol: parsed.protocol,
        hostname: requestHostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers: normalizeRequestHeaders(init.headers),
        servername: isIP(requestHostname) === 0 ? requestHostname : undefined,
        lookup: pinnedAddress ? buildPinnedLookup(pinnedAddress) : undefined,
      },
      (response) => {
        const headers = responseHeaders(response.headers);
        const contentLength = parseContentLength(headers);
        if (contentLength !== null && maxBytes !== null && contentLength > maxBytes) {
          response.resume();
          settleError(
            new Error(
              `Attachment exceeds fetch limit (${contentLength} bytes > ${maxBytes} bytes)`,
            ),
          );
          return;
        }
        if (contentLength !== null) {
          try {
            assertAttachmentDiskHeadroom(contentLength);
          } catch (error) {
            response.resume();
            settleError(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }

        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          settleSuccess({
            ok: false,
            status,
            statusText: response.statusMessage ?? "",
            headers,
            tempPath: null,
            sizeBytes: 0,
          });
          return;
        }

        ensureCuedDirs();
        const tempPath = join(CUED_ATTACHMENTS_TMP_DIR, `${randomUUID()}.part`);
        const output = createWriteStream(tempPath, { flags: "wx" });
        activeTempPath = tempPath;
        activeOutput = output;
        let bytesRead = 0;
        let nextDiskCheckBytes = 8 * 1024 * 1024;
        output.on("error", (error) => {
          request.destroy(error);
        });
        output.on("finish", () => {
          activeTempPath = null;
          activeOutput = null;
          settleSuccess({
            ok: status >= 200 && status < 300,
            status,
            statusText: response.statusMessage ?? "",
            headers,
            tempPath,
            sizeBytes: bytesRead,
          });
        });
        response.on("data", (chunk: Buffer) => {
          bytesRead += chunk.byteLength;
          if (maxBytes !== null && bytesRead > maxBytes) {
            request.destroy(
              new Error(`Attachment exceeds fetch limit (${bytesRead} bytes > ${maxBytes} bytes)`),
            );
            return;
          }
          if (bytesRead >= nextDiskCheckBytes) {
            nextDiskCheckBytes = bytesRead + 8 * 1024 * 1024;
            try {
              assertAttachmentDiskHeadroom(bytesRead);
            } catch (error) {
              request.destroy(error instanceof Error ? error : new Error(String(error)));
              return;
            }
          }
          if (!output.write(chunk)) {
            response.pause();
          }
        });
        output.on("drain", () => response.resume());
        response.on("end", () => {
          output.end();
        });
        response.on("error", settleError);
      },
    );
    request.on("error", settleError);
    request.end();
  });
}

function ensureWithinLimit(
  db: CuedDatabase,
  limitBytes = DEFAULT_ATTACHMENT_CACHE_LIMIT_BYTES,
  protectedEntry?: { attachmentId: string; variant: string },
): void {
  const entries = db.listReadyAttachmentCacheEntries();
  const remainingRefsByPath = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.cache_path) {
      continue;
    }
    remainingRefsByPath.set(entry.cache_path, (remainingRefsByPath.get(entry.cache_path) ?? 0) + 1);
  }
  let totalBytes = entries.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0);
  if (totalBytes <= limitBytes) {
    return;
  }

  for (const entry of entries) {
    if (totalBytes <= limitBytes) {
      break;
    }
    if (
      protectedEntry &&
      entry.attachment_id === protectedEntry.attachmentId &&
      entry.variant === protectedEntry.variant
    ) {
      continue;
    }
    if (entry.cache_path && existsSync(entry.cache_path)) {
      const remainingRefs = (remainingRefsByPath.get(entry.cache_path) ?? 0) - 1;
      if (remainingRefs <= 0) {
        rmSync(entry.cache_path, { force: true });
        remainingRefsByPath.delete(entry.cache_path);
      } else {
        remainingRefsByPath.set(entry.cache_path, remainingRefs);
      }
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

function discardDownloadedResponse(response: DownloadedResponse): void {
  if (response.tempPath) {
    rmSync(response.tempPath, { force: true });
  }
}

async function fetchSlackRemote(
  url: string,
  accountKey: string,
  maxBytes: number | null,
): Promise<DownloadedResponse> {
  const policy = resolveRemoteAttachmentFetchPolicy("slack", url);
  if (policy === "external") {
    return await fetchWithPolicy(url, "external", {}, maxBytes);
  }

  const secret = loadIntegrationSecret("slack", accountKey).secret;
  const token = typeof secret.token === "string" ? secret.token : null;
  const cookie = typeof secret.cookie === "string" ? secret.cookie : null;
  if (!token) {
    throw new Error(`Slack credentials missing token for '${accountKey}'`);
  }

  const authResponse = await fetchWithPolicy(
    url,
    policy,
    {
      headers: {
        ...(policy === "slack-authenticated" ? { Authorization: `Bearer ${token}` } : {}),
        ...(policy === "slack-authenticated" && cookie ? { Cookie: `d=${cookie}` } : {}),
      },
    },
    maxBytes,
  );
  if (authResponse.ok) {
    return authResponse;
  }
  if (!cookie || policy !== "slack-authenticated") {
    return authResponse;
  }
  discardDownloadedResponse(authResponse);
  return await fetchWithPolicy(
    url,
    "slack-authenticated",
    {
      headers: {
        Cookie: `d=${cookie}`,
      },
    },
    maxBytes,
  );
}

async function fetchLinkedInRemote(
  url: string,
  accountKey: string,
  maxBytes: number | null,
): Promise<DownloadedResponse> {
  const policy = resolveRemoteAttachmentFetchPolicy("linkedin", url);
  if (policy === "external") {
    return await fetchWithPolicy(url, "external", {}, maxBytes);
  }

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
  return await fetchWithPolicy(
    url,
    policy,
    {
      headers:
        policy === "linkedin-authenticated" && cookieHeader ? { Cookie: cookieHeader } : undefined,
    },
    maxBytes,
  );
}

async function downloadRemoteAttachment(
  attachment: MessageAttachmentRow,
  url: string,
  maxBytes: number | null,
): Promise<{ tempPath: string; mimeType: string | null; filename: string | null }> {
  const response =
    attachment.platform === "slack"
      ? await fetchSlackRemote(url, attachment.account_key, maxBytes)
      : attachment.platform === "linkedin"
        ? await fetchLinkedInRemote(url, attachment.account_key, maxBytes)
        : await fetchWithPolicy(
            url,
            resolveRemoteAttachmentFetchPolicy(attachment.platform, url),
            {},
            maxBytes,
          );
  if (!response.ok) {
    discardDownloadedResponse(response);
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.tempPath) {
    throw new Error("Attachment download did not produce a cached payload");
  }
  let remoteFilename: string | null = null;
  try {
    remoteFilename = basename(new URL(url).pathname) || null;
  } catch {
    remoteFilename = null;
  }
  return {
    tempPath: response.tempPath,
    mimeType: response.headers.get("content-type") ?? attachment.mime_type ?? null,
    filename: attachment.filename ?? remoteFilename,
  };
}

async function acquireAttachmentPayload(
  attachment: MessageAttachmentRow,
  providerFetchers: ProviderFetchHandlers,
  maxBytes: number | null,
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
    const sourcePath = assertLocalAttachmentPathAllowed(attachment, localPath);
    const sourceSize = statSync(sourcePath).size;
    enforceAttachmentByteCeiling(sourceSize, maxBytes);
    assertAttachmentDiskHeadroom(sourceSize);
    const tempPath = join(CUED_ATTACHMENTS_TMP_DIR, `${randomUUID()}${extname(sourcePath)}`);
    mkdirSync(CUED_ATTACHMENTS_TMP_DIR, { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, tempPath);
    return {
      tempPath,
      mimeType: attachment.mime_type,
      filename: attachment.filename ?? basename(sourcePath),
    };
  }

  const remoteUrl = typeof accessRef?.url === "string" ? accessRef.url : attachment.remote_url;
  if (attachment.access_kind === "remote_url" && remoteUrl) {
    return await downloadRemoteAttachment(attachment, remoteUrl, maxBytes);
  }

  if (attachment.access_kind === "provider_fetch") {
    const handler = providerFetchers[attachment.platform];
    if (!handler) {
      throw new Error(`Attachment fetch is not supported yet for ${attachment.platform}`);
    }
    const result = await handler(attachment);
    enforceAttachmentByteCeiling(result.buffer.byteLength, maxBytes);
    assertAttachmentDiskHeadroom(result.buffer.byteLength);
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
  effective: { mimeType?: string | null; filename?: string | null } = {},
): Promise<{
  extractor: string | null;
  status: string;
  text: string | null;
  lastError: string | null;
}> {
  const mimeType = effective.mimeType ?? attachment.mime_type;
  const filename = effective.filename ?? attachment.filename;
  const sourceSize = statSync(localPath).size;
  if (sourceSize > DEFAULT_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES) {
    return {
      extractor: null,
      status: "skipped_large",
      text: null,
      lastError: `Attachment text extraction skipped because file is too large (${sourceSize} bytes > ${DEFAULT_ATTACHMENT_TEXT_EXTRACT_MAX_BYTES} bytes)`,
    };
  }
  if (normalizeTextExtractorMimeType(mimeType, filename)) {
    const rawContent = readFileSync(localPath, "utf8");
    const content = rawContent.slice(0, DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS);
    return {
      extractor: "utf8",
      status: "ready",
      text: content,
      lastError:
        rawContent.length > DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS
          ? `Attachment text was truncated to ${DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS} characters`
          : null,
    };
  }

  if (isPdf(mimeType, filename) && process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("mdls", [
        "-raw",
        "-name",
        "kMDItemTextContent",
        localPath,
      ]);
      const normalized = stdout.trim();
      if (!normalized || normalized === "(null)") {
        return {
          extractor: null,
          status: "unsupported",
          text: null,
          lastError: null,
        };
      }
      return {
        extractor: "mdls",
        status: "ready",
        text: normalized.slice(0, DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS),
        lastError:
          normalized.length > DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS
            ? `Attachment text was truncated to ${DEFAULT_ATTACHMENT_TEXT_CONTENT_MAX_CHARS} characters`
            : null,
      };
    } catch {
      return {
        extractor: null,
        status: "unsupported",
        text: null,
        lastError: null,
      };
    }
  }

  return {
    extractor: null,
    status: "unsupported",
    text: null,
    lastError: null,
  };
}

function buildListedAttachment(
  db: CuedDatabase,
  attachment: MessageAttachmentRow,
  variant = "original",
): ListedAttachment {
  const cache = db.getAttachmentCacheEntry(attachment.id, variant);
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
    cacheLimitBytes?: number;
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
      const extracted = await extractTextContent(existing.cache_path, attachment, {
        mimeType: existing.mime_type ?? attachment.mime_type,
        filename: attachment.filename,
      });
      db.upsertAttachmentContent({
        attachmentId: attachment.id,
        extractor: extracted.extractor,
        status: extracted.status,
        textContent: extracted.text,
        mimeType: existing.mime_type ?? attachment.mime_type,
        extractedAt: extracted.status === "ready" ? now() : null,
        lastError: extracted.lastError,
        filename: attachment.filename,
        title: attachment.title,
      });
    }
    return {
      ...buildListedAttachment(db, attachment, variant),
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
  let tempPath: string | null = null;
  let mimeType: string | null = existing?.mime_type ?? attachment.mime_type;
  let filename: string | null = attachment.filename;
  const maxBytes = input.maxBytes ?? (input.allowLarge ? null : DEFAULT_ATTACHMENT_FETCH_MAX_BYTES);

  try {
    const payload = await acquireAttachmentPayload(
      attachment,
      input.providerFetchers ?? {},
      maxBytes,
    );
    tempPath = payload.tempPath;
    mimeType = payload.mimeType ?? mimeType;
    filename = payload.filename ?? filename;

    const { sizeBytes, sha256 } = await hashFile(tempPath);
    enforceAttachmentByteCeiling(sizeBytes, maxBytes);

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
      const extracted = await extractTextContent(objectPath, attachment, { mimeType, filename });
      db.upsertAttachmentContent({
        attachmentId: attachment.id,
        extractor: extracted.extractor,
        status: extracted.status,
        textContent: extracted.text,
        mimeType: mimeType ?? attachment.mime_type,
        extractedAt: extracted.status === "ready" ? now() : null,
        lastError: extracted.lastError,
        filename,
        title: attachment.title,
      });
    }

    ensureWithinLimit(db, input.cacheLimitBytes, { attachmentId: attachment.id, variant });
    const cache = db.getAttachmentCacheEntry(attachment.id, variant);
    return {
      ...buildListedAttachment(db, attachment, variant),
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
    if (tempPath && existsSync(tempPath)) {
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
