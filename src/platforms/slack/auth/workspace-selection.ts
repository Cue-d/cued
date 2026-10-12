export const SLACK_PENDING_ACCOUNT_KEY_PREFIX = "pending-slack-";

interface SlackWorkspaceCredentials {
  teamId: string;
  token: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function selectSlackWorkspaceCredentials(
  rawLocalConfig: string,
  accountKey: string,
  pageUrl: string,
): SlackWorkspaceCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLocalConfig);
  } catch {
    return null;
  }
  const teams = record(record(parsed)?.teams);
  if (!teams) return null;
  const candidates: SlackWorkspaceCredentials[] = [];
  for (const [teamId, value] of Object.entries(teams)) {
    const team = record(value);
    if (!team || typeof team.token !== "string" || !team.token.startsWith("xoxc-")) continue;
    candidates.push({
      teamId,
      token: team.token,
    });
  }
  if (accountKey !== "default" && !accountKey.startsWith(SLACK_PENDING_ACCOUNT_KEY_PREFIX)) {
    // Reconnect must never authenticate another workspace from the same browser.
    const exact = candidates.find((team) => team.teamId === accountKey);
    if (exact) return exact;
    // Grid may expose only an enterprise token. This is a candidate, never an
    // identity claim: auth.test must confirm the requested workspace before use.
    const enterprise = candidates.filter((team) => team.teamId.startsWith("E"));
    return enterprise.length === 1 ? { ...enterprise[0]!, teamId: accountKey } : null;
  }
  let visibleTeamId: string | undefined;
  try {
    const url = new URL(pageUrl);
    if (url.hostname === "app.slack.com") {
      visibleTeamId = /^\/client\/(T[A-Z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1];
    }
  } catch {
    return null;
  }
  if (visibleTeamId) {
    return candidates.find((team) => team.teamId === visibleTeamId) ?? null;
  }
  // Enterprise routes do not identify a workspace; don't pick an arbitrary team.
  return candidates.length === 1 ? candidates[0]! : null;
}
