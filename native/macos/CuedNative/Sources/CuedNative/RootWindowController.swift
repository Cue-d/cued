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
  let signInBrowser: SignInBrowserStatus?
}

private let liveRefreshPermissionKeys: Set<String> = ["contacts", "full_disk_access"]

@MainActor
final class RootWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let statusStore: AppStatusStore
  private let onRefresh: () -> Void
  private let viewModel = RootViewModel()
  // Assigned right after super.init: its event handler needs `self`.
  private var daemonClient: DaemonClient!
  private var cachedAllIntegrations: [IntegrationStatus] = []
  private var isRefreshing = false
  private var didEnsurePrerequisites = false
  // Bumped whenever an integration command is issued, so a snapshot that was read before the
  // command cannot overwrite what the user just did.
  private var integrationCommandGeneration = 0
  private var integrationCommandsInFlight = 0
  private var lastAgentTargetRefreshAt = Date.distantPast
  private var pendingStatusRefreshTask: Task<Void, Never>?
  private var pendingPermissionRefreshTask: Task<Void, Never>?
  private var pendingLivePermissionKeys = Set<String>()
  private var pendingLivePermissionDeadline: Date?
  private var pendingRefreshAfterCurrent = false
  private var pendingForceActivePermissionRefreshAfterCurrent = false
  private var pendingTelemetryEnabled: Bool?
  private var isApplyingTelemetryToggle = false
  private var finishAfterTelemetryToggle = false
  private var onboardingStartTask: Task<Void, Never>?

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

    // The daemon pushes an event whenever something this window shows has changed, so the
    // window re-reads then, rather than on a timer.
    daemonClient = DaemonClient(socketPath: configuredDaemonSocketPath()) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.refreshForDaemonChange()
      }
    }

    let hosting = NSHostingController(
      rootView: RootView(
        viewModel: viewModel,
        onRefresh: { [weak self] in self?.refreshForUser() },
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
        onLaunchAgentExample: { [weak self] exampleID, target in
          self?.launchAgentExample(exampleID: exampleID, target: target)
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
    daemonClient.subscribe()
    refresh(forceActivePermissionRefresh: forceActivePermissionRefresh)
  }

  private func refreshForDaemonChange() {
    // While a command is in flight its completion refreshes anyway, with the result.
    guard window?.isVisible == true, integrationCommandsInFlight == 0 else {
      return
    }
    refresh()
  }

  /// A refresh the person caused (opening the window, coming back to the app), as opposed to
  /// one triggered by a daemon change. Only these re-check which agents are installed.
  private func refreshForUser() {
    refreshAgentTargets(force: true)
    refresh()
  }

  func showOnboarding(
    forceActivePermissionRefresh: Bool,
    initialPage: Int,
    after appLaunchTelemetryTask: Task<Void, Never>?
  ) {
    if onboardingStartTask == nil {
      let daemonSupervisor = self.daemonSupervisor
      onboardingStartTask = Task { [weak self, daemonSupervisor] in
        await appLaunchTelemetryTask?.value
        let result = await Task.detached(priority: .utility) {
          daemonSupervisor.runCLI(arguments: ["onboarding", "start"])
        }.value
        if result?.status != 0 {
          self?.onboardingStartTask = nil
        }
      }
    }
    showAndRefresh(
      forceActivePermissionRefresh: forceActivePermissionRefresh,
      initialPage: initialPage
    )
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
    let daemonClient: DaemonClient = self.daemonClient
    let statusStore = self.statusStore
    let shouldEnsurePrerequisites = consumePrerequisiteSetupIntent()
    let commandGeneration = integrationCommandGeneration
    // The cached status file only matters before the first real snapshot: it paints the window
    // immediately on open. After that the daemon answers in about a millisecond, and painting
    // the cache first would just render everything twice.
    let shouldPaintFromCache = !viewModel.hasLoadedSnapshot
    let shouldRefreshPermissions = forceActivePermissionRefresh || shouldRefreshLivePermissions()
    let fastPermissionKeys = shouldRefreshPermissions
      ? (pendingLivePermissionKeys.isEmpty ? liveRefreshPermissionKeys : pendingLivePermissionKeys)
      : []

    if shouldRefreshPermissions {
      applyFastPermissionStatuses(for: fastPermissionKeys)
    }

    Task.detached(priority: .userInitiated) { [daemonSupervisor, daemonClient, statusStore] in
      if shouldEnsurePrerequisites {
        Self.ensurePrerequisites(daemonSupervisor: daemonSupervisor)
      }

      if shouldPaintFromCache {
        let fastSnapshot = Self.fastRootSnapshot(from: statusStore.readSnapshot())
        if fastSnapshot.hasLocalData {
          await MainActor.run {
            guard !self.viewModel.hasLoadedSnapshot else {
              return
            }
            self.viewModel.apply(
              permissions: self.viewModel.permissionStatuses,
              globalSkill: self.viewModel.globalSkillStatus,
              relationshipSummary: fastSnapshot.relationshipSummary,
              allIntegrations: fastSnapshot.integrations,
              integrations: fastSnapshot.integrations,
              signInBrowser: self.viewModel.signInBrowser
            )
            self.viewModel.isRefreshing = true
          }
        }
      }

      let snapshot = await Self.loadSnapshot(
        daemonClient: daemonClient,
        daemonSupervisor: daemonSupervisor,
        refreshPermissions: shouldRefreshPermissions
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

      let setupIntegrations = snapshot.setupIntegrations.filter {
        $0.capability.setupVisible
      }

      await MainActor.run {
        guard self.integrationCommandGeneration == commandGeneration else {
          // Read before a command the user has since issued. Applying it would show the old
          // state and clear the pending indicator; the command's own refresh supersedes it.
          self.isRefreshing = false
          self.runPendingRefreshIfNeeded()
          return
        }
        self.cachedAllIntegrations = snapshot.integrations ?? []
        let permissions = self.overlayFastPermissionStatuses(
          on: snapshot.permissions,
          for: fastPermissionKeys
        )
        self.clearGrantedLivePermissions(using: permissions)
        self.isRefreshing = false
        self.viewModel.apply(
          permissions: permissions,
          globalSkill: snapshot.globalSkill,
          relationshipSummary: snapshot.relationshipSummary ?? RelationshipSummary(),
          allIntegrations: self.cachedAllIntegrations,
          integrations: setupIntegrations,
          signInBrowser: snapshot.signInBrowser
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

  /// Reads the snapshot over the daemon socket. If the daemon is not reachable, falls back to
  /// the CLI, which builds the same snapshot itself when no daemon answers.
  private nonisolated static func loadSnapshot(
    daemonClient: DaemonClient,
    daemonSupervisor: DaemonSupervisor,
    refreshPermissions: Bool
  ) async -> RootSnapshotResponse? {
    if let data = try? await daemonClient.request(
      "onboarding-snapshot",
      fields: [
        "refreshManagedIntegrations": refreshPermissions,
        "refreshPermissions": refreshPermissions,
      ]
    ), let snapshot = try? JSONDecoder().decode(RootSnapshotResponse.self, from: data) {
      return snapshot
    }
    return decodeJSON(
      daemonSupervisor: daemonSupervisor,
      RootSnapshotResponse.self,
      arguments: onboardingSnapshotArguments(refreshPermissions: refreshPermissions)
    )
  }

  /// Sends an integration command over the daemon socket, or through the CLI if the daemon is
  /// not reachable. Returns whether the command was delivered.
  private nonisolated static func sendIntegrationCommand(
    _ action: String,
    platform: String,
    accountKey: String,
    daemonClient: DaemonClient,
    daemonSupervisor: DaemonSupervisor
  ) async -> Bool {
    do {
      _ = try await daemonClient.request(
        "integrations-\(action)",
        fields: ["platform": platform, "accountKey": accountKey],
        // Connect answers once sign-in is launched, and looking for reusable desktop auth
        // first can take a while.
        timeout: action == "connect" ? 60 : 10
      )
      return true
    } catch DaemonClientError.unavailable {
      // The request never reached the daemon, so sending it through the CLI cannot repeat
      // it. Any other failure (refused, timed out, connection lost after sending) means the
      // daemon may be carrying it out: replaying a connect would launch a second sign-in.
      let arguments = ["integrations", action, platform, accountKey]
      if action == "connect" {
        return daemonSupervisor.launchCLI(arguments: arguments)
      }
      return daemonSupervisor.runCLI(arguments: arguments)?.status == 0
    } catch {
      return false
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
    return decodeCLIJSON(type, status: result.status, stdout: result.stdout)
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
      if finishAfterTelemetryToggle {
        finishSetup()
        return
      }
      onRefresh()
      refresh()
      return
    }
    pendingTelemetryEnabled = nil

    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor, enabled] in
      let result = daemonSupervisor.runCLI(arguments: ["telemetry", enabled ? "enable" : "disable"])
      await MainActor.run {
        if result?.status != 0 && self.pendingTelemetryEnabled == nil {
          self.finishAfterTelemetryToggle = false
        }
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
    runIntegrationCommands([(action: "enable", platform: platform, accountKey: accountKey)])
  }

  private func removeIntegration(platform: String, accountKey: String) {
    runIntegrationCommands([(action: "remove", platform: platform, accountKey: accountKey)])
  }

  private func runIntegrationCommands(
    _ commands: [(action: String, platform: String, accountKey: String)]
  ) {
    viewModel.beginRefresh()
    integrationCommandGeneration += 1
    integrationCommandsInFlight += 1
    let daemonSupervisor = self.daemonSupervisor
    let daemonClient: DaemonClient = self.daemonClient
    Task.detached(priority: .userInitiated) { [daemonSupervisor, daemonClient] in
      for command in commands {
        _ = await Self.sendIntegrationCommand(
          command.action,
          platform: command.platform,
          accountKey: command.accountKey,
          daemonClient: daemonClient,
          daemonSupervisor: daemonSupervisor
        )
      }
      await MainActor.run {
        self.integrationCommandsInFlight -= 1
        self.onRefresh()
        self.refresh()
      }
    }
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

    var commands = [(action: String, platform: String, accountKey: String)]()
    if configuration.accounts.contains(where: { $0.accountKey == accountKey && !$0.enabled }) {
      commands.append((action: "enable", platform: platform, accountKey: accountKey))
    }
    // The daemon answers `connect` as soon as the sign-in process is launched, and announces
    // each later step (signed in, failed, cancelled) itself.
    commands.append((action: "connect", platform: platform, accountKey: accountKey))
    runIntegrationCommands(commands)
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
          decodeCLIJSON(SkillInstallResponse.self, status: result.status, stdout: result.stdout)
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
        refreshAgentTargets(force: true)
        return
      }

      let feedback = AgentLaunchService.launch(exampleID: exampleID, target: target)
      viewModel.showAgentLaunchFeedback(feedback)
      refreshAgentTargets(force: true)
    }
  }

  /// Finding out whether each agent is installed and signed in means launching `codex` and
  /// `claude`. That is fine when the person opens or returns to the window, and far too heavy
  /// to repeat on every data refresh, so unforced calls are rate limited.
  private func refreshAgentTargets(force: Bool = false) {
    guard force || Date().timeIntervalSince(lastAgentTargetRefreshAt) > 60 else {
      return
    }
    lastAgentTargetRefreshAt = Date()
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
    if isApplyingTelemetryToggle {
      finishAfterTelemetryToggle = true
      return
    }
    let daemonSupervisor = self.daemonSupervisor
    let onboardingStartTask = self.onboardingStartTask
    close()
    onRefresh()
    Task.detached(priority: .utility) {
      await onboardingStartTask?.value
      _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    }
  }

  override func close() {
    finishAfterTelemetryToggle = false
    pendingRefreshAfterCurrent = false
    pendingForceActivePermissionRefreshAfterCurrent = false
    daemonClient.unsubscribe()
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

  /// Polls while a sign-in is pending, but only against a daemon too old to push changes.
  private func schedulePendingAuthRefreshIfNeeded() {
    pendingStatusRefreshTask?.cancel()
    pendingStatusRefreshTask = nil
    guard !daemonClient.isSubscribed else {
      return
    }

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
    (refreshPermissions ? ["--refresh-managed", "--refresh-permissions"] : [])
}
