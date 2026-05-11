import AppKit
import Combine
import SwiftUI

private final class BundleAnchor {}

public struct InstallerCapabilityStatus: Decodable, Sendable {
  public let availability: String
  public let onboardingVisible: Bool
  public let reason: String?

  public init(availability: String, onboardingVisible: Bool, reason: String?) {
    self.availability = availability
    self.onboardingVisible = onboardingVisible
    self.reason = reason
  }
}

public struct InstallerIntegrationStatus: Decodable, Identifiable, Sendable {
  public let platform: String
  public let accountKey: String
  public let displayName: String?
  public let authState: String
  public let enabled: Bool
  public let capability: InstallerCapabilityStatus

  public var id: String { "\(platform):\(accountKey)" }

  public init(
    platform: String,
    accountKey: String,
    displayName: String?,
    authState: String,
    enabled: Bool,
    capability: InstallerCapabilityStatus
  ) {
    self.platform = platform
    self.accountKey = accountKey
    self.displayName = displayName
    self.authState = authState
    self.enabled = enabled
    self.capability = capability
  }
}

public struct InstallerIntegrationStatusResponse: Decodable, Sendable {
  public let hostOs: String
  public let integrations: [InstallerIntegrationStatus]?
  public let setupIntegrations: [InstallerIntegrationStatus]

  public init(
    hostOs: String,
    integrations: [InstallerIntegrationStatus]?,
    setupIntegrations: [InstallerIntegrationStatus]
  ) {
    self.hostOs = hostOs
    self.integrations = integrations
    self.setupIntegrations = setupIntegrations
  }
}

public struct InstallerPermissionStatus: Decodable, Identifiable, Sendable {
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

public struct InstallerPermissionStatusResponse: Decodable, Sendable {
  public let permissions: [InstallerPermissionStatus]

  public init(permissions: [InstallerPermissionStatus]) {
    self.permissions = permissions
  }
}

func onboardingShouldDismissPermissionGuide(
  activePermissionKey: String?,
  permissions: [InstallerPermissionStatus]
) -> Bool {
  guard let activePermissionKey else {
    return false
  }

  guard let status = permissions.first(where: { $0.key == activePermissionKey })?.status else {
    return true
  }

  return status == "granted"
}

public struct InstallerGlobalSkillStatus: Decodable, Sendable {
  public let installed: Bool
  public let status: String
  public let summary: String

  public init(installed: Bool, status: String, summary: String) {
    self.installed = installed
    self.status = status
    self.summary = summary
  }
}

public struct InstallerPlatformConfiguration: Identifiable {
  public let platform: String
  public let title: String
  public let capability: InstallerCapabilityStatus
  public let accounts: [InstallerIntegrationStatus]
  public let placeholder: InstallerIntegrationStatus?
  public let supportsMultipleAccounts: Bool

  public var id: String { platform }

  public var knownAccounts: [InstallerIntegrationStatus] {
    if accounts.isEmpty, let placeholder {
      return [placeholder]
    }
    return accounts
  }

  public var connectedAccountCount: Int {
    accounts.filter { $0.enabled && installerIsConnectedIntegrationState($0.authState) }.count
  }

  public var hasBlockingState: Bool {
    knownAccounts.contains { $0.authState == "blocked" || $0.authState == "check_failed" }
  }

  public var hasInProgressState: Bool {
    knownAccounts.contains { $0.authState == "requested" || $0.authState == "in_progress" }
  }

  public var hasDisabledConnectedAccount: Bool {
    knownAccounts.contains { !$0.enabled && installerIsConnectedIntegrationState($0.authState) }
  }

