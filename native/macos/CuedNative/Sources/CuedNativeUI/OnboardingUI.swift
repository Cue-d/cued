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
    allIntegrations: [InstallerIntegrationStatus],
    integrations: [InstallerIntegrationStatus]
  ) {
    let normalizedPermissions = buildPermissionStatuses(permissions)
    permissionStatuses = normalizedPermissions
    platformConfigurations = buildPlatformConfigurations(
      permissions: normalizedPermissions,
      allIntegrations: allIntegrations,
      setupIntegrations: integrations
    )
    isRefreshing = false
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
  let onRequestPermission: ([String]) -> Void
  let onEnableIntegration: (String, String) -> Void
  let onRemoveIntegration: (String, String) -> Void
  let onConnectIntegration: (String, String) -> Void
  let onFinish: () -> Void

  @State private var addAccountPrompt: InstallerAddAccountPrompt?
  @State private var removalPrompt: InstallerRemovalPrompt?
  @State private var pendingPermissionKeys = Set<String>()
  @State private var pendingIntegrationActionIDs = Set<String>()
  @State private var pendingPlatformConnectPlatforms = Set<String>()

  public init(
    viewModel: OnboardingViewModel,
    onRefresh: @escaping () -> Void,
    onRequestPermission: @escaping ([String]) -> Void,
    onEnableIntegration: @escaping (String, String) -> Void,
    onRemoveIntegration: @escaping (String, String) -> Void,
    onConnectIntegration: @escaping (String, String) -> Void,
    onFinish: @escaping () -> Void
  ) {
    self.viewModel = viewModel
    self.onRefresh = onRefresh
    self.onRequestPermission = onRequestPermission
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
    .onChange(of: viewModel.permissionStatuses.map(\.id)) { _ in
      pendingPermissionKeys.removeAll()
    }
    .onChange(of: viewModel.permissionStatuses.map(\.status)) { _ in
      pendingPermissionKeys.removeAll()
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
        .buttonStyle(.plain)
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
          .buttonStyle(.plain)
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
          .frame(minWidth: 88)
      }
      .keyboardShortcut(.return)
      .buttonStyle(.borderedProminent)
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

      Text("Cued needs a few macOS permissions to sync your messages and contacts.")
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

      onboardingCard {
        ForEach(Array(viewModel.permissionStatuses.enumerated()), id: \.element.id) { index, permission in
          permissionRow(permission)
          if index < viewModel.permissionStatuses.count - 1 {
            Divider()
          }
        }
      }
    }
  }



  private var platformsPage: some View {
    onboardingPage {
      Text("Platforms")
        .font(.largeTitle.weight(.semibold))

      Text("Connect the sources Cued should sync on this Mac. Slack supports multiple workspaces, and local sources will unlock as soon as the required permissions are ready.")
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
    let isPending = pendingPermissionKeys.contains(permission.key)

    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: descriptor.systemImage)
        .font(.title3.weight(.semibold))
        .foregroundStyle(isGranted ? .green : .secondary)
        .frame(width: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(descriptor.title)
          .font(.headline)
          .foregroundStyle(isGranted ? .secondary : .primary)
        Text(descriptor.subtitle)
          .font(.subheadline)
          .foregroundStyle(isGranted ? .tertiary : .secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      if isGranted {
        Image(systemName: "checkmark.circle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(.green)
          .padding(.top, 2)
          .accessibilityLabel("\(descriptor.title) access granted")
      } else if isPending {
        ProgressView()
          .controlSize(.small)
          .padding(.top, 6)
      } else {
        Button("Request access") {
          pendingPermissionKeys.insert(permission.key)
          onRequestPermission(permission.requestFlags)
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .disabled(isPending)
      }
    }
    .padding(.vertical, 2)
    .opacity(isGranted ? 0.7 : 1.0)
  }

  private func platformConfigurationCard(_ configuration: InstallerPlatformConfiguration) -> some View {
    let isFullyConnected = platformIsFullyConnected(configuration)
    let shouldShowAccountControls =
      configuration.supportsMultipleAccounts || configuration.isRequestable || !isFullyConnected
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

  private func singleAccountPlatformRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> some View {
    let action = accountAction(for: configuration, integration: integration)
    let removeAction = removeAction(for: configuration, integration: integration)
    let showsCheckmark = installerShowsCompletionCheckmark(
      for: configuration,
      integration: integration
    )
    let isPending = pendingIntegrationActionIDs.contains(integration.id)

    return HStack(spacing: 10) {
      Spacer(minLength: 0)
      if isPending {
        ProgressView()
          .controlSize(.small)
      } else if showsCheckmark {
        authenticatedCheckmark(label: "\(configuration.title) authenticated")
      }
      if let removeAction {
        removalButton(label: removeAction.label, action: removeAction.handler)
      }
      if let action {
        actionButton(title: action.title, action: action.handler)
      }
    }
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
    let action = accountAction(for: configuration, integration: integration)
    let removeAction = removeAction(for: configuration, integration: integration)
    let showsCheckmark = installerShowsCompletionCheckmark(
      for: configuration,
      integration: integration
    )
    let isPending = pendingIntegrationActionIDs.contains(integration.id)

    return HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(accountTitle(for: integration))
          .font(.subheadline.weight(.semibold))
        Text(accountDetail(for: integration))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      if isPending {
        ProgressView()
          .controlSize(.small)
          .padding(.top, 2)
      } else if showsCheckmark {
        authenticatedCheckmark(label: "\(accountTitle(for: integration)) authenticated")
      }
      if let removeAction {
        removalButton(label: removeAction.label, action: removeAction.handler)
      }
      if let action {
        actionButton(title: action.title, action: action.handler)
      }
    }
  }

  private func actionButton(
    title: String,
    prominent: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Group {
      if prominent {
        Button(title, action: action)
          .buttonStyle(.borderedProminent)
          .controlSize(.regular)
      } else {
        Button(title, action: action)
          .buttonStyle(.bordered)
          .controlSize(.regular)
      }
    }
  }

  private func removalButton(
    label: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: "xmark")
        .font(.headline.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(width: 18, height: 18, alignment: .center)
    }
    .frame(width: 24, height: 24, alignment: .center)
    .buttonStyle(.plain)
    .accessibilityLabel(label)
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
      if integration.authState == "blocked" || integration.authState == "check_failed" {
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
      integration.authState == "failed" || integration.authState == "blocked"
        || integration.authState == "check_failed"
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
  ) -> (label: String, handler: () -> Void)? {
    guard configuration.isRequestable,
          integration.authState != "requested",
          integration.authState != "in_progress" else {
      return nil
    }

    return (
      "Remove \(accountTitle(for: integration))",
      {
        removalPrompt = InstallerRemovalPrompt(
          platform: configuration.platform,
          platformTitle: configuration.title,
          accountKey: integration.accountKey,
          accountTitle: accountTitle(for: integration)
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

  private func accountTitle(for integration: InstallerIntegrationStatus) -> String {
    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      return title
    }
    return integration.accountKey
  }

  private func accountDetail(for integration: InstallerIntegrationStatus) -> String {
    var parts = [installerReadableIntegrationState(integration.authState)]
    if !integration.enabled && installerIsConnectedIntegrationState(integration.authState) {
      parts.append("turned off")
    }
    if integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) != integration.accountKey,
       !installerShouldHideAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      parts.append(integration.accountKey)
    }
    return parts.joined(separator: " • ")
  }

  private func platformIsFullyConnected(_ configuration: InstallerPlatformConfiguration) -> Bool {
    let accounts = configuration.accounts
    if accounts.isEmpty {
      return false
    }
    return accounts.allSatisfy { installerShowsCompletionCheckmark(for: configuration, integration: $0) }
  }

  private func authenticatedCheckmark(label: String) -> some View {
    Image(systemName: "checkmark.circle.fill")
      .font(.title3.weight(.semibold))
      .foregroundStyle(.secondary)
      .frame(width: 24, height: 24, alignment: .center)
      .accessibilityLabel(label)
  }

  private func connectorDetail(_ integration: InstallerIntegrationStatus) -> String {
    var parts = [installerReadableIntegrationState(integration.authState)]
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
    if let image = loadPlatformImage() {
      Image(nsImage: image)
        .resizable()
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(width: 28, height: 28)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    } else {
      fallbackIcon
        .frame(width: 28, height: 28)
    }
  }

  private func loadPlatformImage() -> NSImage? {
    guard let assetName = installerPlatformIconAssetName(for: platform),
          let url = installerPlatformIconURL(named: assetName),
          let image = NSImage(contentsOf: url) else { return nil }
    image.size = NSSize(width: 28, height: 28)
    return image
  }

  @ViewBuilder
  private var fallbackIcon: some View {
    switch platform {
    case "contacts":
      ZStack {
        Circle()
          .fill(Color(nsColor: .quaternaryLabelColor))
        Image(systemName: "person.crop.circle.fill")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(.white.opacity(0.92))
      }
    case "imessage":
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color(red: 0.20, green: 0.77, blue: 0.35))
        Image(systemName: "message.fill")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.white)
      }
    case "slack":
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.white)
        VStack(spacing: 2) {
          HStack(spacing: 2) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(Color(red: 0.89, green: 0.14, blue: 0.43))
              .frame(width: 8, height: 4)
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(Color(red: 0.21, green: 0.74, blue: 0.87))
              .frame(width: 4, height: 8)
          }
          HStack(spacing: 2) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(Color(red: 0.15, green: 0.73, blue: 0.36))
              .frame(width: 4, height: 8)
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(Color(red: 0.92, green: 0.69, blue: 0.14))
              .frame(width: 8, height: 4)
          }
        }
      }
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(Color.black.opacity(0.08), lineWidth: 0.5)
      )
    case "linkedin":
      ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(Color(red: 0.03, green: 0.45, blue: 0.74))
        Text("in")
          .font(.system(size: 12, weight: .black, design: .rounded))
          .foregroundStyle(.white)
          .offset(y: 0.5)
      }
    case "signal":
      ZStack {
        Circle()
          .stroke(Color(red: 0.24, green: 0.56, blue: 0.98), lineWidth: 2)
        ZStack {
          Circle()
            .fill(Color(red: 0.24, green: 0.56, blue: 0.98))
            .frame(width: 12, height: 12)
          Circle()
            .fill(.white)
            .frame(width: 3, height: 3)
        }
      }
    case "whatsapp":
      ZStack {
        Circle()
          .fill(Color(red: 0.13, green: 0.74, blue: 0.38))
        Image(systemName: "phone.fill")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(.white)
      }
    default:
      ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(Color.accentColor.opacity(0.16))
        Image(systemName: "link.circle.fill")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Color.accentColor)
      }
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
          .buttonStyle(.bordered)
        Button("Connect") {
          let trimmed = accountKey.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else {
            return
          }
          onConnect(trimmed)
        }
        .buttonStyle(.borderedProminent)
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
  "messages_automation",
]

