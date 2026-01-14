/**
 * Attachment service for handling file operations and thumbnail generation.
 *
 * Handles:
 * - Resolving attachment file paths from ~/Library/Messages/Attachments/
 * - Generating thumbnails for images (max 400px, preserve aspect ratio)
 * - Missing/deleted file detection
 *
 * Note: HEIC/HEIF files are uploaded as-is (no conversion) since libheif
 * isn't typically available. Safari/iOS can display them natively.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import sharp from "sharp";
import type { Attachment } from "./types";

/** Maximum dimension (width or height) for thumbnails */
const THUMBNAIL_MAX_SIZE = 400;

/** MIME types that support thumbnail generation */
const THUMBNAIL_SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  // Note: HEIC/HEIF require libvips compiled with libheif, which is often not available
  // Video thumbnails would require ffmpeg - not supported yet
]);

/**
 * Check if a MIME type supports thumbnail generation.
 */
export function supportsThumbnail(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return THUMBNAIL_SUPPORTED_TYPES.has(mimeType.toLowerCase());
}

/**
 * Resolve the full file path for an attachment.
 * The filename in chat.db starts with ~ which needs to be expanded.
 * Returns null if the file doesn't exist.
 */
export function resolveAttachmentPath(path: string): string | null {
  if (!path) return null;

  // Expand ~ to home directory
  const expandedPath = path.startsWith("~")
    ? join(homedir(), path.slice(1))
    : path;

  // Check if file exists
  if (!existsSync(expandedPath)) {
    return null;
  }

  return expandedPath;
}

/**
 * Read an attachment file and return its contents as a Buffer.
 * Returns null if the file doesn't exist or can't be read.
 */
export function readAttachmentFile(attachment: Attachment): Buffer | null {
  const resolvedPath = resolveAttachmentPath(attachment.path);
  if (!resolvedPath) {
    return null;
  }

  try {
    return readFileSync(resolvedPath);
  } catch {
    return null;
  }
}

/**
 * Generate a thumbnail for an image attachment.
 * Returns a JPEG buffer with max dimension of THUMBNAIL_MAX_SIZE (400px).
 * Returns null if thumbnail generation fails or is not supported.
 */
export async function generateThumbnail(
  fileBuffer: Buffer,
  mimeType: string | null
): Promise<Buffer | null> {
  if (!supportsThumbnail(mimeType)) {
    return null;
  }

  try {
    const thumbnail = await sharp(fileBuffer)
      .resize(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE, {
        fit: "inside", // Preserve aspect ratio, fit within bounds
        withoutEnlargement: true, // Don't upscale small images
      })
      .jpeg({ quality: 85 }) // Convert to JPEG for web compatibility
      .toBuffer();

    return thumbnail;
  } catch (error) {
    console.error("Thumbnail generation failed:", error);
    return null;
  }
}

/**
 * Process an attachment for upload.
 * - Reads the file from disk
 * - Generates thumbnail for supported image types
 *
 * Returns null if the file can't be read.
 */
export async function processAttachment(attachment: Attachment): Promise<{
  original: { buffer: Buffer; mimeType: string; filename: string };
  thumbnail: Buffer | null;
} | null> {
  // Read the file
  const fileBuffer = readAttachmentFile(attachment);
  if (!fileBuffer) {
    return null;
  }

  const mimeType = attachment.mimeType ?? "application/octet-stream";

  // Generate thumbnail for supported image types (excludes HEIC since libheif isn't available)
  const thumbnail = await generateThumbnail(fileBuffer, mimeType);

  return {
    original: {
      buffer: fileBuffer,
      mimeType,
      filename: attachment.filename,
    },
    thumbnail,
  };
}
