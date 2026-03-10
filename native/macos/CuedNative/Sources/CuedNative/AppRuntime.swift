import AppKit
import Contacts
import Darwin
import Foundation
import SQLite3

private let appDaemonHeartbeatGraceMs = 120_000
private let appMessagesDBPath =
  FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Messages/chat.db").path

struct AppIntegrationStatus {
  let platform: String
  let accountKey: String
  let displayName: String?
  let authState: String
  let enabled: Bool
}

struct AppStatusSnapshot {
  let daemonRunning: Bool
  let daemonPID: Int?
  let daemonUpdatedAt: Int?
  let contacts: Int
  let conversations: Int
  let messages: Int
  let rawEvents: Int
  let integrations: [AppIntegrationStatus]
}

private final class AppStatusStore {
  private let dbPath: String

  init(dbPath: String) {
    self.dbPath = dbPath
  }

  func readSnapshot() -> AppStatusSnapshot {
    guard FileManager.default.fileExists(atPath: dbPath) else {
      return AppStatusSnapshot(
        daemonRunning: false,
        daemonPID: nil,
        daemonUpdatedAt: nil,
        contacts: 0,
        conversations: 0,
        messages: 0,
        rawEvents: 0,
        integrations: []
      )
    }

    var db: OpaquePointer?
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      if let db {
        sqlite3_close(db)
      }
      return AppStatusSnapshot(
        daemonRunning: false,
        daemonPID: nil,
        daemonUpdatedAt: nil,
        contacts: 0,
        conversations: 0,
        messages: 0,
        rawEvents: 0,
        integrations: []
      )
    }
    defer { sqlite3_close(db) }

    let daemonRow = queryDaemonRow(db: db)
    let counts = [
      countRows(db: db, table: "contacts"),
      countRows(db: db, table: "conversations"),
      countRows(db: db, table: "messages"),
      countRows(db: db, table: "raw_events"),
    ]