  public var isRequestable: Bool {
    installerIsRequestablePlatform(platform)
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
    capability: InstallerCapabilityStatus,
    accounts: [InstallerIntegrationStatus],
    placeholder: InstallerIntegrationStatus?,
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

public struct InstallerAddAccountPrompt: Identifiable {
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

public struct InstallerRemovalPrompt: Identifiable {
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
public final class OnboardingViewModel: ObservableObject {
  public static let windowWidth: CGFloat = 630
  public static let windowHeight: CGFloat = 752

  @Published public var currentPage = 0
  @Published public var isRefreshing = false
  @Published public var platformConfigurations: [InstallerPlatformConfiguration] = []
  @Published public var permissionStatuses: [InstallerPermissionStatus] = installerDefaultPermissionStatuses()
  @Published public var globalSkillStatus = installerDefaultGlobalSkillStatus()
  @Published public private(set) var refreshSequence = 0

  public let pageWidth: CGFloat = OnboardingViewModel.windowWidth

  public var pageCount: Int { 2 }

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
    if currentPage == 0 && !allPermissionsGranted {
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
    permissions: [InstallerPermissionStatus],
    globalSkill: InstallerGlobalSkillStatus,
    allIntegrations: [InstallerIntegrationStatus],
    integrations: [InstallerIntegrationStatus]
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

  public func configuration(for platform: String) -> InstallerPlatformConfiguration? {
    platformConfigurations.first { $0.platform == platform }
  }

  public func suggestedAccountKey(for platform: String) -> String {
    if installerSupportsAutomaticAccountDiscovery(platform) {
      return installerGeneratedPendingAccountKey(
        for: platform,
        existing: Set(configuration(for: platform)?.accounts.map(\.accountKey) ?? [])
      )
    }

    let existing = Set(configuration(for: platform)?.accounts.map(\.accountKey) ?? [])
    if !existing.contains("default") {
      return "default"
    }

    let base = installerAccountNoun(for: platform)
    var index = 2
    var candidate = "\(base)-\(index)"
    while existing.contains(candidate) {
      index += 1
      candidate = "\(base)-\(index)"
    }
    return candidate
  }

  private func buildPermissionStatuses(
    _ permissions: [InstallerPermissionStatus]
  ) -> [InstallerPermissionStatus] {
    let byKey = Dictionary(uniqueKeysWithValues: permissions.map { ($0.key, $0) })
    return installerPermissionOrder.compactMap { key in
      byKey[key] ?? installerDefaultPermissionStatus(for: key)
    }
  }

  private func buildPlatformConfigurations(
    permissions: [InstallerPermissionStatus],
    allIntegrations: [InstallerIntegrationStatus],
    setupIntegrations: [InstallerIntegrationStatus]
  ) -> [InstallerPlatformConfiguration] {
    let visibleSetup = setupIntegrations.filter { $0.capability.onboardingVisible }
    let visibleAll = allIntegrations.filter { $0.capability.onboardingVisible }
    let actualByPlatform = Dictionary(grouping: visibleAll, by: \.platform)
    let setupByPlatform = Dictionary(grouping: visibleSetup, by: \.platform)
    let permissionsByKey = Dictionary(uniqueKeysWithValues: permissions.map { ($0.key, $0) })
    var configurations = [InstallerPlatformConfiguration]()

    for platform in installerPlatformOrder {
      let setupIntegration = (setupByPlatform[platform] ?? []).sorted(by: installerSortIntegrations).first
        ?? installerFallbackIntegration(for: platform)

      let accounts = (actualByPlatform[platform] ?? []).sorted(by: installerSortIntegrations)
      let placeholder = accounts.isEmpty
        ? ((setupByPlatform[platform] ?? []).sorted(by: installerSortIntegrations).first
          ?? installerFallbackIntegration(for: platform))
        : nil
      let base = accounts.first ?? placeholder ?? setupIntegration
      let capability = installerCapabilityForOnboarding(
        platform: platform,
        base: base.capability,
        permissionsByKey: permissionsByKey
      )

      configurations.append(
        InstallerPlatformConfiguration(
          platform: platform,
          title: installerPlatformTitle(platform, fallback: base.displayName),
          capability: capability,
          accounts: accounts,
          placeholder: placeholder,
          supportsMultipleAccounts: installerSupportsMultipleAccounts(platform)
        )
      )
    }

    return configurations
  }
}

public struct CuedOnboardingView: View {
  @ObservedObject var viewModel: OnboardingViewModel

  let onRefresh: () -> Void
  let onGuidePermission: (String) -> Void
  let onDismissPermissionGuide: () -> Void
  let onRequestPermission: ([String]) -> Void
  let onInstallGlobalSkill: () -> Void
  let onEnableIntegration: (String, String) -> Void
  let onRemoveIntegration: (String, String) -> Void
  let onConnectIntegration: (String, String) -> Void
  let onFinish: () -> Void

  @State private var addAccountPrompt: InstallerAddAccountPrompt?
  @State private var removalPrompt: InstallerRemovalPrompt?
  @State private var pendingGlobalSkillInstall = false
  @State private var pendingIntegrationActionIDs = Set<String>()
  @State private var pendingPlatformConnectPlatforms = Set<String>()
  @State private var activePermissionGuideKey: String?

  public init(
    viewModel: OnboardingViewModel,
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
            pageView(for: pageIndex)
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

      navigationBar
    }
    .frame(width: viewModel.pageWidth, height: OnboardingViewModel.windowHeight)
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
      if onboardingShouldDismissPermissionGuide(
        activePermissionKey: activePermissionGuideKey,
        permissions: viewModel.permissionStatuses
      ) {
        activePermissionGuideKey = nil
        onDismissPermissionGuide()
      }
    }
    .onChange(of: viewModel.currentPage) { page in
      guard page != 0 else {
        return
      }
      activePermissionGuideKey = nil
      onDismissPermissionGuide()
    }
    .onChange(of: platformRefreshSignature) { _ in
      pendingIntegrationActionIDs.removeAll()
      pendingPlatformConnectPlatforms.removeAll()
    }
    .sheet(item: $addAccountPrompt) { prompt in
      InstallerAddAccountSheet(
        platformTitle: prompt.platformTitle,
        suggestedAccountKey: prompt.suggestedAccountKey,
        onCancel: { addAccountPrompt = nil },
        onConnect: { accountKey in
          addAccountPrompt = nil
          pendingPlatformConnectPlatforms.insert(prompt.platform)
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
          onRemoveIntegration(prompt.platform, prompt.accountKey)
        },
        secondaryButton: .cancel()
      )
    }
  }

  private var platformRefreshSignature: [String] {
    viewModel.platformConfigurations.flatMap { configuration in
      configuration.knownAccounts.map { integration in
        "\(integration.id):\(integration.authState):\(integration.enabled)"
      }
    }
  }

  @ViewBuilder
  private func pageView(for pageIndex: Int) -> some View {
    switch pageIndex {
    case 0:
      permissionsPage
    case 1:
      platformsPage
    default:
      EmptyView()
    }
  }

  private var navigationBar: some View {
    HStack(spacing: 20) {
      ZStack(alignment: .leading) {
        Button(action: {}, label: {
          Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
        })
        .buttonStyle(
          InstallerPermissionActionButtonStyle(
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
            InstallerPermissionActionButtonStyle(
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

      HStack(spacing: 8) {
        ForEach(0..<viewModel.pageCount, id: \.self) { index in
          Button {
            withAnimation {
              viewModel.currentPage = index
            }
          } label: {
            Circle()
              .fill(index == viewModel.currentPage ? Color.accentColor : Color.gray.opacity(0.3))
              .frame(width: 8, height: 8)
          }
          .buttonStyle(.plain)
        }
      }

      Spacer()

      Button(action: handleNext) {
        Text(viewModel.buttonTitle)
      }
      .keyboardShortcut(.return)
      .buttonStyle(
        InstallerPermissionActionButtonStyle(
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

  private func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
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

  private func onboardingCard(
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

  private var permissionsPage: some View {
    onboardingPage {
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
        globalSkillRow
      }
    }
  }



  private var platformsPage: some View {
    onboardingPage {
      Text("Platforms")
        .font(.largeTitle.weight(.semibold))

      Text("Connect sources to sync. Large message histories can take some time.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      onboardingCard {
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
            platformConfigurationCard(configuration)
            if index < viewModel.platformConfigurations.count - 1 {
              Divider()
            }
          }
        }
      }
    }
  }

  private func permissionRow(_ permission: InstallerPermissionStatus) -> some View {
    let descriptor = installerPermissionDescriptor(for: permission.key)
    let isGranted = permission.status == "granted"

    return HStack(spacing: 14) {
      permissionIconBadge(
        systemImage: descriptor.systemImage,
        tint: descriptor.accentColor,
        isGranted: isGranted
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
          InstallerPermissionActionButtonStyle(
            variant: .prominent,
            size: .compact
          )
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(permissionItemBackground())
  }

  private var globalSkillRow: some View {
    let isInstalled = viewModel.globalSkillStatus.installed

    return HStack(spacing: 14) {
      permissionIconBadge(
        systemImage: "terminal",
        tint: Color(red: 0.12, green: 0.76, blue: 0.29),
        isGranted: isInstalled
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
          InstallerPermissionActionButtonStyle(
            variant: .secondary,
            size: .compact
          )
        )
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(permissionItemBackground())
  }

  private func handlePermissionAction(
    for permission: InstallerPermissionStatus,
    descriptor: InstallerPermissionDescriptor
  ) {
    switch installerPermissionActionKind(for: permission, descriptor: descriptor) {
    case .requestPrompt:
      onRequestPermission(permission.requestFlags)
    case .guideInSettings:
      startPermissionGuideTransition(for: permission.key)
    case .none:
      return
    }
  }

  private func startPermissionGuideTransition(for permissionKey: String) {
    activePermissionGuideKey = permissionKey
    onGuidePermission(permissionKey)
  }

  private func permissionIconBadge(
    systemImage: String,
    tint: Color,
    isGranted _: Bool
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

  private func permissionItemBackground() -> some View {
    RoundedRectangle(cornerRadius: 20, style: .continuous)
      .fill(Color(NSColor.controlBackgroundColor))
      .overlay(
        RoundedRectangle(cornerRadius: 20, style: .continuous)
          .strokeBorder(Color(NSColor.separatorColor).opacity(0.32), lineWidth: 1)
      )
  }

  private func platformConfigurationCard(_ configuration: InstallerPlatformConfiguration) -> some View {
    let isFullyConnected = platformIsFullyConnected(configuration)
    let shouldShowAccountControls = shouldShowAccountRows(for: configuration)
    let shouldDimCard = isFullyConnected && !shouldShowAccountControls

    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        InstallerPlatformIcon(platform: configuration.platform)

        VStack(alignment: .leading, spacing: 5) {
          Text(configuration.title)
            .font(.headline)
            .foregroundStyle(isFullyConnected ? .secondary : .primary)
          Text(platformWalkthrough(for: configuration))
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
        } else if !shouldShowAccountControls && platformIsPending(configuration) {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 10)
        } else if !shouldShowAccountControls, let action = platformLevelAction(for: configuration) {
          actionButton(title: action.title, action: action.handler)
        }
      }

      if shouldShowAccountControls {
        if configuration.supportsMultipleAccounts {
          multiAccountPlatformRows(configuration)
        } else if let integration = configuration.accounts.first ?? configuration.placeholder {
          singleAccountPlatformRow(configuration, integration: integration)
        }
      }
    }
    .padding(.vertical, 2)
    .opacity(shouldDimCard ? 0.7 : 1.0)
  }

  private func shouldShowAccountRows(for configuration: InstallerPlatformConfiguration) -> Bool {
    installerShouldShowAccountRows(for: configuration)
  }

  private func platformIsPending(_ configuration: InstallerPlatformConfiguration) -> Bool {
    if pendingPlatformConnectPlatforms.contains(configuration.platform) {
      return true
    }

    return configuration.knownAccounts.contains { integration in
      pendingIntegrationActionIDs.contains(integration.id)
    }
  }

  private func singleAccountPlatformRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> some View {
    accountSummaryRow(configuration, integration: integration)
  }

  private func multiAccountPlatformRows(_ configuration: InstallerPlatformConfiguration) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !configuration.accounts.isEmpty {
        ForEach(Array(configuration.accounts.enumerated()), id: \.element.id) { index, integration in
          multiAccountRow(configuration, integration: integration)
          if index < configuration.accounts.count - 1 {
            Divider()
          }
        }
      }

      if let action = platformLevelAction(for: configuration) {
        HStack {
          Spacer(minLength: 0)
          if pendingPlatformConnectPlatforms.contains(configuration.platform) {
            ProgressView()
              .controlSize(.small)
          } else {
            actionButton(title: action.title, prominent: false, action: action.handler)
          }
        }
      }
    }
  }

  private func multiAccountRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> some View {
    accountSummaryRow(configuration, integration: integration)
  }

  private func accountSummaryRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> some View {
    let action = accountAction(for: configuration, integration: integration)
    let removeAction = removeAction(for: configuration, integration: integration)
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
        pendingIntegrationIndicator()
          .padding(.top, 3)
      }
      if let removeAction {
        actionButton(title: removeAction.title, action: removeAction.handler)
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
            InstallerPermissionActionButtonStyle(
              variant: .prominent,
              size: .regular
            )
          )
      } else {
        Button(title, action: action)
          .buttonStyle(
            InstallerPermissionActionButtonStyle(
              variant: .secondary,
              size: .regular
            )
          )
      }
    }
  }

  private func pendingIntegrationIndicator() -> some View {
    ProgressView()
      .controlSize(.small)
      .frame(width: 24, height: 24, alignment: .center)
  }

  private func singleAccountDetail(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> String {
    if configuration.needsPermission {
      return "Finish the required permissions on the previous step."
    }
    if configuration.capability.availability == "requires_helper" {
      return helperWalkthrough(for: configuration.platform)
    }
    if configuration.isRequestable {
      if !integration.enabled && installerIsConnectedIntegrationState(integration.authState) {
        return "Authenticated on this Mac, but not currently turned on."
      }
      if integration.authState == "requested" || integration.authState == "in_progress" {
        return "Authentication is in progress."
      }
      if installerShouldShowAuthAttention(configuration.platform, authState: integration.authState) {
        return "Authentication needs attention. Try again."
      }
      return installerIsConnectedIntegrationState(integration.authState)
        ? "Authenticated on this Mac."
        : authFlowDetail(for: configuration.platform)
    }
    return installerIsConnectedIntegrationState(integration.authState)
      ? "This local source is available on this Mac."
      : connectorDetail(integration)
  }

  private func accountAction(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Fix permissions",
        {
          withAnimation {
            viewModel.currentPage = 0
          }
        }
      )
    }
    guard configuration.isRequestable else {
      return nil
    }

    let isConnected = installerIsConnectedIntegrationState(integration.authState)
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

    let title =
      integration.authState == "failed"
        || installerShouldShowAuthAttention(configuration.platform, authState: integration.authState)
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

  private func removeAction(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    guard configuration.accounts.contains(where: {
      $0.platform == integration.platform && $0.accountKey == integration.accountKey
    }) else {
      return nil
    }

    guard configuration.isRequestable,
          integration.authState != "requested",
          integration.authState != "in_progress" else {
      return nil
    }

    return (
      "Remove",
      {
        removalPrompt = InstallerRemovalPrompt(
          platform: configuration.platform,
          platformTitle: configuration.title,
          accountKey: integration.accountKey,
          accountTitle: accountTitle(for: configuration, integration: integration)
        )
      }
    )
  }

  private func platformLevelAction(
    for configuration: InstallerPlatformConfiguration
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Fix permissions",
        {
          withAnimation {
            viewModel.currentPage = 0
          }
        }
      )
    }
    guard configuration.isConnectable else {
      return nil
    }

    if configuration.supportsMultipleAccounts {
      let noun = installerAccountNoun(for: configuration.platform)
      let title = configuration.accounts.isEmpty && installerSupportsAutomaticAccountDiscovery(configuration.platform)
        ? "Connect"
        : "Add \(noun)"
      return (
        title,
        {
          if installerSupportsAutomaticAccountDiscovery(configuration.platform) {
            pendingPlatformConnectPlatforms.insert(configuration.platform)
            onConnectIntegration(
              configuration.platform,
              viewModel.suggestedAccountKey(for: configuration.platform)
            )
          } else {
            addAccountPrompt = InstallerAddAccountPrompt(
              platform: configuration.platform,
              platformTitle: configuration.title,
              suggestedAccountKey: viewModel.suggestedAccountKey(for: configuration.platform)
            )
          }
        }
      )
    }

    if let integration = configuration.placeholder ?? configuration.accounts.first {
      let isConnected = installerIsConnectedIntegrationState(integration.authState)
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
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> String {
    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      if installerNormalizedTitle(title) == installerNormalizedTitle(configuration.title),
         installerShouldHideAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
        return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
      }
      return title
    }
    if !installerShouldHideAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      return integration.accountKey
    }
    return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
  }

  private func accountDetail(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> String {
    var parts = [installerReadableIntegrationState(configuration.platform, integration.authState)]
    if !integration.enabled && installerIsConnectedIntegrationState(integration.authState) {
      parts.append("turned off")
    }
    if installerNormalizedTitle(accountTitle(for: configuration, integration: integration))
      != installerNormalizedTitle(integration.accountKey),
       !installerShouldHideAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      parts.append(integration.accountKey)
    }
    return parts.joined(separator: " • ")
  }

  private func platformIsFullyConnected(_ configuration: InstallerPlatformConfiguration) -> Bool {
    if configuration.platform == "phone_calls" {
      return true
    }
    let accounts = configuration.accounts
    if accounts.isEmpty {
      return false
    }
    return accounts.allSatisfy { installerShowsCompletionCheckmark(for: configuration, integration: $0) }
  }

  private func connectorDetail(_ integration: InstallerIntegrationStatus) -> String {
    var parts = [installerReadableIntegrationState(integration.platform, integration.authState)]
    if let reason = integration.capability.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !reason.isEmpty {
      parts.append(reason)
    }
    return parts.joined(separator: " • ")
  }
}

public struct InstallerPlatformIcon: View {
  let platform: String

  public init(platform: String) {
    self.platform = platform
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              accentColor.opacity(0.98),
              accentColor.opacity(0.78),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.75)

      if let image = loadPlatformImage() {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .antialiased(true)
          .aspectRatio(contentMode: .fit)
          .padding(brandLogoPadding)
      } else {
        fallbackIcon
      }
    }
    .frame(width: 40, height: 40)
  }

