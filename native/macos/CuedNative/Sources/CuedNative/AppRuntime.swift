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

struct AppPlatformMessageCount {
  let platform: String
  let messages: Int
}

struct AppUpdateSummary {
  let availableVersion: String?
  let releaseURL: String?
}

struct AppStatusSnapshot {
  let daemonRunning: Bool
  let daemonPID: Int?
  let daemonUpdatedAt: Int?
  let contacts: Int
  let conversations: Int
  let messages: Int
  let rawEvents: Int
  let messageBreakdown: [AppPlatformMessageCount]
  let integrations: [AppIntegrationStatus]
  let onboardingCompletedVersion: String?
  let installedAppVersion: String?
  let releaseChannel: String?
  let cliSymlinkInstalled: Bool
  let updateSummary: AppUpdateSummary?
}

final class AppStatusStore: @unchecked Sendable {
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
        messageBreakdown: [],
        integrations: [],
        onboardingCompletedVersion: nil,
        installedAppVersion: nil,
        releaseChannel: nil,
        cliSymlinkInstalled: false,
        updateSummary: nil
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
        messageBreakdown: [],
        integrations: [],
        onboardingCompletedVersion: nil,
        installedAppVersion: nil,
        releaseChannel: nil,
        cliSymlinkInstalled: false,
        updateSummary: nil
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
    let integrations = mergeLiveLocalIntegrations(queryIntegrations(db: db))
    let messageBreakdown = mergeMessageBreakdown(
      queryMessageCountsByPlatform(db: db),
      integrations: integrations
    )
    let updateSummary = queryUpdateSummary(db: db)

    return AppStatusSnapshot(
      daemonRunning: daemonRow.running,
      daemonPID: daemonRow.pid,
      daemonUpdatedAt: daemonRow.updatedAt,
      contacts: counts[0],
      conversations: counts[1],
      messages: counts[2],
      rawEvents: counts[3],
      messageBreakdown: messageBreakdown,
      integrations: integrations,
      onboardingCompletedVersion: queryAppSetting(db: db, key: "onboarding_completed_version"),
      installedAppVersion: queryAppSetting(db: db, key: "installed_app_version"),
      releaseChannel: queryAppSetting(db: db, key: "release_channel"),
      cliSymlinkInstalled: queryAppSetting(db: db, key: "cli_symlink_installed") == "1",
      updateSummary: updateSummary
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

  private func queryMessageCountsByPlatform(db: OpaquePointer) -> [AppPlatformMessageCount] {
    let sql = """
      SELECT platform, COUNT(*)
      FROM messages
      GROUP BY platform
      ORDER BY platform
    """

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return []
    }
    defer { sqlite3_finalize(statement) }

    var results: [AppPlatformMessageCount] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      results.append(
        AppPlatformMessageCount(
          platform: String(cString: sqlite3_column_text(statement, 0)),
          messages: Int(sqlite3_column_int64(statement, 1))
        )
      )
    }
    return results
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

