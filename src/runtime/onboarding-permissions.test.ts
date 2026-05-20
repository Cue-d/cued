import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildPermissionStatusMock,
  buildIntegrationStatusMock,
  getGlobalCuedSkillStatusMock,
  installGlobalCuedSkillMock,
} = vi.hoisted(() => ({
  buildPermissionStatusMock: vi.fn(),
  buildIntegrationStatusMock: vi.fn(),
  getGlobalCuedSkillStatusMock: vi.fn(),
  installGlobalCuedSkillMock: vi.fn(),
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

import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding permission refresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses passive permission checks by default", async () => {
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

    await buildOnboardingSnapshot({} as never);

    expect(buildPermissionStatusMock).toHaveBeenCalledWith({
      mode: "passive",
      db: {} as never,
    });
  });

  it("can force a live permission refresh for onboarding snapshots", async () => {
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

    await buildOnboardingSnapshot({} as never, { refreshPermissions: true });

    expect(buildPermissionStatusMock).toHaveBeenCalledWith({
      mode: "active",
      db: {} as never,
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

    const snapshot = await buildOnboardingSnapshot({} as never);

    expect(installGlobalCuedSkillMock).toHaveBeenCalledTimes(1);
    expect(snapshot.globalSkill.installed).toBe(true);
  });

  it("can skip skill auto-install for status-only callers", async () => {
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
      sourcePath: "/Applications/Cued.app/Contents/Resources/skills/cued",
      npxPath: "/opt/homebrew/bin/npx",
      installedPath: null,
    });

    await buildOnboardingSnapshot({} as never, { installGlobalSkill: false });

    expect(installGlobalCuedSkillMock).not.toHaveBeenCalled();
  });
});