    return AppStatusSnapshot(
      daemonRunning: daemonRow.running,
      daemonPID: daemonRow.pid,
      daemonUpdatedAt: daemonRow.updatedAt,
      contacts: counts[0],
      conversations: counts[1],
      messages: counts[2],
      rawEvents: counts[3],
      integrations: mergeLiveLocalIntegrations(queryIntegrations(db: db))
    )
  }

  private func queryDaemonRow(db: OpaquePointer) -> (running: Bool, pid: Int?, updatedAt: Int?) {
    let sql = """
      SELECT pid, updated_at
      FROM daemon_state
      WHERE singleton_key = 'daemon'
      LIMIT 1
    """

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return (false, nil, nil)
    }
    defer { sqlite3_finalize(statement) }

    guard sqlite3_step(statement) == SQLITE_ROW else {
      return (false, nil, nil)
    }

    let pid = sqlite3_column_type(statement, 0) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(statement, 0))
    let updatedAt = sqlite3_column_type(statement, 1) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(statement, 1))
    let running = (updatedAt ?? 0) > 0 && (Int(Date().timeIntervalSince1970 * 1000) - (updatedAt ?? 0)) < appDaemonHeartbeatGraceMs
    return (running, pid, updatedAt)
  }

  private func countRows(db: OpaquePointer, table: String) -> Int {
    let sql = "SELECT COUNT(*) FROM \(table)"
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return 0
    }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_ROW else {
      return 0
    }
    return Int(sqlite3_column_int64(statement, 0))
  }

  private func queryIntegrations(db: OpaquePointer) -> [AppIntegrationStatus] {
    let sql = """
      SELECT platform, account_key, auth_state, enabled
      , display_name
      FROM integration_states
      ORDER BY platform, account_key
    """

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return []
    }
    defer { sqlite3_finalize(statement) }

    var results: [AppIntegrationStatus] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      results.append(
        AppIntegrationStatus(
          platform: String(cString: sqlite3_column_text(statement, 0)),
          accountKey: String(cString: sqlite3_column_text(statement, 1)),
          displayName: sqlite3_column_type(statement, 4) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(statement, 4)),
          authState: String(cString: sqlite3_column_text(statement, 2)),
          enabled: sqlite3_column_int(statement, 3) == 1
        )
      )
    }
    return results
  }

  private func mergeLiveLocalIntegrations(_ existing: [AppIntegrationStatus]) -> [AppIntegrationStatus] {
    var byKey: [String: AppIntegrationStatus] = [:]
    for integration in existing {
      byKey[integrationKey(platform: integration.platform, accountKey: integration.accountKey)] = integration
    }

    upsertLocalIntegration(
      into: &byKey,
      platform: "contacts",
      accountKey: "local",
      displayName: "Contacts.app",
      authState: currentContactsAuthState()
    )
    upsertLocalIntegration(
      into: &byKey,
      platform: "imessage",
      accountKey: "local",
      displayName: "Messages",
      authState: currentIMessageAuthState()
    )

    return byKey.values.sorted {
      if $0.platform == $1.platform {
        return $0.accountKey < $1.accountKey
      }
      return $0.platform < $1.platform
    }
  }

  private func upsertLocalIntegration(
    into integrations: inout [String: AppIntegrationStatus],
    platform: String,
    accountKey: String,
    displayName: String,
    authState: String
  ) {
    let key = integrationKey(platform: platform, accountKey: accountKey)
    let existing = integrations[key]
    integrations[key] = AppIntegrationStatus(
      platform: platform,
      accountKey: accountKey,
      displayName: existing?.displayName ?? displayName,
      authState: authState,
      enabled: existing?.enabled ?? true
    )
  }

  private func integrationKey(platform: String, accountKey: String) -> String {
    "\(platform):\(accountKey)"
  }

  private func currentContactsAuthState() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized:
      return "authorized"
    case .notDetermined:
      return "not_determined"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    @unknown default:
      return "unknown"
    }
  }

  private func currentIMessageAuthState() -> String {
    guard FileManager.default.fileExists(atPath: appMessagesDBPath) else {
      return "missing"
    }

    var db: OpaquePointer?
    guard sqlite3_open_v2(appMessagesDBPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      let message = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unable to open database file"
      if let db {
        sqlite3_close(db)
      }
      return mapIMessageErrorToAuthState(message)
    }
    defer { sqlite3_close(db) }

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT MAX(ROWID) FROM message", -1, &statement, nil) == SQLITE_OK, let statement else {
      return mapIMessageErrorToAuthState(String(cString: sqlite3_errmsg(db)))
    }
    defer { sqlite3_finalize(statement) }

    let result = sqlite3_step(statement)
    if result == SQLITE_ROW || result == SQLITE_DONE {
      return "authorized"
    }

    return mapIMessageErrorToAuthState(String(cString: sqlite3_errmsg(db)))
  }

  private func mapIMessageErrorToAuthState(_ message: String) -> String {
    let normalized = message.lowercased()
    if normalized.contains("authorization denied") || normalized.contains("unable to open database file") {
      return "needs_full_disk_access"
    }
    return "blocked"
  }
}

private final class DatabaseActivityMonitor: @unchecked Sendable {
  private let dbPath: String
  private let queue = DispatchQueue(label: "dev.cued.status-watch")
  private let onChange: @MainActor () -> Void
  private var directorySource: DispatchSourceFileSystemObject?
  private var dbSource: DispatchSourceFileSystemObject?
  private var walSource: DispatchSourceFileSystemObject?
  private var pendingChangeWorkItem: DispatchWorkItem?

  init(dbPath: String, onChange: @escaping @MainActor () -> Void) {
    self.dbPath = dbPath
    self.onChange = onChange
  }

  func start() {
    queue.async { [weak self] in
      self?.installWatchers()
    }
  }

  func stop() {
    queue.async { [weak self] in
      self?.pendingChangeWorkItem?.cancel()
      self?.cancelWatchers()
    }
  }

  private func installWatchers() {
    cancel(&directorySource)
    directorySource = makeWatcher(
      path: directoryPath(),
      eventMask: [.write, .delete, .rename, .attrib]
    ) { [weak self] _ in
      self?.installPathWatchers()
      self?.scheduleChange()
    }
    installPathWatchers()
  }