  private func mergeMessageBreakdown(
    _ existing: [AppPlatformMessageCount],
    integrations: [AppIntegrationStatus]
  ) -> [AppPlatformMessageCount] {
    var counts = Dictionary(uniqueKeysWithValues: existing.map { ($0.platform, $0.messages) })

    for integration in integrations where shouldIncludeMessageDebugPlatform(integration.platform) {
      counts[integration.platform] = counts[integration.platform] ?? 0
    }

    return counts
      .map { AppPlatformMessageCount(platform: $0.key, messages: $0.value) }
      .sorted {
        if ($0.messages == 0) != ($1.messages == 0) {
          return $0.messages > $1.messages
        }
        return platformDisplayTitle($0.platform) < platformDisplayTitle($1.platform)
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

  private func queryAppSetting(db: OpaquePointer, key: String) -> String? {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT value FROM app_settings WHERE key = ? LIMIT 1", -1, &statement, nil) == SQLITE_OK,
          let statement else {
      return nil
    }
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_text(statement, 1, key, -1, nil)
    guard sqlite3_step(statement) == SQLITE_ROW,
          sqlite3_column_type(statement, 0) != SQLITE_NULL,
          let value = sqlite3_column_text(statement, 0) else {
      return nil
    }
    return String(cString: value)
  }

  private func queryUpdateSummary(db: OpaquePointer) -> AppUpdateSummary? {
    guard let raw = queryAppSetting(db: db, key: "update_release_state_json"),
          let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }

    let availableVersion = object["availableVersion"] as? String
    let releaseURL = object["releaseUrl"] as? String
    if availableVersion == nil && releaseURL == nil {
      return nil
    }
    return AppUpdateSummary(availableVersion: availableVersion, releaseURL: releaseURL)
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

private func shouldIncludeMessageDebugPlatform(_ platform: String) -> Bool {
  platform != "contacts"
}

private func platformDisplayTitle(_ platform: String) -> String {
  switch platform {
  case "imessage":
    return "Messages"
  case "linkedin":
    return "LinkedIn"
  case "slack":
    return "Slack"
  case "signal":
    return "Signal"
  case "whatsapp":
    return "WhatsApp"
  default:
    return platform.capitalized
  }
}

private func platformMessageDebugTitle(_ item: AppPlatformMessageCount) -> String {
  "\(platformDisplayTitle(item.platform)) \(item.messages) message\(item.messages == 1 ? "" : "s")"
}

private func debugSummaryTitle(
  label: String,
  value: String
) -> String {
  "\(label): \(value)"
}

@MainActor
final class DaemonSupervisor {
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

  func isLaunching(snapshot: AppStatusSnapshot) -> Bool {
    guard let daemonProcess, daemonProcess.isRunning else {
      return false
    }
    return !snapshot.daemonRunning
  }

  func stop(activePID: Int? = nil) {
    let trackedPID = daemonProcess.flatMap { process in
      process.isRunning ? Int(process.processIdentifier) : nil
    }
    daemonProcess?.terminate()
    daemonProcess = nil

    guard let activePID, activePID > 0 else {
      return
    }

    let currentPID = Int(ProcessInfo.processInfo.processIdentifier)
    guard activePID != currentPID, activePID != trackedPID else {
      return
    }

    _ = Darwin.kill(pid_t(activePID), SIGTERM)
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

  nonisolated func runCLI(arguments: [String]) -> (status: Int32, stdout: String, stderr: String)? {
    if let daemonLaunchPath, !daemonLaunchPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: daemonLaunchPath)
      process.arguments = arguments
      process.environment = daemonEnvironment()
      let stdoutPipe = Pipe()
      let stderrPipe = Pipe()
      process.standardOutput = stdoutPipe
      process.standardError = stderrPipe
      do {
        try process.run()
        process.waitUntilExit()
        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
      } catch {
        return nil
      }
    }

    let command = arguments.map(shellEscape).joined(separator: " ")
    return runShellCommandAndCapture(command, environment: daemonEnvironment())
  }

  private nonisolated func daemonEnvironment() -> [String: String] {
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

  private nonisolated func launchShellCommand(_ command: String, environment: [String: String]? = nil) -> Process? {
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

  private nonisolated func runShellCommandAndCapture(
    _ command: String,
    environment: [String: String]? = nil
  ) -> (status: Int32, stdout: String, stderr: String)? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", command]
    if let environment {
      process.environment = environment
    }
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
      try process.run()
      process.waitUntilExit()
      let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      return (process.terminationStatus, stdout, stderr)
    } catch {
      return nil
    }
  }

  private nonisolated func shellCommand(_ command: String, environment: [String: String]) -> String {
    let exports = environment
      .sorted { $0.key < $1.key }
      .map { "export \($0.key)=\(shellEscape($0.value))" }
      .joined(separator: "; ")
    return exports.isEmpty ? command : "\(exports); \(command)"
  }

  private nonisolated func shellEscape(_ value: String) -> String {
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

private struct SetupCapabilityStatus: Decodable {
  let availability: String
  let onboardingVisible: Bool
  let reason: String?
}

private struct SetupIntegrationStatus: Decodable {
  let platform: String
  let accountKey: String
  let displayName: String?
  let authState: String
  let capability: SetupCapabilityStatus
}

private struct IntegrationStatusResponse: Decodable {
  let hostOs: String
  let setupIntegrations: [SetupIntegrationStatus]
}

private struct LaunchAgentStatusResponse: Decodable {
  let loaded: Bool
}

private struct CLISymlinkStatusResponse: Decodable {
  let installed: Bool
  let path: String
}

private struct UpdateErrorResponse: Decodable {
  let stage: String
  let message: String
}

private struct UpdateStatusResponse: Decodable {
  let currentVersion: String
  let releaseChannel: String
  let lastCheckedAt: Int?
  let latestVersion: String?
  let availableVersion: String?
  let available: Bool
  let releaseUrl: String?
  let tarballUrl: String?
  let lastError: UpdateErrorResponse?
}

private struct UpdateInstallResponse: Decodable {
  let started: Bool
  let targetVersion: String
  let releaseUrl: String?
  let installedAppPath: String
}

private final class LegacyOnboardingDocumentView: NSView {
  override var isFlipped: Bool { true }
}

@MainActor
private final class LegacyOnboardingWindowController: NSWindowController {
  private let daemonSupervisor: DaemonSupervisor
  private let statusStore: AppStatusStore
  private let onRefresh: () -> Void
  private let stackView = NSStackView()
  private let scrollView = NSScrollView()
  private var isRefreshing = false
  private var buttonActions: [ObjectIdentifier: () -> Void] = [:]

  init(daemonSupervisor: DaemonSupervisor, statusStore: AppStatusStore, onRefresh: @escaping () -> Void) {
    self.daemonSupervisor = daemonSupervisor
    self.statusStore = statusStore
    self.onRefresh = onRefresh

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 820),
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

    stackView.orientation = .vertical
    stackView.alignment = .leading
    stackView.spacing = 18
    stackView.translatesAutoresizingMaskIntoConstraints = false

    let backgroundView = NSVisualEffectView()
    backgroundView.material = .windowBackground
    backgroundView.blendingMode = .behindWindow
    backgroundView.state = .active
    backgroundView.wantsLayer = true
    backgroundView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

    let contentView = LegacyOnboardingDocumentView()
    contentView.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(stackView)
    NSLayoutConstraint.activate([
      stackView.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 28),
      stackView.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -28),
      stackView.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
      stackView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 28),
      stackView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -28),
      stackView.widthAnchor.constraint(equalToConstant: 640),
    ])

    scrollView.documentView = contentView
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    backgroundView.addSubview(scrollView)
    NSLayoutConstraint.activate([
      scrollView.leadingAnchor.constraint(equalTo: backgroundView.leadingAnchor),
      scrollView.trailingAnchor.constraint(equalTo: backgroundView.trailingAnchor),
      scrollView.topAnchor.constraint(equalTo: backgroundView.topAnchor),
      scrollView.bottomAnchor.constraint(equalTo: backgroundView.bottomAnchor),
      contentView.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
    ])

