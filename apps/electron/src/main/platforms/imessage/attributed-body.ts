/**
 * Extract text from Apple's attributedBody blob format.
 *
 * Port of backend/services/attributed_body.py to TypeScript.
 * Used to extract message text when the `text` column is NULL in chat.db.
 */

/**
 * Decode a variable-length integer used in Apple's typedstream format.
 * Returns [bytesConsumed, length] or null if invalid.
 */
function decodeLength(data: Buffer, offset: number = 0): [number, number] | null {
  if (offset >= data.length) {
    return null;
  }

  const first = data[offset];

  // Single-byte length (0x00-0x7F)
  if (first < 0x80) {
    return [1, first];
  }

  // Multi-byte lengths: 0x81 = 2 extra bytes, 0x82 = 3 extra, 0x83 = 4 extra
  const extraBytes = first - 0x80 + 1;
  if (extraBytes < 2 || extraBytes > 4 || offset + extraBytes >= data.length) {
    return null;
  }

  let value = 0;
  for (let i = 0; i < extraBytes; i++) {
    value |= data[offset + 1 + i] << (i * 8);
  }
  return [1 + extraBytes, value];
}

/**
 * Extract text from an attributedBody blob (Apple's typedstream format).
 * This is used to extract message text when the `text` column is NULL.
 */
export function extractTextFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) {
    return null;
  }

  // Look for NSString marker
  const nsString = Buffer.from("NSString");
  const pos = blob.indexOf(nsString);
  if (pos === -1) {
    return null;
  }

  const searchStart = pos + nsString.length;
  const afterMarker = blob.subarray(searchStart);

  // Search for the text marker pattern
  for (let i = 0; i < afterMarker.length - 6; i++) {
    const firstByte = afterMarker[i];
    if ((firstByte === 0x94 || firstByte === 0x95) && afterMarker.length > i + 4) {
      if (
        afterMarker[i + 1] === 0x84 &&
        afterMarker[i + 2] === 0x01 &&
        afterMarker[i + 3] === 0x2b
      ) {
        const result = decodeLength(afterMarker, i + 4);
        if (result === null) {
          continue;
        }

        const [lenBytesConsumed, textLen] = result;
        const textStart = i + 4 + lenBytesConsumed;

        if (textStart + textLen <= afterMarker.length) {
          const textBytes = afterMarker.subarray(textStart, textStart + textLen);
          try {
            const trimmed = textBytes.toString("utf-8").trim();

            // Filter out internal Apple strings
            const isAppleInternal =
              !trimmed ||
              trimmed.startsWith("NS") ||
              trimmed.startsWith("_NS") ||
              trimmed.includes("AttributeName");

            if (!isAppleInternal) {
              // Remove object replacement character (used for attachments)
              const filtered = trimmed.replace(/\ufffc/g, "");
              return filtered || "[attachment]";
            }
          } catch {
            continue;
          }
        }
      }
    }
  }

  return null;
}
