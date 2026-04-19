import type { IntegrationStateSummary } from "../platforms/core/state/types.js";
import {
  getPlatformHelperRequirements,
  getPlatformPermissionRequirements,
  getSupportedHostOsForPlatform,
  HOST_OS_VALUES,
  type HostOS,
  isOnboardingVisiblePlatform,
  isPlatformSupportedOnHost,
  type Platform,
  type PlatformHelperRequirement,
  type PlatformPermissionRequirement,
  platformSupportsMultipleAccounts,
} from "../platforms/core/types.js";
import { inspectSlackHelper } from "../platforms/slack/helper/binary.js";

export type PlatformAvailabilityState =
  | "available"
  | "requires_permission"
  | "requires_helper"
  | "unsupported";

export interface PlatformCapabilitySummary {
  platform: Platform;
  hostOs: HostOS;
  supportedHostOs: readonly HostOS[];
  onboardingVisible: boolean;
  supportsMultipleAccounts: boolean;
  permissionRequirements: readonly PlatformPermissionRequirement[];
  helperRequirements: readonly PlatformHelperRequirement[];
  availability: PlatformAvailabilityState;
  reason: string | null;
}

type CapabilityIntegration = Pick<IntegrationStateSummary, "platform" | "authState"> & {
  metadata?: Record<string, unknown> | null;
};

export function resolveHostOS(platform: NodeJS.Platform = process.platform): HostOS {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return HOST_OS_VALUES.includes("linux") ? "linux" : "macos";
}

function resolvePermissionAvailability(
  integration: Pick<IntegrationStateSummary, "authState" | "platform"> | null,
  requirements: readonly PlatformPermissionRequirement[],
): PlatformCapabilitySummary["availability"] | null {
  if (requirements.length === 0 || !integration) {
    return null;
  }

  if (integration.platform === "contacts" && integration.authState !== "authorized") {
    return "requires_permission";
  }

  if (integration.platform === "imessage" && integration.authState !== "authorized") {
    return "requires_permission";
  }

  return null;
}

function resolveHelperAvailability(
  integration: Pick<CapabilityIntegration, "authState" | "metadata"> | null,
  requirements: readonly PlatformHelperRequirement[],
): PlatformCapabilitySummary["availability"] | null {
  if (requirements.length === 0 || !integration) {
    return null;
  }

  if (
    requirements.includes("signal_cli") &&
    (integration.authState === "missing" || integration.authState === "outdated")
  ) {
    return "requires_helper";
  }

  if (requirements.includes("whatsapp_helper") && integration.authState === "missing") {
    return "requires_helper";
  }

  if (requirements.includes("slack_helper")) {
    if (integration.authState !== "authenticated") {
      return null;
    }

    const slackHelperMetadata = integration.metadata;
    const hasSlackHelperMetadata =
      typeof slackHelperMetadata?.slackHelperPath === "string" ||
      slackHelperMetadata?.slackHelperPath === null ||
      typeof slackHelperMetadata?.slackHelperVersionSupported === "boolean";

    if (hasSlackHelperMetadata) {
      return slackHelperMetadata?.slackHelperPath &&
        slackHelperMetadata?.slackHelperVersionSupported === true
        ? null
        : "requires_helper";
    }

    const slackHelperInspection = inspectSlackHelper();
    if (!slackHelperInspection.helperPath || slackHelperInspection.versionSupported !== true) {
      return "requires_helper";
    }
  }

  return null;
}

export function summarizePlatformCapability(
  platform: Platform,
  integration: CapabilityIntegration | null,
  hostOs: HostOS = resolveHostOS(),
): PlatformCapabilitySummary {
  const supportedHostOs = getSupportedHostOsForPlatform(platform);
  const permissionRequirements = getPlatformPermissionRequirements(platform);
  const helperRequirements = getPlatformHelperRequirements(platform);

  if (!isPlatformSupportedOnHost(platform, hostOs)) {
    return {
      platform,
      hostOs,
      supportedHostOs,
      onboardingVisible: isOnboardingVisiblePlatform(platform),
      supportsMultipleAccounts: platformSupportsMultipleAccounts(platform),
      permissionRequirements,
      helperRequirements,
      availability: "unsupported",
      reason: `Unsupported on ${hostOs}`,
    };
  }

  const permissionAvailability = resolvePermissionAvailability(integration, permissionRequirements);
  if (permissionAvailability) {
    return {
      platform,
      hostOs,
      supportedHostOs,
      onboardingVisible: isOnboardingVisiblePlatform(platform),
      supportsMultipleAccounts: platformSupportsMultipleAccounts(platform),
      permissionRequirements,
      helperRequirements,
      availability: permissionAvailability,
      reason: "Permission required",
    };
  }

  const helperAvailability = resolveHelperAvailability(integration, helperRequirements);
  if (helperAvailability) {
    return {
      platform,
      hostOs,
      supportedHostOs,
      onboardingVisible: isOnboardingVisiblePlatform(platform),
      supportsMultipleAccounts: platformSupportsMultipleAccounts(platform),
      permissionRequirements,
      helperRequirements,
      availability: helperAvailability,
      reason: "Helper required",
    };
  }

  return {
    platform,
    hostOs,
    supportedHostOs,
    onboardingVisible: isOnboardingVisiblePlatform(platform),
    supportsMultipleAccounts: platformSupportsMultipleAccounts(platform),
    permissionRequirements,
    helperRequirements,
    availability: "available",
    reason: null,
  };
}
