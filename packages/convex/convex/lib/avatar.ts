/**
 * Normalize contact avatar URLs for global storage/consumption.
 * Only HTTP(S) URLs are considered cross-device safe.
 */
export function normalizePublicAvatarUrl(
  url: string | null | undefined,
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
