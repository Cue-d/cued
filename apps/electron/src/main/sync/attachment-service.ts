/**
 * Attachment service for handling file operations and thumbnail generation.
 *
 * Handles:
 * - Resolving attachment file paths from ~/Library/Messages/Attachments/
 * - Generating thumbnails for images (max 400px, preserve aspect ratio)
 * - HEIC to JPEG conversion for web compatibility
 * - Missing/deleted file detection
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { extname, join } from "path";
import sharp from "sharp";
import type { Attachment, UploadedAttachment } from "./types";

/** Maximum dimension (width or height) for thumbnails */
const THUMBNAIL_MAX_SIZE = 400;

/** MIME types that support thumbnail generation */
const THUMBNAIL_SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
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
 * Get the web-safe MIME type for an attachment.
 * Converts HEIC/HEIF to JPEG since most browsers don't support HEIC.
 */
export function getWebSafeMimeType(mimeType: string | null): string {
  if (!mimeType) return "application/octet-stream";

  const lowerMime = mimeType.toLowerCase();

  // Convert HEIC/HEIF to JPEG (sharp handles conversion)
  if (lowerMime === "image/heic" || lowerMime === "image/heif") {
    return "image/jpeg";
  }

  return mimeType;
}

/**
 * Convert HEIC/HEIF images to JPEG for web compatibility.
 * Returns the original buffer for non-HEIC images.
 */
export async function convertToWebFormat(
  fileBuffer: Buffer,
  mimeType: string | null
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!mimeType) {
    return { buffer: fileBuffer, mimeType: "application/octet-stream" };
  }

  const lowerMime = mimeType.toLowerCase();

  // Convert HEIC/HEIF to JPEG
  if (lowerMime === "image/heic" || lowerMime === "image/heif") {
    try {
      const jpegBuffer = await sharp(fileBuffer).jpeg({ quality: 90 }).toBuffer();
      return { buffer: jpegBuffer, mimeType: "image/jpeg" };
    } catch (error) {
      console.error("HEIC conversion failed:", error);
      // Return original if conversion fails
      return { buffer: fileBuffer, mimeType };
    }
  }

  return { buffer: fileBuffer, mimeType };
}

/**
 * Process an attachment for upload.
 * - Reads the file from disk
 * - Converts HEIC to JPEG if needed
 * - Generates thumbnail for images
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

  // Convert HEIC to web format if needed
  const { buffer: webBuffer, mimeType: webMimeType } = await convertToWebFormat(
    fileBuffer,
    attachment.mimeType
  );

  // Update filename extension if MIME type changed
  let filename = attachment.filename;
  if (webMimeType !== attachment.mimeType) {
    // Replace extension with new MIME type extension
    const ext = extname(filename);
    filename = filename.slice(0, -ext.length) + ".jpg";
  }

  // Generate thumbnail for images
  const thumbnail = await generateThumbnail(webBuffer, webMimeType);

  return {
    original: {
      buffer: webBuffer,
      mimeType: webMimeType,
      filename,
    },
    thumbnail,
  };
}
