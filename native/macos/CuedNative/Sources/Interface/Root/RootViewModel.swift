import AppKit
import Combine
import SwiftUI

final class BundleAnchor {}

public struct CapabilityStatus: Decodable, Sendable {
  public let availability: String
  public let setupVisible: Bool

  private enum CodingKeys: String, CodingKey {
    case availability
    case setupVisible = "onboardingVisible"
  }

  public init(availability: String, setupVisible: Bool) {
    self.availability = availability
    self.setupVisible = setupVisible
  }
}

public struct ProjectionStats: Decodable, Sendable {
  public let rawEvents: Int
  public let rawEventsBySchema: [String: Int]
  public let projectedContacts: Int
  public let projectedConversations: Int
  public let projectedMessages: Int

  private enum CodingKeys: String, CodingKey {
    case rawEvents
    case rawEventsBySchema
    case projectedContacts
    case projectedConversations
    case projectedMessages
  }

  public init(
    rawEvents: Int = 0,
    rawEventsBySchema: [String: Int] = [:],
    projectedContacts: Int = 0,
    projectedConversations: Int = 0,
    projectedMessages: Int = 0
  ) {
    self.rawEvents = rawEvents
    self.rawEventsBySchema = rawEventsBySchema
    self.projectedContacts = projectedContacts
    self.projectedConversations = projectedConversations
    self.projectedMessages = projectedMessages
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    rawEvents = try container.decodeIfPresent(Int.self, forKey: .rawEvents) ?? 0
    rawEventsBySchema =
      try container.decodeIfPresent([String: Int].self, forKey: .rawEventsBySchema) ?? [:]
    projectedContacts = try container.decodeIfPresent(Int.self, forKey: .projectedContacts) ?? 0
    projectedConversations =
      try container.decodeIfPresent(Int.self, forKey: .projectedConversations) ?? 0
    projectedMessages = try container.decodeIfPresent(Int.self, forKey: .projectedMessages) ?? 0
  }
}

public struct IntegrationStatus: Decodable, Identifiable, Sendable {
  public let platform: String
  public let accountKey: String
  public let displayName: String?
  public let authState: String
  public let enabled: Bool
  public let projectionStats: ProjectionStats?
  public let capability: CapabilityStatus

  public var id: String { "\(platform):\(accountKey)" }

  public init(
    platform: String,
    accountKey: String,
    displayName: String?,
    authState: String,
    enabled: Bool,
    projectionStats: ProjectionStats? = nil,
    capability: CapabilityStatus
  ) {
    self.platform = platform
    self.accountKey = accountKey
    self.displayName = displayName
    self.authState = authState
    self.enabled = enabled
    self.projectionStats = projectionStats
    self.capability = capability
  }
}

public struct PermissionStatus: Decodable, Identifiable, Sendable {
  public let key: String
  public let status: String
  public let summary: String
  public let requestFlags: [String]

  public var id: String { key }

  public init(key: String, status: String, summary: String, requestFlags: [String]) {
    self.key = key
    self.status = status
    self.summary = summary
    self.requestFlags = requestFlags
  }
}

func shouldDismissPermissionGuide(
  activePermissionKey: String?,
  permissions: [PermissionStatus]
) -> Bool {
  guard let activePermissionKey else {
    return false
  }

  guard let status = permissions.first(where: { $0.key == activePermissionKey })?.status else {
    return true
  }

  return status == "granted"
}

public struct SkillStatus: Decodable, Sendable {
  public let installed: Bool
  public let status: String
  public let summary: String

  public init(installed: Bool, status: String, summary: String) {
    self.installed = installed
    self.status = status
    self.summary = summary
  }
}

public struct RelationshipSummary: Decodable, Sendable {
  public let messages: Int
  public let contacts: Int
  public let phoneCalls: Int
  public let pendingProjectionEvents: Int
  public let lastUpdatedAt: Double?
  public let source: String

  public init(
    messages: Int = 0,
    contacts: Int = 0,
    phoneCalls: Int = 0,
    pendingProjectionEvents: Int = 0,
    lastUpdatedAt: Double? = nil,
    source: String = "database"
  ) {
    self.messages = messages
    self.contacts = contacts
    self.phoneCalls = phoneCalls
    self.pendingProjectionEvents = pendingProjectionEvents
    self.lastUpdatedAt = lastUpdatedAt
    self.source = source
  }
}

