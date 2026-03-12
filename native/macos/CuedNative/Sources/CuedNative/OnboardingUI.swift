import AppKit
import CuedNativeUI
import SwiftUI

struct InstallerLaunchAgentStatusResponse: Decodable {
  let loaded: Bool
}

struct InstallerCLISymlinkStatusResponse: Decodable {
  let installed: Bool
  let path: String
}

@MainActor
final class OnboardingWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let statusStore: AppStatusStore
  private let onRefresh: () -> Void
  private let viewModel = OnboardingViewModel()
  private var cachedPermissions: [InstallerPermissionStatus] = []
  private var cachedAllIntegrations: [InstallerIntegrationStatus] = []
  private var cachedSetupIntegrations: [InstallerIntegrationStatus] = []
  private var isRefreshing = false
  private var prerequisitesEnsured = false

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
        onRequestPermission: { [weak self] flags in self?.requestPermission(flags: flags) },
        onEnableIntegration: { [weak self] platform, accountKey in
          self?.enableIntegration(platform: platform, accountKey: accountKey)
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
    let statusStore = self.statusStore
    let shouldEnsurePrerequisites = consumePrerequisiteSetupFlag()

    Task.detached(priority: .userInitiated) { [daemonSupervisor, statusStore] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      let permissions = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerPermissionStatusResponse.self,
        arguments: ["permissions", "status"]
      ) ?? InstallerPermissionStatusResponse(permissions: [])

      await MainActor.run {
        self.cachedPermissions = permissions.permissions
        self.viewModel.apply(
          permissions: permissions.permissions,
          allIntegrations: self.cachedAllIntegrations,
          integrations: self.cachedSetupIntegrations
        )
        self.viewModel.isRefreshing = true
      }

      _ = daemonSupervisor.runCLI(arguments: ["integrations", "refresh"])
      let integrations = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerIntegrationStatusResponse.self,
        arguments: ["integrations", "status"]
      ) ?? InstallerIntegrationStatusResponse(hostOs: "macos", integrations: [], setupIntegrations: [])
      _ = statusStore.readSnapshot()

      await MainActor.run {
        self.cachedPermissions = permissions.permissions
        self.cachedAllIntegrations = integrations.integrations ?? []
        self.cachedSetupIntegrations = integrations.setupIntegrations.filter {
          $0.capability.onboardingVisible
        }
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: self.cachedPermissions,
          allIntegrations: self.cachedAllIntegrations,
          integrations: self.cachedSetupIntegrations
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
      InstallerLaunchAgentStatusResponse.self,
      arguments: ["launchd", "status"]
    )
    if launchAgentStatus?.loaded != true {
      _ = daemonSupervisor.runCLI(arguments: ["launchd", "install"])
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

  private func requestPermission(flags: [String]) {
    runActions(argumentsList: [["permissions", "request"] + flags])
  }

  private func enableIntegration(platform: String, accountKey: String) {
    runAction(arguments: ["integrations", "enable", platform, accountKey])
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
    runActions(argumentsList: actions)
  }

  private func finishOnboarding() {
    _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    close()
    onRefresh()
  }
}