    window.contentView = backgroundView
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func showAndRefresh() {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    scrollView.contentView.scroll(to: .zero)
    scrollView.reflectScrolledClipView(scrollView.contentView)
    refresh()
  }

  func refresh() {
    guard !isRefreshing else {
      return
    }
    isRefreshing = true
    rebuildLoading()
    let daemonSupervisor = self.daemonSupervisor
    let statusStore = self.statusStore

    Task.detached(priority: .userInitiated) { [daemonSupervisor, statusStore] in
      _ = daemonSupervisor.runCLI(arguments: ["integrations", "refresh"])
      let snapshot = statusStore.readSnapshot()
      let integrations = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        IntegrationStatusResponse.self,
        arguments: ["integrations", "status"]
      ) ?? IntegrationStatusResponse(hostOs: "macos", setupIntegrations: [])
      let launchd = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        LaunchAgentStatusResponse.self,
        arguments: ["launchd", "status"]
      )
      let cliStatus = Self.decodeJSON(
        daemonSupervisor: daemonSupervisor,
        CLISymlinkStatusResponse.self,
        arguments: ["cli", "status"]
      )

      await MainActor.run {
        self.isRefreshing = false
        self.rebuild(
          snapshot: snapshot,
          integrations: integrations.setupIntegrations.filter { $0.capability.onboardingVisible },
          launchAgentLoaded: launchd?.loaded ?? false,
          cliStatus: cliStatus
        )
      }
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

  private func rebuildLoading() {
    clearStack()
    let card = cardView(
      eyebrow: "Preparing",
      title: "Loading setup status",
      subtitle: "Refreshing daemon, permissions, and connector availability."
    )
    let indicator = NSProgressIndicator()
    indicator.style = .spinning
    indicator.controlSize = .regular
    indicator.startAnimation(nil)
    card.stack.addArrangedSubview(indicator)
    stackView.addArrangedSubview(card.container)
    scrollView.contentView.scroll(to: .zero)
    scrollView.reflectScrolledClipView(scrollView.contentView)
  }

