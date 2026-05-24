import AppKit
import Contacts
import Interface
import SQLite3
import SwiftUI

struct SkillInstallResponse: Decodable {
  let ok: Bool
  let error: String?
}

struct RootSnapshotResponse: Decodable {
  let permissions: [PermissionStatus]
  let globalSkill: SkillStatus
  let relationshipSummary: RelationshipSummary?
  let integrations: [IntegrationStatus]?
  let setupIntegrations: [IntegrationStatus]
}

private let liveRefreshPermissionKeys: Set<String> = ["contacts", "full_disk_access"]
private let platformAuthInteractionTTLMS = 45_000
private let platformAuthInteractionRenewalMS = 15_000

@MainActor
final class RootWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let statusStore: AppStatusStore
  private let onRefresh: () -> Void
  private let viewModel = RootViewModel()
  private var cachedAllIntegrations: [IntegrationStatus] = []
  private var isRefreshing = false
  private var didEnsurePrerequisites = false
  private var pendingAuthLaunchRefreshTask: Task<Void, Never>?
  private var platformAuthInteractionTask: Task<Void, Never>?
  private var platformAuthInteractionSessionId: String?
  private var pendingStatusRefreshTask: Task<Void, Never>?
  private var pendingPermissionRefreshTask: Task<Void, Never>?
  private var pendingLivePermissionKeys = Set<String>()
  private var pendingLivePermissionDeadline: Date?
  private var pendingRefreshAfterCurrent = false
  private var pendingForceActivePermissionRefreshAfterCurrent = false
  private var pendingTelemetryEnabled: Bool?
  private var isApplyingTelemetryToggle = false

  init(
    daemonSupervisor: DaemonSupervisor,
    statusStore: AppStatusStore,
    onRefresh: @escaping () -> Void
  ) {
    self.daemonSupervisor = daemonSupervisor
    self.statusStore = statusStore
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
        onPlatformPageActiveChanged: { [weak self] isActive in
          self?.setPlatformAuthInteractionActive(isActive)
        },
        onLaunchAgentExample: { [weak self] exampleID, target in
          self?.launchAgentExample(exampleID: exampleID, target: target)
        },
        onFinish: { [weak self] in self?.finishSetup() }
      )
    )
    window.contentViewController = hosting
    reportAppLaunch()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func showAndRefresh(
    forceActivePermissionRefresh: Bool = false,
    resetToFirstPage: Bool = false,
    defaultToLastPage: Bool = false,
    initialPage: Int? = nil
  ) {
    if let initialPage {
      viewModel.currentPage = min(max(initialPage, 0), max(0, viewModel.pageCount - 1))
    } else if resetToFirstPage {
      viewModel.currentPage = 0
    } else if defaultToLastPage {
      viewModel.currentPage = max(0, viewModel.pageCount - 1)
    }
    NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
    showWindow(nil)
    window?.makeMain()
    window?.makeKeyAndOrderFront(nil)
    window?.orderFrontRegardless()
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.async { [weak self] in
      guard let window = self?.window else {
        return
      }
      NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
      window.makeMain()
      window.makeKeyAndOrderFront(nil)
      window.orderFrontRegardless()
      NSApp.activate(ignoringOtherApps: true)
    }
    refresh(forceActivePermissionRefresh: forceActivePermissionRefresh)
  }

  private func reportAppLaunch() {
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .utility) { [daemonSupervisor] in
      _ = daemonSupervisor.runCLI(arguments: ["telemetry", "app-launched"])
    }
  }

  func refresh(forceActivePermissionRefresh: Bool = false) {
    refreshAgentTargets()

    guard !isRefreshing else {
      pendingRefreshAfterCurrent = true
      pendingForceActivePermissionRefreshAfterCurrent =
        pendingForceActivePermissionRefreshAfterCurrent || forceActivePermissionRefresh
      return
    }
    isRefreshing = true
    viewModel.beginRefresh()

    let daemonSupervisor = self.daemonSupervisor
    let statusStore = self.statusStore
    let shouldEnsurePrerequisites = consumePrerequisiteSetupIntent()
    let shouldRefreshPermissions = forceActivePermissionRefresh || shouldRefreshLivePermissions()
    let fastPermissionKeys = shouldRefreshPermissions
      ? (pendingLivePermissionKeys.isEmpty ? liveRefreshPermissionKeys : pendingLivePermissionKeys)
      : []

    if shouldRefreshPermissions {
      applyFastPermissionStatuses(for: fastPermissionKeys)
    }

    Task.detached(priority: .userInitiated) { [daemonSupervisor, statusStore] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      let fastSnapshot = Self.fastRootSnapshot(from: statusStore.readSnapshot())
      if fastSnapshot.hasLocalData {
        await MainActor.run {
          self.viewModel.apply(
            permissions: self.viewModel.permissionStatuses,
            globalSkill: self.viewModel.globalSkillStatus,
            relationshipSummary: fastSnapshot.relationshipSummary,
            allIntegrations: fastSnapshot.integrations,
            integrations: fastSnapshot.integrations
          )
          self.viewModel.isRefreshing = true
        }
      }

      let snapshot = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        RootSnapshotResponse.self,
        arguments: onboardingSnapshotArguments(refreshPermissions: shouldRefreshPermissions)
      )

      guard let snapshot else {
        await MainActor.run {
          self.isRefreshing = false
          self.viewModel.finishRefreshWithoutSnapshot()
          self.schedulePermissionRefresh()
          self.runPendingRefreshIfNeeded()
        }
        return
      }

      let globalSkill = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        SkillStatus.self,
        arguments: ["skill", "status"]
      ) ?? snapshot.globalSkill
      let setupIntegrations = snapshot.setupIntegrations.filter {
        $0.capability.setupVisible
      }

      await MainActor.run {
        self.cachedAllIntegrations = snapshot.integrations ?? []
        let permissions = self.overlayFastPermissionStatuses(
          on: snapshot.permissions,
          for: fastPermissionKeys
        )
        self.clearGrantedLivePermissions(using: permissions)
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: permissions,
          globalSkill: globalSkill,
          relationshipSummary: snapshot.relationshipSummary ?? RelationshipSummary(),
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
    guard let result = daemonSupervisor.runCLI(arguments: arguments) else {
      return nil
    }
    guard result.status == 0,
          let data = result.stdout.data(using: .utf8) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  private nonisolated static func fastRootSnapshot(
    from snapshot: AppStatusSnapshot
  ) -> (relationshipSummary: RelationshipSummary, integrations: [IntegrationStatus], hasLocalData: Bool) {
    let messageBreakdown = Dictionary(uniqueKeysWithValues: snapshot.messageBreakdown.map {
      ($0.platform, $0.messages)
    })
    var didUseCachedMessageBreakdown = Set<String>()
    let integrations = snapshot.integrations.map { integration in
      let cachedProjectedMessages: Int
      if integration.projectionStats == nil,
         !didUseCachedMessageBreakdown.contains(integration.platform) {
        cachedProjectedMessages = messageBreakdown[integration.platform] ?? 0
        didUseCachedMessageBreakdown.insert(integration.platform)
      } else {
        cachedProjectedMessages = 0
      }
      let projectedMessages = integration.projectionStats?.projectedMessages ?? cachedProjectedMessages
      let projectionStats = ProjectionStats(
        rawEvents: integration.projectionStats?.rawEvents ?? 0,
        rawEventsBySchema: integration.projectionStats?.rawEventsBySchema ?? [:],
        projectedContacts: integration.projectionStats?.projectedContacts ?? 0,
        projectedConversations: integration.projectionStats?.projectedConversations ?? 0,
        projectedMessages: projectedMessages
      )

      return IntegrationStatus(
        platform: integration.platform,
        accountKey: integration.accountKey,
        displayName: integration.displayName,
        authState: integration.authState,
        enabled: integration.enabled,
        projectionStats: projectionStats,
        capability: integration.capability ?? CapabilityStatus(availability: "available", setupVisible: true)
      )
    }
    let relationshipSummary = RelationshipSummary(
      messages: snapshot.messages > 0 ? snapshot.messages : snapshot.projectedMessages,
      contacts: snapshot.contacts,
      phoneCalls: snapshot.phoneCalls > 0
        ? snapshot.phoneCalls
        : snapshot.integrations.reduce(0) { total, integration in
          total + (integration.projectionStats?.rawEventsBySchema["call.observed@1"] ?? 0)
        },
      pendingProjectionEvents: snapshot.pendingProjectionEvents,
      lastUpdatedAt: nil,
      source: "menu_bar_cache"
    )
    let hasLocalData =
      relationshipSummary.messages > 0
      || relationshipSummary.contacts > 0
      || relationshipSummary.phoneCalls > 0
      || !integrations.isEmpty

    return (relationshipSummary, integrations, hasLocalData)
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

  private func setTelemetryEnabledFromOnboarding(_ enabled: Bool) {
    viewModel.beginRefresh()
    pendingTelemetryEnabled = enabled
    guard !isApplyingTelemetryToggle else {
      return
    }
    isApplyingTelemetryToggle = true
    applyPendingTelemetryToggle()
  }

  private func applyPendingTelemetryToggle() {
    guard let enabled = pendingTelemetryEnabled else {
      isApplyingTelemetryToggle = false
      onRefresh()
      refresh()
      return
    }
    pendingTelemetryEnabled = nil

    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor, enabled] in
      _ = daemonSupervisor.runCLI(arguments: ["telemetry", enabled ? "enable" : "disable"])
      await MainActor.run {
        self.applyPendingTelemetryToggle()
      }
    }
  }

  private func requestPermission(flags: [String]) {
    if flags.contains("--telemetry-enable") {
      setTelemetryEnabledFromOnboarding(true)
      return
    }
    if flags.contains("--telemetry-disable") {
      setTelemetryEnabledFromOnboarding(false)
      return
    }
    let keys = permissionKeys(for: flags)
    let permissionTelemetry = keys.map {
      ["telemetry", "permission-requested", "--kind", $0]
    }
    if keys.contains("contacts") {
      requestContactsPermission()
    }
    let remainingPermissionFlags = permissionRequestFlagsExcludingSwiftContacts(for: keys)
    if remainingPermissionFlags.isEmpty {
      runPermissionTelemetry(permissionTelemetry)
      return
    }
    if keys.contains("full_disk_access") {
      markPermissionRelaunchSetupIntent()
    }
    trackLivePermissionKeys(keys)
    runPermissionCommands(
      permissionTelemetry + [["permissions", "request"] + remainingPermissionFlags],
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
    applyFastPermissionStatuses(for: [key])
    trackLivePermissionKeys([key])
    schedulePermissionRefresh()
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

  private func launchAgentExample(exampleID: AgentExampleID, target: AgentTarget) {
    viewModel.showAgentLaunchFeedback(
      AgentLaunchFeedback(
        title: "Preparing \(target.title)",
        detail: "Checking auth, installing the Cued skill if needed, and preparing the example prompt."
      )
    )

    let daemonSupervisor = self.daemonSupervisor
    let skillAlreadyInstalled = viewModel.globalSkillStatus.installed
    Task { [daemonSupervisor, skillAlreadyInstalled] in
      if let installError = await Self.installGlobalSkillIfNeeded(
        daemonSupervisor: daemonSupervisor,
        alreadyInstalled: skillAlreadyInstalled
      ) {
        viewModel.showAgentLaunchFeedback(
          AgentLaunchFeedback(
            title: "Cued skill install failed",
            detail: installError,
            isError: true
          )
        )
        refreshAgentTargets()
        return
      }

      let feedback = AgentLaunchService.launch(exampleID: exampleID, target: target)
      viewModel.showAgentLaunchFeedback(feedback)
      refreshAgentTargets()
    }
  }

  private func refreshAgentTargets() {
    Task.detached(priority: .utility) {
      let statuses = AgentLaunchService.targetStatuses()
      await MainActor.run {
        self.viewModel.applyAgentTargetStatuses(statuses)
      }
    }
  }

  private nonisolated static func installGlobalSkillIfNeeded(
    daemonSupervisor: DaemonSupervisor,
    alreadyInstalled: Bool
  ) async -> String? {
    guard !alreadyInstalled else {
      return nil
    }

    let result = await Task.detached(priority: .userInitiated) {
      daemonSupervisor.runCLI(arguments: ["skill", "install-global"])
    }.value

    guard result?.status == 0 else {
      let stderr = result?.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      if stderr?.isEmpty == false {
        return stderr
      }
      return "Run `cued skill install-global` from Terminal, then retry the example."
    }

    return nil
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
    platformAuthInteractionTask?.cancel()
    platformAuthInteractionTask = nil
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil
    pendingPermissionRefreshTask?.cancel()
    pendingPermissionRefreshTask = nil
    PermissionGuideAssistant.shared.dismiss()
    platformAuthInteractionSessionId = nil
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

  private func setPlatformAuthInteractionActive(_ isActive: Bool) {
    if isActive {
      startPlatformAuthInteraction()
    } else {
      platformAuthInteractionTask?.cancel()
      platformAuthInteractionTask = nil
      platformAuthInteractionSessionId = nil
    }
  }

  private func startPlatformAuthInteraction() {
    guard platformAuthInteractionTask == nil else {
      return
    }
    let daemonSupervisor = self.daemonSupervisor
    let sessionId = UUID().uuidString
    platformAuthInteractionSessionId = sessionId
    platformAuthInteractionTask = Task.detached(priority: .utility) { [daemonSupervisor, sessionId] in
      defer {
        _ = daemonSupervisor.runCLI(arguments: [
          "integrations",
          "interaction",
          "end",
          "--session-id",
          sessionId,
        ])
      }
      while !Task.isCancelled {
        _ = daemonSupervisor.runCLI(arguments: [
          "integrations",
          "interaction",
          "start",
          "--session-id",
          sessionId,
          "--ttl-ms",
          String(platformAuthInteractionTTLMS),
        ])
        try? await Task.sleep(for: .milliseconds(platformAuthInteractionRenewalMS))
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
        self.applyFastPermissionStatuses()
        self.refresh(forceActivePermissionRefresh: forceActiveRefreshAfter)
      }
    }
  }

  private func runPermissionTelemetry(_ argumentsList: [[String]]) {
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .utility) { [daemonSupervisor] in
      for arguments in argumentsList {
        _ = daemonSupervisor.runCLI(arguments: arguments)
      }
    }
  }

  private func requestContactsPermission() {
    applyFastPermissionStatuses(for: ["contacts"])
    trackLivePermissionKeys(["contacts"])
    let store = CNContactStore()
    store.requestAccess(for: .contacts) { [weak self] _, _ in
      Task { @MainActor [weak self] in
        guard let self else {
          return
        }
        self.applyFastPermissionStatuses(for: ["contacts"])
        self.clearGrantedLivePermissions(using: self.viewModel.permissionStatuses)
        self.schedulePermissionRefresh()
      }
    }
  }

  private func applyFastPermissionStatuses(for keys: Set<String>? = nil) {
    for permission in fastPermissionStatuses(for: keys) {
      viewModel.setPermissionStatus(permission)
    }
  }

  private func overlayFastPermissionStatuses(
    on permissions: [PermissionStatus],
    for keys: Set<String>? = nil
  ) -> [PermissionStatus] {
    var overlaid = permissions
    for permission in fastPermissionStatuses(for: keys) {
      if let index = overlaid.firstIndex(where: { $0.key == permission.key }) {
        overlaid[index] = permission
      } else {
        overlaid.append(permission)
      }
    }
    return overlaid
  }

  private func fastPermissionStatuses(for keys: Set<String>? = nil) -> [PermissionStatus] {
    let keys = keys ?? liveRefreshPermissionKeys
    var permissions: [PermissionStatus] = []
    if keys.contains("contacts") {
      permissions.append(Self.fastContactsPermissionStatus())
    }
    if keys.contains("full_disk_access") {
      permissions.append(Self.fastFullDiskAccessPermissionStatus())
    }
    return permissions
  }

  nonisolated static func fastContactsPermissionStatus(
    authorizationStatus: CNAuthorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
  ) -> PermissionStatus {
    switch authorizationStatus {
    case .authorized:
      return PermissionStatus(
        key: "contacts",
        status: "granted",
        summary: "Contacts access is authorized",
        requestFlags: ["--contacts"]
      )
    case .notDetermined:
      return PermissionStatus(
        key: "contacts",
        status: "unknown",
        summary: "Contacts access has not been requested yet",
        requestFlags: ["--contacts"]
      )
    case .denied:
      return PermissionStatus(
        key: "contacts",
        status: "needs_action",
        summary: "Contacts access is denied",
        requestFlags: ["--contacts"]
      )
    case .restricted:
      return PermissionStatus(
        key: "contacts",
        status: "needs_action",
        summary: "Contacts access is restricted",
        requestFlags: ["--contacts"]
      )
    @unknown default:
      return PermissionStatus(
        key: "contacts",
        status: "unknown",
        summary: "Contacts access could not be checked",
        requestFlags: ["--contacts"]
      )
    }
  }

  nonisolated static func fastFullDiskAccessPermissionStatus(
    messagesDBPath: String = appMessagesDBPath
  ) -> PermissionStatus {
    guard FileManager.default.fileExists(atPath: messagesDBPath) else {
      return PermissionStatus(
        key: "full_disk_access",
        status: "unknown",
        summary: "Messages database was not found",
        requestFlags: ["--full-disk-access"]
      )
    }

    if canOpenSQLiteDatabase(at: messagesDBPath) {
      return PermissionStatus(
        key: "full_disk_access",
        status: "granted",
        summary: "Full Disk Access is available for Messages data",
        requestFlags: ["--full-disk-access"]
      )
    }

    return PermissionStatus(
      key: "full_disk_access",
      status: "needs_action",
      summary: "Messages database is not readable from Cued",
      requestFlags: ["--full-disk-access"]
    )
  }

  private nonisolated static func canOpenSQLiteDatabase(at path: String) -> Bool {
    var db: OpaquePointer?
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      if let db {
        sqlite3_close(db)
      }
      return false
    }
    sqlite3_close(db)
    return true
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
    trackLivePermissionKeys(permissionKeys(for: flags))
  }

  private func trackLivePermissionKeys(_ keys: Set<String>) {
    pendingLivePermissionKeys.formUnion(
      keys.filter { liveRefreshPermissionKeys.contains($0) }
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
  return keys
}

func permissionRequestFlagsExcludingSwiftContacts(for keys: Set<String>) -> [String] {
  var flags: [String] = []
  if keys.contains("full_disk_access") {
    flags.append("--full-disk-access")
  }
  return flags
}

func shouldActivelyRefreshPermissions(for flags: [String]) -> Bool {
  let keys = permissionKeys(for: flags)
  return !keys.isDisjoint(with: liveRefreshPermissionKeys)
}

func onboardingSnapshotArguments(refreshPermissions: Bool) -> [String] {
  ["onboarding", "snapshot"] +
    (refreshPermissions ? ["--refresh-managed"] : [])
}