public struct PlatformConfig: Identifiable {
  public let platform: String
  public let title: String
  public let capability: CapabilityStatus
  public let accounts: [IntegrationStatus]
  public let placeholder: IntegrationStatus?
  public let supportsMultipleAccounts: Bool

  public var id: String { platform }

  public var knownAccounts: [IntegrationStatus] {
    if accounts.isEmpty, let placeholder {
      return [placeholder]
    }
    return accounts
  }

  public var isRequestable: Bool {
    isRequestablePlatform(platform)
  }

  public var isConnectable: Bool {
    isRequestable && capability.availability != "unsupported" && capability.availability != "requires_helper"
  }

  public var needsPermission: Bool {
    capability.availability == "requires_permission"
  }

  public init(
    platform: String,
    title: String,
    capability: CapabilityStatus,
    accounts: [IntegrationStatus],
    placeholder: IntegrationStatus?,
    supportsMultipleAccounts: Bool
  ) {
    self.platform = platform
    self.title = title
    self.capability = capability
    self.accounts = accounts
    self.placeholder = placeholder
    self.supportsMultipleAccounts = supportsMultipleAccounts
  }
}

public struct AddAccountPrompt: Identifiable {
  public let platform: String
  public let platformTitle: String
  public let suggestedAccountKey: String

  public var id: String { platform }

  public init(platform: String, platformTitle: String, suggestedAccountKey: String) {
    self.platform = platform
    self.platformTitle = platformTitle
    self.suggestedAccountKey = suggestedAccountKey
  }
}

public struct RemovalPrompt: Identifiable {
  public let platform: String
  public let platformTitle: String
  public let accountKey: String
  public let accountTitle: String

  public var id: String { "\(platform):\(accountKey)" }

  public init(platform: String, platformTitle: String, accountKey: String, accountTitle: String) {
    self.platform = platform
    self.platformTitle = platformTitle
    self.accountKey = accountKey
    self.accountTitle = accountTitle
  }
}

@MainActor
public final class RootViewModel: ObservableObject {
  nonisolated public static let windowWidth: CGFloat = 630
  nonisolated public static let windowHeight: CGFloat = 752

  @Published public var currentPage = 0
  @Published public var isRefreshing = false
  @Published public var platformConfigurations: [PlatformConfig] = []
  @Published public var permissionStatuses: [PermissionStatus] = defaultPermissionStatuses()
  @Published public var globalSkillStatus = defaultSkillStatus()
  @Published public var relationshipSummary = RelationshipSummary()
  @Published public var agentTargetStatuses = defaultAgentTargetStatuses()
  @Published public var agentLaunchFeedback: AgentLaunchFeedback?
  @Published public var hasLoadedSnapshot = false
  @Published public private(set) var refreshSequence = 0

  public let pageWidth: CGFloat = RootViewModel.windowWidth

  public var pageCount: Int { RootPage.allCases.count }

  public var currentPageTitle: String {
    rootPage(for: currentPage).title
  }

  public var grantedPermissionCount: Int {
    permissionStatuses.filter { $0.status == "granted" }.count
  }

  public var totalPermissionCount: Int {
    permissionStatuses.count
  }

  public var allPermissionsGranted: Bool {
    grantedPermissionCount == totalPermissionCount
  }

  public var buttonTitle: String {
    if rootPage(for: currentPage) == .permissions && !allPermissionsGranted {
      return "Skip for now"
    }
    return currentPage == pageCount - 1 ? "Finish" : "Continue"
  }

  public var canGoBack: Bool {
    currentPage > 0
  }

  public init() {}

  public func beginRefresh() {
    isRefreshing = true
  }

  public func apply(
    permissions: [PermissionStatus],
    globalSkill: SkillStatus,
    relationshipSummary: RelationshipSummary,
    allIntegrations: [IntegrationStatus],
    integrations: [IntegrationStatus]
  ) {
    let normalizedPermissions = buildPermissionStatuses(permissions)
    permissionStatuses = normalizedPermissions
    globalSkillStatus = globalSkill
    self.relationshipSummary = relationshipSummary
    platformConfigurations = buildPlatformConfigurations(
      permissions: normalizedPermissions,
      allIntegrations: allIntegrations,
      setupIntegrations: integrations
    )
    hasLoadedSnapshot = true
    isRefreshing = false
    refreshSequence += 1
  }

