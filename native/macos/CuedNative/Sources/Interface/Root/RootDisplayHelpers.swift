import AppKit
import Combine
import SwiftUI

let permissionOrder = [
  "contacts",
  "full_disk_access",
  "diagnostics",
]

let defaultPermissionOrder = [
  "contacts",
  "full_disk_access",
  "diagnostics",
]

let platformOrder = [
  "contacts",
  "phone_calls",
  "imessage",
  "slack",
  "gmail",
  "discord",
  "linkedin",
  "whatsapp",
  "signal",
]

func defaultPermissionStatuses() -> [PermissionStatus] {
  defaultPermissionOrder.compactMap { defaultPermissionStatus(for: $0) }
}

func defaultSkillStatus() -> SkillStatus {
  SkillStatus(
    installed: false,
    status: "unknown",
    summary: "Checks whether the global Cued skill is available to your agents."
  )
}

func defaultPermissionStatus(
  for key: String,
  includeFuturePermissions: Bool = true
) -> PermissionStatus? {
  switch key {
  case "contacts":
    return PermissionStatus(
      key: key,
      status: "unknown",
      summary: "Contacts permission has not been checked yet",
      requestFlags: ["--contacts"]
    )
  case "full_disk_access":
    return PermissionStatus(
      key: key,
      status: "unknown",
      summary: "Full Disk Access has not been checked yet",
      requestFlags: ["--full-disk-access"]
    )
  case "diagnostics":
    return PermissionStatus(
      key: key,
      status: "granted",
      summary: "Redacted diagnostic reporting is enabled",
      requestFlags: ["--telemetry-enable"]
    )
  case "messages_automation":
    guard includeFuturePermissions else {
      return nil
    }
    return PermissionStatus(
      key: key,
      status: "unknown",
      summary: "Messages automation access has not been checked yet",
      requestFlags: ["--messages"]
    )
  default:
    return nil
  }
}

func platformIconAssetName(for platform: String) -> String? {
  switch platform {
  case "contacts", "phone_calls", "imessage":
    return nil  // Use SF Symbol fallback icons
  case "gmail":
    return "google-logo"
  case "discord":
    return "discord-logo-white"
  case "slack":
    return "slack-logo"
  case "linkedin":
    return "linkedin-logo-white"
  case "signal":
    return "signal-logo-white"
  case "whatsapp":
    return "whatsapp-logo-white"
  default:
    return nil
  }
}

func platformAccentColor(for platform: String) -> Color {
  switch platform {
  case "contacts":
    return Color(red: 0.07, green: 0.72, blue: 0.84)
  case "phone_calls":
    return Color(red: 0.13, green: 0.74, blue: 0.38)
  case "imessage":
    return Color(red: 0.24, green: 0.81, blue: 0.39)
  case "gmail":
    return Color(red: 0.83, green: 0.2, blue: 0.16)
  case "discord":
    return Color(red: 0.345, green: 0.396, blue: 0.949)
  case "slack":
    return Color(red: 0.36, green: 0.18, blue: 0.52)
  case "linkedin":
    return Color(red: 0.03, green: 0.45, blue: 0.74)
  case "signal":
    return Color(red: 0.24, green: 0.56, blue: 0.98)
  case "whatsapp":
    return Color(red: 0.13, green: 0.74, blue: 0.38)
  case "x":
    return Color(red: 0.08, green: 0.08, blue: 0.09)
  default:
    return .accentColor
  }
}

func interfaceResourceURL(named assetName: String, withExtension fileExtension: String) -> URL? {
  let bundles: [Bundle] = [
    Bundle.main.resourceURL.flatMap { Bundle(url: $0.appendingPathComponent("CuedNative_Interface.bundle")) },
    Bundle(for: BundleAnchor.self),
    Bundle.main,
  ].compactMap { $0 }
  for bundle in bundles {
    if let url = bundle.url(forResource: assetName, withExtension: fileExtension) {
      return url
    }
  }
  return nil
}