  private func rebuild(
    snapshot: AppStatusSnapshot,
    integrations: [SetupIntegrationStatus],
    launchAgentLoaded: Bool,
    cliStatus: CLISymlinkStatusResponse?
  ) {
    clearStack()
    let displayVersion = snapshot.installedAppVersion
      ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown")
    let releaseChannel = snapshot.releaseChannel ?? "internal"

    stackView.addArrangedSubview(heroHeader(
      version: displayVersion,
      releaseChannel: releaseChannel,
      daemonRunning: snapshot.daemonRunning
    ))

    let connectedCount = snapshot.integrations.filter { $0.enabled && isConnectedIntegrationState($0.authState) }.count
    let summaryRow = NSStackView()
    summaryRow.orientation = .horizontal
    summaryRow.alignment = .top
    summaryRow.spacing = 14
    summaryRow.distribution = .fillEqually
    summaryRow.addArrangedSubview(statCard(
      label: "Status",
      value: snapshot.daemonRunning ? "Ready" : "Starting",
      tone: snapshot.daemonRunning ? .good : .warning,
      detail: "Daemon \(snapshot.daemonRunning ? "online" : "warming up")"
    ))
    summaryRow.addArrangedSubview(statCard(
      label: "Connected",
      value: "\(connectedCount)",
      tone: connectedCount > 0 ? .good : .neutral,
      detail: connectedCount == 1 ? "connector active" : "connectors active"
    ))
    summaryRow.addArrangedSubview(statCard(
      label: "Messages",
      value: "\(snapshot.messages)",
      tone: .neutral,
      detail: "local records"
    ))
    stackView.addArrangedSubview(summaryRow)

    let systemCard = cardView(
      eyebrow: "System Setup",
      title: "Get this Mac ready",
      subtitle: "Turn on startup behavior, install the CLI, and grant the macOS permissions local connectors need."
    )
    systemCard.stack.addArrangedSubview(actionRow(
      title: launchAgentLoaded ? "Run at login is enabled" : "Run at login is disabled",
      detail: "Cued launches the menu bar app and daemon automatically after login.",
      statusText: launchAgentLoaded ? "On" : "Off",
      statusStyle: launchAgentLoaded ? .good : .neutral,
      buttonTitle: launchAgentLoaded ? "Disable" : "Enable",
      buttonStyle: launchAgentLoaded ? .secondary : .primary,
      action: { [weak self] in
        self?.runAction(arguments: ["launchd", launchAgentLoaded ? "uninstall" : "install"])
      }
    ))
    systemCard.stack.addArrangedSubview(divider())
    systemCard.stack.addArrangedSubview(actionRow(
      title: cliStatus?.installed == true ? "Command line access is ready" : "Install the cued CLI",
      detail: cliStatus?.path ?? "\(NSHomeDirectory())/.local/bin/cued",
      statusText: cliStatus?.installed == true ? "Installed" : "Not installed",
      statusStyle: cliStatus?.installed == true ? .good : .neutral,
      buttonTitle: cliStatus?.installed == true ? "Reinstall" : "Install CLI",
      buttonStyle: cliStatus?.installed == true ? .secondary : .primary,
      action: { [weak self] in
        self?.runAction(arguments: ["cli", "install"])
      }
    ))
    systemCard.stack.addArrangedSubview(divider())
    systemCard.stack.addArrangedSubview(actionRow(
      title: "Grant macOS permissions",
      detail: "Contacts and Full Disk Access unlock local connectors like Contacts.app and Messages.",
      statusText: permissionStatusLabel(for: integrations),
      statusStyle: permissionStatusStyle(for: integrations),
      buttonTitle: "Open Permissions",
      buttonStyle: .primary,
      action: { [weak self] in
        self?.daemonSupervisor.requestPermissions()
        self?.refresh()
      }
    ))

    let healthCard = cardView(
      eyebrow: "Install Snapshot",
      title: "Current local state",
      subtitle: "A quick read on the machine and datastore before you connect anything."
    )
    let healthStats = NSStackView()
    healthStats.orientation = .vertical
    healthStats.alignment = .leading
    healthStats.spacing = 10
    healthStats.addArrangedSubview(statusMetricRow(label: "Version", value: displayVersion))
    healthStats.addArrangedSubview(divider())
    healthStats.addArrangedSubview(statusMetricRow(label: "Channel", value: releaseChannel))
    healthStats.addArrangedSubview(divider())
    healthStats.addArrangedSubview(statusMetricRow(label: "Contacts", value: "\(snapshot.contacts)"))
    healthStats.addArrangedSubview(divider())
    healthStats.addArrangedSubview(statusMetricRow(label: "Conversations", value: "\(snapshot.conversations)"))
    healthStats.addArrangedSubview(divider())
    healthStats.addArrangedSubview(statusMetricRow(label: "Raw events", value: "\(snapshot.rawEvents)"))
    healthCard.stack.addArrangedSubview(healthStats)
    healthCard.stack.addArrangedSubview(calloutView(
      tone: snapshot.daemonRunning ? .neutral : .warning,
      text: snapshot.daemonRunning
        ? "Cued is installed and running locally. You can finish machine setup now or skip straight to connector setup."
        : "The daemon is still starting. You can continue setup while it finishes warming up."
    ))

    stackView.addArrangedSubview(twoColumnRow(systemCard.container, healthCard.container))

    let connectorsCard = cardView(
      eyebrow: "Connectors",
      title: "Choose what to connect",
      subtitle: "You can skip any connector now and add it later from the menu bar app."
    )
    if integrations.isEmpty {
      connectorsCard.stack.addArrangedSubview(emptyStateView(
        title: "No connectors are available yet",
        detail: "Connectors will appear here as soon as the daemon reports supported integrations for this host."
      ))
    } else {
      for (index, integration) in integrations.enumerated() {
        connectorsCard.stack.addArrangedSubview(connectorRow(integration))
        if index < integrations.count - 1 {
          connectorsCard.stack.addArrangedSubview(divider())
        }
      }
    }
    stackView.addArrangedSubview(connectorsCard.container)

    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.spacing = 12
    footer.alignment = .centerY
    footer.distribution = .gravityAreas

    let footerNote = secondaryLabel("You can reopen setup any time from the menu bar.")
    footer.addArrangedSubview(footerNote)

    let spacer = NSView()
    spacer.translatesAutoresizingMaskIntoConstraints = false
    footer.addArrangedSubview(spacer)
    footer.setVisibilityPriority(.detachOnlyIfNecessary, for: spacer)

    let updatesButton = makeButton(title: "View Releases", style: .secondary)
    updatesButton.target = self
    updatesButton.action = #selector(openReleasesPage)
    footer.addArrangedSubview(updatesButton)

    let finishButton = makeButton(title: "Finish Setup", style: .primary)
    finishButton.target = self
    finishButton.action = #selector(finishOnboarding)
    footer.addArrangedSubview(finishButton)
    stackView.addArrangedSubview(footer)
    scrollView.contentView.scroll(to: .zero)
    scrollView.reflectScrolledClipView(scrollView.contentView)
  }

  private func connectorRow(_ integration: SetupIntegrationStatus) -> NSView {
    let title = connectorTitle(integration)
    let detail = connectorDetail(integration)

    let buttonTitle: String?
    let buttonStyle: ActionButtonStyle
    if integration.capability.availability == "unsupported" {
      buttonTitle = nil
      buttonStyle = .secondary
    } else if integration.capability.availability == "requires_permission" {
      buttonTitle = "Grant Access"
      buttonStyle = .secondary
    } else if isConnectedIntegrationState(integration.authState) {
      buttonTitle = "Reconnect"
      buttonStyle = .secondary
    } else {
      buttonTitle = "Connect"
      buttonStyle = .primary
    }

    return actionRow(
      title: title,
      detail: detail,
      statusText: connectorStatusText(integration),
      statusStyle: connectorStatusStyle(integration),
      buttonTitle: buttonTitle,
      buttonStyle: buttonStyle,
      action: { [weak self] in
        guard let self else {
          return
        }
        if integration.capability.availability == "requires_permission" {
          self.daemonSupervisor.requestPermissions()
          self.refresh()
          return
        }
        self.runAction(arguments: ["integrations", "connect", integration.platform, integration.accountKey])
      }
    )
  }

