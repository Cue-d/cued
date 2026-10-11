import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuedDatabase } from "../../../db/database.js";

const { probe, inspect } = vi.hoisted(() => ({ probe: vi.fn(), inspect: vi.fn() }));
vi.mock("../../whatsapp/helper/status.js", () => ({ readWhatsAppHelperStatus: probe }));
vi.mock("../../whatsapp/helper/binary.js", () => ({
  getWhatsAppStoreDir: () => "/test/whatsapp",
  inspectWhatsAppHelper: inspect,
}));
vi.mock("../../signal/cli/binary.js", () => ({
  getSignalConfigDir: () => "/test/signal",
  inspectSignalCli: async () => ({ cliPath: null }),
  readSignalLinkedAccount: () => null,
  isSignalCliVersionSupported: () => false,
}));

import { refreshManagedHelperIntegrationStates } from "./refresh.js";

describe("WhatsApp managed status recovery", () => {
  const roots: string[] = [];
  const databases: CuedDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.resetAllMocks();
  });
  function createDb(authState: "authenticated" | "needs_auth") {
    const root = mkdtempSync(join(tmpdir(), "cued-status-recovery-"));
    roots.push(root);
    const db = new CuedDatabase(join(root, "local.db"));
    databases.push(db);
    db.migrate();
    db.upsertIntegrationState({
      platform: "whatsapp",
      accountKey: "default",
      authState,
      enabled: true,
      syncCapable: authState === "authenticated",
      connectionKind: "qr-link",
      metadata: {
        lastVerifiedAt: 123,
        whatsappAccountJid: authState === "authenticated" ? "linked@s.whatsapp.net" : null,
      },
    });
    inspect.mockReturnValue({ helperPath: "/test/helper", version: "0.1.0" });
    return db;
  }
  it("keeps proven auth retryable on probe failure, then verifies recovery and unlinking", async () => {
    const db = createDb("authenticated");
    probe.mockRejectedValueOnce(new Error("Unexpected end of JSON input"));
    await refreshManagedHelperIntegrationStates(db);
    const failed = db.getIntegrationState("whatsapp", "default")!;
    expect(failed).toMatchObject({ auth_state: "authenticated", sync_capable: 1 });
    expect(JSON.parse(failed.metadata_json!)).toMatchObject({
      whatsappStatusError: "Unexpected end of JSON input",
      lastVerifiedAt: 123,
      whatsappAccountJid: "linked@s.whatsapp.net",
    });
    expect(db.listEnabledSyncTargets()).toContainEqual({
      platform: "whatsapp",
      account_key: "default",
    });
    probe.mockResolvedValueOnce({ authenticated: true, accountJid: "linked@s.whatsapp.net" });
    await refreshManagedHelperIntegrationStates(db);
    const recovered = JSON.parse(db.getIntegrationState("whatsapp", "default")!.metadata_json!);
    expect(recovered.whatsappStatusError).toBeNull();
    expect(recovered.lastVerifiedAt).toBeGreaterThan(123);
    probe.mockResolvedValueOnce({ authenticated: false, accountJid: null });
    await refreshManagedHelperIntegrationStates(db);
    expect(db.getIntegrationState("whatsapp", "default")).toMatchObject({
      auth_state: "needs_auth",
      sync_capable: 0,
    });
    expect(db.listEnabledSyncTargets()).not.toContainEqual({
      platform: "whatsapp",
      account_key: "default",
    });
  });
  it("does not promote an unlinked account on probe failure", async () => {
    const db = createDb("needs_auth");
    probe.mockRejectedValue(new Error("probe failed"));
    await refreshManagedHelperIntegrationStates(db);
    expect(db.getIntegrationState("whatsapp", "default")).toMatchObject({
      auth_state: "blocked",
      sync_capable: 0,
    });
  });
  it("does not keep sync enabled when the helper is missing", async () => {
    const db = createDb("authenticated");
    inspect.mockReturnValue({ helperPath: null, version: null });
    await refreshManagedHelperIntegrationStates(db);
    expect(db.getIntegrationState("whatsapp", "default")).toMatchObject({
      auth_state: "missing",
      sync_capable: 0,
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
