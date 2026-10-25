import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";
import { refreshManagedHelperIntegrationStates } from "./refresh.js";

const mocks = vi.hoisted(() => ({ install: vi.fn(), linked: vi.fn() }));
vi.mock("../../signal/cli/install.js", () => ({ ensureSignalCliAvailable: mocks.install }));
vi.mock("../../signal/cli/binary.js", () => ({
  getSignalConfigDir: () => "/unused/test/config",
  inspectSignalCli: async () => ({ cliPath: null, version: null }),
  readSignalLinkedAccount: mocks.linked,
  isSignalCliVersionSupported: () => false,
}));
vi.mock("../../whatsapp/helper/binary.js", () => ({
  getWhatsAppStoreDir: () => "/unused/test/whatsapp",
  inspectWhatsAppHelper: () => ({ helperPath: null }),
}));
const dirs: string[] = [];
const databases: CuedDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
function database(authState: "in_progress" | "authenticated", enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "cued-signal-state-"));
  dirs.push(dir);
  const db = new CuedDatabase(join(dir, "local.db"));
  databases.push(db);
  db.migrate();
  db.upsertIntegrationState({
    platform: "signal",
    accountKey: "default",
    displayName: "Signal",
    authState,
    enabled,
    connectionKind: "local-cli",
    syncCapable: false,
    launchStrategy: "qr-native",
    launchTarget: null,
    importedFrom: "bundled-helper",
  });
  return db;
}
it("keeps authentication in progress during the first runtime download", async () => {
  mocks.linked.mockReturnValue(null);
  const db = database("in_progress");
  await refreshManagedHelperIntegrationStates(db);
  expect(db.getIntegrationState("signal", "default")?.auth_state).toBe("in_progress");
  expect(mocks.install).not.toHaveBeenCalled();
});
it("preserves linked accounts while provisioning asynchronously", async () => {
  mocks.linked.mockReturnValue("+15555550123");
  mocks.install.mockReturnValue(new Promise(() => {}));
  const db = database("authenticated");
  await refreshManagedHelperIntegrationStates(db);
  expect(db.getIntegrationState("signal", "default")?.auth_state).toBe("authenticated");
  expect(mocks.install).toHaveBeenCalledTimes(1);
});
it("does not download for disabled linked accounts", async () => {
  mocks.linked.mockReturnValue("+15555550123");
  const db = database("authenticated", false);
  await refreshManagedHelperIntegrationStates(db);
  expect(mocks.install).not.toHaveBeenCalled();
});