private let installerPlatformOrder = [
  "contacts",
  "imessage",
  "slack",
  "linkedin",
  "whatsapp",
  "signal",
]

private func installerDefaultPermissionStatuses() -> [InstallerPermissionStatus] {
  installerPermissionOrder.compactMap { installerDefaultPermissionStatus(for: $0) }
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
  case "messages_automation":
    return InstallerPermissionStatus(
      key: key,
      status: "unknown",
      summary: "Messages automation access has not been checked yet",
      requestFlags: ["--messages"]
    )
  default:
    return nil
  }
}

private func installerPlatformIconAssetName(for platform: String) -> String? {
  switch platform {
  case "contacts", "imessage":
    return nil  // Use SF Symbol fallback icons
  case "slack":
    return "slack-logo"
  case "linkedin":
    return "linkedin-logo"
  case "signal":
    return "signal-logo"
  case "whatsapp":
    return "whatsapp-logo"
  default:
    return nil
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

private func installerFallbackAuthState(for platform: String) -> String {
  switch platform {
  case "contacts", "imessage":
    return "not_determined"
  default:
    return "missing"
  }
}

private func installerDefaultAccountKey(for platform: String) -> String {
  platform == "contacts" || platform == "imessage" ? "local" : "default"
}

private func installerPermissionDescriptor(for key: String) -> (
  title: String,
  subtitle: String,
  systemImage: String
) {
  switch key {
  case "contacts":
    return (
      "Contacts",
      "Allow Cued to read Contacts.app so it can resolve people consistently across local data.",
      "person.crop.circle.badge.checkmark"
    )
  case "full_disk_access":
    return (
      "Full Disk Access",
      "Required to read the Messages database for passive sync on this Mac.",
      "internaldrive.fill"
    )
  case "messages_automation":
    return (
      "Messages automation",
      "Required only for AppleScript send and control flows in Messages. Passive sync does not use this.",
      "paperplane.circle.fill"
    )
  default:
    return ("Permission", "Review this macOS permission.", "hand.raised.fill")
  }
}

private func platformWalkthrough(for configuration: InstallerPlatformConfiguration) -> String {
  switch configuration.platform {
  case "contacts":
    return "Uses the Contacts permission from the previous step to resolve people across local data."
  case "imessage":
    return "Uses Full Disk Access for local Messages sync and Messages automation for AppleScript sending."
  case "slack":
    return "Authenticate each workspace in a browser sign-in flow. You can add more workspaces at any time."
  case "linkedin":
    return "Authenticate in a browser window and Cued will save the session on this Mac."
  case "whatsapp":
    return "Authenticate by linking your phone in a QR flow with the local WhatsApp helper."
  case "signal":
    return "Authenticate by linking Signal with a QR flow using the local signal-cli helper."
  default:
    return "Authenticate this source on this Mac."
  }
}

private func authFlowDetail(for platform: String) -> String {
  switch platform {
  case "slack":
    return "Opens Slack sign-in in a browser tab for this workspace."
  case "linkedin":
    return "Opens LinkedIn sign-in in a browser window."
  case "whatsapp":
    return "Starts a QR linking flow for your phone."
  case "signal":
    return "Starts a QR linking flow with the local Signal helper."
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
  let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
  return bundlePath.hasSuffix(".app")
}

private func installerIsConnectedIntegrationState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

private func installerReadableIntegrationState(_ value: String) -> String {
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
    return "Needs attention"
  case "missing":
    return "Not authenticated"
  case "blocked":
    return "Blocked"
  case "not_determined":
    return "Needs permission"
  case "cancelled":
    return "Disconnected"
  default:
    return value.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func installerPlatformTitle(_ platform: String, fallback: String?) -> String {
  switch platform {
  case "contacts":
    return "Contacts"
  case "imessage":
    return "Messages"
  case "linkedin":
    return "LinkedIn"
  case "signal":
    return "Signal"
  case "slack":
    return "Slack"
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
  installerSupportsAutomaticAccountDiscovery(platform) && accountKey.hasPrefix("pending-slack-")
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
  case "linkedin", "signal", "slack", "whatsapp":
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
  allIntegrations: [InstallerIntegrationStatus],
  setupIntegrations: [InstallerIntegrationStatus]
) -> OnboardingViewModel {
  let viewModel = OnboardingViewModel()
  viewModel.currentPage = page
  viewModel.apply(
    permissions: permissions,
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
    allIntegrations: [InstallerIntegrationStatus],
    setupIntegrations: [InstallerIntegrationStatus]
  ) {
    _viewModel = StateObject(
      wrappedValue: installerPreviewViewModel(
        page: page,
        permissions: permissions,
        allIntegrations: allIntegrations,
        setupIntegrations: setupIntegrations
      )
    )
  }

  var body: some View {
    CuedOnboardingView(
      viewModel: viewModel,
      onRefresh: {},
      onRequestPermission: { _ in },
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
      InstallerPermissionStatus(
        key: "messages_automation",
        status: "needs_action",
        summary: "Apple Events automation for Messages is not verified",
        requestFlags: ["--messages"]
      ),
    ],
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
