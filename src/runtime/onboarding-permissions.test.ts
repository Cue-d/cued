import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildPermissionStatusMock,
  buildIntegrationStatusMock,
  getGlobalCuedSkillStatusMock,
  installGlobalCuedSkillMock,
  readMenuBarStatusCacheMock,
} = vi.hoisted(() => ({
  buildPermissionStatusMock: vi.fn(),
  buildIntegrationStatusMock: vi.fn(),
  getGlobalCuedSkillStatusMock: vi.fn(),
  installGlobalCuedSkillMock: vi.fn(),
  readMenuBarStatusCacheMock: vi.fn(),
}));

vi.mock("./doctor.js", () => ({
  buildPermissionStatus: buildPermissionStatusMock,
}));

vi.mock("../platforms/core/state/status.js", () => ({
  buildIntegrationStatus: buildIntegrationStatusMock,
}));

vi.mock("../skills/install.js", () => ({
  getGlobalCuedSkillStatus: getGlobalCuedSkillStatusMock,
  installGlobalCuedSkill: installGlobalCuedSkillMock,
}));

vi.mock("./menu-bar-status-cache.js", () => ({
  readMenuBarStatusCache: readMenuBarStatusCacheMock,
}));

import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding permission refresh", () => {
  const db = {
    dbPath: "/tmp/cued-test/local.db",
    getMenuBarOverview: () => ({ messages: 0, contacts: 0 }),
    getProjectionBacklog: () => ({ pending_raw_events: 0 }),
    getIntegrationProjectionStats: () => ({ rawEventsBySchema: {} }),
    getAppSetting: vi.fn().mockReturnValue(null),
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockSnapshotDependencies(): void {
    buildPermissionStatusMock.mockResolvedValue({ permissions: [] });
    buildIntegrationStatusMock.mockReturnValue({
      hostOs: "macos",
      integrations: [],
      setupIntegrations: [],
    });
    getGlobalCuedSkillStatusMock.mockReturnValue({
      installed: false,
      status: "needs_action",
      summary: "",
      sourcePath: null,
      npxPath: null,
      installedPath: null,
    });
  }

  it("uses passive permission checks by default", async () => {
    mockSnapshotDependencies();

    await buildOnboardingSnapshot(db as never);

    expect(buildPermissionStatusMock).toHaveBeenCalledWith({
      mode: "passive",
      db: db as never,
    });
  });

  it("can force a live permission refresh for onboarding snapshots", async () => {
    mockSnapshotDependencies();

    await buildOnboardingSnapshot(db as never, { refreshPermissions: true });

    expect(buildPermissionStatusMock).toHaveBeenCalledWith({
      mode: "active",
      db: db as never,
    });
  });

  it("auto-installs the bundled skill when onboarding can resolve it", async () => {
    buildPermissionStatusMock.mockResolvedValue({ permissions: [] });
    buildIntegrationStatusMock.mockReturnValue({
      hostOs: "macos",
      integrations: [],
      setupIntegrations: [],
    });
    getGlobalCuedSkillStatusMock
      .mockReturnValueOnce({
        installed: false,
        status: "needs_action",
        summary: "",
        sourcePath: "/Applications/Cued.app/Contents/Resources/skills/cued",
        npxPath: "/opt/homebrew/bin/npx",
        installedPath: null,
      })
      .mockReturnValueOnce({
        installed: true,
        status: "installed",
        summary: "Cued skill is installed globally.",
        sourcePath: "/Applications/Cued.app/Contents/Resources/skills/cued",
        npxPath: "/opt/homebrew/bin/npx",
        installedPath: "~/.agents/skills/cued",
      });
    installGlobalCuedSkillMock.mockReturnValue({ ok: true });

    const snapshot = await buildOnboardingSnapshot(db as never);

    expect(installGlobalCuedSkillMock).toHaveBeenCalledTimes(1);
    expect(snapshot.globalSkill.installed).toBe(true);
  });

  it("can skip skill auto-install for status-only callers", async () => {
    mockSnapshotDependencies();
    getGlobalCuedSkillStatusMock.mockReturnValue({
      installed: false,
      status: "needs_action",
      summary: "",
      sourcePath: "/Applications/Cued.app/Contents/Resources/skills/cued",
      npxPath: "/opt/homebrew/bin/npx",
      installedPath: null,
    });

    await buildOnboardingSnapshot(db as never, { installGlobalSkill: false });

    expect(installGlobalCuedSkillMock).not.toHaveBeenCalled();
  });

  it("uses the menu bar cache relationship summary through the shared cache boundary", async () => {
    mockSnapshotDependencies();
    readMenuBarStatusCacheMock.mockReturnValue({
      path: "/tmp/cued-test/menu-bar-status.json",
      mtimeMs: 1234,
      snapshot: {
        dbPath: db.dbPath,
        relationshipSummary: {
          messages: 12,
          contacts: 7,
          phoneCalls: 3,
          pendingProjectionEvents: 5,
        },
      },
    });

    const snapshot = await buildOnboardingSnapshot(db as never, { installGlobalSkill: false });

    expect(readMenuBarStatusCacheMock).toHaveBeenCalledWith({ dbPath: db.dbPath });
    expect(snapshot.relationshipSummary).toEqual({
      messages: 12,
      contacts: 7,
      phoneCalls: 3,
      pendingProjectionEvents: 5,
      lastUpdatedAt: 1234,
      source: "menu_bar_cache",
    });
  });

  it("falls back to legacy menu bar cache fields when the summary is malformed", async () => {
    mockSnapshotDependencies();
    readMenuBarStatusCacheMock.mockReturnValue({
      path: "/tmp/cued-test/menu-bar-status.json",
      mtimeMs: 5678,
      snapshot: {
        dbPath: db.dbPath,
        relationshipSummary: { messages: "bad" },
        overview: {
          messages: 4,
          contacts: 2,
        },
        dataStatus: {
          pendingProjectionEvents: 9,
        },
        integrations: [
          {
            platform: "imessage",
            projectionStats: {
              rawEventsBySchema: {
                "call.observed@1": 6,
              },
            },
          },
        ],
      },
    });

    const snapshot = await buildOnboardingSnapshot(db as never, { installGlobalSkill: false });

    expect(snapshot.relationshipSummary).toEqual({
      messages: 4,
      contacts: 2,
      phoneCalls: 6,
      pendingProjectionEvents: 9,
      lastUpdatedAt: 5678,
      source: "menu_bar_cache",
    });
  });
});
