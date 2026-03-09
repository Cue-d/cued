function decodeLength(data: Buffer, offset = 0): [number, number] | null {
  if (offset >= data.length) return null;
  const first = data[offset];
  if (first < 0x80) return [1, first];

  const extraBytes = first - 0x80 + 1;
  if (extraBytes < 2 || extraBytes > 4 || offset + extraBytes >= data.length) {
    return null;
  }

  let value = 0;
  for (let i = 0; i < extraBytes; i += 1) {
    value |= data[offset + 1 + i] << (i * 8);
  }
  return [1 + extraBytes, value];
}

export function extractTextFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;

  const nsString = Buffer.from("NSString");
  const pos = blob.indexOf(nsString);
  if (pos === -1) return null;

  const afterMarker = blob.subarray(pos + nsString.length);
  for (let i = 0; i < afterMarker.length - 6; i += 1) {
    const firstByte = afterMarker[i];
    if ((firstByte === 0x94 || firstByte === 0x95) && afterMarker.length > i + 4) {
      if (
        afterMarker[i + 1] === 0x84
        && afterMarker[i + 2] === 0x01
        && afterMarker[i + 3] === 0x2b
      ) {
        const result = decodeLength(afterMarker, i + 4);
        if (!result) continue;

        const [lenBytesConsumed, textLen] = result;
        const textStart = i + 4 + lenBytesConsumed;
        if (textStart + textLen > afterMarker.length) continue;

        const textBytes = afterMarker.subarray(textStart, textStart + textLen);
        const trimmed = textBytes.toString("utf8").trim();
        const isAppleInternal = !trimmed || trimmed.startsWith("NS") || trimmed.startsWith("_NS");
        if (isAppleInternal) continue;

        const filtered = trimmed.replace(/\ufffc/g, "");
        return filtered || "[attachment]";
      }
    }
  }

  return null;
}
