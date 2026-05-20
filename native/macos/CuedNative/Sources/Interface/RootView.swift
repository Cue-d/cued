import AppKit
import Combine
import SwiftUI

private final class BundleAnchor {}

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
  public let projectedContacts: Int
  public let projectedConversations: Int
  public let projectedMessages: Int

  public init(
    rawEvents: Int = 0,
    projectedContacts: Int = 0,
    projectedConversations: Int = 0,
    projectedMessages: Int = 0
  ) {
    self.rawEvents = rawEvents
    self.projectedContacts = projectedContacts
    self.projectedConversations = projectedConversations
    self.projectedMessages = projectedMessages
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
    allIntegrations: [IntegrationStatus],
    integrations: [IntegrationStatus]
  ) {
    let normalizedPermissions = buildPermissionStatuses(permissions)
    permissionStatuses = normalizedPermissions
    globalSkillStatus = globalSkill
    platformConfigurations = buildPlatformConfigurations(
      permissions: normalizedPermissions,
      allIntegrations: allIntegrations,
      setupIntegrations: integrations
    )
    isRefreshing = false
    refreshSequence += 1
  }

  public func configuration(for platform: String) -> PlatformConfig? {
    platformConfigurations.first { $0.platform == platform }
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

private enum RootPage: Int, CaseIterable {
  case welcome
  case permissions
  case platforms
  case automaticBugfixing
  case useCases
  case application

  var title: String {
    switch self {
    case .welcome:
      return "Welcome"
    case .permissions:
      return "Permissions"
    case .platforms:
      return "Platforms"
    case .automaticBugfixing:
      return "Automatic bugfixing"
    case .useCases:
      return "Use cases"
    case .application:
      return "Cued Application"
    }
  }

  var shortTitle: String {
    switch self {
    case .automaticBugfixing:
      return "Debug"
    case .application:
      return "App"
    default:
      return title
    }
  }
}

private func rootPage(for index: Int) -> RootPage {
  RootPage(rawValue: index) ?? .welcome
}

public struct RootView: View {
  @ObservedObject var viewModel: RootViewModel

  let onRefresh: () -> Void
  let onGuidePermission: (String) -> Void
  let onDismissPermissionGuide: () -> Void
  let onRequestPermission: ([String]) -> Void
  let onInstallGlobalSkill: () -> Void
  let onEnableIntegration: (String, String) -> Void
  let onRemoveIntegration: (String, String) -> Void
  let onConnectIntegration: (String, String) -> Void
  let onFinish: () -> Void

  @State private var addAccountPrompt: AddAccountPrompt?
  @State private var removalPrompt: RemovalPrompt?
  @State private var pendingGlobalSkillInstall = false
  @State private var pendingIntegrationActionIDs = Set<String>()
  @State private var pendingRemovedIntegrationIDs = Set<String>()
  @State private var activePermissionGuideKey: String?

  public init(
    viewModel: RootViewModel,
    onRefresh: @escaping () -> Void,
    onGuidePermission: @escaping (String) -> Void,
    onDismissPermissionGuide: @escaping () -> Void,
    onRequestPermission: @escaping ([String]) -> Void,
    onInstallGlobalSkill: @escaping () -> Void,
    onEnableIntegration: @escaping (String, String) -> Void,
    onRemoveIntegration: @escaping (String, String) -> Void,
    onConnectIntegration: @escaping (String, String) -> Void,
    onFinish: @escaping () -> Void
  ) {
    self.viewModel = viewModel
    self.onRefresh = onRefresh
    self.onGuidePermission = onGuidePermission
    self.onDismissPermissionGuide = onDismissPermissionGuide
    self.onRequestPermission = onRequestPermission
    self.onInstallGlobalSkill = onInstallGlobalSkill
    self.onEnableIntegration = onEnableIntegration
    self.onRemoveIntegration = onRemoveIntegration
    self.onConnectIntegration = onConnectIntegration
    self.onFinish = onFinish
  }

  public var body: some View {
    VStack(spacing: 0) {
      GeometryReader { geo in
        HStack(spacing: 0) {
          ForEach(0..<viewModel.pageCount, id: \.self) { pageIndex in
            page(for: pageIndex)
              .frame(width: viewModel.pageWidth, height: geo.size.height)
          }
        }
        .offset(x: CGFloat(-viewModel.currentPage) * viewModel.pageWidth)
        .animation(
          .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
          value: viewModel.currentPage
        )
        .clipped()
      }

      navigationFooter
    }
    .frame(width: viewModel.pageWidth, height: RootViewModel.windowHeight)
    .background(Color(NSColor.windowBackgroundColor))
    .onAppear {
      if viewModel.currentPage >= viewModel.pageCount {
        viewModel.currentPage = 0
      }
      onRefresh()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        .debounce(for: .milliseconds(250), scheduler: RunLoop.main)
    ) { _ in
      onRefresh()
    }
    .onChange(of: viewModel.refreshSequence) { _ in
      pendingGlobalSkillInstall = false
      prunePendingIntegrationActions()
      if shouldDismissPermissionGuide(
        activePermissionKey: activePermissionGuideKey,
        permissions: viewModel.permissionStatuses
      ) {
        activePermissionGuideKey = nil
        onDismissPermissionGuide()
      }
    }
    .onChange(of: viewModel.currentPage) { page in
      guard rootPage(for: page) != .permissions else {
        return
      }
      activePermissionGuideKey = nil
      onDismissPermissionGuide()
    }
    .onChange(of: platformRefreshSignature) { _ in
      pendingIntegrationActionIDs.removeAll()
      pendingRemovedIntegrationIDs.removeAll()
    }
    .sheet(item: $addAccountPrompt) { prompt in
      AddAccountSheet(
        platform: prompt.platform,
        platformTitle: prompt.platformTitle,
        suggestedAccountKey: prompt.suggestedAccountKey,
        onCancel: { addAccountPrompt = nil },
        onConnect: { accountKey in
          addAccountPrompt = nil
          onConnectIntegration(prompt.platform, accountKey)
        }
      )
    }
    .alert(item: $removalPrompt) { prompt in
      Alert(
        title: Text("Remove \(prompt.accountTitle)?"),
        message: Text("This deletes the saved \(prompt.platformTitle) connection from this Mac."),
        primaryButton: .destructive(Text("Remove")) {
          pendingIntegrationActionIDs.insert(prompt.id)
          pendingRemovedIntegrationIDs.insert(prompt.id)
          onRemoveIntegration(prompt.platform, prompt.accountKey)
        },
        secondaryButton: .cancel()
      )
    }
  }

  private func prunePendingIntegrationActions() {
    let activePendingIDs = Set(
      viewModel.platformConfigurations.flatMap { configuration in
        visibleKnownAccounts(for: configuration).compactMap { integration in
          integration.authState == "requested" || integration.authState == "in_progress"
            ? integration.id
            : nil
        }
      }
    )
    pendingIntegrationActionIDs.formIntersection(activePendingIDs)
  }

  private var platformRefreshSignature: [String] {
    viewModel.platformConfigurations.flatMap { configuration in
      configuration.knownAccounts.map { integration in
        "\(integration.id):\(integration.authState):\(integration.enabled)"
      }
    }
  }

  @ViewBuilder
  private func page(for pageIndex: Int) -> some View {
    switch rootPage(for: pageIndex) {
    case .welcome:
      welcomePage
    case .permissions:
      permissionsPage
    case .platforms:
      platformsPage
    case .automaticBugfixing:
      automaticBugfixingPage
    case .useCases:
      useCasesPage
    case .application:
      applicationPage
    }
  }

  private var navigationFooter: some View {
    HStack(spacing: 20) {
      ZStack(alignment: .leading) {
        Button(action: {}, label: {
          Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
        })
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .secondary,
            size: .icon
          )
        )
        .opacity(0)
        .disabled(true)

        if viewModel.canGoBack {
          Button {
            withAnimation {
              viewModel.currentPage = max(0, viewModel.currentPage - 1)
            }
          } label: {
            Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
          }
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .icon
            )
          )
          .foregroundStyle(.secondary)
          .opacity(0.8)
          .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
      }
      .frame(minWidth: 80, alignment: .leading)

      Spacer()

      VStack(spacing: 8) {
        Text(viewModel.currentPageTitle)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)

        HStack(spacing: 7) {
          ForEach(0..<viewModel.pageCount, id: \.self) { index in
            Button {
              withAnimation {
                viewModel.currentPage = index
              }
            } label: {
              Capsule(style: .continuous)
                .fill(index == viewModel.currentPage ? Color.accentColor : Color.gray.opacity(0.28))
                .frame(width: index == viewModel.currentPage ? 18 : 7, height: 7)
            }
            .buttonStyle(.plain)
            .help(rootPage(for: index).title)
          }
        }
      }

      Spacer()

      Button(action: handleNext) {
        Text(viewModel.buttonTitle)
      }
      .keyboardShortcut(.return)
      .buttonStyle(
        PermissionActionButtonStyle(
          variant: viewModel.buttonTitle == "Skip for now" ? .secondary : .prominent,
          size: .regular
        )
      )
    }
    .padding(.horizontal, 28)
    .padding(.bottom, 13)
    .frame(minHeight: 60, alignment: .bottom)
  }

  private func handleNext() {
    if viewModel.currentPage == viewModel.pageCount - 1 {
      onFinish()
      return
    }
    withAnimation {
      viewModel.currentPage += 1
    }
  }

  private func pageContainer(@ViewBuilder _ content: () -> some View) -> some View {
    ScrollView {
      VStack(spacing: 16) {
        content()
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .top)
      .padding(.top, 24)
      .padding(.bottom, 8)
    }
    .scrollIndicators(.never)
    .padding(.horizontal, 28)
    .frame(width: viewModel.pageWidth, alignment: .top)
  }

  private func card(
    spacing: CGFloat = 12,
    padding: CGFloat = 16,
    @ViewBuilder _ content: () -> some View
  ) -> some View {
    VStack(alignment: .leading, spacing: spacing) {
      content()
    }
    .padding(padding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color(NSColor.controlBackgroundColor))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
    )
  }

  private var welcomePage: some View {
    pageContainer {
      VStack(spacing: 10) {
        Image(systemName: "tray.and.arrow.down.fill")
          .font(.system(size: 34, weight: .semibold))
          .foregroundStyle(Color.accentColor)
          .frame(width: 62, height: 62)
          .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .fill(Color.accentColor.opacity(0.12))
          )

        Text("Welcome to Cued")
          .font(.largeTitle.weight(.semibold))

        Text("Local context for your agents.")
          .font(.body)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 62)

      VStack(spacing: 10) {
        workflowRow(
          icon: "lock.laptopcomputer",
          title: "Grant local access",
          detail: "Contacts and messages stay on this Mac."
        )
        workflowRow(
          icon: "arrow.triangle.2.circlepath",
          title: "Connect sources",
          detail: "Cued indexes into a local database."
        )
        workflowRow(
          icon: "terminal",
          title: "Use with agents",
          detail: "Codex and Claude Code can read the context you choose."
        )
      }
      .padding(.top, 22)
    }
  }

  private var permissionsPage: some View {
    pageContainer {
      Text("Permissions")
        .font(.largeTitle.weight(.semibold))

      Text("Cued needs these permissions to sync your data in the background into a local database.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      HStack(alignment: .top, spacing: 6) {
        Image(systemName: "bolt.badge.automatic.fill")
          .font(.caption)
          .foregroundStyle(.tertiary)
        Text("CLI access and background launch are configured automatically.")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      .padding(.top, 2)

      VStack(spacing: 12) {
        ForEach(viewModel.permissionStatuses) { permission in
          permissionRow(permission)
        }
        skillRow
      }
    }
  }



  private var platformsPage: some View {
    pageContainer {
      Text("Platforms")
        .font(.largeTitle.weight(.semibold))

      Text("Connect sources to sync. Large message histories can take some time.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      card {
        if viewModel.platformConfigurations.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
              Image(systemName: "sparkle.magnifyingglass")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 26)
              VStack(alignment: .leading, spacing: 4) {
                Text("No platforms are available yet")
                  .font(.headline)
                Text("Platforms appear here as soon as the daemon reports supported integrations for this Mac.")
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            }
          }
        } else {
          ForEach(Array(viewModel.platformConfigurations.enumerated()), id: \.element.id) { index, configuration in
            platformCard(configuration)
            if index < viewModel.platformConfigurations.count - 1 {
              Divider()
            }
          }
        }
      }
    }
  }

  private var automaticBugfixingPage: some View {
    pageContainer {
      Text("Automatic bugfixing")
        .font(.largeTitle.weight(.semibold))

      Text("Experimental. Use at your own risk.")
        .font(.headline)
        .foregroundStyle(.red)

      card(spacing: 14) {
        workflowRow(
          icon: "exclamationmark.triangle.fill",
          title: "Syncs can be brittle",
          detail: "Local context depends on permissions, helpers, and source apps."
        )
        workflowRow(
          icon: "shippingbox.fill",
          title: "Debug Bundle",
          detail: "Collect logs, source state, and a redacted local DB summary."
        )
        workflowRow(
          icon: "arrow.branch",
          title: "Draft PR",
          detail: "Let Codex or Claude Code inspect, patch, test, and propose a branch."
        )
      }

      HStack(spacing: 10) {
        debugAgentChoice(title: "Codex", icon: "chevron.left.forwardslash.chevron.right")
        debugAgentChoice(title: "Claude Code", icon: "sparkles")
      }

      Toggle("I understand this can edit a local branch", isOn: .constant(false))
        .toggleStyle(.checkbox)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      Button("Create draft PR") {}
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .prominent,
            size: .regular
          )
        )
        .disabled(true)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private var useCasesPage: some View {
    pageContainer {
      Text("Use cases")
        .font(.largeTitle.weight(.semibold))

      Text("Choose where Cued context should show up.")
        .font(.body)
        .foregroundStyle(.secondary)

      LazyVGrid(
        columns: [
          GridItem(.flexible(), spacing: 12),
          GridItem(.flexible(), spacing: 12),
        ],
        spacing: 12
      ) {
        useCaseTile(icon: "terminal", title: "Open in Codex", detail: "Debug sync or query context.")
        useCaseTile(icon: "sparkles", title: "Open in Claude Code", detail: "Investigate repo issues locally.")
        useCaseTile(icon: "command", title: "Use from CLI", detail: "Run focused local queries.")
        useCaseTile(icon: "clock.arrow.circlepath", title: "Follow-up queue", detail: "Find stale or unanswered threads.")
      }
      .padding(.top, 10)
    }
  }

  private var applicationPage: some View {
    pageContainer {
      Text("Cued Application")
        .font(.largeTitle.weight(.semibold))

      Text("Your local sync and relationship context surface.")
        .font(.body)
        .foregroundStyle(.secondary)

      card(spacing: 14) {
        appSummaryRow(
          label: "Local DB",
          value: localDatabaseSummary,
          status: "Ready"
        )
        Divider()
        appSummaryRow(
          label: "Sources",
          value: sourceSummary,
          status: "\(connectedPlatformCount)/\(max(viewModel.platformConfigurations.count, 1))"
        )
        Divider()
        appSummaryRow(
          label: "Sync Health",
          value: syncHealthSummary,
          status: syncHealthStatus
        )
      }

      card(spacing: 10) {
        Text("Relationship context")
          .font(.headline)
        Text("Recent people, stale threads, unanswered messages, and agent-ready context will live here after setup.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func workflowRow(icon: String, title: String, detail: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.secondary)
        .frame(width: 40, height: 40)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(NSColor.controlBackgroundColor))
        )

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.headline)
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground(cornerRadius: 14))
  }

  private func debugAgentChoice(title: String, icon: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(title)
        .font(.subheadline.weight(.semibold))
      Spacer(minLength: 0)
      Circle()
        .strokeBorder(Color(NSColor.separatorColor), lineWidth: 1)
        .frame(width: 16, height: 16)
    }
    .padding(14)
    .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
    .background(rowBackground(cornerRadius: 14))
  }

  private func useCaseTile(icon: String, title: String, detail: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(.secondary)
        .frame(width: 28, height: 28, alignment: .leading)

      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline)
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 146, alignment: .topLeading)
    .background(rowBackground(cornerRadius: 14))
  }

  private func appSummaryRow(label: String, value: String, status: String) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(label)
          .font(.headline)
        Text(value)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      Text(status)
        .font(.caption.weight(.semibold))
        .fontDesign(.monospaced)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
          Capsule(style: .continuous)
            .fill(Color(NSColor.controlBackgroundColor))
        )
    }
  }

  private var connectedPlatformCount: Int {
    viewModel.platformConfigurations.filter(isPlatformComplete).count
  }

  private var sourceSummary: String {
    if viewModel.platformConfigurations.isEmpty {
      return "Sources appear after the daemon reports supported integrations."
    }
    return "Connected, pending, and paused source state in one place."
  }

  private var syncHealthStatus: String {
    connectedPlatformCount > 0 ? "OK" : "Setup"
  }

  private var syncHealthSummary: String {
    connectedPlatformCount > 0
      ? "Recent runs, retries, throttling, and source errors will be summarized here."
      : "Complete access and sources before sync health becomes useful."
  }

  private var localDatabaseSummary: String {
    "~/.cued/local.db"
  }

  private func permissionRow(_ permission: PermissionStatus) -> some View {
    let descriptor = permissionDescriptor(for: permission.key)
    let isGranted = permission.status == "granted"

    return HStack(spacing: 14) {
      statusIcon(
        systemImage: descriptor.systemImage,
        tint: descriptor.accentColor
      )

      VStack(alignment: .leading, spacing: 3) {
        Text(descriptor.title)
          .font(.headline)
          .foregroundStyle(.primary)
        Text(descriptor.subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if isGranted {
        Image(systemName: "checkmark.circle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(.green)
          .accessibilityLabel("\(descriptor.title) access granted")
      } else {
        Button("Allow") {
          handlePermissionAction(for: permission, descriptor: descriptor)
        }
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .prominent,
            size: .compact
          )
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground())
  }

  private var skillRow: some View {
    let isInstalled = viewModel.globalSkillStatus.installed

    return HStack(spacing: 14) {
      statusIcon(
        systemImage: "terminal",
        tint: Color(red: 0.12, green: 0.76, blue: 0.29)
      )

      VStack(alignment: .leading, spacing: 3) {
        Text("Cued skill")
          .font(.headline)
          .foregroundStyle(.primary)
        Text(viewModel.globalSkillStatus.summary)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if isInstalled {
        Image(systemName: "checkmark.circle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(.green)
          .accessibilityLabel("Cued skill installed")
      } else if pendingGlobalSkillInstall {
        ProgressView()
          .controlSize(.small)
          .frame(minWidth: 76)
      } else {
        Button("Install") {
          pendingGlobalSkillInstall = true
          onInstallGlobalSkill()
        }
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .secondary,
            size: .compact
          )
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground())
  }

  private func handlePermissionAction(
    for permission: PermissionStatus,
    descriptor: PermissionDescriptor
  ) {
    switch permissionAction(for: permission, descriptor: descriptor) {
    case .requestPrompt:
      onRequestPermission(permission.requestFlags)
    case .guideInSettings:
      showPermissionGuide(for: permission.key)
    case .none:
      return
    }
  }

  private func showPermissionGuide(for permissionKey: String) {
    activePermissionGuideKey = permissionKey
    onGuidePermission(permissionKey)
  }

  private func statusIcon(
    systemImage: String,
    tint: Color
  ) -> some View {
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [
              tint.opacity(0.98),
              tint.opacity(0.78),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      Circle()
        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.75)

      Image(systemName: systemImage)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
    }
    .frame(width: 40, height: 40)
  }

  private func rowBackground(cornerRadius: CGFloat = 20) -> some View {
    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      .fill(Color(NSColor.controlBackgroundColor))
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(Color(NSColor.separatorColor).opacity(0.32), lineWidth: 1)
      )
  }

  private func platformCard(_ configuration: PlatformConfig) -> some View {
    let isFullyConnected = isPlatformComplete(configuration)
    let shouldShowAccountControls = showsAccountRows(for: configuration)
    let shouldDimCard = isFullyConnected && !shouldShowAccountControls

    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        PlatformIcon(platform: configuration.platform)

        VStack(alignment: .leading, spacing: 5) {
          Text(configuration.title)
            .font(.headline)
            .foregroundStyle(isFullyConnected ? .secondary : .primary)
          Text(platformDescription(for: configuration))
            .font(.subheadline)
            .foregroundStyle(isFullyConnected ? .tertiary : .secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 12)

        if isFullyConnected {
          Image(systemName: "checkmark.circle.fill")
            .font(.title3.weight(.semibold))
            .foregroundStyle(.green)
            .accessibilityLabel("\(configuration.title) connected")
        } else if !shouldShowAccountControls && visibleKnownAccounts(for: configuration).contains(where: {
          pendingIntegrationActionIDs.contains($0.id)
        }) {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 10)
        } else if !shouldShowAccountControls, let action = platformLevelAction(for: configuration) {
          actionButton(title: action.title, action: action.handler)
        }
      }

      if shouldShowAccountControls {
        if configuration.supportsMultipleAccounts {
          multiAccountRows(configuration)
        } else if let integration = configuration.accounts.first ?? configuration.placeholder {
          accountRow(configuration, integration: integration)
        }
      }
    }
    .padding(.vertical, 2)
    .opacity(shouldDimCard ? 0.7 : 1.0)
  }

  private func showsAccountRows(for configuration: PlatformConfig) -> Bool {
    if configuration.supportsMultipleAccounts {
      return !visibleAccounts(for: configuration).isEmpty
    }

    guard let integration = visibleAccounts(for: configuration).first else {
      return false
    }

    if isConnectedAuthState(integration.authState) {
      return true
    }

    return integration.authState == "requested"
      || integration.authState == "in_progress"
      || integration.authState == "blocked"
      || integration.authState == "check_failed"
  }

  private func visibleAccounts(for configuration: PlatformConfig) -> [IntegrationStatus] {
    configuration.accounts.filter { !pendingRemovedIntegrationIDs.contains($0.id) }
  }

  private func visibleKnownAccounts(for configuration: PlatformConfig) -> [IntegrationStatus] {
    let accounts = visibleAccounts(for: configuration)
    if accounts.isEmpty, let placeholder = configuration.placeholder,
       !pendingRemovedIntegrationIDs.contains(placeholder.id) {
      return [placeholder]
    }
    return accounts
  }

  private func multiAccountRows(_ configuration: PlatformConfig) -> some View {
    let accounts = visibleAccounts(for: configuration)
    return VStack(alignment: .leading, spacing: 10) {
      if !accounts.isEmpty {
        ForEach(Array(accounts.enumerated()), id: \.element.id) { index, integration in
          accountRow(configuration, integration: integration)
          if index < accounts.count - 1 {
            Divider()
          }
        }
      }

      if let action = platformLevelAction(for: configuration) {
        HStack {
          Spacer(minLength: 0)
          actionButton(title: action.title, prominent: false, action: action.handler)
        }
      }
    }
  }

  private func accountRow(
    _ configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> some View {
    let action = primaryAccountAction(for: configuration, integration: integration)
    let removeAccountAction = removeAccountAction(for: configuration, integration: integration)
    let isPending = pendingIntegrationActionIDs.contains(integration.id)

    return HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(accountTitle(for: configuration, integration: integration))
          .font(.subheadline.weight(.semibold))
        Text(accountDetail(for: configuration, integration: integration))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      if isPending {
        pendingIndicator()
          .padding(.top, 3)
      }
      if let removeAccountAction {
        actionButton(title: removeAccountAction.title, action: removeAccountAction.handler)
      }
      if let action {
        actionButton(title: action.title, action: action.handler)
      }
    }
    .padding(.leading, 40)
  }

  private func actionButton(
    title: String,
    prominent: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Group {
      if prominent {
        Button(title, action: action)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .prominent,
              size: .regular
            )
          )
      } else {
        Button(title, action: action)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .regular
            )
          )
      }
    }
  }

  private func pendingIndicator() -> some View {
    ProgressView()
      .controlSize(.small)
      .frame(width: 24, height: 24, alignment: .center)
  }

  private func primaryAccountAction(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Fix permissions",
        {
          withAnimation {
            viewModel.currentPage = RootPage.permissions.rawValue
          }
        }
      )
    }
    guard configuration.isRequestable else {
      return nil
    }

    let isConnected = isConnectedAuthState(integration.authState)
    if !integration.enabled && isConnected {
      return (
        "Turn on",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          onEnableIntegration(configuration.platform, integration.accountKey)
        }
      )
    }
    if isConnected {
      return nil
    }
    if integration.authState == "requested" || integration.authState == "in_progress" {
      return nil
    }

    let title =
      integration.authState == "failed"
        || needsAuthAttention(configuration.platform, authState: integration.authState)
        ? "Connect again"
        : "Connect"
    return (
      title,
      {
        pendingIntegrationActionIDs.insert(integration.id)
        onConnectIntegration(configuration.platform, integration.accountKey)
      }
    )
  }

  private func removeAccountAction(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    guard configuration.accounts.contains(where: {
      $0.platform == integration.platform && $0.accountKey == integration.accountKey
    }) else {
      return nil
    }

    guard configuration.isRequestable else {
      return nil
    }

    if integration.authState == "requested" || integration.authState == "in_progress" {
      return (
        "Cancel",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          pendingRemovedIntegrationIDs.insert(integration.id)
          onRemoveIntegration(configuration.platform, integration.accountKey)
        }
      )
    }

    return (
      "Remove",
      {
        removalPrompt = RemovalPrompt(
          platform: configuration.platform,
          platformTitle: configuration.title,
          accountKey: integration.accountKey,
          accountTitle: accountTitle(for: configuration, integration: integration)
        )
      }
    )
  }

  private func platformLevelAction(
    for configuration: PlatformConfig
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Fix permissions",
        {
          withAnimation {
            viewModel.currentPage = RootPage.permissions.rawValue
          }
        }
      )
    }
    guard configuration.isConnectable else {
      return nil
    }

    if configuration.supportsMultipleAccounts {
      let noun = accountNoun(for: configuration.platform)
      let title = visibleAccounts(for: configuration).isEmpty && supportsAutomaticAccountDiscovery(configuration.platform)
        ? "Connect"
        : "Add \(noun)"
      return (
        title,
        {
          if supportsAutomaticAccountDiscovery(configuration.platform) {
            onConnectIntegration(
              configuration.platform,
              viewModel.suggestedAccountKey(for: configuration.platform)
            )
          } else {
            addAccountPrompt = AddAccountPrompt(
              platform: configuration.platform,
              platformTitle: configuration.title,
              suggestedAccountKey: viewModel.suggestedAccountKey(for: configuration.platform)
            )
          }
        }
      )
    }

    if let integration = configuration.placeholder ?? configuration.accounts.first {
      let isConnected = isConnectedAuthState(integration.authState)
      if !integration.enabled && isConnected {
        return (
          "Turn on",
          {
            pendingIntegrationActionIDs.insert(integration.id)
            onEnableIntegration(configuration.platform, integration.accountKey)
          }
        )
      }
      return (
        isConnected ? "Connect again" : "Connect",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          onConnectIntegration(configuration.platform, integration.accountKey)
        }
      )
    }

    return nil
  }

  private func accountTitle(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> String {
    if hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
    }

    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      return title
    }
    if !hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      return integration.accountKey
    }
    return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
  }

  private func accountDetail(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> String {
    var parts = [readableAuthState(configuration.platform, integration.authState)]
    if let dataSummary = dataSummary(integration) {
      parts.append(dataSummary)
    }
    if !integration.enabled && isConnectedAuthState(integration.authState) {
      parts.append("turned off")
    }
    if normalizedTitle(accountTitle(for: configuration, integration: integration))
      != normalizedTitle(integration.accountKey),
       !hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      parts.append(integration.accountKey)
    }
    return parts.joined(separator: " • ")
  }

  private func dataSummary(_ integration: IntegrationStatus) -> String? {
    guard let stats = integration.projectionStats else {
      return nil
    }
    if !isConnectedAuthState(integration.authState) && integration.platform != "whatsapp" {
      return nil
    }

    if stats.projectedMessages > 0 {
      return "\(formatCount(stats.projectedMessages)) messages indexed"
    }
    if stats.projectedContacts > 0 {
      return "\(formatCount(stats.projectedContacts)) contacts indexed"
    }

    let projectedItems =
      stats.projectedContacts + stats.projectedConversations + stats.projectedMessages
    if stats.rawEvents > 0 && projectedItems == 0 {
      return "\(formatCount(stats.rawEvents)) items captured, indexing"
    }
    return nil
  }

  private func isPlatformComplete(_ configuration: PlatformConfig) -> Bool {
    if configuration.platform == "phone_calls" {
      return true
    }
    let accounts = visibleAccounts(for: configuration)
    if accounts.isEmpty {
      return false
    }
    return accounts.allSatisfy { showsCompletionCheckmark(for: configuration, integration: $0) }
  }
}

