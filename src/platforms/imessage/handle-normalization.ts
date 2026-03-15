const FILTERED_SUFFIX_REGEX = /\s*\(filtered\)\s*$/i;

export function normalizeChatDbHandleIdentifier(identifier: string): string {
  return identifier.replace(FILTERED_SUFFIX_REGEX, "");
}
