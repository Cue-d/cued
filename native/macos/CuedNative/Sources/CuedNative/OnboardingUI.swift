import AppKit
import SwiftUI

struct InstallerCapabilityStatus: Decodable {
  let availability: String
  let onboardingVisible: Bool
  let reason: String?
}

struct InstallerIntegrationStatus: Decodable, Identifiable {
  let platform: String
  let accountKey: String
  let displayName: String?
  let authState: String
  let capability: InstallerCapabilityStatus

  var id: String { "\(platform):\(accountKey)" }
}

struct InstallerIntegrationStatusResponse: Decodable {
  let hostOs: String
  let setupIntegrations: [InstallerIntegrationStatus]
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
  @Published var integrations: [InstallerIntegrationStatus] = []
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
    integrations.contains { $0.capability.availability == "requires_permission" }
  }

  func beginRefresh() {
    isRefreshing = true
  }

  func apply(
    snapshot: AppStatusSnapshot,
    integrations: [InstallerIntegrationStatus],
    launchAgentLoaded: Bool,
    cliStatus: InstallerCLISymlinkStatusResponse?
  ) {
    self.snapshot = snapshot
    self.integrations = integrations
    self.launchAgentLoaded = launchAgentLoaded
    self.cliStatus = cliStatus
    isRefreshing = false
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
        onConnectIntegration: { [weak self] integration in self?.handleIntegrationAction(integration) },
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

    DispatchQueue.global(qos: .userInitiated).async {
      _ = daemonSupervisor.runCLI(arguments: ["integrations", "refresh"])
      let snapshot = statusStore.readSnapshot()
      let integrations = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerIntegrationStatusResponse.self,
        arguments: ["integrations", "status"]
      ) ?? InstallerIntegrationStatusResponse(hostOs: "macos", setupIntegrations: [])
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

      DispatchQueue.main.async {
        self.isRefreshing = false
        self.viewModel.apply(
          snapshot: snapshot,
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

  private static func decodeJSON<T: Decodable>(
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
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    DispatchQueue.global(qos: .userInitiated).async {
      _ = daemonSupervisor.runCLI(arguments: arguments)
      DispatchQueue.main.async {
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

  private func handleIntegrationAction(_ integration: InstallerIntegrationStatus) {
    if integration.capability.availability == "requires_permission" {
      requestPermissions()
      return
    }
    runAction(arguments: ["integrations", "connect", integration.platform, integration.accountKey])
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
  let onConnectIntegration: (InstallerIntegrationStatus) -> Void
  let onOpenReleases: () -> Void
  let onFinish: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      GlowingCuedIcon(size: 130, glowIntensity: 0.28)
        .offset(y: 10)
        .frame(height: 145)

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
      Text("Connect local sources")
        .font(.largeTitle.weight(.semibold))

      Text("Review the connectors Cued detected on this Mac. Grant access where needed, connect what you want now, and skip the rest until later.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      onboardingCard {
        if viewModel.integrations.isEmpty {
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
          ForEach(Array(viewModel.integrations.enumerated()), id: \.element.id) { index, integration in
            connectorRow(integration)
            if index < viewModel.integrations.count - 1 {
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

  private func connectorRow(_ integration: InstallerIntegrationStatus) -> some View {
    let buttonTitle: String
    if integration.capability.availability == "requires_permission" {
      buttonTitle = "Grant"
    } else if installerIsConnectedIntegrationState(integration.authState) {
      buttonTitle = "Reconnect"
    } else {
      buttonTitle = "Connect"
    }

    let statusText: String
    let tone: InstallerBadgeTone
    switch integration.capability.availability {
    case "unsupported":
      statusText = "Unsupported"
      tone = .neutral
    case "requires_permission":
      statusText = "Needs access"
      tone = .warning
    default:
      if installerIsConnectedIntegrationState(integration.authState) {
        statusText = "Connected"
        tone = .good
      } else if integration.authState == "blocked" || integration.authState == "check_failed" {
        statusText = "Blocked"
        tone = .danger
      } else {
        statusText = "Ready"
        tone = .neutral
      }
    }

    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: connectorSymbol(for: integration))
        .font(.title3.weight(.semibold))
        .foregroundStyle(Color.accentColor)
        .frame(width: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(connectorTitle(integration))
          .font(.headline)
        Text(connectorDetail(integration))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 12)

      VStack(alignment: .trailing, spacing: 8) {
        statusPill(text: statusText, tone: tone)
        if integration.capability.availability != "unsupported" {
          if installerIsConnectedIntegrationState(integration.authState) {
            Button(buttonTitle) {
              onConnectIntegration(integration)
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
          } else {
            Button(buttonTitle) {
              onConnectIntegration(integration)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
          }
        }
      }
    }
    .padding(.vertical, 2)
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

  private func connectorTitle(_ integration: InstallerIntegrationStatus) -> String {
    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      return title
    }
    return integration.platform.capitalized
  }

  private func connectorDetail(_ integration: InstallerIntegrationStatus) -> String {
    var parts = [installerIntegrationStateLabel(integration.authState).capitalized]
    if let reason = integration.capability.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !reason.isEmpty {
      parts.append(reason)
    }
    return parts.joined(separator: " • ")
  }

  private func connectorSymbol(for integration: InstallerIntegrationStatus) -> String {
    switch integration.platform {
    case "contacts":
      return "person.crop.circle"
    case "imessage":
      return "message.fill"
    case "whatsapp":
      return "phone.connection.fill"
    case "telegram":
      return "paperplane.fill"
    default:
      return "link.circle.fill"
    }
  }
}

private struct GlowingCuedIcon: View {
  @Environment(\.scenePhase) private var scenePhase

  let size: CGFloat
  let glowIntensity: Double
  let enableFloating: Bool

  @State private var breathe = false

  private var heroImage: NSImage {
    if let image = Self.loadBundledCuedMark() {
      return image
    }
    return NSApp.applicationIconImage
  }

  init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
    self.size = size
    self.glowIntensity = glowIntensity
    self.enableFloating = enableFloating
  }

  var body: some View {
    let glowBlurRadius: CGFloat = 18
    let glowCanvasSize: CGFloat = size + 56
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [
              Color.accentColor.opacity(glowIntensity),
              Color.blue.opacity(glowIntensity * 0.6),
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

      Image(nsImage: heroImage)
        .resizable()
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
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

  private static func loadBundledCuedMark() -> NSImage? {
    let candidates = [
      Bundle.main.path(forResource: "cued-mark", ofType: "png"),
      executableRelativeMarkPath(),
    ]

    for candidate in candidates {
      guard let candidate, let image = NSImage(contentsOfFile: candidate) else {
        continue
      }
      return image
    }

    return nil
  }

  private static func executableRelativeMarkPath() -> String? {
    guard let executablePath = Bundle.main.executablePath else {
      return nil
    }

    let executableURL = URL(fileURLWithPath: executablePath)
    let candidates = [
      executableURL
        .deletingLastPathComponent()
        .appendingPathComponent("../../Resources/cued-mark.png")
        .standardizedFileURL.path,
      executableURL
        .deletingLastPathComponent()
        .appendingPathComponent("../../../Resources/cued-mark.png")
        .standardizedFileURL.path,
    ]

    return candidates.first { FileManager.default.fileExists(atPath: $0) }
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
