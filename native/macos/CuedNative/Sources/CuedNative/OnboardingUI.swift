import AppKit
import SwiftUI

struct InstallerCapabilityStatus: Decodable {
  let availability: String
  let onboardingVisible: Bool
  let supportsMultipleAccounts: Bool
  let reason: String?
}

struct InstallerIntegrationStatus: Decodable, Identifiable {
  let platform: String
  let accountKey: String
  let displayName: String?
  let authState: String
  let enabled: Bool
  let capability: InstallerCapabilityStatus

  var id: String { "\(platform):\(accountKey)" }
}

struct InstallerIntegrationStatusResponse: Decodable {
  let hostOs: String
  let integrations: [InstallerIntegrationStatus]?
  let setupIntegrations: [InstallerIntegrationStatus]
}

struct InstallerPlatformConfiguration: Identifiable {
  let platform: String
  let title: String
  let capability: InstallerCapabilityStatus
  let accounts: [InstallerIntegrationStatus]
  let placeholder: InstallerIntegrationStatus?
  let supportsMultipleAccounts: Bool

  var id: String { platform }

  var knownAccounts: [InstallerIntegrationStatus] {
    if accounts.isEmpty, let placeholder {
      return [placeholder]
    }
    return accounts
  }

  var connectedAccountCount: Int {
    accounts.filter { $0.enabled && installerIsConnectedIntegrationState($0.authState) }.count
  }

  var hasBlockingState: Bool {
    knownAccounts.contains { $0.authState == "blocked" || $0.authState == "check_failed" }
  }

  var hasInProgressState: Bool {
    knownAccounts.contains { $0.authState == "requested" || $0.authState == "in_progress" }
  }

  var isRequestable: Bool {
    installerIsRequestablePlatform(platform)
  }

  var isConnectable: Bool {
    isRequestable && capability.availability != "unsupported" && capability.availability != "requires_helper"
  }

  var needsPermission: Bool {
    capability.availability == "requires_permission"
  }
}

struct InstallerAddAccountPrompt: Identifiable {
  let platform: String
  let platformTitle: String
  let suggestedAccountKey: String

  var id: String { platform }
}

struct InstallerLaunchAgentStatusResponse: Decodable {
  let loaded: Bool
}

struct InstallerCLISymlinkStatusResponse: Decodable {
  let installed: Bool
  let path: String
}

@MainActor
final class OnboardingViewModel: ObservableObject {
  static let windowWidth: CGFloat = 630
  static let windowHeight: CGFloat = 752

  @Published var currentPage = 0
  @Published var isRefreshing = false
  @Published var snapshot: AppStatusSnapshot?
  @Published var platformConfigurations: [InstallerPlatformConfiguration] = []
  @Published private(set) var platformSelections: [String: Bool] = [:]
  @Published var launchAgentLoaded = false
  @Published var cliStatus: InstallerCLISymlinkStatusResponse?

  let pageWidth: CGFloat = OnboardingViewModel.windowWidth
  let contentHeight: CGFloat = 474

  var pageCount: Int { 4 }

  var buttonTitle: String {
    currentPage == pageCount - 1 ? "Finish" : "Next"
  }

  var canGoBack: Bool {
    currentPage > 0
  }

  var connectedCount: Int {
    snapshot?.integrations.filter { $0.enabled && installerIsConnectedIntegrationState($0.authState) }.count ?? 0
  }

  var daemonStatusLabel: String {
    guard let snapshot else {
      return isRefreshing ? "Refreshing" : "Checking"
    }
    return snapshot.daemonRunning ? "Ready" : "Starting"
  }

  var daemonStatusTone: InstallerBadgeTone {
    snapshot?.daemonRunning == true ? .good : .warning
  }

  var permissionNeeded: Bool {
    platformConfigurations.contains { $0.needsPermission }
  }

  func beginRefresh() {
    isRefreshing = true
  }

  func apply(
    snapshot: AppStatusSnapshot,
    allIntegrations: [InstallerIntegrationStatus],
    integrations: [InstallerIntegrationStatus],
    launchAgentLoaded: Bool,
    cliStatus: InstallerCLISymlinkStatusResponse?
  ) {
    self.snapshot = snapshot
    let previousSelections = platformSelections
    let configurations = buildPlatformConfigurations(
      allIntegrations: allIntegrations,
      setupIntegrations: integrations
    )
    platformConfigurations = configurations
    platformSelections = Dictionary(
      uniqueKeysWithValues: configurations.map { configuration in
        if configuration.accounts.isEmpty, let previous = previousSelections[configuration.platform] {
          return (configuration.platform, previous)
        }
        let selected = configuration.accounts.contains { $0.enabled } || configuration.placeholder?.enabled == true
        return (configuration.platform, selected)
      }
    )
    self.launchAgentLoaded = launchAgentLoaded
    self.cliStatus = cliStatus
    isRefreshing = false
  }

