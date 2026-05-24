import { createHash } from "node:crypto";

export function providerStableHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Internal alias used by snapshot builders that already name the helper `stableId`. */
export const stableId = providerStableHash;