  public func finishRefreshWithoutSnapshot() {
    isRefreshing = false
    refreshSequence += 1
  }

  public func setPermissionStatus(
    key: String,
    status: String,
    summary: String,
    requestFlags: [String]
  ) {
    let replacement = PermissionStatus(
      key: key,
      status: status,
      summary: summary,
      requestFlags: requestFlags
    )
    if let index = permissionStatuses.firstIndex(where: { $0.key == key }) {
      permissionStatuses[index] = replacement
    } else {
      permissionStatuses.append(replacement)
      permissionStatuses = buildPermissionStatuses(permissionStatuses)
    }
  }

  public func configuration(for platform: String) -> PlatformConfig? {
    platformConfigurations.first { $0.platform == platform }
  }

  public func applyAgentTargetStatuses(_ statuses: [AgentTarget: AgentTargetStatus]) {
    agentTargetStatuses = statuses
  }

  public func showAgentLaunchFeedback(_ feedback: AgentLaunchFeedback) {
    agentLaunchFeedback = feedback
  }

  public func clearAgentLaunchFeedback() {
    agentLaunchFeedback = nil
  }

  public func suggestedAccountKey(for platform: String) -> String {
    if supportsAutomaticAccountDiscovery(platform) {
      return pendingAccountKey(
        for: platform,
        existing: Set(configuration(for: platform)?.accounts.map(\.accountKey) ?? [])
      )
    }

    let existing = Set(configuration(for: platform)?.accounts.map(\.accountKey) ?? [])
    if !existing.contains("default") {
      return "default"
    }

    let base = accountNoun(for: platform)
    var index = 2
    var candidate = "\(base)-\(index)"
    while existing.contains(candidate) {
      index += 1
      candidate = "\(base)-\(index)"
    }
    return candidate
  }

  private func buildPermissionStatuses(
    _ permissions: [PermissionStatus]
  ) -> [PermissionStatus] {
    if permissions.isEmpty {
      return defaultPermissionStatuses()
    }

    let byKey = Dictionary(uniqueKeysWithValues: permissions.map { ($0.key, $0) })
    let orderedKnownPermissions = permissionOrder.compactMap { key in
      byKey[key] ?? defaultPermissionStatus(for: key, includeFuturePermissions: false)
    }
    let orderedKeys = Set(permissionOrder)
    let extraPermissions = permissions.filter { !orderedKeys.contains($0.key) }
    return orderedKnownPermissions + extraPermissions
  }

  private func buildPlatformConfigurations(
    permissions: [PermissionStatus],
    allIntegrations: [IntegrationStatus],
    setupIntegrations: [IntegrationStatus]
  ) -> [PlatformConfig] {
    let visibleSetup = setupIntegrations.filter { $0.capability.setupVisible }
    let visibleAll = allIntegrations.filter { $0.capability.setupVisible }
    let actualByPlatform = Dictionary(grouping: visibleAll, by: \.platform)
    let setupByPlatform = Dictionary(grouping: visibleSetup, by: \.platform)
    let permissionsByKey = Dictionary(uniqueKeysWithValues: permissions.map { ($0.key, $0) })
    var configurations = [PlatformConfig]()

    for platform in platformOrder {
      let setupIntegration = (setupByPlatform[platform] ?? []).sorted(by: sortIntegrations).first
        ?? fallbackIntegration(for: platform)

      let accounts = (actualByPlatform[platform] ?? []).sorted(by: sortIntegrations)
      let placeholder = accounts.isEmpty
        ? ((setupByPlatform[platform] ?? []).sorted(by: sortIntegrations).first
          ?? fallbackIntegration(for: platform))
        : nil
      let base = accounts.first ?? placeholder ?? setupIntegration
      let capability = effectiveCapability(
        platform: platform,
        base: base.capability,
        permissionsByKey: permissionsByKey
      )

      configurations.append(
        PlatformConfig(
          platform: platform,
          title: platformTitle(platform, fallback: base.displayName),
          capability: capability,
          accounts: accounts,
          placeholder: placeholder,
          supportsMultipleAccounts: supportsMultipleAccounts(platform)
        )
      )
    }

    return configurations
  }
}
