import AppKit
import Interface
import SwiftUI

struct SkillInstallResponse: Decodable {
  let ok: Bool
  let error: String?
}

struct RootSnapshotResponse: Decodable {
  let permissions: [PermissionStatus]
  let globalSkill: SkillStatus
  let integrations: [IntegrationStatus]?
  let setupIntegrations: [IntegrationStatus]
}

private let liveRefreshPermissionKeys: Set<String> = ["messages_automation", "full_disk_access"]

@MainActor
final class RootWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let onRefresh: () -> Void
  private let viewModel = RootViewModel()
  private var cachedAllIntegrations: [IntegrationStatus] = []
  private var isRefreshing = false
  private var didEnsurePrerequisites = false
  private var pendingAuthLaunchRefreshTask: Task<Void, Never>?
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
        width: RootViewModel.windowWidth,
        height: RootViewModel.windowHeight
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
      rootView: RootView(
        viewModel: viewModel,
        onRefresh: { [weak self] in self?.refresh() },
        onGuidePermission: { [weak self] key in self?.guidePermission(key: key) },
        onDismissPermissionGuide: { PermissionGuideAssistant.shared.dismiss() },
        onRequestPermission: { [weak self] flags in self?.requestPermission(flags: flags) },
        onInstallGlobalSkill: { [weak self] in self?.installSkill() },
        onEnableIntegration: { [weak self] platform, accountKey in
          self?.enableIntegration(platform: platform, accountKey: accountKey)
        },
        onRemoveIntegration: { [weak self] platform, accountKey in
          self?.removeIntegration(platform: platform, accountKey: accountKey)
        },
        onConnectIntegration: { [weak self] platform, accountKey in
          self?.connectIntegration(platform: platform, accountKey: accountKey)
        },
        onFinish: { [weak self] in self?.finishSetup() }
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
    let shouldEnsurePrerequisites = consumePrerequisiteSetupIntent()
    let shouldRefreshPermissions = forceActivePermissionRefresh || shouldRefreshLivePermissions()

    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      let snapshot = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        RootSnapshotResponse.self,
        arguments: ["onboarding", "snapshot"] + (shouldRefreshPermissions ? ["--refresh-permissions"] : [])
      )
      let globalSkill = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        SkillStatus.self,
        arguments: ["skill", "status"]
      ) ?? snapshot?.globalSkill ?? SkillStatus(
        installed: false,
        status: "unknown",
        summary: "Checks whether the global Cued skill is available to your agents."
      )
      let setupIntegrations = (snapshot?.setupIntegrations ?? []).filter {
        $0.capability.setupVisible
      }

      await MainActor.run {
        self.cachedAllIntegrations = snapshot?.integrations ?? []
        self.clearGrantedLivePermissions(using: snapshot?.permissions ?? [])
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: snapshot?.permissions ?? [],
          globalSkill: globalSkill,
          allIntegrations: self.cachedAllIntegrations,
          integrations: setupIntegrations
        )
        self.schedulePermissionRefresh()
        self.schedulePendingAuthRefreshIfNeeded()
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

  private func consumePrerequisiteSetupIntent() -> Bool {
    guard !didEnsurePrerequisites, shouldAutoConfigurePrerequisites() else {
      return false
    }
    didEnsurePrerequisites = true
    return true
  }

  private nonisolated static func ensurePrerequisites(daemonSupervisor: DaemonSupervisor) {
    let launchAgentStatus = decodeJSON(
      daemonSupervisor: daemonSupervisor,
      LoginItemStatusResponse.self,
      arguments: ["login-item", "status"]
    )
    if launchAgentStatus?.enabled != true && launchAgentStatus?.status != "requires_approval" {
      _ = daemonSupervisor.runCLI(arguments: ["login-item", "enable"])
    }

    let cliStatus = decodeJSON(
      daemonSupervisor: daemonSupervisor,
      CLISymlinkStatusResponse.self,
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

  private func runCLICommands(_ argumentsList: [[String]]) {
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
    if permissionKeys(for: flags).contains("full_disk_access") {
      markPermissionRelaunchSetupIntent()
    }
    trackLivePermissionRequests(flags: flags)
    runPermissionCommands(
      [["permissions", "request"] + flags],
      forceActiveRefreshAfter: shouldActivelyRefreshPermissions(for: flags)
    )
  }

  private func guidePermission(key: String) {
    guard let panel = permissionGuidePanel(for: key) else {
      return
    }
    if key == "full_disk_access" {
      markPermissionRelaunchSetupIntent()
    }
    PermissionGuideAssistant.shared.present(panel: panel)
  }

  private func enableIntegration(platform: String, accountKey: String) {
    runCLICommands([["integrations", "enable", platform, accountKey]])
  }

  private func removeIntegration(platform: String, accountKey: String) {
    runCLICommands([["integrations", "remove", platform, accountKey]])
  }

  private func connectIntegration(platform: String, accountKey: String) {
    guard let configuration = viewModel.configuration(for: platform),
          configuration.capability.availability != "unsupported",
          configuration.capability.availability != "requires_helper",
          !configuration.needsPermission else {
      return
    }

    if configuration.knownAccounts.contains(where: {
      $0.accountKey == accountKey && ($0.authState == "requested" || $0.authState == "in_progress")
    }) {
      return
    }

    var actions = [[String]]()
    if configuration.accounts.contains(where: { $0.accountKey == accountKey && !$0.enabled }) {
      actions.append(["integrations", "enable", platform, accountKey])
    }
    actions.append(["integrations", "connect", platform, accountKey])
    runConnectCommands(actions)
  }

  private func installSkill() {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor

    Task(priority: .userInitiated) { [daemonSupervisor] in
      let installCommandResult = await Task.detached(priority: .userInitiated) { [daemonSupervisor] in
        daemonSupervisor.runCLI(arguments: ["skill", "install-global"])
      }.value
      let installResult: SkillInstallResponse? =
        installCommandResult.flatMap { result in
          guard result.status == 0, let data = result.stdout.data(using: .utf8) else {
            return nil
          }
          return try? JSONDecoder().decode(SkillInstallResponse.self, from: data)
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

  private func finishSetup() {
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
    pendingAuthLaunchRefreshTask?.cancel()
    pendingAuthLaunchRefreshTask = nil
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

  private func runConnectCommands(_ argumentsList: [[String]]) {
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
          self.scheduleAuthLaunchRefresh()
        } else {
          self.refresh()
        }
      }
    }
  }

  private func schedulePendingAuthRefreshIfNeeded() {
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

  private func scheduleAuthLaunchRefresh() {
    pendingAuthLaunchRefreshTask?.cancel()
    pendingAuthLaunchRefreshTask = Task { [weak self] in
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
        self?.pendingAuthLaunchRefreshTask = nil
      }
    }
  }

  private func runPermissionCommands(
    _ argumentsList: [[String]],
    forceActiveRefreshAfter: Bool
  ) {
    viewModel.beginRefresh()
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      for arguments in argumentsList {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
      await MainActor.run {
        self.onRefresh()
        self.refresh(forceActivePermissionRefresh: forceActiveRefreshAfter)
      }
    }
  }

  private func shouldRefreshLivePermissions() -> Bool {
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
    return !pendingLivePermissionKeys.isDisjoint(with: liveRefreshPermissionKeys)
  }

  private func trackLivePermissionRequests(flags: [String]) {
    pendingLivePermissionKeys.formUnion(
      permissionKeys(for: flags).filter { liveRefreshPermissionKeys.contains($0) }
    )
    if !pendingLivePermissionKeys.isEmpty {
      pendingLivePermissionDeadline = Date().addingTimeInterval(30)
    }
  }

  private func clearGrantedLivePermissions(using permissions: [PermissionStatus]) {
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

  private func schedulePermissionRefresh() {
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

func permissionKeys(for flags: [String]) -> Set<String> {
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
  if flags.contains("--messages") {
    keys.insert("messages_automation")
  }
  return keys
}

func shouldActivelyRefreshPermissions(for flags: [String]) -> Bool {
  let keys = permissionKeys(for: flags)
  return !keys.isDisjoint(with: liveRefreshPermissionKeys)
}