  private func installPathWatchers() {
    cancel(&dbSource)
    dbSource = makeWatcher(
      path: dbPath,
      eventMask: [.write, .extend, .delete, .rename, .revoke, .attrib]
    ) { [weak self] events in
      if events.contains(.delete) || events.contains(.rename) || events.contains(.revoke) {
        self?.installPathWatchers()
      }
      self?.scheduleChange()
    }
    cancel(&walSource)
    walSource = makeWatcher(
      path: "\(dbPath)-wal",
      eventMask: [.write, .extend, .delete, .rename, .revoke, .attrib]
    ) { [weak self] events in
      if events.contains(.delete) || events.contains(.rename) || events.contains(.revoke) {
        self?.installPathWatchers()
      }
      self?.scheduleChange()
    }
  }

  private func makeWatcher(
    path: String,
    eventMask: DispatchSource.FileSystemEvent,
    handler: @escaping (DispatchSource.FileSystemEvent) -> Void
  ) -> DispatchSourceFileSystemObject? {
    let fd = open(path, O_EVTONLY)
    guard fd >= 0 else {
      return nil
    }

    var source: DispatchSourceFileSystemObject?
    source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fd,
      eventMask: eventMask,
      queue: queue
    )
    source?.setEventHandler { [weak source] in
      guard let source else {
        return
      }
      handler(source.data)
    }
    source?.setCancelHandler {
      close(fd)
    }
    source?.resume()
    return source
  }

  private func cancelWatchers() {
    cancel(&directorySource)
    cancel(&dbSource)
    cancel(&walSource)
  }

  private func cancel(_ source: inout DispatchSourceFileSystemObject?) {
    source?.cancel()
    source = nil
  }

  private func directoryPath() -> String {
    URL(fileURLWithPath: dbPath).deletingLastPathComponent().path
  }

  private func scheduleChange() {
    pendingChangeWorkItem?.cancel()
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else {
        return
      }
      let onChange = self.onChange
      Task { @MainActor in
        onChange()
      }
    }
    pendingChangeWorkItem = workItem
    queue.asyncAfter(deadline: .now() + .milliseconds(150), execute: workItem)
  }
}

private func isConnectedIntegrationState(_ value: String) -> Bool {
  value == "authorized" || value == "authenticated"
}

