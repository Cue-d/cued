import AppKit
import Foundation
import SQLite3

private let appDaemonHeartbeatGraceMs = 20_000

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
      integrations: queryIntegrations(db: db)
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
    if
      let daemonProcess,
      daemonProcess.isRunning,
      !snapshot.daemonRunning,
      snapshot.daemonPID == nil || snapshot.daemonPID == Int(daemonProcess.processIdentifier)
    {
      daemonProcess.terminate()
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

  func stop() {
    daemonProcess?.terminate()
    daemonProcess = nil
  }

  func openSetupInTerminal() {
    runInTerminal(setupCommand)
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
  private let statusStore: AppStatusStore
  private let daemonSupervisor: DaemonSupervisor
  private var timer: Timer?
  private let statusItemImage = MenuBarAppController.loadStatusItemImage()

  init(dbPath: String, daemonLaunchPath: String?, daemonCommand: String, setupCommand: String, permissionsCommand: String) {
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
    timer = Timer.scheduledTimer(timeInterval: 5, target: self, selector: #selector(refreshStatus), userInfo: nil, repeats: true)
    if let timer {
      RunLoop.main.add(timer, forMode: .common)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
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
    if let button = statusItem.button {
      if let statusItemImage {
        button.title = ""
        button.image = statusItemImage
        button.imagePosition = .imageOnly
      } else {
        button.image = nil
        button.title = snapshot.daemonRunning ? "Cued" : "Cued!"
        button.imagePosition = .noImage
      }
      button.toolTip = snapshot.daemonRunning ? "Cued" : "Cued (daemon stopped)"
      button.appearsDisabled = !snapshot.daemonRunning
    }

    let menu = NSMenu()
    menu.addItem(
      withTitle: snapshot.daemonRunning
        ? "Daemon running\(snapshot.daemonPID.map { " (pid \($0))" } ?? "")"
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
    menu.addItem(
      withTitle: snapshot.daemonRunning ? "Restart Daemon" : "Start Daemon",
      action: #selector(restartDaemon),
      keyEquivalent: ""
    ).target = self

    let stopItem = menu.addItem(withTitle: "Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "")
    stopItem.target = self
    stopItem.isEnabled = snapshot.daemonRunning

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
