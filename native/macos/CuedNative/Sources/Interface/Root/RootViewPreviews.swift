import AppKit
import Combine
import SwiftUI

#if DEBUG
@MainActor
func previewModel(
  page: Int,
  permissions: [PermissionStatus],
  globalSkill: SkillStatus,
  allIntegrations: [IntegrationStatus],
  setupIntegrations: [IntegrationStatus]
) -> RootViewModel {
  let viewModel = RootViewModel()
  viewModel.currentPage = page
  viewModel.apply(
    permissions: permissions,
    globalSkill: globalSkill,
    relationshipSummary: RelationshipSummary(),
    allIntegrations: allIntegrations,
    integrations: setupIntegrations
  )
  return viewModel
}

func previewCapability(
  availability: String = "available"
) -> CapabilityStatus {
  CapabilityStatus(availability: availability, setupVisible: true)
}

func previewIntegration(
  platform: String,
  accountKey: String,
  displayName: String?,
  authState: String,
  enabled: Bool,
  capability: CapabilityStatus
) -> IntegrationStatus {
  IntegrationStatus(
    platform: platform,
    accountKey: accountKey,
    displayName: displayName,
    authState: authState,
    enabled: enabled,
    capability: capability
  )
}

struct RootPreview: View {
  @StateObject private var viewModel: RootViewModel

  init(
    page: Int,
    permissions: [PermissionStatus],
    globalSkill: SkillStatus,
    allIntegrations: [IntegrationStatus],
    setupIntegrations: [IntegrationStatus]
  ) {
    _viewModel = StateObject(
      wrappedValue: previewModel(
        page: page,
        permissions: permissions,
        globalSkill: globalSkill,
        allIntegrations: allIntegrations,
        setupIntegrations: setupIntegrations
      )
    )
  }

  var body: some View {
    RootView(
      viewModel: viewModel,
      onRefresh: {},
      onGuidePermission: { _ in },
      onDismissPermissionGuide: {},
      onRequestPermission: { _ in },
      onInstallGlobalSkill: {},
      onEnableIntegration: { _, _ in },
      onRemoveIntegration: { _, _ in },
      onConnectIntegration: { _, _ in },
      onPlatformPageActiveChanged: { _ in },
      onLaunchAgentExample: { _, _ in },
      onFinish: {}
    )
  }
}

@available(macOS 14.0, *)
#Preview("Permissions · Partial Access") {
  RootPreview(
    page: 1,
    permissions: [
      PermissionStatus(
        key: "contacts",
        status: "granted",
        summary: "Contacts access is authorized",
        requestFlags: ["--contacts"]
      ),
      PermissionStatus(
        key: "full_disk_access",
        status: "needs_action",
        summary: "Messages database is not readable from the current process",
        requestFlags: ["--full-disk-access"]
      ),
    ],
    globalSkill: defaultSkillStatus(),
    allIntegrations: [],
    setupIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "needs_full_disk_access",
        enabled: true,
        capability: previewCapability(availability: "requires_permission")
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · No Accounts") {
  RootPreview(
    page: 2,
    permissions: defaultPermissionStatuses(),
    globalSkill: defaultSkillStatus(),
    allIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
    ],
    setupIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · Slack Multi-Workspace") {
  RootPreview(
    page: 2,
    permissions: defaultPermissionStatuses(),
    globalSkill: defaultSkillStatus(),
    allIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "slack",
        accountKey: "workspace-a",
        displayName: "Acme Product",
        authState: "authenticated",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "slack",
        accountKey: "workspace-b",
        displayName: "Acme Sales",
        authState: "authenticated",
        enabled: false,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "authenticated",
        enabled: true,
        capability: previewCapability()
      ),
    ],
    setupIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "authenticated",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · Helpers Missing") {
  RootPreview(
    page: 2,
    permissions: defaultPermissionStatuses(),
    globalSkill: defaultSkillStatus(),
    allIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: previewCapability(availability: "requires_helper")
      ),
      previewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: previewCapability(availability: "requires_helper")
      ),
    ],
    setupIntegrations: [
      previewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "missing",
        enabled: true,
        capability: previewCapability()
      ),
      previewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: previewCapability(availability: "requires_helper")
      ),
      previewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: previewCapability(availability: "requires_helper")
      ),
    ]
  )
}
#endif