func platformIconURL(named assetName: String) -> URL? {
  interfaceResourceURL(named: assetName, withExtension: "svg")
    ?? interfaceResourceURL(named: assetName, withExtension: "png")
}

func fallbackIntegration(for platform: String) -> IntegrationStatus {
  let accountKey = platform == "contacts" || platform == "phone_calls" || platform == "imessage" ? "local" : "default"
  let authState: String
  switch platform {
  case "phone_calls":
    authState = "authorized"
  case "contacts", "imessage":
    authState = "not_determined"
  default:
    authState = "missing"
  }

  let availability = platform == "contacts" || platform == "imessage" ? "requires_permission" : "available"

  return IntegrationStatus(
    platform: platform,
    accountKey: accountKey,
    displayName: platformTitle(platform, fallback: nil),
    authState: authState,
    enabled: true,
    capability: CapabilityStatus(
      availability: availability,
      setupVisible: true
    )
  )
}

func effectiveCapability(
  platform: String,
  base: CapabilityStatus,
  permissionsByKey: [String: PermissionStatus]
) -> CapabilityStatus {
  guard let permissionKey = permissionKey(for: platform),
        let permission = permissionsByKey[permissionKey],
        base.availability != "unsupported" else {
    return base
  }

  switch permission.status {
  case "granted":
    return CapabilityStatus(
      availability: "available",
      setupVisible: base.setupVisible
    )
  case "needs_action":
    return CapabilityStatus(
      availability: "requires_permission",
      setupVisible: base.setupVisible
    )
  default:
    return base
  }
}

func permissionKey(for platform: String) -> String? {
  switch platform {
  case "contacts":
    return "contacts"
  case "imessage":
    return "full_disk_access"
  default:
    return nil
  }
}

func showsCompletionCheckmark(
  for configuration: PlatformConfig,
  integration: IntegrationStatus
) -> Bool {
  if !configuration.isRequestable {
    return configuration.capability.availability == "available"
  }
  return integration.enabled && isConnectedAuthState(integration.authState)
}

func platformDescription(for configuration: PlatformConfig) -> String {
  switch configuration.platform {
  case "contacts":
    return "Adds your local contacts so Cued can recognize people across conversations."
  case "phone_calls":
    return "Adds your recent phone calls from this Mac."
  case "imessage":
    return "Syncs your Messages conversations from this Mac."
  case "gmail":
    return "Syncs Gmail messages after you grant readonly access with Google OAuth."
  case "slack":
    return "Syncs messages from each Slack workspace you connect."
  case "discord":
    return "Syncs new Discord messages after you connect your account."
  case "linkedin":
    return "Syncs your LinkedIn messages on this Mac."
  case "whatsapp":
    return "Syncs WhatsApp messages after you link your phone."
  case "signal":
    return "Syncs Signal messages after you link your device."
  case "x":
    return "Imports direct messages and follow relationships from your local X archive."
  default:
    return "Syncs this source on this Mac."
  }
}

public func shouldAutoConfigurePrerequisites() -> Bool {
  if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" {
    return false
  }
  if ProcessInfo.processInfo.environment["CUED_SKIP_AUTO_PREREQUISITES"] == "1" {
    return false
  }
  let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
  return bundlePath.hasSuffix(".app")
}

func isConnectedAuthState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

