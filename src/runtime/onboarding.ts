import type { CuedDatabase } from "../db/database.js";
import { refreshManagedIntegrationStates } from "../platforms/core/state/refresh.js";
import { buildIntegrationStatus } from "../platforms/core/state/status.js";
import { getGlobalCuedSkillStatus } from "../skills/install.js";
import { buildPermissionStatus } from "./doctor.js";

export interface OnboardingSnapshot {
  permissions: Awaited<ReturnType<typeof buildPermissionStatus>>["permissions"];
  globalSkill: ReturnType<typeof getGlobalCuedSkillStatus>;
  hostOs: ReturnType<typeof buildIntegrationStatus>["hostOs"];
  integrations: ReturnType<typeof buildIntegrationStatus>["integrations"];
  setupIntegrations: ReturnType<typeof buildIntegrationStatus>["setupIntegrations"];
}

export async function buildOnboardingSnapshot(
  db: CuedDatabase,
  options: {
    refreshManagedIntegrations?: boolean;
    refreshPermissions?: boolean;
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
  const globalSkill = getGlobalCuedSkillStatus();
  const integrations = buildIntegrationStatus(db, { includeDiagnostics: true });

  return {
    permissions: permissions.permissions.filter(
      (permission) => permission.key !== "messages_automation",
    ),
    globalSkill,
    ...integrations,
  };
}
