/**
 * Normalize avatar URLs for cross-device storage/consumption.
 * Only HTTP(S) URLs are considered sync-safe.
 */
export function normalizePublicAvatarUrl(
  url: string | null | undefined
): string | undefined {
  if (!url) return undefined;

  const trimmed = url.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
