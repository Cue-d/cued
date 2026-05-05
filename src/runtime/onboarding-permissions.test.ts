import { afterEach, describe, expect, it, vi } from "vitest";

const { buildPermissionStatusMock, buildIntegrationStatusMock, getGlobalCuedSkillStatusMock } =
  vi.hoisted(() => ({
    buildPermissionStatusMock: vi.fn(),
    buildIntegrationStatusMock: vi.fn(),
    getGlobalCuedSkillStatusMock: vi.fn(),
  }));

vi.mock("./doctor.js", () => ({
  buildPermissionStatus: buildPermissionStatusMock,
}));

vi.mock("../platforms/core/state/status.js", () => ({
  buildIntegrationStatus: buildIntegrationStatusMock,
}));

vi.mock("../skills/install.js", () => ({
  getGlobalCuedSkillStatus: getGlobalCuedSkillStatusMock,
}));

import { buildOnboardingSnapshot } from "./onboarding.js";

describe("onboarding permission refresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads permission status for onboarding snapshots", async () => {
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

    expect(buildPermissionStatusMock).toHaveBeenCalledWith();
  });

  it("keeps refreshPermissions as a snapshot-compatible no-op", async () => {
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

    expect(buildPermissionStatusMock).toHaveBeenCalledWith();
  });
});
