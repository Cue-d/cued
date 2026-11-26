import type { CuedDatabase } from "../../../db/database.js";
import { buildLocalIntegrationStates } from "./local.js";
import {
  addSupportedByDaemonMetadata,
  listIntegrationStates,
  refreshPersistedRequestableIntegrationStates,
  upsertManagedIntegrationState,
} from "./status.js";
import type { ManagedIntegrationState } from "./types.js";

export function refreshLocalIntegrationStates(
  db: CuedDatabase,
  // Probing spawns the native helper; a caller that must not block probes off-thread first.
  localIntegrationStates: ManagedIntegrationState[] = buildLocalIntegrationStates(),
): {
  refreshed: number;
  integrations: ReturnType<typeof listIntegrationStates>;
} {
  const refreshedPersistedRequestables = refreshPersistedRequestableIntegrationStates(db);
  const managed = localIntegrationStates.map(addSupportedByDaemonMetadata);
  for (const integration of managed) {
    upsertManagedIntegrationState(db, integration);
  }

  return {
    refreshed: refreshedPersistedRequestables + managed.length,
    integrations: listIntegrationStates(db, { includeDiagnostics: false }),
  };
}
