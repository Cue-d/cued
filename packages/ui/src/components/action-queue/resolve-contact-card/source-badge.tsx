export type MergeSource =
  | "email_match"
  | "phone_match"
  | "exact_name_match"
  | "fuzzy_name_match"
  | "llm_fuzzy_match"

/** Format source for display (e.g. "exact_name_match" → "Exact name match") */
export function formatSource(source: MergeSource): string {
  const raw = source.replace(/_/g, " ")
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

// Keep these exports for backwards compat with barrel files
export type SourceBadgeProps = {
  source: MergeSource
  className?: string
}
