import { afterEach, describe, expect, it, vi } from "vitest";

const { buildPermissionStatusMock, buildIntegrationStatusMock } = vi.hoisted(() => ({
  buildPermissionStatusMock: vi.fn(),
  buildIntegrationStatusMock: vi.fn(),
}));

vi.mock("./doctor.js", () => ({
  buildPermissionStatus: buildPermissionStatusMock,
}));

vi.mock("../platforms/core/state/status.js", () => ({
  buildIntegrationStatus: buildIntegrationStatusMock,
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

    await buildOnboardingSnapshot({} as never, { refreshPermissions: true });

    expect(buildPermissionStatusMock).toHaveBeenCalledWith({
      mode: "active",
      db: {} as never,
    });
  });
});