public struct PlatformIcon: View {
  let platform: String

  public init(platform: String) {
    self.platform = platform
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(
          LinearGradient(
            colors: backgroundColors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.75)

      if let image = platformImage() {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .antialiased(true)
          .aspectRatio(contentMode: .fit)
          .padding(logoPadding)
      } else {
        fallbackIcon
      }
    }
    .frame(width: 40, height: 40)
  }

  private func platformImage() -> NSImage? {
    guard let assetName = platformIconAssetName(for: platform),
          let url = platformIconURL(named: assetName),
          let image = NSImage(contentsOf: url) else { return nil }
    return image
  }

  private var accentColor: Color {
    platformAccentColor(for: platform)
  }

  private var backgroundColors: [Color] {
    if platform == "gmail" {
      return [
        Color.white.opacity(0.98),
        Color(red: 0.94, green: 0.95, blue: 0.97),
      ]
    }
    return [
      accentColor.opacity(0.98),
      accentColor.opacity(0.78),
    ]
  }

  private var logoPadding: CGFloat {
    switch platform {
    case "slack":
      9
    case "gmail":
      6
    case "linkedin":
      5
    case "discord", "signal", "whatsapp":
      7
    default:
      7
    }
  }

  @ViewBuilder
  private var fallbackIcon: some View {
    switch platform {
    case "contacts":
      Image(systemName: "person.crop.circle.fill")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white.opacity(0.96))
    case "phone_calls":
      Image(systemName: "phone.fill")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(.white)
    case "imessage":
      Image(systemName: "message.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
    case "gmail":
      Image(systemName: "envelope.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96))
    case "slack":
      Image(systemName: "number")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(.white)
    case "linkedin":
      Text("in")
        .font(.system(size: 14, weight: .black, design: .rounded))
        .foregroundStyle(.white)
        .offset(y: 0.5)
    case "signal":
      ZStack {
        ZStack {
          Circle()
            .fill(.white.opacity(0.96))
            .frame(width: 12, height: 12)
          Circle()
            .fill(accentColor)
            .frame(width: 3, height: 3)
        }
      }
    case "whatsapp":
      Image(systemName: "phone.fill")
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(.white)
    default:
      Image(systemName: "link.circle.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
    }
  }
}

private struct AddAccountSheet: View {
  let platform: String
  let platformTitle: String
  let suggestedAccountKey: String
  let onCancel: () -> Void
  let onConnect: (String) -> Void

  @State private var accountKey: String

  init(
    platform: String,
    platformTitle: String,
    suggestedAccountKey: String,
    onCancel: @escaping () -> Void,
    onConnect: @escaping (String) -> Void
  ) {
    self.platform = platform
    self.platformTitle = platformTitle
    self.suggestedAccountKey = suggestedAccountKey
    self.onCancel = onCancel
    self.onConnect = onConnect
    _accountKey = State(initialValue: suggestedAccountKey)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Add \(platformTitle) \(accountNoun(for: platform))")
        .font(.title2.weight(.semibold))

      Text("Choose a stable account key. For Slack, a workspace slug or team ID works well.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: 6) {
        Text("Account key")
          .font(.subheadline.weight(.medium))
        TextField("Account key", text: $accountKey)
          .textFieldStyle(.roundedBorder)
      }

      HStack {
        Spacer(minLength: 0)
        Button("Cancel", action: onCancel)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .regular
            )
          )
        Button("Connect") {
          let trimmed = accountKey.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else {
            return
          }
          onConnect(trimmed)
        }
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .prominent,
            size: .regular
          )
        )
        .disabled(accountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(width: 420)
  }
}

