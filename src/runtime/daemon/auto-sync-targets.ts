import process from "node:process";
import {
  type AdapterPlatform,
  getDefaultAccountKeyForPlatform,
} from "../../core/types/provider.js";
import type { openCuedDatabase } from "../../db/database.js";
import { isAdapterPlatform, listAutoSyncPlatforms } from "../../platforms/core/registry.js";
import type { DiscordRealtimeStatus } from "../../platforms/discord/realtime/session.js";

function getConfiguredAutoSyncPlatforms(): AdapterPlatform[] | null {
  const raw = process.env.CUED_AUTOSYNC_PLATFORMS?.trim();
  if (raw == null) {
    return null;
  }
  if (raw === "" || ["0", "false", "none", "off"].includes(raw.toLowerCase())) {
    return [];
  }
  const configured = raw
    .split(",")
    .map((value) => value.trim())
    .filter(isAdapterPlatform);
  return [...new Set(configured)];
}

const LOCAL_ACCESS_SYNC_SOURCES = ["contacts", "imessage"] as const;

/**
 * The Contacts and Messages sources a manual sync of `source` covers that the saved state does
 * not hold syncable. Their access may have been granted since the daemon last looked.
 */
export function localSyncSourcesToRecheck(
  db: Pick<ReturnType<typeof openCuedDatabase>, "listEnabledSyncTargets">,
  source: string | undefined,
): Array<(typeof LOCAL_ACCESS_SYNC_SOURCES)[number]> {
  const covered = LOCAL_ACCESS_SYNC_SOURCES.filter(
    (platform) => source == null || source === platform,
  );
  if (covered.length === 0) {
    return [];
  }
  const syncable = new Set(db.listEnabledSyncTargets().map((target) => target.platform));
  return covered.filter((platform) => !syncable.has(platform));
}

export function getAutoSyncTargets(
  db: Pick<ReturnType<typeof openCuedDatabase>, "listEnabledSyncTargets" | "listIntegrationStates">,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  const configured = getConfiguredAutoSyncPlatforms();

  const integrationStates = db.listIntegrationStates();
  if (configured && integrationStates.length === 0) {
    return configured.map((platform) => ({
      platform,
      accountKey: getDefaultAccountKeyForPlatform(platform),
    }));
  }

  const enabled = db
    .listEnabledSyncTargets()
    .filter((target): target is { platform: AdapterPlatform; account_key: string } =>
      isAdapterPlatform(target.platform),
    )
    .map((target) => ({
      platform: target.platform,
      accountKey: target.account_key,
    }));
  if (configured) {
    return enabled.filter((target) => configured.includes(target.platform));
  }
  if (enabled.length > 0) {
    return enabled;
  }
  if (integrationStates.length > 0) {
    return [];
  }

  return listAutoSyncPlatforms().map((platform) => ({
    platform,
    accountKey: getDefaultAccountKeyForPlatform(platform),
  }));
}

export function buildSyncResumeTargets(
  db: Pick<
    ReturnType<typeof openCuedDatabase>,
    "listEnabledSyncTargets" | "listIntegrationStates" | "listCheckpointTargets"
  >,
): Array<{ platform: AdapterPlatform; accountKey: string }> {
  return [
    ...getAutoSyncTargets(db),
    ...db
      .listCheckpointTargets()
      .filter((target): target is { platform: AdapterPlatform; account_key: string } =>
        isAdapterPlatform(target.platform),
      )
      .map((target) => ({ platform: target.platform, accountKey: target.account_key })),
  ];
}

export function shouldSkipConnectedDiscordSchedulerSync(
  targetPlatform: AdapterPlatform,
  trigger: string,
  status: DiscordRealtimeStatus | null,
): boolean {
  return targetPlatform === "discord" && trigger === "scheduler" && status?.state === "connected";
}