  func isPlatformSelected(_ platform: String) -> Bool {
    platformSelections[platform] ?? true
  }

  func setPlatformSelected(_ platform: String, selected: Bool) {
    platformSelections[platform] = selected
  }

  func configuration(for platform: String) -> InstallerPlatformConfiguration? {
    platformConfigurations.first { $0.platform == platform }
  }

  func accountKeys(for platform: String) -> [String] {
    configuration(for: platform)?.accounts.map(\.accountKey) ?? []
  }

  func suggestedAccountKey(for platform: String) -> String {
    let existing = Set(accountKeys(for: platform))
    if !existing.contains("default") {
      return "default"
    }

    let base = platform == "slack" ? "workspace" : "account"
    var index = 2
    var candidate = "\(base)-\(index)"
    while existing.contains(candidate) {
      index += 1
      candidate = "\(base)-\(index)"
    }
    return candidate
  }

  private func buildPlatformConfigurations(
    allIntegrations: [InstallerIntegrationStatus],
    setupIntegrations: [InstallerIntegrationStatus]
  ) -> [InstallerPlatformConfiguration] {
    let visibleSetup = setupIntegrations.filter { $0.capability.onboardingVisible }
    let visibleAll = allIntegrations.filter { $0.capability.onboardingVisible }
    let actualByPlatform = Dictionary(grouping: visibleAll, by: \.platform)
    let setupByPlatform = Dictionary(grouping: visibleSetup, by: \.platform)
    var seen = Set<String>()

    return visibleSetup.compactMap { setupIntegration in
      guard seen.insert(setupIntegration.platform).inserted else {
        return nil
      }

      let accounts = (actualByPlatform[setupIntegration.platform] ?? []).sorted(by: installerSortIntegrations)
      let placeholder = accounts.isEmpty
        ? (setupByPlatform[setupIntegration.platform] ?? []).sorted(by: installerSortIntegrations).first
        : nil
      let base = accounts.first ?? placeholder ?? setupIntegration

      return InstallerPlatformConfiguration(
        platform: setupIntegration.platform,
        title: installerPlatformTitle(setupIntegration.platform, fallback: base.displayName),
        capability: base.capability,
        accounts: accounts,
        placeholder: placeholder,
        supportsMultipleAccounts: base.capability.supportsMultipleAccounts
      )
    }
  }
}

