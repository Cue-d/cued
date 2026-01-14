/**
 * Attachment uploader for syncing attachments to Convex storage.
 *
 * Handles:
 * - Generating upload URLs from Convex
 * - Uploading files to Convex storage
 * - Batch processing attachments with thumbnails
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "@prm/convex";
import type { Attachment, UploadedAttachment } from "./types";
import { processAttachment } from "./attachment-service";

/**
 * Upload a single file buffer to Convex storage.
 * Returns the storage ID on success, null on failure.
 */
async function uploadFile(
  uploadUrl: string,
  buffer: Buffer,
  contentType: string
): Promise<string | null> {
  try {
    // Convert Buffer to ArrayBuffer for fetch compatibility
    // Use Uint8Array which accepts Buffer directly and is a valid BlobPart
    const uint8Array = Uint8Array.from(buffer);
    const blob = new Blob([uint8Array], { type: contentType });

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
      },
      body: blob,
    });

    if (!response.ok) {
      console.error("Upload failed:", response.status, response.statusText);
      return null;
    }

    const result = await response.json();
    return result.storageId;
  } catch (error) {
    console.error("Upload error:", error);
    return null;
  }
}

/**
 * Upload attachments to Convex storage.
 *
 * For each attachment:
 * 1. Reads the file from disk
 * 2. Converts HEIC to JPEG if needed
 * 3. Generates thumbnail for images
 * 4. Uploads original and thumbnail to Convex storage
 *
 * Returns array of uploaded attachments with storage IDs.
 * Attachments that fail to upload are logged but skipped.
 */
export async function uploadAttachments(
  convex: ConvexHttpClient,
  attachments: Attachment[]
): Promise<UploadedAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  const results: UploadedAttachment[] = [];

  for (const attachment of attachments) {
    try {
      // Process the attachment (read, convert, generate thumbnail)
      const processed = await processAttachment(attachment);
      if (!processed) {
        console.warn(`Skipping attachment ${attachment.id}: file not found at ${attachment.path}`);
        continue;
      }

      // Determine how many upload URLs we need (1 for original, +1 if thumbnail exists)
      const hasThumbnail = processed.thumbnail !== null;
      const urlCount = hasThumbnail ? 2 : 1;

      // Generate upload URLs
      const uploadUrls = await convex.mutation(api.files.generateUploadUrls, {
        count: urlCount,
      });

      // Upload original file
      const originalStorageId = await uploadFile(
        uploadUrls[0],
        processed.original.buffer,
        processed.original.mimeType
      );

      if (!originalStorageId) {
        console.warn(`Failed to upload original for attachment ${attachment.id}`);
        continue;
      }

      // Upload thumbnail if available
      let thumbnailStorageId: string | undefined;
      if (hasThumbnail) {
        thumbnailStorageId =
          (await uploadFile(uploadUrls[1], processed.thumbnail!, "image/jpeg")) ?? undefined;

        if (!thumbnailStorageId) {
          console.warn(`Failed to upload thumbnail for attachment ${attachment.id}`);
        }
      }

      results.push({
        filename: processed.original.filename,
        mimeType: processed.original.mimeType,
        size: attachment.size,
        storageId: originalStorageId,
        thumbnailStorageId,
      });
    } catch (error) {
      console.error(`Error processing attachment ${attachment.id}:`, error);
      // Continue with next attachment
    }
  }

  return results;
}
