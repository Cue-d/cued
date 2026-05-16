export function validateIntegrationAccountKey(accountKey: string): string {
  if (typeof accountKey !== "string") {
    throw new Error("Integration account key must be a string");
  }

  const trimmed = accountKey.trim();
  if (trimmed.length === 0) {
    throw new Error("Integration account key must not be empty");
  }
  if (trimmed !== accountKey) {
    throw new Error("Integration account key must not have leading or trailing whitespace");
  }
  if (trimmed.length > 256) {
    throw new Error("Integration account key must be 256 characters or fewer");
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const codePoint = trimmed.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new Error("Integration account key must not contain control characters");
    }
  }
  if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("Integration account key must not contain path separators or dot segments");
  }

  return trimmed;
}

export function resolveIntegrationAccountKey(
  accountKey: string | undefined,
  defaultAccountKey: string,
): string {
  return accountKey === undefined
    ? validateIntegrationAccountKey(defaultAccountKey)
    : validateIntegrationAccountKey(accountKey);
}