@MainActor
final class OnboardingWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let statusStore: AppStatusStore
  private let onRefresh: () -> Void
  private let viewModel = OnboardingViewModel()
  private var isRefreshing = false

  init(daemonSupervisor: DaemonSupervisor, statusStore: AppStatusStore, onRefresh: @escaping () -> Void) {
    self.daemonSupervisor = daemonSupervisor
    self.statusStore = statusStore
    self.onRefresh = onRefresh

    let window = NSWindow(
      contentRect: NSRect(
        x: 0,
        y: 0,
        width: OnboardingViewModel.windowWidth,
        height: OnboardingViewModel.windowHeight
      ),
      styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Cued Setup"
    window.center()
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.backgroundColor = .windowBackgroundColor
    super.init(window: window)

    let hosting = NSHostingController(
      rootView: CuedOnboardingView(
        viewModel: viewModel,
        onRefresh: { [weak self] in self?.refresh() },
        onToggleLaunchAtLogin: { [weak self] in self?.toggleLaunchAtLogin() },
        onInstallCLI: { [weak self] in self?.installCLI() },
        onRequestPermissions: { [weak self] in self?.requestPermissions() },
        onSetPlatformSelection: { [weak self] platform, isSelected in
          self?.handlePlatformSelection(platform: platform, isSelected: isSelected)
        },
        onConnectIntegration: { [weak self] platform, accountKey in
          self?.handleIntegrationAction(platform: platform, accountKey: accountKey)
        },
        onOpenReleases: { [weak self] in self?.openReleasesPage() },
        onFinish: { [weak self] in self?.finishOnboarding() }
      )
    )
    window.contentViewController = hosting
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func showAndRefresh() {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    refresh()
  }

  func refresh() {
    guard !isRefreshing else {
      return
    }
    isRefreshing = true
    viewModel.beginRefresh()

    let daemonSupervisor = self.daemonSupervisor
    let statusStore = self.statusStore

    Task.detached(priority: .userInitiated) { [daemonSupervisor, statusStore] in
      _ = daemonSupervisor.runCLI(arguments: ["integrations", "refresh"])
      let snapshot = statusStore.readSnapshot()
      let integrations = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerIntegrationStatusResponse.self,
        arguments: ["integrations", "status"]
      ) ?? InstallerIntegrationStatusResponse(hostOs: "macos", integrations: [], setupIntegrations: [])
      let launchd = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerLaunchAgentStatusResponse.self,
        arguments: ["launchd", "status"]
      )
      let cliStatus = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerCLISymlinkStatusResponse.self,
        arguments: ["cli", "status"]
      )

      await MainActor.run {
        self.isRefreshing = false
        self.viewModel.apply(
          snapshot: snapshot,
          allIntegrations: integrations.integrations ?? [],
          integrations: integrations.setupIntegrations.filter { $0.capability.onboardingVisible },
          launchAgentLoaded: launchd?.loaded ?? false,
          cliStatus: cliStatus
        )
      }
    }
  }

  func openReleasesPage() {
    guard let url = URL(string: "https://github.com/Cue-d/cued/releases") else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  private nonisolated static func decodeJSON<T: Decodable>(
    daemonSupervisor: DaemonSupervisor,
    _ type: T.Type,
    arguments: [String]
  ) -> T? {
    guard let result = daemonSupervisor.runCLI(arguments: arguments),
          result.status == 0,
          let data = result.stdout.data(using: .utf8) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  private func runAction(arguments: [String]) {
    runActions(argumentsList: [arguments])
  }

  private func runActions(argumentsList: [[String]]) {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      for arguments in argumentsList {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
      await MainActor.run {
        self.onRefresh()
        self.refresh()
      }
    }
  }

  private func toggleLaunchAtLogin() {
    runAction(arguments: ["launchd", viewModel.launchAgentLoaded ? "uninstall" : "install"])
  }

  private func installCLI() {
    runAction(arguments: ["cli", "install"])
  }

  private func requestPermissions() {
    daemonSupervisor.requestPermissions()
    refresh()
  }

  private func handlePlatformSelection(platform: String, isSelected: Bool) {
    viewModel.setPlatformSelected(platform, selected: isSelected)
    let accountKeys = viewModel.accountKeys(for: platform)
    guard !accountKeys.isEmpty else {
      return
    }

    let command = isSelected ? "enable" : "disable"
    runActions(argumentsList: accountKeys.map { ["integrations", command, platform, $0] })
  }

  private func handleIntegrationAction(platform: String, accountKey: String) {
    guard let configuration = viewModel.configuration(for: platform) else {
      return
    }
    if configuration.capability.availability == "requires_permission" {
      requestPermissions()
      return
    }

    viewModel.setPlatformSelected(platform, selected: true)
    var actions = [[String]]()
    if configuration.accounts.contains(where: { $0.accountKey == accountKey && !$0.enabled }) {
      actions.append(["integrations", "enable", platform, accountKey])
    }
    actions.append(["integrations", "connect", platform, accountKey])
    runActions(argumentsList: actions)
  }

  private func finishOnboarding() {
    _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    close()
    onRefresh()
  }
}

enum InstallerBadgeTone {
  case good
  case warning
  case neutral
  case danger
}

private struct CuedOnboardingView: View {
  @ObservedObject var viewModel: OnboardingViewModel

  let onRefresh: () -> Void
  let onToggleLaunchAtLogin: () -> Void
  let onInstallCLI: () -> Void
  let onRequestPermissions: () -> Void
  let onSetPlatformSelection: (String, Bool) -> Void
  let onConnectIntegration: (String, String) -> Void
  let onOpenReleases: () -> Void
  let onFinish: () -> Void

  @State private var addAccountPrompt: InstallerAddAccountPrompt?

  var body: some View {
    VStack(spacing: 0) {
      GlowingCuedIcon(size: 64, glowIntensity: 0.16)
        .offset(y: 4)
        .frame(height: 82)

      GeometryReader { _ in
        HStack(spacing: 0) {
          ForEach(0..<viewModel.pageCount, id: \.self) { pageIndex in
            pageView(for: pageIndex)
              .frame(width: viewModel.pageWidth)
          }
        }
        .offset(x: CGFloat(-viewModel.currentPage) * viewModel.pageWidth)
        .animation(
          .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
          value: viewModel.currentPage
        )
        .frame(height: viewModel.contentHeight, alignment: .top)
        .clipped()
      }
      .frame(height: viewModel.contentHeight)

      Spacer(minLength: 0)
      navigationBar
    }
    .frame(width: viewModel.pageWidth, height: OnboardingViewModel.windowHeight)
    .background(Color(NSColor.windowBackgroundColor))
    .onAppear {
      viewModel.currentPage = 0
      onRefresh()
    }
    .sheet(item: $addAccountPrompt) { prompt in
      InstallerAddAccountSheet(
        platformTitle: prompt.platformTitle,
        suggestedAccountKey: prompt.suggestedAccountKey,
        onCancel: { addAccountPrompt = nil },
        onConnect: { accountKey in
          addAccountPrompt = nil
          onConnectIntegration(prompt.platform, accountKey)
        }
      )
    }
  }

  @ViewBuilder
  private func pageView(for pageIndex: Int) -> some View {
    switch pageIndex {
    case 0:
      welcomePage
    case 1:
      systemSetupPage
    case 2:
      connectorsPage
    case 3:
      readyPage
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
    let scrollIndicatorGutter: CGFloat = 18
    return ScrollView {
      VStack(spacing: 16) {
        content()
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .top)
      .padding(.trailing, scrollIndicatorGutter)
    }
    .scrollIndicators(.automatic)
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

  private var welcomePage: some View {
    onboardingPage {
      VStack(spacing: 22) {
        Text("Welcome to Cued")
          .font(.largeTitle.weight(.semibold))

        Text("Cued keeps your messages and contacts local to this Mac, then helps agents work with that data safely.")
          .font(.body)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .frame(maxWidth: 560)
          .fixedSize(horizontal: false, vertical: true)

        onboardingCard(spacing: 10, padding: 14) {
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
              .font(.title3.weight(.semibold))
              .foregroundStyle(Color(nsColor: .systemOrange))
              .frame(width: 22)
              .padding(.top, 1)

            VStack(alignment: .leading, spacing: 6) {
              Text("Security notice")
                .font(.headline)
              Text(
                "Cued can unlock powerful local data sources like Contacts.app and Messages on this Mac. " +
                  "Those connectors depend on the permissions you grant, and agents using Cued may read or transform that local data.\n\n" +
                  "Only enable the sources you understand, and only use prompts or integrations you trust."
              )
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .frame(maxWidth: 520)
      }
      .padding(.top, 16)
    }
  }

  private var systemSetupPage: some View {
    onboardingPage {
      Text("Prepare this Mac")
        .font(.largeTitle.weight(.semibold))

      Text("Get Cued’s local-first setup in place: start on login, install the CLI, and grant the permissions your connectors need.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      onboardingCard {
        setupActionRow(
          title: viewModel.launchAgentLoaded ? "Run at login is enabled" : "Run at login is disabled",
          subtitle: "Launch the menu bar host and daemon automatically after login.",
          systemImage: "powerplug.fill",
          status: viewModel.launchAgentLoaded ? "On" : "Off",
          tone: viewModel.launchAgentLoaded ? .good : .neutral,
          buttonTitle: viewModel.launchAgentLoaded ? "Disable" : "Enable",
          buttonAction: onToggleLaunchAtLogin
        )

        Divider()

        setupActionRow(
          title: viewModel.cliStatus?.installed == true ? "Command line access is ready" : "Install the cued CLI",
          subtitle: viewModel.cliStatus?.path ?? "\(NSHomeDirectory())/.local/bin/cued",
          systemImage: "terminal.fill",
          status: viewModel.cliStatus?.installed == true ? "Installed" : "Not installed",
          tone: viewModel.cliStatus?.installed == true ? .good : .neutral,
          buttonTitle: viewModel.cliStatus?.installed == true ? "Reinstall" : "Install",
          buttonAction: onInstallCLI
        )

        Divider()

        setupActionRow(
          title: "Grant macOS permissions",
          subtitle: "Contacts access and Full Disk Access unlock local connectors like Contacts.app and Messages.",
          systemImage: "hand.raised.fill",
          status: viewModel.permissionNeeded ? "Needed" : "Ready",
          tone: viewModel.permissionNeeded ? .warning : .good,
          buttonTitle: "Open",
          buttonAction: onRequestPermissions
        )
      }

      onboardingCard(spacing: 14) {
        HStack {
          statusPill(text: viewModel.daemonStatusLabel, tone: viewModel.daemonStatusTone)
          statusPill(text: "\(viewModel.connectedCount) connected", tone: viewModel.connectedCount > 0 ? .good : .neutral)
          if let snapshot = viewModel.snapshot {
            statusPill(text: "\(snapshot.messages) messages", tone: .neutral)
          }
          Spacer(minLength: 0)
          Button("Refresh", action: onRefresh)
            .buttonStyle(.link)
        }

        Text("You can continue through the wizard now and come back later. The menu bar app keeps this setup page available after install.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var connectorsPage: some View {
    onboardingPage {
      Text("Choose platforms and accounts")
        .font(.largeTitle.weight(.semibold))

      Text("Pick the platforms Cued should sync on this Mac, then connect the accounts you want under each one. Multi-account sources like Slack can keep more than one account active.")
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
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
              VStack(alignment: .leading, spacing: 4) {
                Text("No connectors are available yet")
                  .font(.headline)
                Text("Connectors appear here as soon as the daemon reports supported integrations for this Mac.")
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            }
            Button("Refresh", action: onRefresh)
              .buttonStyle(.link)
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

  private var readyPage: some View {
    onboardingPage {
      Text("Finish setup")
        .font(.largeTitle.weight(.semibold))

      Text("Cued is ready to run as a local datastore for agents. Finish now, or review the current machine state one last time.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 520)

      onboardingCard {
        metricRow(label: "Daemon", value: viewModel.daemonStatusLabel)
        Divider()
        metricRow(label: "Contacts", value: "\(viewModel.snapshot?.contacts ?? 0)")
        Divider()
        metricRow(label: "Conversations", value: "\(viewModel.snapshot?.conversations ?? 0)")
        Divider()
        metricRow(label: "Messages", value: "\(viewModel.snapshot?.messages ?? 0)")
        Divider()
        metricRow(label: "Raw events", value: "\(viewModel.snapshot?.rawEvents ?? 0)")
      }

      onboardingCard {
        featureRow(
          title: "Open the menu bar app",
          subtitle: "Reopen this setup wizard or inspect the daemon from the Cued status item.",
          systemImage: "menubar.rectangle"
        )
        featureRow(
          title: "Connect more sources later",
          subtitle: "Permissions and integration setup are safe to stage over time.",
          systemImage: "link.circle"
        )
        featureActionRow(
          title: "Check releases",
          subtitle: "Open the latest Cued release notes in GitHub.",
          systemImage: "sparkles",
          buttonTitle: "View releases",
          action: onOpenReleases
        )
      }
    }
  }

  private func setupActionRow(
    title: String,
    subtitle: String,
    systemImage: String,
    status: String,
    tone: InstallerBadgeTone,
    buttonTitle: String,
    buttonAction: @escaping () -> Void
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: systemImage)
        .font(.title3.weight(.semibold))
        .foregroundStyle(Color.accentColor)
        .frame(width: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline)
        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      VStack(alignment: .trailing, spacing: 8) {
        statusPill(text: status, tone: tone)
        Button(buttonTitle, action: buttonAction)
          .buttonStyle(.borderedProminent)
          .controlSize(.regular)
      }
    }
    .padding(.vertical, 2)
  }

  private func platformConfigurationCard(_ configuration: InstallerPlatformConfiguration) -> some View {
    let selection = platformSelectionBinding(for: configuration)
    let status = platformStatus(for: configuration, isSelected: selection.wrappedValue)

    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: connectorSymbol(for: configuration.platform))
          .font(.title3.weight(.semibold))
          .foregroundStyle(Color.accentColor)
          .frame(width: 26)

        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 8) {
            Text(configuration.title)
              .font(.headline)
            if configuration.supportsMultipleAccounts {
              statusPill(text: "Multi-account", tone: .neutral)
            }
          }
          Text(platformDetail(for: configuration, isSelected: selection.wrappedValue))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 12)

        VStack(alignment: .trailing, spacing: 8) {
          statusPill(text: status.text, tone: status.tone)
          VStack(alignment: .trailing, spacing: 4) {
            Text("Sync")
              .font(.caption.weight(.medium))
              .foregroundStyle(.secondary)
            Toggle("", isOn: selection)
              .labelsHidden()
          }
        }
      }

      if configuration.supportsMultipleAccounts {
        multiAccountPlatformRows(configuration, isSelected: selection.wrappedValue)
      } else if let integration = configuration.accounts.first ?? configuration.placeholder {
        singleAccountPlatformRow(configuration, integration: integration, isSelected: selection.wrappedValue)
      }
    }
    .padding(.vertical, 2)
  }

  private func singleAccountPlatformRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus,
    isSelected: Bool
  ) -> some View {
    let accountStatus = connectorStatus(for: integration)
    let action = accountAction(for: configuration, integration: integration, isSelected: isSelected)

    return HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(singleAccountDetail(for: configuration, integration: integration))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      VStack(alignment: .trailing, spacing: 8) {
        statusPill(text: accountStatus.text, tone: accountStatus.tone)
        if let action {
          actionButton(title: action.title, prominent: action.prominent, action: action.handler)
            .disabled(viewModel.isRefreshing)
        }
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(Color(NSColor.controlBackgroundColor).opacity(0.7))
    )
  }

  private func multiAccountPlatformRows(
    _ configuration: InstallerPlatformConfiguration,
    isSelected: Bool
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if configuration.accounts.isEmpty {
        Text(isSelected
          ? "No accounts connected yet."
          : "Sync is off. Turn it on when you want to add accounts.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        ForEach(Array(configuration.accounts.enumerated()), id: \.element.id) { index, integration in
          multiAccountRow(configuration, integration: integration, isSelected: isSelected)
          if index < configuration.accounts.count - 1 {
            Divider()
          }
        }
      }

      if let action = platformLevelAction(for: configuration, isSelected: isSelected) {
        HStack {
          Spacer(minLength: 0)
          actionButton(title: action.title, prominent: action.prominent, action: action.handler)
            .disabled(viewModel.isRefreshing)
        }
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(Color(NSColor.controlBackgroundColor).opacity(0.7))
    )
  }

  private func multiAccountRow(
    _ configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus,
    isSelected: Bool
  ) -> some View {
    let accountStatus = connectorStatus(for: integration)
    let action = accountAction(for: configuration, integration: integration, isSelected: isSelected)

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

      VStack(alignment: .trailing, spacing: 8) {
        statusPill(text: accountStatus.text, tone: accountStatus.tone)
        if let action {
          actionButton(title: action.title, prominent: action.prominent, action: action.handler)
            .disabled(viewModel.isRefreshing)
        }
      }
    }
  }

  @ViewBuilder
  private func actionButton(
    title: String,
    prominent: Bool,
    action: @escaping () -> Void
  ) -> some View {
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

  private func platformSelectionBinding(for configuration: InstallerPlatformConfiguration) -> Binding<Bool> {
    Binding(
      get: { viewModel.isPlatformSelected(configuration.platform) },
      set: { selected in
        viewModel.setPlatformSelected(configuration.platform, selected: selected)
        onSetPlatformSelection(configuration.platform, selected)
      }
    )
  }

  private func platformStatus(
    for configuration: InstallerPlatformConfiguration,
    isSelected: Bool
  ) -> (text: String, tone: InstallerBadgeTone) {
    if configuration.capability.availability == "unsupported" {
      return ("Unsupported", .neutral)
    }
    if configuration.capability.availability == "requires_permission" {
      return (isSelected ? "Needs access" : "Off", isSelected ? .warning : .neutral)
    }
    if configuration.capability.availability == "requires_helper" {
      return ("Needs helper", .warning)
    }
    if !isSelected {
      return ("Off", .neutral)
    }
    if configuration.connectedAccountCount > 1 {
      return ("\(configuration.connectedAccountCount) connected", .good)
    }
    if configuration.connectedAccountCount == 1 {
      return ("Connected", .good)
    }
    if configuration.hasInProgressState {
      return ("Connecting", .warning)
    }
    if configuration.hasBlockingState {
      return ("Blocked", .danger)
    }
    if configuration.supportsMultipleAccounts && !configuration.accounts.isEmpty {
      return ("\(configuration.accounts.count) accounts", .neutral)
    }
    return ("Ready", .neutral)
  }

  private func platformDetail(
    for configuration: InstallerPlatformConfiguration,
    isSelected: Bool
  ) -> String {
    var parts = [isSelected ? "Sync is on" : "Sync is off"]
    if let reason = configuration.capability.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !reason.isEmpty,
       configuration.capability.availability != "available" {
      parts.append(reason)
    } else if configuration.supportsMultipleAccounts {
      let count = configuration.accounts.count
      parts.append(count == 0 ? "Connect one or more accounts." : "\(count) account\(count == 1 ? "" : "s") configured.")
    } else if let integration = configuration.accounts.first ?? configuration.placeholder {
      parts.append(singleAccountDetail(for: configuration, integration: integration))
    }
    return parts.joined(separator: " ")
  }

  private func singleAccountDetail(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus
  ) -> String {
    if configuration.needsPermission {
      return "Grant the required macOS access for this source."
    }
    if configuration.capability.availability == "requires_helper" {
      return "Install the required helper before connecting this source."
    }
    if configuration.isRequestable {
      return installerIsConnectedIntegrationState(integration.authState)
        ? "Account connected and ready to sync."
        : "Connect this account when you’re ready."
    }
    return installerIsConnectedIntegrationState(integration.authState)
      ? "This local source is available on this Mac."
      : connectorDetail(integration)
  }

  private func connectorStatus(for integration: InstallerIntegrationStatus) -> (text: String, tone: InstallerBadgeTone) {
    switch integration.capability.availability {
    case "unsupported":
      return ("Unsupported", .neutral)
    case "requires_permission":
      return ("Needs access", .warning)
    case "requires_helper":
      return ("Needs helper", .warning)
    default:
      if installerIsConnectedIntegrationState(integration.authState) {
        return (integration.enabled ? "Connected" : "Disabled", integration.enabled ? .good : .neutral)
      }
      if integration.authState == "requested" || integration.authState == "in_progress" {
        return ("Connecting", .warning)
      }
      if integration.authState == "blocked" || integration.authState == "check_failed" {
        return ("Blocked", .danger)
      }
      return (integration.enabled ? "Ready" : "Disabled", .neutral)
    }
  }

  private func accountAction(
    for configuration: InstallerPlatformConfiguration,
    integration: InstallerIntegrationStatus,
    isSelected: Bool
  ) -> (title: String, prominent: Bool, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return ("Grant access", true, onRequestPermissions)
    }
    guard configuration.isRequestable else {
      return nil
    }

    let isConnected = installerIsConnectedIntegrationState(integration.authState)
    let title = isConnected ? "Reconnect" : "Connect"
    return (
      title,
      !isConnected && isSelected,
      { onConnectIntegration(configuration.platform, integration.accountKey) }
    )
  }

  private func platformLevelAction(
    for configuration: InstallerPlatformConfiguration,
    isSelected: Bool
  ) -> (title: String, prominent: Bool, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return ("Grant access", true, onRequestPermissions)
    }
    guard configuration.isConnectable else {
      return nil
    }

    if configuration.supportsMultipleAccounts {
      let title = configuration.accounts.isEmpty ? "Connect account" : "Add account"
      return (
        title,
        isSelected,
        {
          addAccountPrompt = InstallerAddAccountPrompt(
            platform: configuration.platform,
            platformTitle: configuration.title,
            suggestedAccountKey: viewModel.suggestedAccountKey(for: configuration.platform)
          )
        }
      )
    }

    if let integration = configuration.placeholder {
      let isConnected = installerIsConnectedIntegrationState(integration.authState)
      return (
        isConnected ? "Reconnect" : "Connect",
        !isConnected && isSelected,
        { onConnectIntegration(configuration.platform, integration.accountKey) }
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
    var parts = [installerIntegrationStateLabel(integration.authState).capitalized]
    if integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) != integration.accountKey {
      parts.append(integration.accountKey)
    }
    return parts.joined(separator: " • ")
  }

  private func metricRow(label: String, value: String) -> some View {
    HStack(spacing: 12) {
      Text(label)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
      Spacer(minLength: 0)
      Text(value)
        .font(.system(.subheadline, design: .monospaced, weight: .semibold))
    }
  }

  private func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
    featureRowContent(title: title, subtitle: subtitle, systemImage: systemImage, action: nil)
  }

  private func featureActionRow(
    title: String,
    subtitle: String,
    systemImage: String,
    buttonTitle: String,
    action: @escaping () -> Void
  ) -> some View {
    featureRowContent(
      title: title,
      subtitle: subtitle,
      systemImage: systemImage,
      action: AnyView(
        Button(buttonTitle, action: action)
          .buttonStyle(.link)
          .padding(.top, 2)
      )
    )
  }

  private func featureRowContent(
    title: String,
    subtitle: String,
    systemImage: String,
    action: AnyView?
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: systemImage)
        .font(.title3.weight(.semibold))
        .foregroundStyle(Color.accentColor)
        .frame(width: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.headline)
        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
        if let action {
          action
        }
      }

      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
  }

  private func statusPill(text: String, tone: InstallerBadgeTone) -> some View {
    Text(text.uppercased())
      .font(.system(size: 11, weight: .semibold, design: .monospaced))
      .foregroundStyle(pillTextColor(for: tone))
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(
        Capsule(style: .continuous)
          .fill(pillBackgroundColor(for: tone))
      )
  }

  private func pillBackgroundColor(for tone: InstallerBadgeTone) -> Color {
    switch tone {
    case .good:
      return Color(nsColor: .systemGreen).opacity(0.14)
    case .warning:
      return Color(nsColor: .systemOrange).opacity(0.16)
    case .neutral:
      return Color(nsColor: .controlBackgroundColor)
    case .danger:
      return Color(nsColor: .systemRed).opacity(0.14)
    }
  }

  private func pillTextColor(for tone: InstallerBadgeTone) -> Color {
    switch tone {
    case .good:
      return Color(nsColor: .systemGreen)
    case .warning:
      return Color(nsColor: .systemOrange)
    case .neutral:
      return Color.secondary
    case .danger:
      return Color(nsColor: .systemRed)
    }
  }

  private func connectorDetail(_ integration: InstallerIntegrationStatus) -> String {
    var parts = [installerIntegrationStateLabel(integration.authState).capitalized]
    if let reason = integration.capability.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !reason.isEmpty {
      parts.append(reason)
    }
    return parts.joined(separator: " • ")
  }

  private func connectorSymbol(for platform: String) -> String {
    installerConnectorSymbol(for: platform)
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
      Text("Add \(platformTitle) account")
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

private struct GlowingCuedIcon: View {
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.scenePhase) private var scenePhase

  let size: CGFloat
  let glowIntensity: Double
  let enableFloating: Bool

  @State private var breathe = false

  init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
    self.size = size
    self.glowIntensity = glowIntensity
    self.enableFloating = enableFloating
  }

  var body: some View {
    let glowBlurRadius: CGFloat = 14
    let glowCanvasSize: CGFloat = size + 32
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [
              Color.accentColor.opacity(colorScheme == .dark ? glowIntensity : glowIntensity * 0.72),
              Color.blue.opacity(colorScheme == .dark ? glowIntensity * 0.58 : glowIntensity * 0.34),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
        .frame(width: glowCanvasSize, height: glowCanvasSize)
        .padding(glowBlurRadius)
        .blur(radius: glowBlurRadius)
        .scaleEffect(breathe ? 1.08 : 0.96)
        .opacity(0.84)

      CuedMark(size: size)
        .foregroundStyle(Color.primary.opacity(colorScheme == .dark ? 0.96 : 0.92))
        .shadow(
          color: colorScheme == .dark ? .black.opacity(0.18) : .black.opacity(0.1),
          radius: 10,
          y: 4
        )
        .scaleEffect(breathe ? 1.02 : 1.0)
    }
    .frame(
      width: glowCanvasSize + (glowBlurRadius * 2),
      height: glowCanvasSize + (glowBlurRadius * 2)
    )
    .onAppear { updateBreatheAnimation() }
    .onDisappear { breathe = false }
    .onChange(of: scenePhase) { _ in
      updateBreatheAnimation()
    }
  }

  private func updateBreatheAnimation() {
    guard enableFloating, scenePhase == .active else {
      breathe = false
      return
    }
    guard !breathe else {
      return
    }
    withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
      breathe = true
    }
  }
}

