import { getCurrentAppVersion } from "../core/app-metadata.js";
import type { CuedDatabase, IntegrationProjectionCount } from "../db/database.js";
import type { LocalAccess, StatusAggregates } from "../db/db-worker-jobs.js";
import {
  readSignInBrowserState,
  type SignInBrowserState,
} from "../platforms/core/auth/browser-setup.js";
import { refreshManagedIntegrationStates } from "../platforms/core/state/refresh.js";
import { buildIntegrationStatus } from "../platforms/core/state/status.js";
import { isPlatform } from "../platforms/core/types.js";
import {
  type GlobalCuedSkillMonitor,
  getGlobalCuedSkillStatus,
  installGlobalCuedSkill,
} from "../skills/install.js";
import { isTelemetryEnabled } from "../telemetry/client.js";
import { sendTelemetryEventSafe } from "../telemetry/context.js";
import type { TelemetryProperties } from "../telemetry/events.js";
import { buildPermissionStatus } from "./doctor.js";
import { type MenuBarStatusCacheEntry, readMenuBarStatusCache } from "./menu-bar-status-cache.js";
import { hydrateIntegrationProjectionCounts } from "./status.js";

export async function transitionOnboarding(
  db: CuedDatabase,
  transition: "start" | "complete",
  emit: (
    event: "onboarding_started" | "onboarding_completed",
    properties: TelemetryProperties,
  ) => void | Promise<void> = (event, properties) => sendTelemetryEventSafe(db, event, properties),
) {
  const version = getCurrentAppVersion();
  const starting = transition === "start";
  const changed = starting
    ? db.markOnboardingStarted(version)
    : db.markOnboardingCompleted(version);
  if (changed) {
    await emit(starting ? "onboarding_started" : "onboarding_completed", {
      component: "onboarding",
      operation: transition,
      stage: transition,
    });
  }
  return db.getAppMetadata();
}

export interface OnboardingSnapshot {
  permissions: Awaited<ReturnType<typeof buildPermissionStatus>>["permissions"];
  globalSkill: ReturnType<typeof getGlobalCuedSkillStatus>;
  hostOs: ReturnType<typeof buildIntegrationStatus>["hostOs"];
  integrations: ReturnType<typeof buildIntegrationStatus>["integrations"];
  setupIntegrations: ReturnType<typeof buildIntegrationStatus>["setupIntegrations"];
  relationshipSummary: RelationshipSummary;
  /** Set while a sign-in window waits on a browser (or a download of one), or just failed to. */
  signInBrowser: SignInBrowserState | null;
}

export interface RelationshipSummary {
  messages: number;
  contacts: number;
  phoneCalls: number;
  pendingProjectionEvents: number;
  lastUpdatedAt: number | null;
  source: "menu_bar_cache" | "database";
}

export async function buildOnboardingSnapshot(
  db: CuedDatabase,
  options: {
    refreshManagedIntegrations?: boolean;
    refreshPermissions?: boolean;
    installGlobalSkill?: boolean;
    /**
     * Long-lived callers pass a monitor so the skill check never blocks: it answers from the
     * filesystem and verifies or installs in the background. Without one the check shells out
     * to `npx` synchronously, which is only acceptable in a short-lived CLI process.
     */
    globalSkillMonitor?: GlobalCuedSkillMonitor;
    /**
     * Values the daemon keeps warm off-thread. Supplying them makes the snapshot a handful of
     * small reads; omitting them probes access and counts rows inline.
     */
    localAccess?: LocalAccess;
    aggregates?: StatusAggregates;
  } = {},
): Promise<OnboardingSnapshot> {
  if (options.refreshManagedIntegrations) {
    try {
      await refreshManagedIntegrationStates(db);
    } catch {
      // The daemon may be writing at the same time. The onboarding UI can still
      // render a usable snapshot from the current DB state and live permission checks.
    }
  }

  const permissions = options.localAccess
    ? { permissions: [...options.localAccess.permissions] }
    : await buildPermissionStatus({
        mode: options.refreshPermissions ? "active" : "passive",
        db,
      });
  permissions.permissions.push({
    key: "diagnostics",
    status: isTelemetryEnabled(db) ? "granted" : "disabled",
    summary: isTelemetryEnabled(db)
      ? "Redacted diagnostic reporting is enabled"
      : "Redacted diagnostic reporting is disabled",
    requestFlags: ["--telemetry-enable"],
  });
  const installGlobalSkill = options.installGlobalSkill ?? true;
  let globalSkill: ReturnType<typeof getGlobalCuedSkillStatus>;
  if (options.globalSkillMonitor) {
    globalSkill = options.globalSkillMonitor.status({ ensureInstalled: installGlobalSkill });
  } else {
    globalSkill = getGlobalCuedSkillStatus();
    if (
      installGlobalSkill &&
      !globalSkill.installed &&
      globalSkill.status === "needs_action" &&
      globalSkill.sourcePath
    ) {
      const install = installGlobalCuedSkill();
      globalSkill = install.ok
        ? getGlobalCuedSkillStatus()
        : {
            ...globalSkill,
            error: install.stderr || install.error || globalSkill.error,
          };
    }
  }
  const cachedStatus = options.aggregates ? null : readMenuBarStatusCache({ dbPath: db.dbPath });
  const cachedRelationship = options.aggregates
    ? aggregatesRelationshipSummary(db, options.aggregates)
    : cachedStatus
      ? readCachedRelationshipSummary(cachedStatus)
      : null;
  const cachedProjectionCounts =
    options.aggregates?.overview.integrationBreakdown ??
    (cachedStatus ? readCachedProjectionCounts(cachedStatus) : null);
  const fallbackOverview =
    cachedRelationship && cachedProjectionCounts ? null : db.getMenuBarOverview();
  const projectionCounts = cachedProjectionCounts ?? fallbackOverview?.integrationBreakdown ?? [];
  const integrationStatus = buildIntegrationStatus(db, {
    includeDiagnostics: false,
    localIntegrationStates: options.localAccess?.localIntegrationStates,
  });
  const integrations = hydrateIntegrationProjectionCounts(
    integrationStatus.integrations,
    projectionCounts,
  );
  const setupIntegrations = hydrateIntegrationProjectionCounts(
    integrationStatus.setupIntegrations,
    projectionCounts,
  );

  return {
    permissions: permissions.permissions,
    globalSkill,
    ...integrationStatus,
    integrations,
    setupIntegrations,
    relationshipSummary:
      cachedRelationship ?? buildDatabaseRelationshipSummary(db, fallbackOverview),
    signInBrowser: readSignInBrowserState(db),
  };
}

