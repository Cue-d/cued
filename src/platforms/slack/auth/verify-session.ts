import { createHash } from "node:crypto";
import { isSlackAuthInvalidationCode } from "../helper/client.js";

function credentialPairKey(token: string, cookie: string, teamId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([token, cookie, teamId]))
    .digest("hex");
}

export class SlackSessionVerificationError extends Error {}

export class SlackVerificationState {
  private readonly rejected = new Set<string>();
  private retryAt = 0;
  private failures = 0;
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly report: (event: "session_cookie_returned") => void = () => {},
  ) {}

  observeResponse(response: Response): void {
    if (response.headers.getSetCookie().some((cookie) => /^d=/i.test(cookie)))
      this.report("session_cookie_returned");
  }

  ready(): boolean {
    return this.clock() >= this.retryAt;
  }
  wasRejected(key: string): boolean {
    return this.rejected.has(key);
  }
  rejectPair(token: string, cookie: string, teamId: string): void {
    this.reject(credentialPairKey(token, cookie, teamId));
  }
  reject(key: string): void {
    this.rejected.add(key);
    if (this.rejected.size > 256) this.rejected.delete(this.rejected.values().next().value!);
  }
  defer(retryAfter?: string | null): void {
    this.failures = Math.min(this.failures + 1, 6);
    const requested = retryAfter == null ? NaN : Number(retryAfter) * 1000;
    const delay = Number.isFinite(requested)
      ? Math.max(1000, requested)
      : Math.min(30_000, 1000 * 2 ** this.failures);
    this.retryAt = this.clock() + delay;
  }
}

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
  state = new SlackVerificationState(),
): Promise<VerifiedSlackSession | null> {
  if (!state.ready()) return null;
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
    const key = credentialPairKey(token, cookie, expectedTeamId);
    if (state.wasRejected(key)) continue;
    let response: Response;
    try {
      response = await fetchImpl("https://slack.com/api/auth.test", {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `d=${cookie}` },
        body: new URLSearchParams({ token, team_id: expectedTeamId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      state.defer();
      throw new SlackSessionVerificationError(
        "Slack credential verification request failed; retry connecting",
      );
    }
    state.observeResponse(response);
    if (!response.ok) {
      state.defer(response.headers.get("retry-after"));
      throw new SlackSessionVerificationError(
        `Slack credential verification failed (HTTP ${response.status}); retry connecting`,
      );
    }
    let result: Record<string, unknown>;
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new SlackSessionVerificationError();
      result = body as Record<string, unknown>;
    } catch {
      state.defer();
      throw new SlackSessionVerificationError(
        "Slack credential verification returned an invalid response",
      );
    }
    if (result.ok !== true) {
      if (isSlackAuthInvalidationCode(String(result.error))) {
        state.reject(key);
        continue;
      }
      state.defer(response.headers.get("retry-after"));
      throw new SlackSessionVerificationError(
        "Slack credential verification was not successful; retry connecting",
      );
    }
    if (
      result.team_id !== expectedTeamId ||
      typeof result.user_id !== "string" ||
      !result.user_id
    ) {
      state.reject(key);
      continue;
    }
    return {
      cookie,
      teamId: expectedTeamId,
      teamName: typeof result.team === "string" ? result.team : expectedTeamId,
      userId: result.user_id,
    };
  }
  return null;
}