  private func clearStack() {
    buttonActions.removeAll()
    let subviews = stackView.arrangedSubviews
    for view in subviews {
      stackView.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
  }

  private func sectionTitle(_ value: String) -> NSTextField {
    let label = NSTextField(labelWithString: value)
    label.font = NSFont.systemFont(ofSize: 16, weight: .semibold)
    label.textColor = .labelColor
    return label
  }

  private func bodyLabel(_ value: String) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: value)
    label.font = NSFont.systemFont(ofSize: 13)
    label.textColor = .secondaryLabelColor
    label.maximumNumberOfLines = 0
    return label
  }

  private func secondaryLabel(_ value: String) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: value)
    label.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    label.textColor = .secondaryLabelColor
    label.maximumNumberOfLines = 0
    return label
  }

  private func heroTitleLabel(_ value: String) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: value)
    label.font = NSFont.systemFont(ofSize: 30, weight: .bold)
    label.textColor = .labelColor
    label.maximumNumberOfLines = 0
    return label
  }

  private func eyebrowLabel(_ value: String) -> NSTextField {
    let label = NSTextField(labelWithString: value.uppercased())
    label.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
    label.textColor = .secondaryLabelColor
    return label
  }

  private enum BadgeStyle {
    case good
    case warning
    case neutral
    case danger
  }

  private enum ActionButtonStyle {
    case primary
    case secondary
  }

  private func toneTextColor(_ style: BadgeStyle) -> NSColor {
    switch style {
    case .good:
      return NSColor.systemGreen
    case .warning:
      return NSColor.systemOrange
    case .neutral:
      return NSColor.labelColor
    case .danger:
      return NSColor.systemRed
    }
  }

  private func badge(text: String, style: BadgeStyle) -> NSView {
    let label = NSTextField(labelWithString: text.uppercased())
    label.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
    label.textColor = badgeTextColor(style)

    let container = NSView()
    container.wantsLayer = true
    container.layer?.cornerRadius = 999
    container.layer?.backgroundColor = badgeBackgroundColor(style).cgColor
    container.translatesAutoresizingMaskIntoConstraints = false

    label.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
      label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
      label.topAnchor.constraint(equalTo: container.topAnchor, constant: 5),
      label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -5),
    ])

    return container
  }

  private func badgeBackgroundColor(_ style: BadgeStyle) -> NSColor {
    switch style {
    case .good:
      return NSColor.systemGreen.withAlphaComponent(0.14)
    case .warning:
      return NSColor.systemOrange.withAlphaComponent(0.14)
    case .neutral:
      return NSColor.controlBackgroundColor
    case .danger:
      return NSColor.systemRed.withAlphaComponent(0.14)
    }
  }

  private func badgeTextColor(_ style: BadgeStyle) -> NSColor {
    switch style {
    case .good:
      return NSColor.systemGreen
    case .warning:
      return NSColor.systemOrange
    case .neutral:
      return NSColor.secondaryLabelColor
    case .danger:
      return NSColor.systemRed
    }
  }

  private func makeButton(title: String, style: ActionButtonStyle) -> NSButton {
    let button = NSButton(title: title, target: nil, action: nil)
    button.isBordered = true
    button.bezelStyle = .rounded
    button.controlSize = .large
    if #available(macOS 11.0, *) {
      button.bezelColor = style == .primary ? .controlAccentColor : .controlBackgroundColor
    }
    button.contentTintColor = style == .primary ? .white : .labelColor
    button.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.heightAnchor.constraint(equalToConstant: 36).isActive = true
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: max(120, CGFloat(title.count * 8))).isActive = true
    return button
  }

  private func divider() -> NSView {
    let line = NSView()
    line.wantsLayer = true
    line.layer?.backgroundColor = NSColor(calibratedWhite: 1, alpha: 0.08).cgColor
    line.translatesAutoresizingMaskIntoConstraints = false
    line.heightAnchor.constraint(equalToConstant: 1).isActive = true
    return line
  }

  private func heroHeader(version: String, releaseChannel: String, daemonRunning: Bool) -> NSView {
    let container = NSStackView()
    container.orientation = .vertical
    container.alignment = .centerX
    container.spacing = 12

    let iconWrap = NSView()
    iconWrap.translatesAutoresizingMaskIntoConstraints = false
    iconWrap.wantsLayer = true
    iconWrap.layer?.cornerRadius = 58

    let glow = NSView()
    glow.translatesAutoresizingMaskIntoConstraints = false
    glow.wantsLayer = true
    glow.layer?.cornerRadius = 52
    glow.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.18).cgColor
    iconWrap.addSubview(glow)

    let icon = NSImageView(image: NSApp.applicationIconImage)
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.imageScaling = .scaleProportionallyUpOrDown
    icon.wantsLayer = true
    icon.layer?.cornerRadius = 18
    icon.layer?.masksToBounds = true
    iconWrap.addSubview(icon)

    NSLayoutConstraint.activate([
      iconWrap.widthAnchor.constraint(equalToConstant: 112),
      iconWrap.heightAnchor.constraint(equalToConstant: 112),
      glow.centerXAnchor.constraint(equalTo: iconWrap.centerXAnchor),
      glow.centerYAnchor.constraint(equalTo: iconWrap.centerYAnchor),
      glow.widthAnchor.constraint(equalToConstant: 104),
      glow.heightAnchor.constraint(equalToConstant: 104),
      icon.centerXAnchor.constraint(equalTo: iconWrap.centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: iconWrap.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 76),
      icon.heightAnchor.constraint(equalToConstant: 76),
    ])
    container.addArrangedSubview(iconWrap)

    let title = NSTextField(wrappingLabelWithString: "Set up Cued on this Mac")
    title.font = NSFont.systemFont(ofSize: 30, weight: .semibold)
    title.textColor = .labelColor
    title.alignment = .center
    title.maximumNumberOfLines = 0
    container.addArrangedSubview(title)

    let subtitle = NSTextField(wrappingLabelWithString: "Local-first messaging and contacts for agents. Finish machine setup now, then connect the sources you want.")
    subtitle.font = NSFont.systemFont(ofSize: 14)
    subtitle.textColor = .secondaryLabelColor
    subtitle.alignment = .center
    subtitle.maximumNumberOfLines = 0
    subtitle.preferredMaxLayoutWidth = 560
    container.addArrangedSubview(subtitle)

    let badges = NSStackView()
    badges.orientation = .horizontal
    badges.spacing = 10
    badges.alignment = .centerY
    badges.addArrangedSubview(badge(text: "v\(version)", style: .neutral))
    badges.addArrangedSubview(badge(text: releaseChannel, style: .neutral))
    badges.addArrangedSubview(badge(text: daemonRunning ? "Daemon ready" : "Daemon starting", style: daemonRunning ? .good : .warning))
    container.addArrangedSubview(badges)

    return container
  }

  private func cardView(
    eyebrow: String,
    title: String,
    subtitle: String
  ) -> (container: NSView, stack: NSStackView) {
    let wrapper = NSVisualEffectView()
    wrapper.material = .popover
    wrapper.state = .active
    wrapper.blendingMode = .withinWindow
    wrapper.wantsLayer = true
    wrapper.layer?.cornerRadius = 20
    wrapper.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    wrapper.layer?.borderWidth = 1
    wrapper.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor
    wrapper.translatesAutoresizingMaskIntoConstraints = false

    let content = NSStackView()
    content.orientation = .vertical
    content.alignment = .leading
    content.spacing = 14
    content.translatesAutoresizingMaskIntoConstraints = false
    wrapper.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 22),
      content.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -22),
      content.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 20),
      content.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -20),
    ])

    content.addArrangedSubview(eyebrowLabel(eyebrow))
    content.addArrangedSubview(sectionTitle(title))
    content.addArrangedSubview(bodyLabel(subtitle))
    return (wrapper, content)
  }

  private func twoColumnRow(_ left: NSView, _ right: NSView) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .top
    row.spacing = 14
    row.distribution = .fillEqually
    row.addArrangedSubview(left)
    row.addArrangedSubview(right)
    return row
  }

  private func statCard(label: String, value: String, tone: BadgeStyle, detail: String) -> NSView {
    let wrapper = NSVisualEffectView()
    wrapper.material = .popover
    wrapper.state = .active
    wrapper.blendingMode = .withinWindow
    wrapper.wantsLayer = true
    wrapper.layer?.cornerRadius = 16
    wrapper.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    wrapper.layer?.borderWidth = 1
    wrapper.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.3).cgColor

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    wrapper.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -16),
    ])

    let labelView = NSTextField(labelWithString: label.uppercased())
    labelView.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    labelView.textColor = .secondaryLabelColor
    stack.addArrangedSubview(labelView)

    let valueView = NSTextField(labelWithString: value)
    valueView.font = NSFont.systemFont(ofSize: 24, weight: .bold)
    valueView.textColor = toneTextColor(tone)
    stack.addArrangedSubview(valueView)
    stack.addArrangedSubview(secondaryLabel(detail))

    return wrapper
  }

  private func statusMetricRow(label: String, value: String) -> NSView {
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.distribution = .fill
    row.spacing = 10

    let left = secondaryLabel(label)
    let right = NSTextField(labelWithString: value)
    right.font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .semibold)
    right.textColor = .labelColor
    right.alignment = .right
    row.addArrangedSubview(left)
    row.addArrangedSubview(NSView())
    row.addArrangedSubview(right)
    return row
  }

  private func calloutView(tone: BadgeStyle, text: String) -> NSView {
    let wrapper = NSView()
    wrapper.wantsLayer = true
    wrapper.layer?.cornerRadius = 14
    wrapper.layer?.backgroundColor = badgeBackgroundColor(tone).cgColor
    wrapper.translatesAutoresizingMaskIntoConstraints = false

    let label = NSTextField(wrappingLabelWithString: text)
    label.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    label.textColor = badgeTextColor(tone)
    label.translatesAutoresizingMaskIntoConstraints = false
    wrapper.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 14),
      label.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -14),
      label.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 12),
      label.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -12),
    ])
    return wrapper
  }

  private func actionRow(
    title: String,
    detail: String,
    statusText: String,
    statusStyle: BadgeStyle,
    buttonTitle: String?,
    buttonStyle: ActionButtonStyle,
    action: @escaping () -> Void
  ) -> NSView {
    let container = NSStackView()
    container.orientation = .horizontal
    container.alignment = .centerY
    container.spacing = 16
    container.distribution = .fill

    let labels = NSStackView()
    labels.orientation = .vertical
    labels.spacing = 6
    labels.alignment = .leading
    let titleLabel = NSTextField(labelWithString: title)
    titleLabel.font = NSFont.systemFont(ofSize: 15, weight: .semibold)
    titleLabel.textColor = .labelColor
    labels.addArrangedSubview(titleLabel)
    labels.addArrangedSubview(bodyLabel(detail))
    container.addArrangedSubview(labels)

    let trailing = NSStackView()
    trailing.orientation = .horizontal
    trailing.spacing = 10
    trailing.alignment = .centerY
    trailing.setHuggingPriority(.required, for: .horizontal)
    trailing.addArrangedSubview(badge(text: statusText, style: statusStyle))

    if let buttonTitle {
      let button = makeButton(title: buttonTitle, style: buttonStyle)
      button.target = self
      button.action = #selector(handleButtonAction(_:))
      buttonActions[ObjectIdentifier(button)] = action
      trailing.addArrangedSubview(button)
    }

    container.addArrangedSubview(trailing)

    return container
  }

  private func emptyStateView(title: String, detail: String) -> NSView {
    let container = NSStackView()
    container.orientation = .vertical
    container.alignment = .leading
    container.spacing = 8
    let icon = NSTextField(labelWithString: "◎")
    icon.font = NSFont.systemFont(ofSize: 26, weight: .regular)
    icon.textColor = NSColor(calibratedRed: 0.57, green: 0.74, blue: 1.0, alpha: 0.9)
    container.addArrangedSubview(icon)
    container.addArrangedSubview(sectionTitle(title))
    container.addArrangedSubview(bodyLabel(detail))
    return container
  }

  private func permissionStatusLabel(for integrations: [SetupIntegrationStatus]) -> String {
    if integrations.contains(where: { $0.capability.availability == "requires_permission" }) {
      return "Needed"
    }
    return "Ready"
  }

  private func permissionStatusStyle(for integrations: [SetupIntegrationStatus]) -> BadgeStyle {
    integrations.contains(where: { $0.capability.availability == "requires_permission" }) ? .warning : .good
  }

  private func connectorTitle(_ integration: SetupIntegrationStatus) -> String {
    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      return title
    }
    return integration.platform.capitalized
  }

  private func connectorDetail(_ integration: SetupIntegrationStatus) -> String {
    var parts = [integrationStateLabel(integration.authState).capitalized]
    if let reason = integration.capability.reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !reason.isEmpty {
      parts.append(reason)
    }
    return parts.joined(separator: " • ")
  }

  private func connectorStatusText(_ integration: SetupIntegrationStatus) -> String {
    if integration.capability.availability == "unsupported" {
      return "Unsupported"
    }
    if integration.capability.availability == "requires_permission" {
      return "Needs access"
    }
    if isConnectedIntegrationState(integration.authState) {
      return "Connected"
    }
    if integration.authState == "in_progress" {
      return "Connecting"
    }
    return "Ready"
  }

  private func connectorStatusStyle(_ integration: SetupIntegrationStatus) -> BadgeStyle {
    if integration.capability.availability == "unsupported" {
      return .neutral
    }
    if integration.capability.availability == "requires_permission" {
      return .warning
    }
    if isConnectedIntegrationState(integration.authState) {
      return .good
    }
    if integration.authState == "blocked" || integration.authState == "check_failed" {
      return .danger
    }
    return .neutral
  }

  private func runAction(arguments: [String]) {
    rebuildLoading()
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      _ = daemonSupervisor.runCLI(arguments: arguments)
      await MainActor.run {
        self.onRefresh()
        self.refresh()
      }
    }
  }

  @objc private func finishOnboarding() {
    _ = daemonSupervisor.runCLI(arguments: ["onboarding", "complete"])
    close()
    onRefresh()
  }

  @objc func openReleasesPage() {
    guard let url = URL(string: "https://github.com/Cue-d/cued/releases") else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  @objc private func handleButtonAction(_ sender: NSButton) {
    buttonActions[ObjectIdentifier(sender)]?()
  }
}