private func integrationStateLabel(_ value: String) -> String {
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

private func integrationMenuTitle(_ integration: AppIntegrationStatus) -> String {
  let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
  let base = (title?.isEmpty == false) ? title! : "\(integration.platform) \(integration.accountKey)"
  return "\(base) • \(integrationStateLabel(integration.authState))\(integration.enabled ? "" : " (disabled)")"
}

@MainActor
private final class DaemonSupervisor {
  private var daemonProcess: Process?
  private let daemonLaunchPath: String?
  private let daemonCommand: String
  private let setupCommand: String
  private let permissionsCommand: String
  private let statusStore: AppStatusStore

  init(
    daemonLaunchPath: String?,
    daemonCommand: String,
    setupCommand: String,
    permissionsCommand: String,
    statusStore: AppStatusStore
  ) {
    self.daemonLaunchPath = daemonLaunchPath
    self.daemonCommand = daemonCommand
    self.setupCommand = setupCommand
    self.permissionsCommand = permissionsCommand
    self.statusStore = statusStore
  }

  func startIfNeeded() {
    guard daemonLaunchPath != nil || !daemonCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    let snapshot = statusStore.readSnapshot()
    if let daemonProcess, !daemonProcess.isRunning {
      self.daemonProcess = nil
    }
    guard daemonProcess == nil, !snapshot.daemonRunning else {
      return
    }
    daemonProcess = launchDaemonProcess()
  }

  func restart() {
    stop()
    startIfNeeded()
  }

  func isLaunching(snapshot: AppStatusSnapshot) -> Bool {
    guard let daemonProcess, daemonProcess.isRunning else {
      return false
    }
    return !snapshot.daemonRunning
  }

  func launchPID() -> Int? {
    guard let daemonProcess, daemonProcess.isRunning else {
      return nil
    }
    return Int(daemonProcess.processIdentifier)
  }

  func stop() {
    daemonProcess?.terminate()
    daemonProcess = nil
  }

  func openSetupInTerminal() {
    let command: String
    if let daemonLaunchPath, !daemonLaunchPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      command = "\(shellEscape(daemonLaunchPath)) setup"
    } else {
      var environment = daemonEnvironment()
      let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
      if !bundlePath.isEmpty {
        environment["CUED_APP_PATH"] = bundlePath
      }
      if let executablePath = Bundle.main.executablePath,
         !executablePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      {
        environment["CUED_NATIVE_BINARY"] = executablePath
      }
      command = shellCommand(setupCommand, environment: environment)
    }

    runInTerminal(command)
  }

  func requestPermissions() {
    var environment = daemonEnvironment()
    if let executablePath = Bundle.main.executablePath,
       !executablePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      environment["CUED_NATIVE_BINARY"] = executablePath
    }
    let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
    if !bundlePath.isEmpty {
      environment["CUED_PERMISSION_TARGET"] = bundlePath
    }
    _ = launchShellCommand(permissionsCommand, environment: environment)
  }

  private func daemonEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment

    if let executablePath = Bundle.main.executablePath,
       !executablePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      if environment["CUED_IMESSAGE_NATIVE_BINARY"] == nil {
        environment["CUED_IMESSAGE_NATIVE_BINARY"] = executablePath
      }
      if environment["CUED_CONTACTS_NATIVE_BINARY"] == nil {
        environment["CUED_CONTACTS_NATIVE_BINARY"] = executablePath
      }
    }
    let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
    if !bundlePath.isEmpty, environment["CUED_APP_PATH"] == nil {
      environment["CUED_APP_PATH"] = bundlePath
    }

    return environment
  }

  private func launchDaemonProcess() -> Process? {
    if let daemonLaunchPath, !daemonLaunchPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: daemonLaunchPath)
      process.arguments = ["daemon"]
      process.environment = daemonEnvironment()
      process.standardOutput = nil
      process.standardError = nil
      process.terminationHandler = { [weak self] terminatedProcess in
        DispatchQueue.main.async {
          if self?.daemonProcess?.processIdentifier == terminatedProcess.processIdentifier {
            self?.daemonProcess = nil
          }
        }
      }
      do {
        try process.run()
        return process
      } catch {
        return nil
      }
    }

    return launchShellCommand(daemonCommand, environment: daemonEnvironment())
  }

  private func launchShellCommand(_ command: String, environment: [String: String]? = nil) -> Process? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", command]
    if let environment {
      process.environment = environment
    }
    process.standardOutput = nil
    process.standardError = nil
    process.terminationHandler = { [weak self] terminatedProcess in
      DispatchQueue.main.async {
        if self?.daemonProcess?.processIdentifier == terminatedProcess.processIdentifier {
          self?.daemonProcess = nil
        }
      }
    }
    do {
      try process.run()
      return process
    } catch {
      return nil
    }
  }

  private func shellCommand(_ command: String, environment: [String: String]) -> String {
    let exports = environment
      .sorted { $0.key < $1.key }
      .map { "export \($0.key)=\(shellEscape($0.value))" }
      .joined(separator: "; ")
    return exports.isEmpty ? command : "\(exports); \(command)"
  }

  private func shellEscape(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }

  private func runInTerminal(_ command: String) {
    let escaped = command
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")

    let script = """
    tell application "Terminal"
      activate
      do script "\(escaped)"
    end tell
    """

    var error: NSDictionary?
    NSAppleScript(source: script)?.executeAndReturnError(&error)
  }
}

