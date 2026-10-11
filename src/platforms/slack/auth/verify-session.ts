interface SlackCookie {
  name: string;
  domain: string;
  value: string;
}

export interface VerifiedSlackSession {
  cookie: string;
  teamId: string;
  teamName: string;
  userId: string;
}

// Probe only bounded, unique Slack cookies. Never persist an unverified pair.
export async function verifySlackSession(
  token: string,
  expectedTeamId: string,
  cookies: SlackCookie[],
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedSlackSession | null> {
  const candidates = [
    ...new Set(
      cookies
        .filter((cookie) => {
          const domain = cookie.domain.replace(/^\./, "");
          return (
            cookie.name === "d" &&
            cookie.value &&
            (domain === "slack.com" || domain.endsWith(".slack.com"))
          );
        })
        .map((cookie) => cookie.value),
    ),
  ].slice(0, 5);
  for (const cookie of candidates) {
    let response: Response;
    try {
      response = await fetchImpl("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `d=${cookie}` },
        body: new URLSearchParams({ token, team_id: expectedTeamId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("Slack credential verification request failed; retry connecting");
    }
    if (!response.ok)
      throw new Error(
        `Slack credential verification failed (HTTP ${response.status}); retry connecting`,
      );
    let result: Record<string, unknown>;
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      result = body as Record<string, unknown>;
    } catch {
      throw new Error("Slack credential verification returned an invalid response");
    }
    if (result.ok !== true) {
      if (
        [
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "token_expired",
          "account_inactive",
        ].includes(String(result.error))
      )
        continue;
      throw new Error("Slack credential verification was not successful; retry connecting");
    }
    if (result.team_id !== expectedTeamId || typeof result.user_id !== "string" || !result.user_id)
      continue;
    return {
      cookie,
      teamId: expectedTeamId,
      teamName: typeof result.team === "string" ? result.team : expectedTeamId,
      userId: result.user_id,
    };
  }
  return null;
}
