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

struct InstallerSkillInstallResponse: Decodable {
  let ok: Bool
  let error: String?
}

struct InstallerOnboardingSnapshotResponse: Decodable {
  let permissions: [InstallerPermissionStatus]
  let globalSkill: InstallerGlobalSkillStatus
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
  private var pendingPermissionRefreshTask: Task<Void, Never>?
  private var pendingLivePermissionKeys = Set<String>()
  private var pendingLivePermissionDeadline: Date?
  private var pendingRefreshAfterCurrent = false
  private var pendingForceActivePermissionRefreshAfterCurrent = false

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
        onGuidePermission: { [weak self] key in self?.guidePermission(key: key) },
        onDismissPermissionGuide: { PermissionGuideAssistant.shared.dismiss() },
        onRequestPermission: { [weak self] flags in self?.requestPermission(flags: flags) },
        onInstallGlobalSkill: { [weak self] in self?.installGlobalSkill() },
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

  func showAndRefresh(forceActivePermissionRefresh: Bool = false) {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    refresh(forceActivePermissionRefresh: forceActivePermissionRefresh)
  }

  func refresh(forceActivePermissionRefresh: Bool = false) {
    guard !isRefreshing else {
      pendingRefreshAfterCurrent = true
      pendingForceActivePermissionRefreshAfterCurrent =
        pendingForceActivePermissionRefreshAfterCurrent || forceActivePermissionRefresh
      return
    }
    isRefreshing = true
    viewModel.beginRefresh()

    let daemonSupervisor = self.daemonSupervisor
    let shouldEnsurePrerequisites = consumePrerequisiteSetupFlag()
    let shouldRefreshPermissions = forceActivePermissionRefresh || shouldRefreshPermissionsActively()

    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      let snapshot = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerOnboardingSnapshotResponse.self,
        arguments: ["onboarding", "snapshot"] + (shouldRefreshPermissions ? ["--refresh-permissions"] : [])
      )
      let globalSkill = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        InstallerGlobalSkillStatus.self,
        arguments: ["skill", "status"]
      ) ?? snapshot?.globalSkill ?? InstallerGlobalSkillStatus(
        installed: false,
        status: "unknown",
        summary: "Checks whether the global Cued skill is available to your agents."
      )

      await MainActor.run {
        self.cachedPermissions = snapshot?.permissions ?? []
        self.cachedAllIntegrations = snapshot?.integrations ?? []
        self.cachedSetupIntegrations = (snapshot?.setupIntegrations ?? []).filter {
          $0.capability.onboardingVisible
        }
        self.resolvePendingLivePermissions(using: snapshot?.permissions ?? [])
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: snapshot?.permissions ?? [],
          globalSkill: globalSkill,
          allIntegrations: self.cachedAllIntegrations,
          integrations: self.cachedSetupIntegrations
        )
        self.schedulePermissionRefreshRetry()
        self.schedulePendingStatusRefreshIfNeeded()
        self.runPendingRefreshIfNeeded()
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
    if onboardingPermissionKeys(for: flags).contains("full_disk_access") {
      markPermissionRelaunchSetupIntent()
    }
    markPendingLivePermissions(flags: flags)
    runActions(
      argumentsList: [["permissions", "request"] + flags],
      forceActivePermissionRefreshAfter: onboardingShouldRefreshPermissionsActively(for: flags)
    )
  }

  private func guidePermission(key: String) {
    guard let panel = onboardingGuidePanel(for: key) else {
      return
    }
    if key == "full_disk_access" {
      markPermissionRelaunchSetupIntent()
    }
    PermissionGuideAssistant.shared.present(panel: panel)
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

  private func installGlobalSkill() {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor

    Task(priority: .userInitiated) { [daemonSupervisor] in
      let installCommandResult = await Task.detached(priority: .userInitiated) { [daemonSupervisor] in
        daemonSupervisor.runCLI(arguments: ["skill", "install-global"])
      }.value
      let installResult: InstallerSkillInstallResponse? =
        installCommandResult.flatMap { result in
          guard result.status == 0, let data = result.stdout.data(using: .utf8) else {
            return nil
          }
          return try? JSONDecoder().decode(InstallerSkillInstallResponse.self, from: data)
        }
      let installFailed = ((installCommandResult?.status ?? 1) != 0 || installResult?.ok == false)

      refresh()
      if installFailed {
        let alert = NSAlert()
        alert.messageText = "Cued could not install the global skill."
        let stderr = installCommandResult?.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallbackMessage =
          (stderr?.isEmpty == false ? stderr : nil)
          ?? "Run `cued skill install-global` from Terminal to retry."
        alert.informativeText =
          installResult?.error
          ?? fallbackMessage
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
      }
    }
  }

  private func finishOnboarding() {
    let daemonSupervisor = self.daemonSupervisor
    close()
    onRefresh()
    Task.detached(priority: .utility) { [daemonSupervisor] in
      _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    }
  }

  override func close() {
    pendingRefreshAfterCurrent = false
    pendingForceActivePermissionRefreshAfterCurrent = false
    pendingAuthKickoffRefreshTask?.cancel()
    pendingAuthKickoffRefreshTask = nil
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil
    pendingPermissionRefreshTask?.cancel()
    pendingPermissionRefreshTask = nil
    PermissionGuideAssistant.shared.dismiss()
    super.close()
  }

  private func runPendingRefreshIfNeeded() {
    guard pendingRefreshAfterCurrent else {
      return
    }
    let forceActivePermissionRefresh = pendingForceActivePermissionRefreshAfterCurrent
    pendingRefreshAfterCurrent = false
    pendingForceActivePermissionRefreshAfterCurrent = false
    refresh(forceActivePermissionRefresh: forceActivePermissionRefresh)
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
      for delay in [200, 700, 1_500, 3_000, 6_000, 10_000] {
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

  private func runActions(
    argumentsList: [[String]],
    forceActivePermissionRefreshAfter: Bool
  ) {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      for arguments in argumentsList {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
      await MainActor.run {
        self.onRefresh()
        self.refresh(forceActivePermissionRefresh: forceActivePermissionRefreshAfter)
      }
    }
  }

  private func shouldRefreshPermissionsActively() -> Bool {
    guard !pendingLivePermissionKeys.isEmpty else {
      pendingLivePermissionDeadline = nil
      return false
    }
    guard let deadline = pendingLivePermissionDeadline else {
      return false
    }
    if deadline <= Date() {
      pendingLivePermissionKeys.removeAll()
      pendingLivePermissionDeadline = nil
      return false
    }
    return pendingLivePermissionKeys.contains("full_disk_access")
  }

  private func markPendingLivePermissions(flags: [String]) {
    pendingLivePermissionKeys.formUnion(
      onboardingPermissionKeys(for: flags).filter(isRetryablePermissionKey)
    )
    if !pendingLivePermissionKeys.isEmpty {
      pendingLivePermissionDeadline = Date().addingTimeInterval(30)
    }
  }

  private func resolvePendingLivePermissions(using permissions: [InstallerPermissionStatus]) {
    guard !pendingLivePermissionKeys.isEmpty else {
      pendingLivePermissionDeadline = nil
      return
    }

    let grantedKeys = Set(permissions.filter { $0.status == "granted" }.map(\.key))
    pendingLivePermissionKeys.subtract(grantedKeys)
    if pendingLivePermissionKeys.isEmpty {
      pendingLivePermissionDeadline = nil
      pendingPermissionRefreshTask?.cancel()
      pendingPermissionRefreshTask = nil
    }
  }

  private func schedulePermissionRefreshRetry() {
    guard !pendingLivePermissionKeys.isEmpty else {
      pendingPermissionRefreshTask?.cancel()
      pendingPermissionRefreshTask = nil
      return
    }

    pendingPermissionRefreshTask?.cancel()
    pendingPermissionRefreshTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(900))
      guard !Task.isCancelled else {
        return
      }
      await MainActor.run {
        guard let self else {
          return
        }
        self.pendingPermissionRefreshTask = nil
        self.refresh()
      }
    }
  }

}

func onboardingPermissionKeys(for flags: [String]) -> Set<String> {
  if flags.contains("--all") {
    return ["contacts", "full_disk_access"]
  }

  var keys = Set<String>()
  if flags.contains("--contacts") {
    keys.insert("contacts")
  }
  if flags.contains("--full-disk-access") {
    keys.insert("full_disk_access")
  }
  return keys
}

func onboardingShouldRetryPermissionRefresh(for flags: [String]) -> Bool {
  onboardingPermissionKeys(for: flags).contains(where: isRetryablePermissionKey)
}

func onboardingShouldRefreshPermissionsActively(for flags: [String]) -> Bool {
  let keys = onboardingPermissionKeys(for: flags)
  return keys.contains("full_disk_access")
}

func isRetryablePermissionKey(_ key: String) -> Bool {
  key == "full_disk_access"
}