@MainActor
final class MenuBarAppController: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let dbPath: String
  private let statusStore: AppStatusStore
  private let daemonSupervisor: DaemonSupervisor
  private lazy var statusMonitor = DatabaseActivityMonitor(dbPath: dbPath) { [weak self] in
    self?.refreshStatus()
  }
  private var timer: Timer?
  private let statusItemImage = MenuBarAppController.loadStatusItemImage()

  init(dbPath: String, daemonLaunchPath: String?, daemonCommand: String, setupCommand: String, permissionsCommand: String) {
    self.dbPath = dbPath
    self.statusStore = AppStatusStore(dbPath: dbPath)
    self.daemonSupervisor = DaemonSupervisor(
      daemonLaunchPath: daemonLaunchPath,
      daemonCommand: daemonCommand,
      setupCommand: setupCommand,
      permissionsCommand: permissionsCommand,
      statusStore: self.statusStore
    )
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    daemonSupervisor.startIfNeeded()
    rebuildMenu()
    statusMonitor.start()
    timer = Timer.scheduledTimer(timeInterval: 5, target: self, selector: #selector(refreshStatus), userInfo: nil, repeats: true)
    if let timer {
      RunLoop.main.add(timer, forMode: .common)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
    statusMonitor.stop()
  }

  @objc private func restartDaemon() {
    daemonSupervisor.restart()
    rebuildMenu()
  }

  @objc private func stopDaemon() {
    daemonSupervisor.stop()
    rebuildMenu()
  }

  @objc private func openSetup() {
    daemonSupervisor.openSetupInTerminal()
  }

  @objc private func requestPermissions() {
    daemonSupervisor.requestPermissions()
  }

  @objc private func refreshStatus() {
    daemonSupervisor.startIfNeeded()
    rebuildMenu()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }

  private func rebuildMenu() {
    let snapshot = statusStore.readSnapshot()
    let daemonStarting = daemonSupervisor.isLaunching(snapshot: snapshot)
    if let button = statusItem.button {
      if let statusItemImage {
        button.title = ""
        button.image = statusItemImage
        button.imagePosition = .imageOnly
      } else {
        button.image = nil
        button.title = snapshot.daemonRunning || daemonStarting ? "Cued" : "Cued!"
        button.imagePosition = .noImage
      }
      button.toolTip = snapshot.daemonRunning
        ? "Cued"
        : daemonStarting
          ? "Cued (daemon starting)"
          : "Cued (daemon stopped)"
      button.appearsDisabled = !(snapshot.daemonRunning || daemonStarting)
    }

    let menu = NSMenu()
    menu.addItem(
      withTitle: snapshot.daemonRunning
        ? "Daemon running\(snapshot.daemonPID.map { " (pid \($0))" } ?? "")"
        : daemonStarting
          ? "Daemon starting\(daemonSupervisor.launchPID().map { " (pid \($0))" } ?? "")"
          : "Daemon stopped",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    menu.addItem(
      withTitle: "Messages \(snapshot.messages)  Contacts \(snapshot.contacts)  Conversations \(snapshot.conversations)",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    let projectionItem = NSMenuItem(
      title: "Raw events \(snapshot.rawEvents)",
      action: nil,
      keyEquivalent: ""
    )
    projectionItem.isEnabled = false
    menu.addItem(projectionItem)
    menu.addItem(.separator())

    if snapshot.integrations.isEmpty {
      let item = NSMenuItem(title: "No integrations configured", action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    } else {
      let visibleIntegrations = snapshot.integrations.filter { $0.enabled }
      let connectedIntegrations = visibleIntegrations.filter { isConnectedIntegrationState($0.authState) }
      let needsAttentionIntegrations = visibleIntegrations.filter { !isConnectedIntegrationState($0.authState) }

      if connectedIntegrations.isEmpty {
        let item = NSMenuItem(title: "No connected integrations", action: nil, keyEquivalent: "")
        item.isEnabled = false
        menu.addItem(item)
      } else {
        let sectionHeader = NSMenuItem(title: "Connected", action: nil, keyEquivalent: "")
        sectionHeader.isEnabled = false
        menu.addItem(sectionHeader)
        for integration in connectedIntegrations {
          let item = NSMenuItem(title: integrationMenuTitle(integration), action: nil, keyEquivalent: "")
          item.isEnabled = false
          menu.addItem(item)
        }
      }

      if !needsAttentionIntegrations.isEmpty {
        menu.addItem(.separator())
        let sectionHeader = NSMenuItem(title: "Needs Attention", action: nil, keyEquivalent: "")
        sectionHeader.isEnabled = false
        menu.addItem(sectionHeader)
        for integration in needsAttentionIntegrations {
          let item = NSMenuItem(title: integrationMenuTitle(integration), action: nil, keyEquivalent: "")
          item.isEnabled = false
          menu.addItem(item)
        }
      }
    }

    menu.addItem(.separator())
    let startItem = menu.addItem(
      withTitle: snapshot.daemonRunning ? "Restart Daemon" : daemonStarting ? "Starting Daemon..." : "Start Daemon",
      action: #selector(restartDaemon),
      keyEquivalent: ""
    )
    startItem.target = self
    startItem.isEnabled = !daemonStarting

    let stopItem = menu.addItem(withTitle: "Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "")
    stopItem.target = self
    stopItem.isEnabled = snapshot.daemonRunning || daemonStarting

    menu.addItem(withTitle: "Open Setup", action: #selector(openSetup), keyEquivalent: "").target = self
    menu.addItem(withTitle: "Request Permissions", action: #selector(requestPermissions), keyEquivalent: "").target = self

    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit", action: #selector(quitApp), keyEquivalent: "q").target = self

    statusItem.menu = menu
  }

  private static func loadStatusItemImage() -> NSImage? {
    let candidates = [
      Bundle.main.path(forResource: "trayIconTemplate", ofType: "png"),
      executableRelativeIconPath(),
    ]

    for candidate in candidates {
      guard let candidate, let image = NSImage(contentsOfFile: candidate) else {
        continue
      }
      image.isTemplate = true
      image.size = NSSize(width: 18, height: 18)
      return image
    }

    return nil
  }

  private static func executableRelativeIconPath() -> String? {
    guard let executablePath = Bundle.main.executablePath else {
      return nil
    }

    let executableURL = URL(fileURLWithPath: executablePath)
    let candidates = [
      executableURL
        .deletingLastPathComponent()
        .appendingPathComponent("../../../../apps/electron/resources/trayIconTemplate.png")
        .standardizedFileURL.path,
      executableURL
        .deletingLastPathComponent()
        .appendingPathComponent("../../../apps/electron/resources/trayIconTemplate.png")
        .standardizedFileURL.path,
    ]

    return candidates.first { FileManager.default.fileExists(atPath: $0) }
  }
}

@MainActor
func runMenuBarApp() {
  let daemonLaunchPath = Bundle.main.path(forResource: "cued-cli", ofType: nil)
  let daemonCommand = (Bundle.main.object(forInfoDictionaryKey: "CuedDaemonCommand") as? String)
    ?? ProcessInfo.processInfo.environment["CUED_DAEMON_COMMAND"]
    ?? ""
  let setupCommand = (Bundle.main.object(forInfoDictionaryKey: "CuedSetupCommand") as? String)
    ?? ProcessInfo.processInfo.environment["CUED_SETUP_COMMAND"]
    ?? "cued setup"
  let permissionsCommand = (Bundle.main.object(forInfoDictionaryKey: "CuedPermissionsCommand") as? String)
    ?? ProcessInfo.processInfo.environment["CUED_PERMISSIONS_COMMAND"]
    ?? "cued permissions request --all"
  let dbPath = (Bundle.main.object(forInfoDictionaryKey: "CuedDBPath") as? String)
    ?? "\(NSHomeDirectory())/.cued/local.db"

  let app = NSApplication.shared
  let delegate = MenuBarAppController(
    dbPath: dbPath,
    daemonLaunchPath: daemonLaunchPath,
    daemonCommand: daemonCommand,
    setupCommand: setupCommand,
    permissionsCommand: permissionsCommand
  )
  app.delegate = delegate
  app.run()
}