private let permissionOrder = [
  "contacts",
  "full_disk_access",
  "messages_automation",
]

private let defaultPermissionOrder = [
  "contacts",
  "full_disk_access",
]

private let platformOrder = [
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

private func defaultPermissionStatuses() -> [PermissionStatus] {
  defaultPermissionOrder.compactMap { defaultPermissionStatus(for: $0) }
}

private func defaultSkillStatus() -> SkillStatus {
  SkillStatus(
    installed: false,
    status: "unknown",
    summary: "Checks whether the global Cued skill is available to your agents."
  )
}

private func defaultPermissionStatus(
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

private func platformIconAssetName(for platform: String) -> String? {
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

private func platformAccentColor(for platform: String) -> Color {
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
  default:
    return .accentColor
  }
}

private func platformIconURL(named assetName: String) -> URL? {
  let bundles: [Bundle] = [
    Bundle.module,
    Bundle(url: Bundle.main.bundleURL.appendingPathComponent("CuedNative_Interface.bundle")),
    Bundle.main.resourceURL.flatMap { Bundle(url: $0.appendingPathComponent("CuedNative_Interface.bundle")) },
    Bundle(for: BundleAnchor.self),
    Bundle.main,
  ].compactMap { $0 }
  for bundle in bundles {
    if let url = bundle.url(forResource: assetName, withExtension: "svg") {
      return url
    }
    if let url = bundle.url(forResource: assetName, withExtension: "png") {
      return url
    }
  }
  return nil
}

private func fallbackIntegration(for platform: String) -> IntegrationStatus {
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

private func effectiveCapability(
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

private func permissionKey(for platform: String) -> String? {
  switch platform {
  case "contacts":
    return "contacts"
  case "imessage":
    return "full_disk_access"
  default:
    return nil
  }
}

private func showsCompletionCheckmark(
  for configuration: PlatformConfig,
  integration: IntegrationStatus
) -> Bool {
  if !configuration.isRequestable {
    return configuration.capability.availability == "available"
  }
  return integration.enabled && isConnectedAuthState(integration.authState)
}

private func platformDescription(for configuration: PlatformConfig) -> String {
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

private func isConnectedAuthState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

private func readableAuthState(_ platform: String, _ value: String) -> String {
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

private func usesQRLink(_ platform: String) -> Bool {
  platform == "signal" || platform == "whatsapp"
}

private func needsAuthAttention(_ platform: String, authState: String) -> Bool {
  if usesQRLink(platform) {
    return false
  }
  return authState == "blocked" || authState == "check_failed"
}

private func formatCount(_ value: Int) -> String {
  let formatter = NumberFormatter()
  formatter.numberStyle = .decimal
  return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

private func platformTitle(_ platform: String, fallback: String?) -> String {
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
  default:
    if let fallback = fallback?.trimmingCharacters(in: .whitespacesAndNewlines), !fallback.isEmpty {
      return fallback
    }
    return platform.capitalized
  }
}

private func accountNoun(for platform: String) -> String {
  platform == "slack" ? "workspace" : "account"
}

private func supportsAutomaticAccountDiscovery(_ platform: String) -> Bool {
  platform == "gmail" || platform == "slack"
}

private func hidesAccountKey(platform: String, accountKey: String) -> Bool {
  if supportsAutomaticAccountDiscovery(platform)
    && (accountKey.hasPrefix("pending-slack-") || accountKey.hasPrefix("pending-gmail-")) {
    return true
  }
  if !supportsMultipleAccounts(platform) && accountKey == "default" {
    return true
  }
  return false
}

private func normalizedTitle(_ value: String?) -> String {
  value?.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase ?? ""
}

private func fallbackAccountTitle(for platform: String, authState: String) -> String {
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

private func pendingAccountKey(
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

private func supportsMultipleAccounts(_ platform: String) -> Bool {
  platform == "gmail" || platform == "slack"
}

private func isRequestablePlatform(_ platform: String) -> Bool {
  switch platform {
  case "discord", "gmail", "linkedin", "signal", "slack", "whatsapp":
    return true
  default:
    return false
  }
}

private func sortIntegrations(
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

#if DEBUG
@MainActor
private func previewModel(
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
    allIntegrations: allIntegrations,
    integrations: setupIntegrations
  )
  return viewModel
}

private func previewCapability(
  availability: String = "available"
) -> CapabilityStatus {
  CapabilityStatus(availability: availability, setupVisible: true)
}

private func previewIntegration(
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

private struct RootPreview: View {
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