private struct CuedMark: View {
  let size: CGFloat

  var body: some View {
    let width = size * 0.8
    let outerCorner = size * (5.0 / 32.0)
    let innerCorner = size * (2.0 / 32.0)
    let innerWidth = size * (19.6 / 32.0)
    let innerHeight = size * (26.0 / 32.0)
    let cutoutSize = size * (26.0 / 32.0)
    let cutoutXOffset = size * (9.2 / 32.0)

    return RoundedRectangle(cornerRadius: outerCorner, style: .continuous)
      .fill(.foreground)
      .frame(width: width, height: size)
      .overlay {
        Circle()
          .fill(.white)
          .frame(width: cutoutSize, height: cutoutSize)
          .offset(x: cutoutXOffset)
          .mask {
            RoundedRectangle(cornerRadius: innerCorner, style: .continuous)
              .frame(width: innerWidth, height: innerHeight)
          }
          .blendMode(.destinationOut)
      }
      .compositingGroup()
      .frame(width: width, height: size)
      .accessibilityHidden(true)
  }
}

private func installerIsConnectedIntegrationState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

private func installerIntegrationStateLabel(_ value: String) -> String {
  switch value {
  case "authorized", "authenticated":
    return "connected"
  case "in_progress":
    return "connecting"
  case "needs_full_disk_access":
    return "needs full disk access"
  case "native_helper_missing":
    return "needs native helper"
  case "check_failed":
    return "check failed"
  case "missing":
    return "missing"
  case "blocked":
    return "blocked"
  case "not_determined":
    return "needs permission"
  case "cancelled":
    return "disconnected"
  default:
    return value.replacingOccurrences(of: "_", with: " ")
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

private func installerIsRequestablePlatform(_ platform: String) -> Bool {
  switch platform {
  case "linkedin", "signal", "slack", "whatsapp":
    return true
  default:
    return false
  }
}

private func installerConnectorSymbol(for platform: String) -> String {
  switch platform {
  case "contacts":
    return "person.crop.circle"
  case "imessage":
    return "message.fill"
  case "slack":
    return "bubble.left.and.bubble.right.fill"
  case "linkedin":
    return "person.2.square.stack.fill"
  case "signal":
    return "lock.bubble.left.fill"
  case "whatsapp":
    return "phone.connection.fill"
  default:
    return "link.circle.fill"
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
