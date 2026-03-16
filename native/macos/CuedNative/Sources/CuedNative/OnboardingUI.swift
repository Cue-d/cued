import AppKit
import CuedNativeUI
import SwiftUI

struct InstallerLoginItemStatusResponse: Decodable {
  let enabled: Bool
  let status: String
}

struct InstallerCLISymlinkStatusResponse: Decodable {
  let installed: Bool
  let path: String
}

struct InstallerOnboardingSnapshotResponse: Decodable {
  let permissions: [InstallerPermissionStatus]
  let hostOs: String
  let integrations: [InstallerIntegrationStatus]?
  let setupIntegrations: [InstallerIntegrationStatus]
}

@MainActor
final class OnboardingWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let onRefresh: () -> Void
  private let viewModel = OnboardingViewModel()
  private var cachedPermissions: [InstallerPermissionStatus] = []
  private var cachedAllIntegrations: [InstallerIntegrationStatus] = []
  private var cachedSetupIntegrations: [InstallerIntegrationStatus] = []
  private var isRefreshing = false
  private var prerequisitesEnsured = false
  private var pendingAuthKickoffRefreshTask: Task<Void, Never>?
  private var pendingStatusRefreshTask: Task<Void, Never>?

  init(daemonSupervisor: DaemonSupervisor, onRefresh: @escaping () -> Void) {
    self.daemonSupervisor = daemonSupervisor
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
    window.title = "Cued Settings"
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
        onRequestPermission: { [weak self] flags in self?.requestPermission(flags: flags) },
        onEnableIntegration: { [weak self] platform, accountKey in
          self?.enableIntegration(platform: platform, accountKey: accountKey)
        },
        onRemoveIntegration: { [weak self] platform, accountKey in
          self?.removeIntegration(platform: platform, accountKey: accountKey)
        },
        onConnectIntegration: { [weak self] platform, accountKey in
          self?.handleIntegrationAction(platform: platform, accountKey: accountKey)
        },
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
    let shouldEnsurePrerequisites = consumePrerequisiteSetupFlag()

    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      let snapshot = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerOnboardingSnapshotResponse.self,
        arguments: ["onboarding", "snapshot"]
      ) ?? InstallerOnboardingSnapshotResponse(
        permissions: [],
        hostOs: "macos",
        integrations: [],
        setupIntegrations: []
      )

      await MainActor.run {
        self.cachedPermissions = snapshot.permissions
        self.cachedAllIntegrations = snapshot.integrations ?? []
        self.cachedSetupIntegrations = snapshot.setupIntegrations.filter {
          $0.capability.onboardingVisible
        }
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: snapshot.permissions,
          allIntegrations: self.cachedAllIntegrations,
          integrations: self.cachedSetupIntegrations
        )
        self.schedulePendingStatusRefreshIfNeeded()
      }
    }
  }

  func openReleasesPage() {
    guard let url = URL(string: "https://github.com/Cue-d/cued/releases") else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  private func consumePrerequisiteSetupFlag() -> Bool {
    guard !prerequisitesEnsured, installerShouldAutoConfigurePrerequisites() else {
      return false
    }
    prerequisitesEnsured = true
    return true
  }

  private nonisolated static func ensurePrerequisites(daemonSupervisor: DaemonSupervisor) {
    let launchAgentStatus = decodeJSON(
      daemonSupervisor: daemonSupervisor,
      InstallerLoginItemStatusResponse.self,
      arguments: ["login-item", "status"]
    )
    if launchAgentStatus?.enabled != true && launchAgentStatus?.status != "requires_approval" {
      _ = daemonSupervisor.runCLI(arguments: ["login-item", "enable"])
    }

    let cliStatus = decodeJSON(
      daemonSupervisor: daemonSupervisor,
      InstallerCLISymlinkStatusResponse.self,
      arguments: ["cli", "status"]
    )
    if cliStatus?.installed != true {
      _ = daemonSupervisor.runCLI(arguments: ["cli", "install"])
    }
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

  private func runActions(
    argumentsList: [[String]]
  ) {
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

  private func requestPermission(flags: [String]) {
    runActions(argumentsList: [["permissions", "request"] + flags])
  }

  private func enableIntegration(platform: String, accountKey: String) {
    runActions(argumentsList: [["integrations", "enable", platform, accountKey]])
  }

  private func removeIntegration(platform: String, accountKey: String) {
    runActions(argumentsList: [["integrations", "remove", platform, accountKey]])
  }

  private func handleIntegrationAction(platform: String, accountKey: String) {
    guard let configuration = viewModel.configuration(for: platform),
          configuration.capability.availability != "unsupported",
          configuration.capability.availability != "requires_helper",
          !configuration.needsPermission else {
      return
    }

    var actions = [[String]]()
    if configuration.accounts.contains(where: { $0.accountKey == accountKey && !$0.enabled }) {
      actions.append(["integrations", "enable", platform, accountKey])
    }
    actions.append(["integrations", "connect", platform, accountKey])
    runConnectActions(argumentsList: actions)
  }

  private func finishOnboarding() {
    _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    close()
    onRefresh()
  }

  override func close() {
    pendingAuthKickoffRefreshTask?.cancel()
    pendingAuthKickoffRefreshTask = nil
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil
    super.close()
  }

  private func runConnectActions(argumentsList: [[String]]) {
    guard let connectArguments = argumentsList.last else {
      return
    }

    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    let setupArguments = Array(argumentsList.dropLast())
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      for arguments in setupArguments {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
      let launched = daemonSupervisor.launchCLI(arguments: connectArguments)
      await MainActor.run {
        self.onRefresh()
        if launched {
          self.scheduleAuthKickoffRefresh()
        } else {
          self.refresh()
        }
      }
    }
  }

  private func schedulePendingStatusRefreshIfNeeded() {
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil

    let hasPendingAuth = cachedAllIntegrations.contains {
      $0.authState == "requested" || $0.authState == "in_progress"
    }
    guard hasPendingAuth else {
      return
    }

    pendingStatusRefreshTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(700))
      guard !Task.isCancelled else {
        return
      }
      await MainActor.run {
        self?.refresh()
      }
    }
  }

  private func scheduleAuthKickoffRefresh() {
    pendingAuthKickoffRefreshTask?.cancel()
    pendingAuthKickoffRefreshTask = Task { [weak self] in
      for delay in [200, 700] {
        try? await Task.sleep(for: .milliseconds(delay))
        guard !Task.isCancelled else {
          return
        }
        await MainActor.run {
          self?.refresh()
        }
      }
      await MainActor.run {
        self?.pendingAuthKickoffRefreshTask = nil
      }
    }
  }
}
