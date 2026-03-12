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

enum InstallerRefreshMode: Equatable {
  case full
  case statusOnly
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
  private var pendingStatusRefreshTask: Task<Void, Never>?

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

  func refresh(mode: InstallerRefreshMode = .full) {
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

      if mode == .full {
        let permissions = Self.decodeJSON(
          daemonSupervisor: daemonSupervisor,
          InstallerPermissionStatusResponse.self,
          arguments: ["permissions", "status"]
        ) ?? InstallerPermissionStatusResponse(permissions: [])

        let initialIntegrations = Self.decodeJSON(
          daemonSupervisor: daemonSupervisor,
          InstallerIntegrationStatusResponse.self,
          arguments: ["integrations", "status"]
        ) ?? InstallerIntegrationStatusResponse(hostOs: "macos", integrations: [], setupIntegrations: [])

        await MainActor.run {
          self.cachedPermissions = permissions.permissions
          self.cachedAllIntegrations = initialIntegrations.integrations ?? []
          self.cachedSetupIntegrations = initialIntegrations.setupIntegrations.filter {
            $0.capability.onboardingVisible
          }
          self.viewModel.apply(
            permissions: permissions.permissions,
            allIntegrations: self.cachedAllIntegrations,
            integrations: self.cachedSetupIntegrations
          )
          self.viewModel.isRefreshing = true
        }

        _ = daemonSupervisor.runCLI(arguments: ["integrations", "refresh"])
      }

      let integrations = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerIntegrationStatusResponse.self,
        arguments: ["integrations", "status"]
      ) ?? InstallerIntegrationStatusResponse(hostOs: "macos", integrations: [], setupIntegrations: [])
      _ = statusStore.readSnapshot()

      await MainActor.run {
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

  private func runActions(
    argumentsList: [[String]],
    refreshMode: InstallerRefreshMode = .full
  ) {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      for arguments in argumentsList {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
      await MainActor.run {
        self.onRefresh()
        self.refresh(mode: refreshMode)
      }
    }
  }

  private func requestPermission(flags: [String]) {
    runActions(argumentsList: [["permissions", "request"] + flags], refreshMode: .full)
  }

  private func enableIntegration(platform: String, accountKey: String) {
    runActions(
      argumentsList: [["integrations", "enable", platform, accountKey]],
      refreshMode: .statusOnly
    )
  }

  private func removeIntegration(platform: String, accountKey: String) {
    runActions(
      argumentsList: [["integrations", "remove", platform, accountKey]],
      refreshMode: .statusOnly
    )
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
    runActions(argumentsList: actions, refreshMode: .statusOnly)
  }

  private func finishOnboarding() {
    _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    close()
    onRefresh()
  }

  override func close() {
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil
    super.close()
  }

  private func schedulePendingStatusRefreshIfNeeded() {
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil

    let hasPendingAuth = cachedSetupIntegrations.contains {
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
        self?.refresh(mode: .statusOnly)
      }
    }
  }
}
