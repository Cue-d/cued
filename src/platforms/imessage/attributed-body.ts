function decodeLength(data: Buffer, offset = 0): [number, number] | null {
  if (offset >= data.length) return null;
  const first = data[offset];
  if (first < 0x80) return [1, first];

  const extraBytesByMarker: Record<number, number> = {
    129: 2,
    130: 4,
    131: 8,
  };
  const extraBytes = extraBytesByMarker[first];
  if (!extraBytes || offset + 1 + extraBytes > data.length) {
    return null;
  }

  let value = 0n;
  for (let i = 0; i < extraBytes; i += 1) {
    value |= BigInt(data[offset + 1 + i]) << BigInt(i * 8);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return [1 + extraBytes, Number(value)];
}

const nsString = Buffer.from("NSString");
const typedStringTag = 0x2b;
const typedStreamEnd = Buffer.from([0x86, 0x84]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function normalizeDecodedText(value: string): string | null {
  const stripped = value.replace(/\ufffc/g, "").trim();
  if (!stripped) {
    return value.includes("\ufffc") ? "[attachment]" : null;
  }
  if (stripped.startsWith("NS") || stripped.startsWith("_NS") || stripped.startsWith("NSMutable")) {
    return null;
  }
  return stripped;
}

function decodeLengthPrefixedString(data: Buffer, offset: number): string | null {
  const result = decodeLength(data, offset);
  if (!result) return null;

  const [lengthBytes, textLength] = result;
  const textStart = offset + lengthBytes;
  const textEnd = textStart + textLength;
  if (textLength <= 0 || textEnd > data.length) return null;

  const decoded = decodeUtf8(data.subarray(textStart, textEnd));
  return decoded ? normalizeDecodedText(decoded) : null;
}

function decodeEndDelimitedString(data: Buffer, offset: number): string | null {
  const textEnd = data.indexOf(typedStreamEnd, offset);
  if (textEnd === -1 || textEnd <= offset) return null;

  let textBytes = data.subarray(offset, textEnd);
  const embeddedLength = decodeLength(textBytes);
  if (embeddedLength) {
    const [lengthBytes, textLength] = embeddedLength;
    if (lengthBytes + textLength === textBytes.length) {
      textBytes = textBytes.subarray(lengthBytes);
    }
  }

  const decoded = decodeUtf8(textBytes);
  return decoded ? normalizeDecodedText(decoded) : null;
}

function decodeTypedStringAfterTag(data: Buffer, offset: number): string | null {
  return decodeEndDelimitedString(data, offset) ?? decodeLengthPrefixedString(data, offset);
}

export function extractTextFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;

  let searchStart = 0;
  while (searchStart < blob.length) {
    const marker = blob.indexOf(nsString, searchStart);
    if (marker === -1) return null;

    const afterMarker = marker + nsString.length;
    for (let i = afterMarker; i < blob.length - 1; i += 1) {
      if (blob[i] !== typedStringTag) continue;

      const decoded = decodeTypedStringAfterTag(blob, i + 1);
      if (decoded) return decoded;
    }

    searchStart = afterMarker;
  }

  return null;
}
