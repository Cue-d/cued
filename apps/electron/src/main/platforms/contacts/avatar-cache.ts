import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONTACTS_CACHE_DIR = join(homedir(), ".cued");
export const CONTACT_AVATAR_CACHE_DIR = join(CONTACTS_CACHE_DIR, "contact-avatars");
export const CONTACT_AVATAR_SCHEME = "cued-contact-avatar";

const FILE_NAME_REGEX =
  /^[a-f0-9]{64}\.(?:jpg|jpeg|png|gif|webp|heic|heif|bin)$/i;

function ensureAvatarCacheDir(): void {
  if (!existsSync(CONTACT_AVATAR_CACHE_DIR)) {
    mkdirSync(CONTACT_AVATAR_CACHE_DIR, { recursive: true });
  }
}

function toBuffer(data: Buffer | Uint8Array | undefined): Buffer | undefined {
  if (!data || data.length === 0) return undefined;
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function detectImageExtension(bytes: Buffer): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  if (bytes.length >= 12) {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "heic" || brand === "heix" || brand === "heif" || brand === "hevc") {
      return "heic";
    }
  }
  return "bin";
}

export function cacheContactAvatar(
  contactIdentifier: string,
  imageData: Buffer | Uint8Array | undefined,
): { fileName: string; url: string } | null {
  const bytes = toBuffer(imageData);
  if (!bytes) {
    return null;
  }

  const hash = createHash("sha256")
    .update(contactIdentifier)
    .update(":")
    .update(bytes)
    .digest("hex");
  const ext = detectImageExtension(bytes);
  const fileName = `${hash}.${ext}`;

  ensureAvatarCacheDir();

  const filePath = join(CONTACT_AVATAR_CACHE_DIR, fileName);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, bytes);
  }

  return {
    fileName,
    url: `${CONTACT_AVATAR_SCHEME}://avatar/${encodeURIComponent(fileName)}`,
  };
}

export function pruneContactAvatarCache(usedFileNames: Set<string>): void {
  if (!existsSync(CONTACT_AVATAR_CACHE_DIR)) {
    return;
  }

  try {
    const files = readdirSync(CONTACT_AVATAR_CACHE_DIR);
    for (const fileName of files) {
      if (!usedFileNames.has(fileName)) {
        unlinkSync(join(CONTACT_AVATAR_CACHE_DIR, fileName));
      }
    }
  } catch {
    // Non-fatal cache cleanup failure.
  }
}

export function resolveContactAvatarPathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${CONTACT_AVATAR_SCHEME}:`) {
      return null;
    }
    if (parsed.hostname !== "avatar") {
      return null;
    }

    const fileName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!FILE_NAME_REGEX.test(fileName)) {
      return null;
    }

    return join(CONTACT_AVATAR_CACHE_DIR, fileName);
  } catch {
    return null;
  }
}
