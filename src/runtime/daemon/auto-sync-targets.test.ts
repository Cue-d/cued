import { describe, expect, it } from "vitest";
import {
  buildSyncResumeTargets,
  getAutoSyncTargets,
  localSyncSourcesToRecheck,
  shouldSkipConnectedDiscordSchedulerSync,
} from "./auto-sync-targets.js";

describe("discord scheduler pacing", () => {
  const connectedStatus = {
    platform: "discord" as const,
    accountKey: "default",
    state: "connected" as const,
    userId: "u-self",
    username: "avery",
    connectedAt: 1,
    lastEventAt: 1,
    lastReconnectAt: null,
    reconnectAttempts: 0,
    lastSessionError: null,
  };

  it("skips scheduler syncs while discord realtime is connected", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", connectedStatus)).toBe(
      true,
    );
  });

  it("does not skip non-scheduler or degraded discord runs", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("discord", "cli", connectedStatus)).toBe(false);
    expect(
      shouldSkipConnectedDiscordSchedulerSync("discord", "scheduler", {
        ...connectedStatus,
        state: "degraded",
      }),
    ).toBe(false);
  });

  it("does not affect other platforms", () => {
    expect(shouldSkipConnectedDiscordSchedulerSync("slack", "scheduler", connectedStatus)).toBe(
      false,
    );
  });
});

describe("local access before a manual sync", () => {
  const db = (targets: Array<{ platform: string; account_key: string }>) => ({
    listEnabledSyncTargets: () => targets as never,
  });

  it("rechecks the local sources a sync covers that are not syncable yet", () => {
    const contactsOnly = db([{ platform: "contacts", account_key: "local" }]);
    expect(localSyncSourcesToRecheck(db([]), undefined)).toEqual(["contacts", "imessage"]);
    expect(localSyncSourcesToRecheck(contactsOnly, undefined)).toEqual(["imessage"]);
    expect(localSyncSourcesToRecheck(db([]), "contacts")).toEqual(["contacts"]);
    expect(localSyncSourcesToRecheck(contactsOnly, "imessage")).toEqual(["imessage"]);
  });

  it("rechecks nothing when the covered local sources are syncable or none is covered", () => {
    const both = db([
      { platform: "contacts", account_key: "local" },
      { platform: "imessage", account_key: "local" },
    ]);
    expect(localSyncSourcesToRecheck(both, undefined)).toEqual([]);
    expect(localSyncSourcesToRecheck(db([]), "slack")).toEqual([]);
    expect(localSyncSourcesToRecheck(db([]), "whatsapp-desktop")).toEqual([]);
  });
});

describe("sync resume targets", () => {
  it("allows autosync to be explicitly disabled", () => {
    const previous = process.env.CUED_AUTOSYNC_PLATFORMS;
    process.env.CUED_AUTOSYNC_PLATFORMS = "none";
    try {
      expect(
        getAutoSyncTargets({
          listEnabledSyncTargets: () => [
            {
              platform: "imessage",
              account_key: "local",
            },
          ],
          listIntegrationStates: () => [],
        }),
      ).toEqual([]);
    } finally {
      if (previous == null) {
        delete process.env.CUED_AUTOSYNC_PLATFORMS;
      } else {
        process.env.CUED_AUTOSYNC_PLATFORMS = previous;
      }
    }
  });

  it("configured platforms cannot re-enable an invalidated account or discard account keys", () => {
    const previous = process.env.CUED_AUTOSYNC_PLATFORMS;
    process.env.CUED_AUTOSYNC_PLATFORMS = "gmail,slack";
    try {
      expect(
        getAutoSyncTargets({
          listEnabledSyncTargets: () => [
            { platform: "gmail", account_key: "healthy@example.com" },
            { platform: "discord", account_key: "default" },
          ],
          listIntegrationStates: () =>
            [{ platform: "slack", auth_state: "needs_auth" }] as ReturnType<
              Parameters<typeof getAutoSyncTargets>[0]["listIntegrationStates"]
            >,
        }),
      ).toEqual([{ platform: "gmail", accountKey: "healthy@example.com" }]);
    } finally {
      if (previous == null) delete process.env.CUED_AUTOSYNC_PLATFORMS;
      else process.env.CUED_AUTOSYNC_PLATFORMS = previous;
    }
  });

  it("preserves account keys that contain colons", () => {
    expect(
      buildSyncResumeTargets({
        listEnabledSyncTargets: () => [
          {
            platform: "slack",
            account_key: "workspace:team",
          },
        ],
        listIntegrationStates: () => [],
        listCheckpointTargets: () => [
          {
            platform: "gmail",
            account_key: "avery@example.com",
          },
        ],
      }),
    ).toEqual([
      {
        platform: "slack",
        accountKey: "workspace:team",
      },
      {
        platform: "gmail",
        accountKey: "avery@example.com",
      },
    ]);
  });

  it("does not fall back to unauthenticated default targets after integration state exists", () => {
    expect(
      buildSyncResumeTargets({
        listEnabledSyncTargets: () => [],
        listIntegrationStates: () => [{ platform: "contacts" }] as never,
        listCheckpointTargets: () => [],
      }),
    ).toEqual([]);
  });
});
