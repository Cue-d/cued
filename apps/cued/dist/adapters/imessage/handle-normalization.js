const FILTERED_SUFFIX_REGEX = /\s*\(filtered\)\s*$/i;
export function normalizeChatDbHandleIdentifier(identifier) {
    return identifier.replace(FILTERED_SUFFIX_REGEX, "");
}
//# sourceMappingURL=handle-normalization.js.map