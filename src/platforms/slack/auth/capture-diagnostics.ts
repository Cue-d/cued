export const SLACK_CAPTURE_DIAGNOSTICS = [
  "helper_accepted",
  "helper_rejected",
  "node_recheck_accepted",
  "node_recheck_rejected",
  "node_recheck_error",
  "confirmed",
  "session_cookie_returned",
] as const;
export type SlackCaptureDiagnostic = (typeof SLACK_CAPTURE_DIAGNOSTICS)[number];

// Never forward arbitrary browser stderr or payload fields into daemon logs.
export function parseSlackCaptureDiagnostic(line: string): SlackCaptureDiagnostic | null {
  if (line.length > 256) return null;
  try {
    const data: unknown = JSON.parse(line);
    if (
      !data ||
      typeof data !== "object" ||
      !("provider" in data) ||
      data.provider !== "slack" ||
      !("captureDiagnostic" in data)
    )
      return null;
    return SLACK_CAPTURE_DIAGNOSTICS.find((event) => event === data.captureDiagnostic) ?? null;
  } catch {
    return null;
  }
}