  private func loadPlatformImage() -> NSImage? {
    guard let assetName = installerPlatformIconAssetName(for: platform),
          let url = installerPlatformIconURL(named: assetName),
          let image = NSImage(contentsOf: url) else { return nil }
    return image
  }

  private var accentColor: Color {
    installerPlatformAccentColor(for: platform)
  }

  private var brandLogoPadding: CGFloat {
    switch platform {
    case "slack":
      9
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

private struct InstallerAddAccountSheet: View {
  let platformTitle: String
  let suggestedAccountKey: String
  let onCancel: () -> Void
  let onConnect: (String) -> Void

  @State private var accountKey: String

  init(
    platformTitle: String,
    suggestedAccountKey: String,
    onCancel: @escaping () -> Void,
    onConnect: @escaping (String) -> Void
  ) {
    self.platformTitle = platformTitle
    self.suggestedAccountKey = suggestedAccountKey
    self.onCancel = onCancel
    self.onConnect = onConnect
    _accountKey = State(initialValue: suggestedAccountKey)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Add \(platformTitle) \(installerAccountNoun(for: platformTitle.lowercased()))")
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
            InstallerPermissionActionButtonStyle(
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
          InstallerPermissionActionButtonStyle(
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

private let installerPermissionOrder = [
  "contacts",
  "full_disk_access",
]

private let installerPlatformOrder = [
  "contacts",
  "phone_calls",
  "imessage",
  "slack",
  "discord",
  "linkedin",
  "whatsapp",
  "signal",
]

private func installerDefaultPermissionStatuses() -> [InstallerPermissionStatus] {
  installerPermissionOrder.compactMap { installerDefaultPermissionStatus(for: $0) }
}

private func installerDefaultGlobalSkillStatus() -> InstallerGlobalSkillStatus {
  InstallerGlobalSkillStatus(
    installed: false,
    status: "unknown",
    summary: "Checks whether the global Cued skill is available to your agents."
  )
}

private func installerDefaultPermissionStatus(for key: String) -> InstallerPermissionStatus? {
  switch key {
  case "contacts":
    return InstallerPermissionStatus(
      key: key,
      status: "unknown",
      summary: "Contacts permission has not been checked yet",
      requestFlags: ["--contacts"]
    )
  case "full_disk_access":
    return InstallerPermissionStatus(
      key: key,
      status: "unknown",
      summary: "Full Disk Access has not been checked yet",
      requestFlags: ["--full-disk-access"]
    )
  default:
    return nil
  }
}

private func installerPlatformIconAssetName(for platform: String) -> String? {
  switch platform {
  case "contacts", "phone_calls", "imessage":
    return nil  // Use SF Symbol fallback icons
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

private func installerPlatformAccentColor(for platform: String) -> Color {
  switch platform {
  case "contacts":
    return Color(red: 0.07, green: 0.72, blue: 0.84)
  case "phone_calls":
    return Color(red: 0.13, green: 0.74, blue: 0.38)
  case "imessage":
    return Color(red: 0.24, green: 0.81, blue: 0.39)
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

private func installerPlatformIconURL(named assetName: String) -> URL? {
  let bundles: [Bundle] = [
    Bundle(url: Bundle.main.bundleURL.appendingPathComponent("CuedNative_CuedNativeUI.bundle")),
    Bundle.main.resourceURL.flatMap { Bundle(url: $0.appendingPathComponent("CuedNative_CuedNativeUI.bundle")) },
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

private func installerFallbackIntegration(for platform: String) -> InstallerIntegrationStatus {
  InstallerIntegrationStatus(
    platform: platform,
    accountKey: installerDefaultAccountKey(for: platform),
    displayName: installerPlatformTitle(platform, fallback: nil),
    authState: installerFallbackAuthState(for: platform),
    enabled: true,
    capability: installerFallbackCapability(for: platform)
  )
}

private func installerFallbackCapability(for platform: String) -> InstallerCapabilityStatus {
  switch platform {
  case "contacts":
    return InstallerCapabilityStatus(
      availability: "requires_permission",
      onboardingVisible: true,
      reason: "Contacts access is required."
    )
  case "phone_calls":
    return InstallerCapabilityStatus(
      availability: "available",
      onboardingVisible: true,
      reason: nil
    )
  case "imessage":
    return InstallerCapabilityStatus(
      availability: "requires_permission",
      onboardingVisible: true,
      reason: "Full Disk Access is required."
    )
  default:
    return InstallerCapabilityStatus(
      availability: "available",
      onboardingVisible: true,
      reason: nil
    )
  }
}

private func installerCapabilityForOnboarding(
  platform: String,
  base: InstallerCapabilityStatus,
  permissionsByKey: [String: InstallerPermissionStatus]
) -> InstallerCapabilityStatus {
  guard let permissionKey = installerPermissionKey(for: platform),
        let permission = permissionsByKey[permissionKey],
        base.availability != "unsupported" else {
    return base
  }

  switch permission.status {
  case "granted":
    return InstallerCapabilityStatus(
      availability: "available",
      onboardingVisible: base.onboardingVisible,
      reason: nil
    )
  case "needs_action":
    return InstallerCapabilityStatus(
      availability: "requires_permission",
      onboardingVisible: base.onboardingVisible,
      reason: base.reason ?? "Permission required"
    )
  default:
    return base
  }
}

private func installerPermissionKey(for platform: String) -> String? {
  switch platform {
  case "contacts":
    return "contacts"
  case "imessage":
    return "full_disk_access"
  default:
    return nil
  }
}

private func installerShowsCompletionCheckmark(
  for configuration: InstallerPlatformConfiguration,
  integration: InstallerIntegrationStatus
) -> Bool {
  if !configuration.isRequestable {
    return configuration.capability.availability == "available"
  }
  return integration.enabled && installerIsConnectedIntegrationState(integration.authState)
}

func installerShouldShowAccountRows(for configuration: InstallerPlatformConfiguration) -> Bool {
  if configuration.supportsMultipleAccounts {
    return !configuration.accounts.isEmpty
  }

  guard let integration = configuration.accounts.first else {
    return false
  }

  if installerIsConnectedIntegrationState(integration.authState) {
    return configuration.isRequestable
  }

  return integration.authState == "requested"
    || integration.authState == "in_progress"
    || integration.authState == "blocked"
    || integration.authState == "check_failed"
}

private func installerFallbackAuthState(for platform: String) -> String {
  switch platform {
  case "phone_calls":
    return "authorized"
  case "contacts", "imessage":
    return "not_determined"
  default:
    return "missing"
  }
}

private func installerDefaultAccountKey(for platform: String) -> String {
  platform == "contacts" || platform == "phone_calls" || platform == "imessage" ? "local" : "default"
}

private func platformWalkthrough(for configuration: InstallerPlatformConfiguration) -> String {
  switch configuration.platform {
  case "contacts":
    return "Adds your local contacts so Cued can recognize people across conversations."
  case "phone_calls":
    return "Adds your recent phone calls from this Mac."
  case "imessage":
    return "Syncs your Messages conversations from this Mac."
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

private func authFlowDetail(for platform: String) -> String {
  switch platform {
  case "slack":
    return "Opens Slack sign-in in a browser tab for this workspace."
  case "discord":
    return "Opens Discord sign-in in a browser window."
  case "linkedin":
    return "Opens LinkedIn sign-in in a browser window."
  case "whatsapp":
    return "Starts a QR linking flow for your phone."
  case "signal":
    return "Starts a QR linking flow for Signal."
  default:
    return "Starts the authentication flow for this source."
  }
}

private func helperWalkthrough(for platform: String) -> String {
  switch platform {
  case "whatsapp":
    return "Install the WhatsApp helper before starting the QR linking flow."
  case "signal":
    return "Install signal-cli before starting the QR linking flow."
  default:
    return "Install the required helper before authenticating this source."
  }
}

private func multiAccountEmptyStateDetail(for configuration: InstallerPlatformConfiguration) -> String {
  if configuration.capability.availability == "requires_helper" {
    return helperWalkthrough(for: configuration.platform)
  }
  return "No \(installerAccountNoun(for: configuration.platform))s added yet. \(authFlowDetail(for: configuration.platform))"
}

public func installerShouldAutoConfigurePrerequisites() -> Bool {
  if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" {
    return false
  }
  if ProcessInfo.processInfo.environment["CUED_SKIP_AUTO_PREREQUISITES"] == "1" {
    return false
  }
  let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
  return bundlePath.hasSuffix(".app")
}

private func installerIsConnectedIntegrationState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

private func installerReadableIntegrationState(_ platform: String, _ value: String) -> String {
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
    if installerIsQrLinkPlatform(platform) {
      return "Not authenticated"
    }
    return "Needs attention"
  case "missing":
    return "Not authenticated"
  case "needs_auth":
    return "Not authenticated"
  case "blocked":
    if installerIsQrLinkPlatform(platform) {
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

private func installerIsQrLinkPlatform(_ platform: String) -> Bool {
  platform == "signal" || platform == "whatsapp"
}

private func installerShouldShowAuthAttention(_ platform: String, authState: String) -> Bool {
  if installerIsQrLinkPlatform(platform) {
    return false
  }
  return authState == "blocked" || authState == "check_failed"
}

private func installerPlatformTitle(_ platform: String, fallback: String?) -> String {
  switch platform {
  case "contacts":
    return "Contacts"
  case "phone_calls":
    return "Phone calls"
  case "imessage":
    return "Messages"
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

private func installerAccountNoun(for platform: String) -> String {
  platform == "slack" ? "workspace" : "account"
}

private func installerSupportsAutomaticAccountDiscovery(_ platform: String) -> Bool {
  platform == "slack"
}

private func installerShouldHideAccountKey(platform: String, accountKey: String) -> Bool {
  if installerSupportsAutomaticAccountDiscovery(platform) && accountKey.hasPrefix("pending-slack-") {
    return true
  }
  if !installerSupportsMultipleAccounts(platform) && accountKey == "default" {
    return true
  }
  return false
}

private func installerNormalizedTitle(_ value: String?) -> String {
  value?.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase ?? ""
}

private func fallbackAccountTitle(for platform: String, authState: String) -> String {
  if installerIsConnectedIntegrationState(authState) {
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

private func installerGeneratedPendingAccountKey(
  for platform: String,
  existing: Set<String>
) -> String {
  let prefix = platform == "slack" ? "pending-slack-" : "pending-"
  var candidate = "\(prefix)\(UUID().uuidString.prefix(8).lowercased())"
  while existing.contains(candidate) {
    candidate = "\(prefix)\(UUID().uuidString.prefix(8).lowercased())"
  }
  return candidate
}

private func installerSupportsMultipleAccounts(_ platform: String) -> Bool {
  platform == "slack"
}

private func installerIsRequestablePlatform(_ platform: String) -> Bool {
  switch platform {
  case "discord", "linkedin", "signal", "slack", "whatsapp":
    return true
  default:
    return false
  }
}

private func installerSortIntegrations(
  left: InstallerIntegrationStatus,
  right: InstallerIntegrationStatus
) -> Bool {
  let leftConnected = installerIsConnectedIntegrationState(left.authState)
  let rightConnected = installerIsConnectedIntegrationState(right.authState)
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
private func installerPreviewViewModel(
  page: Int,
  permissions: [InstallerPermissionStatus],
  globalSkill: InstallerGlobalSkillStatus,
  allIntegrations: [InstallerIntegrationStatus],
  setupIntegrations: [InstallerIntegrationStatus]
) -> OnboardingViewModel {
  let viewModel = OnboardingViewModel()
  viewModel.currentPage = page
  viewModel.apply(
    permissions: permissions,
    globalSkill: globalSkill,
    allIntegrations: allIntegrations,
    integrations: setupIntegrations
  )
  return viewModel
}

private func installerPreviewCapability(
  availability: String = "available",
  reason: String? = nil
) -> InstallerCapabilityStatus {
  InstallerCapabilityStatus(availability: availability, onboardingVisible: true, reason: reason)
}

private func installerPreviewIntegration(
  platform: String,
  accountKey: String,
  displayName: String?,
  authState: String,
  enabled: Bool,
  capability: InstallerCapabilityStatus
) -> InstallerIntegrationStatus {
  InstallerIntegrationStatus(
    platform: platform,
    accountKey: accountKey,
    displayName: displayName,
    authState: authState,
    enabled: enabled,
    capability: capability
  )
}

private struct InstallerPreviewContainer: View {
  @StateObject private var viewModel: OnboardingViewModel

  init(
    page: Int,
    permissions: [InstallerPermissionStatus],
    globalSkill: InstallerGlobalSkillStatus,
    allIntegrations: [InstallerIntegrationStatus],
    setupIntegrations: [InstallerIntegrationStatus]
  ) {
    _viewModel = StateObject(
      wrappedValue: installerPreviewViewModel(
        page: page,
        permissions: permissions,
        globalSkill: globalSkill,
        allIntegrations: allIntegrations,
        setupIntegrations: setupIntegrations
      )
    )
  }

  var body: some View {
    CuedOnboardingView(
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
  InstallerPreviewContainer(
    page: 0,
    permissions: [
      InstallerPermissionStatus(
        key: "contacts",
        status: "granted",
        summary: "Contacts access is authorized",
        requestFlags: ["--contacts"]
      ),
      InstallerPermissionStatus(
        key: "full_disk_access",
        status: "needs_action",
        summary: "Messages database is not readable from the current process",
        requestFlags: ["--full-disk-access"]
      ),
    ],
    globalSkill: installerDefaultGlobalSkillStatus(),
    allIntegrations: [],
    setupIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "needs_full_disk_access",
        enabled: true,
        capability: installerPreviewCapability(availability: "requires_permission", reason: "Permission required")
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · No Accounts") {
  InstallerPreviewContainer(
    page: 1,
    permissions: installerDefaultPermissionStatuses(),
    globalSkill: installerDefaultGlobalSkillStatus(),
    allIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
    ],
    setupIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · Slack Multi-Workspace") {
  InstallerPreviewContainer(
    page: 1,
    permissions: installerDefaultPermissionStatuses(),
    globalSkill: installerDefaultGlobalSkillStatus(),
    allIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "slack",
        accountKey: "workspace-a",
        displayName: "Acme Product",
        authState: "authenticated",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "slack",
        accountKey: "workspace-b",
        displayName: "Acme Sales",
        authState: "authenticated",
        enabled: false,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "authenticated",
        enabled: true,
        capability: installerPreviewCapability()
      ),
    ],
    setupIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "authenticated",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
    ]
  )
}

@available(macOS 14.0, *)
#Preview("Platforms · Helpers Missing") {
  InstallerPreviewContainer(
    page: 1,
    permissions: installerDefaultPermissionStatuses(),
    globalSkill: installerDefaultGlobalSkillStatus(),
    allIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability(availability: "requires_helper", reason: "Helper required")
      ),
      installerPreviewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability(availability: "requires_helper", reason: "Helper required")
      ),
    ],
    setupIntegrations: [
      installerPreviewIntegration(
        platform: "contacts",
        accountKey: "local",
        displayName: "Contacts.app",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "imessage",
        accountKey: "local",
        displayName: "Messages",
        authState: "authorized",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "slack",
        accountKey: "default",
        displayName: "Slack",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "linkedin",
        accountKey: "default",
        displayName: "LinkedIn",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability()
      ),
      installerPreviewIntegration(
        platform: "whatsapp",
        accountKey: "default",
        displayName: "WhatsApp",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability(availability: "requires_helper", reason: "Helper required")
      ),
      installerPreviewIntegration(
        platform: "signal",
        accountKey: "default",
        displayName: "Signal",
        authState: "missing",
        enabled: true,
        capability: installerPreviewCapability(availability: "requires_helper", reason: "Helper required")
      ),
    ]
  )
}
#endif