func readableAuthState(_ platform: String, _ value: String) -> String {
  switch value {
  case "authorized", "authenticated":
    return "Authenticated"
  case "in_progress":
    return "Authenticating"
  case "requested":
    return "Starting authentication"
  case "needs_full_disk_access":
    return "Needs Full Disk Access"
  case "native_helper_missing":
    return "Needs helper"
  case "check_failed":
    if usesQRLink(platform) {
      return "Not authenticated"
    }
    return "Needs attention"
  case "missing":
    return "Not authenticated"
  case "needs_auth":
    return "Not authenticated"
  case "blocked":
    if usesQRLink(platform) {
      return "Not authenticated"
    }
    return "Blocked"
  case "not_determined":
    return "Needs permission"
  case "cancelled":
    return "Disconnected"
  default:
    return value.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

func usesQRLink(_ platform: String) -> Bool {
  platform == "signal" || platform == "whatsapp"
}

func needsAuthAttention(_ platform: String, authState: String) -> Bool {
  if usesQRLink(platform) {
    return false
  }
  return authState == "blocked" || authState == "check_failed"
}

func formatCount(_ value: Int) -> String {
  let formatter = NumberFormatter()
  formatter.numberStyle = .decimal
  return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

func platformTitle(_ platform: String, fallback: String?) -> String {
  switch platform {
  case "contacts":
    return "Contacts"
  case "phone_calls":
    return "Phone calls"
  case "imessage":
    return "Messages"
  case "gmail":
    return "Gmail"
  case "linkedin":
    return "LinkedIn"
  case "signal":
    return "Signal"
  case "slack":
    return "Slack"
  case "discord":
    return "Discord"
  case "whatsapp":
    return "WhatsApp"
  case "x":
    return "X"
  default:
    if let fallback = fallback?.trimmingCharacters(in: .whitespacesAndNewlines), !fallback.isEmpty {
      return fallback
    }
    return platform.capitalized
  }
}

func accountNoun(for platform: String) -> String {
  platform == "slack" ? "workspace" : "account"
}

func supportsAutomaticAccountDiscovery(_ platform: String) -> Bool {
  platform == "gmail" || platform == "slack"
}

func hidesAccountKey(platform: String, accountKey: String) -> Bool {
  if supportsAutomaticAccountDiscovery(platform)
    && (accountKey.hasPrefix("pending-slack-") || accountKey.hasPrefix("pending-gmail-")) {
    return true
  }
  if !supportsMultipleAccounts(platform) && accountKey == "default" {
    return true
  }
  return false
}

func normalizedTitle(_ value: String?) -> String {
  value?.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase ?? ""
}

func fallbackAccountTitle(for platform: String, authState: String) -> String {
  if isConnectedAuthState(authState) {
    switch platform {
    case "linkedin":
      return "LinkedIn account"
    case "signal":
      return "Linked Signal device"
    case "whatsapp":
      return "Linked WhatsApp device"
    default:
      return "Connected account"
    }
  }

  if authState == "requested" || authState == "in_progress" {
    switch platform {
    case "gmail":
      return "Gmail sign-in"
    case "slack":
      return "Slack sign-in"
    default:
      break
    }
  }

  switch platform {
  case "linkedin":
    return "Browser sign-in"
  case "signal":
    return "Signal device"
  case "whatsapp":
    return "WhatsApp device"
  default:
    return "Account"
  }
}

func pendingAccountKey(
  for platform: String,
  existing: Set<String>
) -> String {
  let prefix = platform == "slack" ? "pending-slack-" : platform == "gmail" ? "pending-gmail-" : "pending-"
  var candidate = "\(prefix)\(UUID().uuidString.prefix(8).lowercased())"
  while existing.contains(candidate) {
    candidate = "\(prefix)\(UUID().uuidString.prefix(8).lowercased())"
  }
  return candidate
}

func supportsMultipleAccounts(_ platform: String) -> Bool {
  platform == "gmail" || platform == "slack"
}

func isRequestablePlatform(_ platform: String) -> Bool {
  switch platform {
  case "discord", "gmail", "linkedin", "signal", "slack", "whatsapp":
    return true
  default:
    return false
  }
}

func sortIntegrations(
  left: IntegrationStatus,
  right: IntegrationStatus
) -> Bool {
  let leftConnected = isConnectedAuthState(left.authState)
  let rightConnected = isConnectedAuthState(right.authState)
  if left.enabled != right.enabled {
    return left.enabled && !right.enabled
  }
  if leftConnected != rightConnected {
    return leftConnected && !rightConnected
  }

  let leftTitle = (left.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    ? left.displayName!
    : left.accountKey).localizedLowercase
  let rightTitle = (right.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    ? right.displayName!
    : right.accountKey).localizedLowercase
  return leftTitle < rightTitle
}
