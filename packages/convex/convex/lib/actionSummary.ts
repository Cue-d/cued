const MAX_ACTION_SUMMARY_LENGTH = 40;

const DEFAULT_ACTION_SUMMARIES: Record<string, string> = {
  respond: "Reply needed",
  follow_up: "Follow up",
  send_message: "Send message",
  eod_contact: "Check in",
  resolve_contact: "Merge contacts",
  new_connection: "New connection",
};

function truncateSummary(text: string): string {
  if (text.length <= MAX_ACTION_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_ACTION_SUMMARY_LENGTH - 3).trimEnd()}...`;
}

export function normalizeActionSummary(summary?: string | null): string | undefined {
  const trimmed = summary?.trim();
  if (!trimmed) return undefined;
  return truncateSummary(trimmed);
}

export function resolveActionSummary(type: string, summary?: string | null): string {
  return (
    normalizeActionSummary(summary) ??
    DEFAULT_ACTION_SUMMARIES[type] ??
    "Action needed"
  );
}
