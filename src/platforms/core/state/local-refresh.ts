import type { CuedDatabase } from "../../../db/database.js";
import { buildLocalIntegrationStates } from "./local.js";
import {
  addSupportedByDaemonMetadata,
  listIntegrationStates,
  refreshPersistedRequestableIntegrationStates,
  upsertManagedIntegrationState,
} from "./status.js";

export function refreshLocalIntegrationStates(db: CuedDatabase): {
  refreshed: number;
  integrations: ReturnType<typeof listIntegrationStates>;
} {
  const refreshedPersistedRequestables = refreshPersistedRequestableIntegrationStates(db);
  const managed = buildLocalIntegrationStates().map(addSupportedByDaemonMetadata);
  for (const integration of managed) {
    upsertManagedIntegrationState(db, integration);
  }

  return {
    refreshed: refreshedPersistedRequestables + managed.length,
    integrations: listIntegrationStates(db),
  };
}
