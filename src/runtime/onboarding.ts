import { existsSync, readFileSync, statSync } from "node:fs";
import { CUED_MENU_BAR_STATUS_PATH } from "../core/config.js";
import type { CuedDatabase } from "../db/database.js";
import { refreshManagedIntegrationStates } from "../platforms/core/state/refresh.js";
import { buildIntegrationStatus } from "../platforms/core/state/status.js";
import { getGlobalCuedSkillStatus, installGlobalCuedSkill } from "../skills/install.js";
import { buildPermissionStatus } from "./doctor.js";

export interface OnboardingSnapshot {
  permissions: Awaited<ReturnType<typeof buildPermissionStatus>>["permissions"];
  globalSkill: ReturnType<typeof getGlobalCuedSkillStatus>;
  hostOs: ReturnType<typeof buildIntegrationStatus>["hostOs"];
  integrations: ReturnType<typeof buildIntegrationStatus>["integrations"];
  setupIntegrations: ReturnType<typeof buildIntegrationStatus>["setupIntegrations"];
  relationshipSummary: RelationshipSummary;
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

  const permissions = await buildPermissionStatus({
    mode: options.refreshPermissions ? "active" : "passive",
    db,
  });
  let globalSkill = getGlobalCuedSkillStatus();
  if (options.installGlobalSkill ?? true) {
    if (!globalSkill.installed && globalSkill.status === "needs_action" && globalSkill.sourcePath) {
      const install = installGlobalCuedSkill();
      globalSkill = install.ok
        ? getGlobalCuedSkillStatus()
        : {
            ...globalSkill,
            error: install.stderr || install.error || globalSkill.error,
          };
    }
  }
  const integrations = buildIntegrationStatus(db, { includeDiagnostics: true });

  return {
    permissions: permissions.permissions,
    globalSkill,
    ...integrations,
    relationshipSummary: buildRelationshipSummary(db),
  };
}

function buildRelationshipSummary(db: CuedDatabase): RelationshipSummary {
  const cached = readCachedRelationshipSummary(db.dbPath);
  if (cached) {
    return {
      ...cached,
      phoneCalls:
        cached.phoneCalls > 0
          ? cached.phoneCalls
          : (db.getIntegrationProjectionStats("imessage", "local").rawEventsBySchema[
              "call.observed@1"
            ] ?? 0),
    };
  }

  const overview = db.getMenuBarOverview();
  const projection = db.getProjectionBacklog({ initializeProjectionState: false });
  const imessageStats = db.getIntegrationProjectionStats("imessage", "local");

  return {
    messages: overview.messages,
    contacts: overview.contacts,
    phoneCalls: imessageStats.rawEventsBySchema["call.observed@1"] ?? 0,
    pendingProjectionEvents: projection.pending_raw_events,
    lastUpdatedAt: null,
    source: "database",
  };
}

function readCachedRelationshipSummary(dbPath: string): RelationshipSummary | null {
  try {
    if (!existsSync(CUED_MENU_BAR_STATUS_PATH)) {
      return null;
    }

    const parsed = JSON.parse(readFileSync(CUED_MENU_BAR_STATUS_PATH, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const overview = isRecord(parsed.overview) ? parsed.overview : null;
    const dataStatus = isRecord(parsed.dataStatus) ? parsed.dataStatus : null;
    if (typeof parsed.dbPath === "string" && parsed.dbPath !== dbPath) {
      return null;
    }
    const integrations = Array.isArray(parsed.integrations) ? parsed.integrations : [];
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
      lastUpdatedAt: statSync(CUED_MENU_BAR_STATUS_PATH).mtimeMs,
      source: "menu_bar_cache",
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