function aggregatesRelationshipSummary(
  db: CuedDatabase,
  aggregates: StatusAggregates,
): RelationshipSummary {
  return {
    messages: aggregates.overview.messages,
    contacts: aggregates.overview.contacts,
    phoneCalls: aggregates.phoneCalls,
    pendingProjectionEvents: db.getProjectionBacklog({ initializeProjectionState: false })
      .pending_raw_events,
    lastUpdatedAt: null,
    source: "database",
  };
}

function buildDatabaseRelationshipSummary(
  db: CuedDatabase,
  overview: ReturnType<CuedDatabase["getMenuBarOverview"]> | null,
): RelationshipSummary {
  const resolvedOverview = overview ?? db.getMenuBarOverview();
  const projection = db.getProjectionBacklog({ initializeProjectionState: false });

  return {
    messages: resolvedOverview.messages,
    contacts: resolvedOverview.contacts,
    phoneCalls: db.countObservedPhoneCalls(),
    pendingProjectionEvents: projection.pending_raw_events,
    lastUpdatedAt: null,
    source: "database",
  };
}

function readCachedRelationshipSummary(
  cached: MenuBarStatusCacheEntry,
): RelationshipSummary | null {
  return (
    readCurrentCachedRelationshipSummary(cached) ?? readLegacyCachedRelationshipSummary(cached)
  );
}

function readCachedProjectionCounts(
  cached: MenuBarStatusCacheEntry,
): IntegrationProjectionCount[] | null {
  const overview = isRecord(cached.snapshot.overview) ? cached.snapshot.overview : null;
  if (!Array.isArray(overview?.integrationBreakdown)) {
    return null;
  }
  const counts: IntegrationProjectionCount[] = [];
  for (const row of overview.integrationBreakdown) {
    if (!isRecord(row) || typeof row.platform !== "string" || !isPlatform(row.platform)) {
      return null;
    }
    if (typeof row.accountKey !== "string") {
      return null;
    }
    counts.push({
      platform: row.platform,
      accountKey: row.accountKey,
      contacts: numberValue(row.contacts),
      messages: numberValue(row.messages),
    });
  }
  return counts;
}

function readCurrentCachedRelationshipSummary(
  cached: MenuBarStatusCacheEntry,
): RelationshipSummary | null {
  const summary = isRecord(cached.snapshot.relationshipSummary)
    ? cached.snapshot.relationshipSummary
    : null;
  const messages = finiteNumberOrNull(summary?.messages);
  const contacts = finiteNumberOrNull(summary?.contacts);
  const phoneCalls = finiteNumberOrNull(summary?.phoneCalls);
  const pendingProjectionEvents = finiteNumberOrNull(summary?.pendingProjectionEvents);
  if (
    messages == null ||
    contacts == null ||
    phoneCalls == null ||
    pendingProjectionEvents == null
  ) {
    return null;
  }

  return {
    messages,
    contacts,
    phoneCalls,
    pendingProjectionEvents,
    lastUpdatedAt: cached.mtimeMs,
    source: "menu_bar_cache",
  };
}

function readLegacyCachedRelationshipSummary(cached: MenuBarStatusCacheEntry): RelationshipSummary {
  const overview = isRecord(cached.snapshot.overview) ? cached.snapshot.overview : null;
  const dataStatus = isRecord(cached.snapshot.dataStatus) ? cached.snapshot.dataStatus : null;
  const integrations = Array.isArray(cached.snapshot.integrations)
    ? cached.snapshot.integrations
    : [];
  const imessage = integrations.find((integration): integration is Record<string, unknown> => {
    return isRecord(integration) && integration.platform === "imessage";
  });
  const projectionStats = isRecord(imessage?.projectionStats) ? imessage.projectionStats : null;
  const rawEventsBySchema = isRecord(projectionStats?.rawEventsBySchema)
    ? projectionStats.rawEventsBySchema
    : null;

  return {
    messages: numberValue(overview?.messages),
    contacts: numberValue(overview?.contacts),
    phoneCalls: numberValue(rawEventsBySchema?.["call.observed@1"]),
    pendingProjectionEvents: numberValue(dataStatus?.pendingProjectionEvents),
    lastUpdatedAt: cached.mtimeMs,
    source: "menu_bar_cache",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