@MainActor
final class MenuBarAppController: NSObject, NSApplicationDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let dbPath: String
  private let statusStore: AppStatusStore
  private let daemonSupervisor: DaemonSupervisor
  private lazy var onboardingWindowController = OnboardingWindowController(
    daemonSupervisor: daemonSupervisor,
    onRefresh: { [weak self] in
      self?.refreshStatus()
    }
  )
  private lazy var statusMonitor = DatabaseActivityMonitor(dbPath: dbPath) { [weak self] in
    self?.refreshStatus()
  }
  private var timer: Timer?
  private var shouldAutoStartDaemon = true
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
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
      self?.openSetupIfNeeded()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
    statusMonitor.stop()
  }

  @objc private func openSetup() {
    onboardingWindowController.showAndRefresh()
  }

  @objc private func toggleDaemon() {
    let snapshot = statusStore.readSnapshot()
    let daemonStarting = daemonSupervisor.isLaunching(snapshot: snapshot)
    if snapshot.daemonRunning || daemonStarting {
      shouldAutoStartDaemon = false
      daemonSupervisor.stop(activePID: snapshot.daemonPID)
    } else {
      shouldAutoStartDaemon = true
      daemonSupervisor.startIfNeeded()
    }
    rebuildMenu()
  }

  @objc private func refreshStatus() {
    if shouldAutoStartDaemon {
      daemonSupervisor.startIfNeeded()
    }
    rebuildMenu()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }

  @objc private func checkForUpdates() {
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      let result = daemonSupervisor.runCLI(arguments: ["update", "check", "--force"])
      let updateStatus: UpdateStatusResponse? = result.flatMap { output in
        guard output.status == 0, let data = output.stdout.data(using: .utf8) else {
          return nil
        }
        return try? JSONDecoder().decode(UpdateStatusResponse.self, from: data)
      }

      await MainActor.run { [weak self] in
        guard let self else {
          return
        }
        self.refreshStatus()
        if let updateStatus {
          self.presentUpdateStatus(updateStatus)
          return
        }

        let message = result?.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        self.presentAlert(
          title: "Update Check Failed",
          message: message?.isEmpty == false ? message! : "Cued could not check GitHub Releases right now."
        )
      }
    }
  }

  private func openSetupIfNeeded() {
    let snapshot = statusStore.readSnapshot()
    let currentVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
      ?? snapshot.installedAppVersion
    guard snapshot.onboardingCompletedVersion != currentVersion else {
      return
    }
    onboardingWindowController.showAndRefresh()
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
        ? "Daemon running"
        : daemonStarting
          ? "Daemon starting"
          : "Daemon stopped",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    menu.addItem(
      withTitle: "Messages \(snapshot.messages)  Contacts \(snapshot.contacts)  Conversations \(snapshot.conversations)",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false
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
    let debugItem = NSMenuItem(title: "Debug", action: nil, keyEquivalent: "")
    debugItem.submenu = buildDebugMenu(snapshot: snapshot, daemonStarting: daemonStarting)
    menu.addItem(debugItem)

    menu.addItem(.separator())
    let daemonToggleItem = menu.addItem(
      withTitle: snapshot.daemonRunning || daemonStarting ? "Stop" : "Start",
      action: #selector(toggleDaemon),
      keyEquivalent: ""
    )
    daemonToggleItem.target = self

    menu.addItem(withTitle: "Settings", action: #selector(openSetup), keyEquivalent: "").target = self
    menu.addItem(
      withTitle: snapshot.updateSummary?.availableVersion.map { "Update Available: v\($0)" } ?? "Check for Updates",
      action: #selector(checkForUpdates),
      keyEquivalent: ""
    ).target = self

    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit", action: #selector(quitApp), keyEquivalent: "q").target = self

    statusItem.menu = menu
  }

  private func presentUpdateStatus(_ status: UpdateStatusResponse) {
    if status.available, let targetVersion = status.availableVersion {
      let alert = NSAlert()
      alert.alertStyle = .informational
      alert.messageText = "Update Available: v\(targetVersion)"
      alert.informativeText =
        "Current version: v\(status.currentVersion)\nInstalling the update will restart Cued and migrate the local database if needed."
      alert.addButton(withTitle: "Install and Restart")
      alert.addButton(withTitle: "Later")
      if status.releaseUrl != nil {
        alert.addButton(withTitle: "View Releases")
      }
      NSApp.activate(ignoringOtherApps: true)
      let response = alert.runModal()
      if response == .alertFirstButtonReturn {
        installUpdate()
        return
      }
      if status.releaseUrl != nil, response == NSApplication.ModalResponse.alertThirdButtonReturn {
        openReleaseURL(status.releaseUrl)
      }
      return
    }

    if let error = status.lastError {
      presentAlert(title: "Updater Error", message: error.message)
      return
    }

    presentAlert(
      title: "Cued Is Up To Date",
      message: "You are already running v\(status.currentVersion)."
    )
  }

  private func installUpdate() {
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      let result = daemonSupervisor.runCLI(arguments: ["update", "install"])
      let installResponse: UpdateInstallResponse? = result.flatMap { output in
        guard output.status == 0, let data = output.stdout.data(using: .utf8) else {
          return nil
        }
        return try? JSONDecoder().decode(UpdateInstallResponse.self, from: data)
      }

      await MainActor.run { [weak self] in
        guard let self else {
          return
        }
        if let installResponse, installResponse.started {
          NSApp.terminate(nil)
          return
        }

        let message = result?.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        self.presentAlert(
          title: "Install Failed",
          message: message?.isEmpty == false ? message! : "Cued could not start the update installer."
        )
      }
    }
  }

  private func presentAlert(title: String, message: String) {
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }

  private func openReleaseURL(_ value: String?) {
    guard let value, let url = URL(string: value) else {
      onboardingWindowController.openReleasesPage()
      return
    }
    NSWorkspace.shared.open(url)
  }

  private func buildDebugMenu(snapshot: AppStatusSnapshot, daemonStarting: Bool) -> NSMenu {
    let debugMenu = NSMenu(title: "Debug")

    let daemonItem = NSMenuItem(
      title: debugSummaryTitle(
        label: "Daemon",
        value: snapshot.daemonRunning ? "running" : daemonStarting ? "starting" : "stopped"
      ),
      action: nil,
      keyEquivalent: ""
    )
    daemonItem.isEnabled = false
    debugMenu.addItem(daemonItem)

    let totals = [
      debugSummaryTitle(label: "Messages", value: "\(snapshot.messages)"),
      debugSummaryTitle(label: "Contacts", value: "\(snapshot.contacts)"),
      debugSummaryTitle(label: "Conversations", value: "\(snapshot.conversations)"),
    ]

    for title in totals {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.isEnabled = false
      debugMenu.addItem(item)
    }

    debugMenu.addItem(.separator())

    if snapshot.messageBreakdown.isEmpty {
      let item = NSMenuItem(title: "No message sync data yet", action: nil, keyEquivalent: "")
      item.isEnabled = false
      debugMenu.addItem(item)
      return debugMenu
    }

    for item in snapshot.messageBreakdown {
      let menuItem = NSMenuItem(title: platformMessageDebugTitle(item), action: nil, keyEquivalent: "")
      menuItem.isEnabled = false
      debugMenu.addItem(menuItem)
    }

    return debugMenu
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
        .appendingPathComponent("../../Resources/trayIconTemplate.png")
        .standardizedFileURL.path,
      executableURL
        .deletingLastPathComponent()
        .appendingPathComponent("../../../Resources/trayIconTemplate.png")
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
