import {
  isSlackAuthInvalidationError,
  SlackHelperClient,
  SlackHelperError,
} from "../helper/client.js";
import type { SlackCaptureDiagnostic } from "./capture-diagnostics.js";
import type { VerifiedSlackSession } from "./verify-session.js";

type Probe = () => Promise<{ ok: boolean; team_id?: string; user_id?: string }>;
// Keep the browser open unless both the actual sync transport and a fresh
// browser/provider recheck accept the same credentials.
export class SlackCaptureConfirmation {
  private nextProbeAt = 0;
  constructor(
    private readonly report: (event: SlackCaptureDiagnostic) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  ready(): boolean {
    return this.clock() >= this.nextProbeAt;
  }

  async confirm(
    token: string,
    session: VerifiedSlackSession,
    recheck: () => Promise<boolean>,
    probe: Probe = () =>
      new SlackHelperClient(
        { token, cookie: session.cookie },
        {
          retryAttempts: 1,
          timeoutMs: 10_000,
        },
      ).testAuth(),
    rejectPair: () => void = () => {},
  ): Promise<boolean> {
    if (!this.ready()) return false;
    try {
      const result = await probe();
      if (!result.ok || result.team_id !== session.teamId || result.user_id !== session.userId)
        throw new SlackHelperError("identity mismatch", { slackCode: "identity_mismatch" });
    } catch (error) {
      this.report("helper_rejected");
      const rejected =
        isSlackAuthInvalidationError(error) ||
        (error instanceof SlackHelperError && error.slackCode === "identity_mismatch");
      if (rejected) {
        try {
          this.report((await recheck()) ? "node_recheck_accepted" : "node_recheck_rejected");
        } catch {
          this.report("node_recheck_error");
        }
        rejectPair();
      }
      this.nextProbeAt =
        this.clock() +
        Math.max(30_000, error instanceof SlackHelperError ? (error.retryAfterMs ?? 0) : 0);
      return false;
    }
    this.report("helper_accepted");
    try {
      if (await recheck()) {
        this.report("node_recheck_accepted");
        this.report("confirmed");
        return true;
      }
      this.report("node_recheck_rejected");
    } catch {
      this.report("node_recheck_error");
    }
    this.nextProbeAt = this.clock() + 30_000;
    return false;
  }
}
