import AppKit
import Contacts
import Darwin
import Foundation
import SQLite3

private let appDaemonHeartbeatGraceMs = 120_000
private let appSingletonLockStaleMs = 15_000
private let singletonLockSlotBytes = 1_024
private let singletonLockSlotCount = 2
private let menuBarReopenNotificationName = Notification.Name("so.cued.desktop.menuBar.reopen")
private let appMessagesDBPath =
  FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Messages/chat.db").path

private func environmentPath(_ name: String) -> String? {
  trimmedEnvironmentPath(ProcessInfo.processInfo.environment, name: name)
}

private func configuredCuedHomePath() -> String {
  configuredCuedHomePath(environment: ProcessInfo.processInfo.environment)
}

private func configuredCuedDBPath() -> String {
  configuredCuedDBPath(environment: ProcessInfo.processInfo.environment)
}

private func configuredDaemonLockPath() -> String {
  "\(configuredCuedHomePath())/daemon.lock"
}

private func configuredMenuBarLockPath() -> String {
  "\(configuredCuedHomePath())/menu-bar.lock"
}

private func configuredMenuBarStatusPath() -> String {
  "\(configuredCuedHomePath())/menu-bar-status.json"
}

private func bundledNativeHelperPath() -> String? {
  guard let resourcePath = Bundle.main.resourcePath?.trimmingCharacters(in: .whitespacesAndNewlines),
        !resourcePath.isEmpty else {
    return nil
  }

  let candidate = URL(fileURLWithPath: resourcePath)
    .appendingPathComponent("helpers/cued-native-helper")
    .path
  return FileManager.default.fileExists(atPath: candidate) ? candidate : nil
}

private func currentTimeMs() -> Int {
  Int(Date().timeIntervalSince1970 * 1000)
}

private struct SingletonLockMetadata: Codable {
  let kind: String
  let pid: Int
  let startedAt: Int
  var updatedAt: Int
  let version: String?
  let executablePath: String?
  let appPath: String?
}

private enum SingletonLockError: Error {
  case held(SingletonLockMetadata?)
}

private enum SingletonLockPersistenceError: Error {
  case metadataTooLarge
}

private final class SingletonLockLease {
  private let path: String
  private var fileHandle: FileHandle?
  private(set) var metadata: SingletonLockMetadata
  private var activeSlot: Int
  private var released = false

  private init(path: String, fileHandle: FileHandle, metadata: SingletonLockMetadata) {
    self.path = path
    self.fileHandle = fileHandle
    self.metadata = metadata
    self.activeSlot = singletonLockSlotCount - 1
  }

  static func acquire(
    path: String,
    kind: String,
    staleMs: Int = appSingletonLockStaleMs,
    version: String? = nil,
    probe: (SingletonLockMetadata?) -> Bool = { _ in false }
  ) throws -> SingletonLockLease {
    let metadata = SingletonLockMetadata(
      kind: kind,
      pid: Int(ProcessInfo.processInfo.processIdentifier),
      startedAt: currentTimeMs(),
      updatedAt: currentTimeMs(),
      version: version,
      executablePath: Bundle.main.executablePath,
      appPath: Bundle.main.bundlePath
    )
    do {
      return try SingletonLockLease.create(path: path, metadata: metadata)
    } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileWriteFileExists.rawValue {
      let existing = read(path: path)
      let fresh = existing.map { currentTimeMs() - $0.updatedAt < staleMs } ?? false
      let pidRunning = existing.map { isProcessRunning($0.pid) } ?? false
      if fresh && pidRunning {
        throw SingletonLockError.held(existing)
      }
      if probe(existing) {
        throw SingletonLockError.held(existing)
      }
      try? FileManager.default.removeItem(atPath: path)
      do {
        return try SingletonLockLease.create(path: path, metadata: metadata)
      } catch let retryError as NSError where retryError.domain == NSCocoaErrorDomain && retryError.code == CocoaError.fileWriteFileExists.rawValue {
        throw SingletonLockError.held(read(path: path))
      }
    }
  }

  func heartbeat() {
    guard !released, let fileHandle else {
      return
    }
    guard stillOwnsPath(fileHandle) else {
      closeQuietly(fileHandle)
      self.fileHandle = nil
      released = true
      return
    }
    metadata.updatedAt = currentTimeMs()
    let nextSlot = (activeSlot + 1) % singletonLockSlotCount
    do {
      try writeLockFile(fileHandle, metadata: metadata, slot: nextSlot)
      activeSlot = nextSlot
    } catch {
      // Best effort.
    }
  }

  func release() {
    guard !released else {
      return
    }
    released = true
    let ownsPath = fileHandle.map(stillOwnsPath) ?? false
    if let fileHandle {
      closeQuietly(fileHandle)
      self.fileHandle = nil
    }
    if ownsPath {
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  static func read(path: String) -> SingletonLockMetadata? {
    guard let data = FileManager.default.contents(atPath: path) else {
      return nil
    }
    return parseSingletonLockContents(data)
  }

  private static func create(path: String, metadata: SingletonLockMetadata) throws -> SingletonLockLease {
    let directoryURL = URL(fileURLWithPath: path).deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )

    let fd = path.withCString { pointer in
      Darwin.open(pointer, O_RDWR | O_CREAT | O_EXCL, 0o600)
    }
    guard fd >= 0 else {
      let openError = errno
      if openError == EEXIST {
        throw CocoaError(.fileWriteFileExists)
      }
      throw POSIXError(POSIXErrorCode(rawValue: openError) ?? .EIO)
    }
    let fileHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    do {
      try initializeLockFile(fileHandle, metadata: metadata)
    } catch {
      closeQuietly(fileHandle)
      try? FileManager.default.removeItem(atPath: path)
      throw error
    }
    return SingletonLockLease(path: path, fileHandle: fileHandle, metadata: metadata)
  }

  private func stillOwnsPath(_ fileHandle: FileHandle) -> Bool {
    var fileStat = stat()
    guard fstat(fileHandle.fileDescriptor, &fileStat) == 0 else {
      return false
    }

    var pathStat = stat()
    let statResult = path.withCString { pointer in
      Darwin.lstat(pointer, &pathStat)
    }
    guard statResult == 0 else {
      return false
    }

    return fileStat.st_dev == pathStat.st_dev && fileStat.st_ino == pathStat.st_ino
  }
}

private func initializeLockFile(_ fileHandle: FileHandle, metadata: SingletonLockMetadata) throws {
  for slot in 0..<singletonLockSlotCount {
    try writeLockSlot(fileHandle, metadata: metadata, slot: slot)
  }
  try fileHandle.synchronize()
}

private func writeLockFile(
  _ fileHandle: FileHandle,
  metadata: SingletonLockMetadata,
  slot: Int
) throws {
  try writeLockSlot(fileHandle, metadata: metadata, slot: slot)
  try fileHandle.synchronize()
}

private func writeLockSlot(
  _ fileHandle: FileHandle,
  metadata: SingletonLockMetadata,
  slot: Int
) throws {
  let payload = try singletonLockPayload(metadata)
  guard payload.count <= singletonLockSlotBytes else {
    throw SingletonLockPersistenceError.metadataTooLarge
  }

  var slotData = Data(count: singletonLockSlotBytes)
  slotData.replaceSubrange(0..<payload.count, with: payload)
  try fileHandle.seek(toOffset: UInt64(slot * singletonLockSlotBytes))
  try fileHandle.write(contentsOf: slotData)
}

private func singletonLockPayload(_ metadata: SingletonLockMetadata) throws -> Data {
  let data = try JSONEncoder().encode(metadata)
  return data + Data("\n".utf8)
}

private func parseSingletonLockContents(_ data: Data) -> SingletonLockMetadata? {
  let slotCount = max(1, (data.count + singletonLockSlotBytes - 1) / singletonLockSlotBytes)
  var latest: SingletonLockMetadata?
  for slot in 0..<slotCount {
    let start = slot * singletonLockSlotBytes
    let end = min(start + singletonLockSlotBytes, data.count)
    guard start < end else {
      continue
    }
    let candidate = parseSingletonLockChunk(data.subdata(in: start..<end))
    if let candidate, latest.map({ candidate.updatedAt > $0.updatedAt }) ?? true {
      latest = candidate
    }
  }
  return latest
}

private func parseSingletonLockChunk(_ chunk: Data) -> SingletonLockMetadata? {
  let nullIndex = chunk.firstIndex(of: 0) ?? chunk.endIndex
  let prefix = chunk[..<nullIndex]
  let lineEnd = prefix.firstIndex(of: 0x0A) ?? prefix.endIndex
  let record = prefix[..<lineEnd]
  guard !record.isEmpty else {
    return nil
  }
  return try? JSONDecoder().decode(SingletonLockMetadata.self, from: Data(record))
}

private func closeQuietly(_ fileHandle: FileHandle) {
  do {
    try fileHandle.close()
  } catch {
    // Best effort.
  }
}

private func isProcessRunning(_ pid: Int) -> Bool {
  guard pid > 0 else {
    return false
  }

  if Darwin.kill(pid_t(pid), 0) == 0 {
    return true
  }

  return errno == EPERM
}

private func readSingletonLockState(path: String, staleMs: Int = appSingletonLockStaleMs) -> (running: Bool, pid: Int?, updatedAt: Int?) {
  guard let metadata = SingletonLockLease.read(path: path) else {
    return (false, nil, nil)
  }

  let fresh = currentTimeMs() - metadata.updatedAt < staleMs
  let running = fresh && isProcessRunning(metadata.pid)
  return (running, running ? metadata.pid : nil, metadata.updatedAt)
}

private func normalizeFileSystemPath(_ path: String) -> String {
  URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

private func extractAppBundlePath(from command: String) -> String? {
  guard let range = command.range(of: "/Cued.app/") else {
    return nil
  }
  let prefix = command[..<range.upperBound]
  guard let start = prefix.lastIndex(of: " ") else {
    return String(prefix.dropLast())
  }
  return String(prefix[prefix.index(after: start)..<prefix.index(before: prefix.endIndex)])
}

private func looksLikeCuedDaemonCommand(_ command: String) -> Bool {
  command.contains("/Cued.app/")
    && (
      command.contains("/Contents/MacOS/CuedDaemon")
        || command.contains("/Contents/Resources/cued-cli daemon")
        || command.contains("dist/cli.js daemon")
    )
}

private func terminateCompetingDaemonProcesses(currentAppPath: String) {
  let normalizedCurrentAppPath = normalizeFileSystemPath(currentAppPath)
  let currentPID = Int(ProcessInfo.processInfo.processIdentifier)

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/ps")
  process.arguments = ["-axo", "pid=,command="]
  let stdout = Pipe()
  process.standardOutput = stdout
  process.standardError = nil
  do {
    try process.run()
  } catch {
    return
  }

  let data = stdout.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()

  guard process.terminationStatus == 0 else {
    return
  }

  guard let output = String(data: data, encoding: .utf8) else {
    return
  }

  var terminatedPIDs: [Int] = []
  for rawLine in output.split(separator: "\n") {
    let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !line.isEmpty, let splitIndex = line.firstIndex(where: \.isWhitespace) else {
      continue
    }
    let pidText = line[..<splitIndex].trimmingCharacters(in: .whitespacesAndNewlines)
    let command = line[splitIndex...].trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pid = Int(pidText), pid > 0, pid != currentPID, looksLikeCuedDaemonCommand(command) else {
      continue
    }

    guard let appPath = extractAppBundlePath(from: command) else {
      continue
    }
    let normalizedAppPath = normalizeFileSystemPath(appPath)
    let shouldTerminate =
      normalizedAppPath != normalizedCurrentAppPath
        || normalizedAppPath.contains("/.Trash/")
        || normalizedAppPath.contains("/Trash/")
        || !FileManager.default.fileExists(atPath: appPath)
    guard shouldTerminate else {
      continue
    }

    if Darwin.kill(pid_t(pid), SIGTERM) == 0 || errno == ESRCH {
      terminatedPIDs.append(pid)
    }
  }

  guard !terminatedPIDs.isEmpty else {
    return
  }

  let deadline = currentTimeMs() + 5_000
  let socketPath = "\(configuredCuedHomePath())/cued.sock"
  while currentTimeMs() < deadline {
    let anyRunning = terminatedPIDs.contains { isProcessRunning($0) }
    let lockOwnerPID = SingletonLockLease.read(path: configuredDaemonLockPath())?.pid
    let lockHeldByCompetingPID = lockOwnerPID.map { terminatedPIDs.contains($0) } ?? false
    let socketExists = FileManager.default.fileExists(atPath: socketPath)
    if !anyRunning && !lockHeldByCompetingPID && !socketExists {
      break
    }
    usleep(100_000)
  }
}

private func activateExistingCuedApp() {
  guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
    return
  }

  let currentPID = ProcessInfo.processInfo.processIdentifier
  for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
  where app.processIdentifier != currentPID {
    _ = app.activate(options: [.activateIgnoringOtherApps])
  }
}

private func signalExistingMenuBarInstance() {
  DistributedNotificationCenter.default().postNotificationName(
    menuBarReopenNotificationName,
    object: nil,
    userInfo: nil,
    options: [.deliverImmediately]
  )
  activateExistingCuedApp()
}

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
  let capturedRawEvents: Int
  let projectedMessages: Int
  let pendingProjectionEvents: Int
  let pendingSearchIndexMessages: Int
  let failedSearchIndexMessages: Int
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
    let daemonLockState = readSingletonLockState(path: configuredDaemonLockPath())
    guard FileManager.default.fileExists(atPath: dbPath) else {
      return AppStatusSnapshot(
        daemonRunning: daemonLockState.running,
        daemonPID: daemonLockState.pid,
        daemonUpdatedAt: daemonLockState.updatedAt,
        contacts: 0,
        conversations: 0,
        messages: 0,
        rawEvents: 0,
        capturedRawEvents: 0,
        projectedMessages: 0,
        pendingProjectionEvents: 0,
        pendingSearchIndexMessages: 0,
        failedSearchIndexMessages: 0,
        messageBreakdown: [],
        integrations: [],
        onboardingCompletedVersion: nil,
        installedAppVersion: nil,
        releaseChannel: nil,
        cliSymlinkInstalled: false,
        updateSummary: nil
      )
    }
    if let snapshot = readSnapshotFromCache(daemonLockState: daemonLockState) {
      return snapshot
    }

    var db: OpaquePointer?
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      if let db {
        sqlite3_close(db)
      }
      return AppStatusSnapshot(
        daemonRunning: daemonLockState.running,
        daemonPID: daemonLockState.pid,
        daemonUpdatedAt: daemonLockState.updatedAt,
        contacts: 0,
        conversations: 0,
        messages: 0,
        rawEvents: 0,
        capturedRawEvents: 0,
        projectedMessages: 0,
        pendingProjectionEvents: 0,
        pendingSearchIndexMessages: 0,
        failedSearchIndexMessages: 0,
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
    let daemonState = daemonRow.running ? daemonRow : daemonLockState
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
      daemonRunning: daemonState.running,
      daemonPID: daemonState.pid,
      daemonUpdatedAt: daemonState.updatedAt,
      contacts: counts[0],
      conversations: counts[1],
      messages: counts[2],
      rawEvents: counts[3],
      capturedRawEvents: counts[3],
      projectedMessages: counts[2],
      pendingProjectionEvents: 0,
      pendingSearchIndexMessages: 0,
      failedSearchIndexMessages: 0,
      messageBreakdown: messageBreakdown,
      integrations: integrations,
      onboardingCompletedVersion: queryAppSetting(db: db, key: "onboarding_completed_version"),
      installedAppVersion: queryAppSetting(db: db, key: "installed_app_version"),
      releaseChannel: queryAppSetting(db: db, key: "release_channel"),
      cliSymlinkInstalled: queryAppSetting(db: db, key: "cli_symlink_installed") == "1",
      updateSummary: updateSummary
    )
  }

  private func readSnapshotFromCache(
    daemonLockState: (running: Bool, pid: Int?, updatedAt: Int?)
  ) -> AppStatusSnapshot? {
    guard let data = FileManager.default.contents(atPath: configuredMenuBarStatusPath()) else {
      return nil
    }
    guard
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return nil
    }
    return parseStatusPayload(payload, daemonLockState: daemonLockState)
  }

  private func parseStatusPayload(
    _ payload: [String: Any],
    daemonLockState: (running: Bool, pid: Int?, updatedAt: Int?)
  ) -> AppStatusSnapshot {
    let overview = payload["overview"] as? [String: Any] ?? [:]
    let dataStatus = payload["dataStatus"] as? [String: Any] ?? [:]
    let integrations = parseIntegrations(payload["integrations"])
    let app = payload["app"] as? [String: Any] ?? [:]
    let install = app["install"] as? [String: Any] ?? [:]
    let update = payload["update"] as? [String: Any] ?? [:]
    let daemon = payload["daemon"] as? [String: Any] ?? [:]
    let daemonUpdatedAt = intValue(daemon["updated_at"]) ?? daemonLockState.updatedAt
    let daemonPID = intValue(daemon["pid"]) ?? daemonLockState.pid
    let daemonRowFresh =
      daemonUpdatedAt.map { currentTimeMs() - $0 < appDaemonHeartbeatGraceMs } ?? false
    let daemonRowRunning =
      stringValue(daemon["status"]) == "running"
      && daemonRowFresh
      && daemonPID.map { isProcessRunning($0) } == true
    let daemonRunning =
      boolValue(payload["socketRunning"]) == true
      || boolValue(payload["daemonRunning"]) == true
      || daemonRowRunning
      || daemonLockState.running

    return AppStatusSnapshot(
      daemonRunning: daemonRunning,
      daemonPID: daemonLockState.running ? daemonLockState.pid : daemonPID,
      daemonUpdatedAt: daemonLockState.running ? daemonLockState.updatedAt : daemonUpdatedAt,
      contacts: intValue(overview["contacts"]) ?? 0,
      conversations: intValue(overview["conversations"]) ?? 0,
      messages: intValue(overview["messages"]) ?? 0,
      rawEvents: intValue(overview["rawEvents"]) ?? 0,
      capturedRawEvents: intValue(dataStatus["capturedRawEvents"]) ?? intValue(overview["rawEvents"]) ?? 0,
      projectedMessages: intValue(dataStatus["projectedMessages"]) ?? intValue(overview["messages"]) ?? 0,
      pendingProjectionEvents: intValue(dataStatus["pendingProjectionEvents"]) ?? 0,
      pendingSearchIndexMessages: intValue(dataStatus["pendingSearchIndexMessages"]) ?? 0,
      failedSearchIndexMessages: intValue(dataStatus["failedSearchIndexMessages"]) ?? 0,
      messageBreakdown: parseMessageBreakdown(overview["messageBreakdown"]),
      integrations: mergeLiveLocalIntegrations(integrations),
      onboardingCompletedVersion: stringValue(install["onboardingCompletedVersion"]),
      installedAppVersion: stringValue(install["installedAppVersion"]),
      releaseChannel: stringValue(install["releaseChannel"]),
      cliSymlinkInstalled: boolValue(install["cliSymlinkInstalled"]) ?? false,
      updateSummary: parseUpdateSummary(update)
    )
  }

  private func parseMessageBreakdown(_ value: Any?) -> [AppPlatformMessageCount] {
    guard let rows = value as? [[String: Any]] else {
      return []
    }

    return rows.compactMap { row in
      guard let platform = stringValue(row["platform"]) else {
        return nil
      }
      return AppPlatformMessageCount(
        platform: platform,
        messages: intValue(row["messages"]) ?? 0
      )
    }
  }

  private func parseIntegrations(_ value: Any?) -> [AppIntegrationStatus] {
    guard let rows = value as? [[String: Any]] else {
      return []
    }

    return rows.compactMap { row in
      guard
        let platform = stringValue(row["platform"]),
        let accountKey = stringValue(row["accountKey"]),
        let authState = stringValue(row["authState"])
      else {
        return nil
      }

      return AppIntegrationStatus(
        platform: platform,
        accountKey: accountKey,
        displayName: stringValue(row["displayName"]),
        authState: authState,
        enabled: boolValue(row["enabled"]) ?? false
      )
    }
  }

  private func parseUpdateSummary(_ value: Any?) -> AppUpdateSummary? {
    guard let update = value as? [String: Any] else {
      return nil
    }

    return AppUpdateSummary(
      availableVersion: stringValue(update["availableVersion"]),
      releaseURL: stringValue(update["releaseUrl"])
    )
  }

  private func stringValue(_ value: Any?) -> String? {
    value as? String
  }

  private func intValue(_ value: Any?) -> Int? {
    switch value {
    case let number as NSNumber:
      return number.int64Value > Int64(Int.max) || number.int64Value < Int64(Int.min)
        ? nil
        : Int(number.int64Value)
    case let text as String:
      return Int(text)
    default:
      return nil
    }
  }

  private func boolValue(_ value: Any?) -> Bool? {
    switch value {
    case let bool as Bool:
      return bool
    case let number as NSNumber:
      return number.boolValue
    case let text as String:
      return (text as NSString).boolValue
    default:
      return nil
    }
  }

  private func metadataMarksUserRemoved(_ metadataJSON: String?) -> Bool {
    guard let metadataJSON,
          let data = metadataJSON.data(using: .utf8),
          let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return false
    }
    return boolValue(metadata["userRemoved"]) == true
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
    let fresh = (updatedAt ?? 0) > 0 && (Int(Date().timeIntervalSince1970 * 1000) - (updatedAt ?? 0)) < appDaemonHeartbeatGraceMs
    let running = fresh && pid.map { isProcessRunning($0) } == true
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
      SELECT i.platform, i.account_key, i.auth_state, i.enabled
      , CASE
          WHEN i.platform = 'linkedin'
            AND TRIM(COALESCE(i.display_name, '')) = 'LinkedIn'
            AND TRIM(COALESCE(s.display_name, '')) NOT IN ('', 'LinkedIn')
          THEN s.display_name
          ELSE i.display_name
        END AS display_name
      , i.metadata_json
      FROM integration_states i
      LEFT JOIN source_accounts s
        ON s.platform = i.platform
       AND s.account_key = i.account_key
      ORDER BY i.platform, i.account_key
    """

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return []
    }
    defer { sqlite3_finalize(statement) }

    var results: [AppIntegrationStatus] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let metadataJSON = sqlite3_column_type(statement, 5) == SQLITE_NULL
        ? nil
        : String(cString: sqlite3_column_text(statement, 5))
      if metadataMarksUserRemoved(metadataJSON) {
        continue
      }
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
  private let queue = DispatchQueue(label: "so.cued.desktop.status-watch")
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
  case "needs_auth":
    return "not authenticated"
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

private func sourceSummaryTitle(connected: Int, needsAttention: Int) -> String {
  if connected == 0 && needsAttention == 0 {
    return "No sources connected"
  }
  if connected == 0 {
    return "\(needsAttention) source\(needsAttention == 1 ? "" : "s") need\(needsAttention == 1 ? "s" : "") attention"
  }

  let connectedText = "\(connected) source\(connected == 1 ? "" : "s") connected"
  guard needsAttention > 0 else {
    return connectedText
  }

  return "\(connectedText) • \(needsAttention) need\(needsAttention == 1 ? "s" : "") attention"
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
        environment["CUED_AUTH_NATIVE_BINARY"] = executablePath
      }
      command = buildShellCommand(setupCommand, environment: environment)
    }

    runInTerminal(command)
  }

  func requestPermissions() {
    var environment = daemonEnvironment()
    if let helperPath = bundledNativeHelperPath() {
      environment["CUED_NATIVE_BINARY"] = helperPath
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

  nonisolated func launchCLI(arguments: [String]) -> Bool {
    if let daemonLaunchPath, !daemonLaunchPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: daemonLaunchPath)
      process.arguments = arguments
      process.environment = daemonEnvironment()
      process.standardOutput = nil
      process.standardError = nil
      do {
        try process.run()
        return true
      } catch {
        return false
      }
    }

    let command = arguments.map(shellEscape).joined(separator: " ")
    return launchShellCommand(command, environment: daemonEnvironment()) != nil
  }

  private nonisolated func daemonEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    for (key, value) in loadConfiguredDaemonEnvironment(environment: environment) {
      environment[key] = value
    }
    let executablePath = Bundle.main.executablePath?.trimmingCharacters(in: .whitespacesAndNewlines)

    if let helperPath = bundledNativeHelperPath() {
      if environment["CUED_NATIVE_BINARY"] == nil {
        environment["CUED_NATIVE_BINARY"] = helperPath
      }
      if environment["CUED_IMESSAGE_NATIVE_BINARY"] == nil {
        environment["CUED_IMESSAGE_NATIVE_BINARY"] = helperPath
      }
      if environment["CUED_CONTACTS_NATIVE_BINARY"] == nil {
        environment["CUED_CONTACTS_NATIVE_BINARY"] = helperPath
      }
    } else if let executablePath, !executablePath.isEmpty {
      if environment["CUED_IMESSAGE_NATIVE_BINARY"] == nil {
        environment["CUED_IMESSAGE_NATIVE_BINARY"] = executablePath
      }
      if environment["CUED_CONTACTS_NATIVE_BINARY"] == nil {
        environment["CUED_CONTACTS_NATIVE_BINARY"] = executablePath
      }
    }
    if let executablePath, !executablePath.isEmpty, environment["CUED_AUTH_NATIVE_BINARY"] == nil
    {
      environment["CUED_AUTH_NATIVE_BINARY"] = executablePath
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

@MainActor
final class MenuBarAppController: NSObject, NSApplicationDelegate {
  private static let statusItemImageHeight: CGFloat = 18
  private static let statusItemHorizontalPadding: CGFloat = 0
  private static let fallbackStatusItemLength: CGFloat = 18

  private let statusItem = NSStatusBar.system.statusItem(withLength: fallbackStatusItemLength)
  private let dbPath: String
  private let menuBarLease: SingletonLockLease
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

  fileprivate init(
    dbPath: String,
    daemonLaunchPath: String?,
    daemonCommand: String,
    setupCommand: String,
    permissionsCommand: String,
    menuBarLease: SingletonLockLease
  ) {
    self.dbPath = dbPath
    self.menuBarLease = menuBarLease
    self.statusStore = AppStatusStore(dbPath: dbPath)
    self.daemonSupervisor = DaemonSupervisor(
      daemonLaunchPath: daemonLaunchPath,
      daemonCommand: daemonCommand,
      setupCommand: setupCommand,
      permissionsCommand: permissionsCommand,
      statusStore: self.statusStore
    )
    super.init()
    DistributedNotificationCenter.default().addObserver(
      self,
      selector: #selector(handleMenuBarReopenNotification(_:)),
      name: menuBarReopenNotificationName,
      object: nil
    )
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    menuBarLease.heartbeat()
    daemonSupervisor.startIfNeeded()
    rebuildMenu()
    statusMonitor.start()
    timer = Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(refreshStatus), userInfo: nil, repeats: true)
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
    DistributedNotificationCenter.default().removeObserver(self)
    menuBarLease.release()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    onboardingWindowController.showAndRefresh(forceActivePermissionRefresh: true)
    return true
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
    menuBarLease.heartbeat()
    if shouldAutoStartDaemon {
      daemonSupervisor.startIfNeeded()
    }
    rebuildMenu()
  }

  @objc private func handleMenuBarReopenNotification(_ notification: Notification) {
    onboardingWindowController.showAndRefresh()
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }

  @objc private func checkForUpdates() {
    let daemonSupervisor = self.daemonSupervisor
    Task.detached(priority: .userInitiated) { [daemonSupervisor] in
      let result = daemonSupervisor.runCLI(arguments: ["update", "check", "--force"])
      let updateStatus = result.flatMap { output in
        decodeCLIJSON(UpdateStatusResponse.self, status: output.status, stdout: output.stdout)
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
    if consumePermissionRelaunchSetupIntent() {
      onboardingWindowController.showAndRefresh(forceActivePermissionRefresh: true)
      return
    }

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
        statusItem.length = statusItemImage.size.width + Self.statusItemHorizontalPadding
      } else {
        button.image = nil
        button.title = snapshot.daemonRunning || daemonStarting ? "Cued" : "Cued!"
        button.imagePosition = .noImage
        statusItem.length = NSStatusItem.variableLength
      }
      button.toolTip = snapshot.daemonRunning
        ? "Cued"
        : daemonStarting
          ? "Cued (daemon starting)"
          : "Cued (daemon stopped)"
      button.appearsDisabled = !(snapshot.daemonRunning || daemonStarting)
    }

    let menu = NSMenu()
    let visibleIntegrations = snapshot.integrations.filter { $0.enabled }
    let connectedIntegrations = visibleIntegrations.filter { isConnectedIntegrationState($0.authState) }
    let needsAttentionIntegrations = visibleIntegrations.filter { !isConnectedIntegrationState($0.authState) }

    menu.addItem(
      withTitle: snapshot.daemonRunning
        ? "Cued is running"
        : daemonStarting
          ? "Cued is starting"
          : "Cued is stopped",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    menu.addItem(
      withTitle: sourceSummaryTitle(
        connected: connectedIntegrations.count,
        needsAttention: needsAttentionIntegrations.count
      ),
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    menu.addItem(
      withTitle: snapshot.pendingProjectionEvents > 0
        ? "\(snapshot.contacts) contacts • \(snapshot.projectedMessages) messages projected • \(snapshot.capturedRawEvents) events captured"
        : snapshot.pendingSearchIndexMessages > 0
          ? "\(snapshot.contacts) contacts • \(snapshot.projectedMessages) messages • indexing search"
        : "\(snapshot.contacts) contacts • \(snapshot.projectedMessages) messages",
      action: nil,
      keyEquivalent: ""
    ).isEnabled = false

    menu.addItem(.separator())
    menu.addItem(withTitle: "Open Cued", action: #selector(openSetup), keyEquivalent: "").target = self

    let debugItem = NSMenuItem(title: "Debug", action: nil, keyEquivalent: "")
    debugItem.submenu = buildDebugMenu(snapshot: snapshot, daemonStarting: daemonStarting)
    menu.addItem(debugItem)

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
      let installResponse = result.flatMap { output in
        decodeCLIJSON(UpdateInstallResponse.self, status: output.status, stdout: output.stdout)
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

    let visibleIntegrations = snapshot.integrations.filter { $0.enabled }
    let connectedIntegrations = visibleIntegrations.filter { isConnectedIntegrationState($0.authState) }
    let needsAttentionIntegrations = visibleIntegrations.filter { !isConnectedIntegrationState($0.authState) }

    if visibleIntegrations.isEmpty {
      let item = NSMenuItem(title: "No integrations configured", action: nil, keyEquivalent: "")
      item.isEnabled = false
      debugMenu.addItem(item)
    } else {
      if connectedIntegrations.isEmpty {
        let item = NSMenuItem(title: "No connected integrations", action: nil, keyEquivalent: "")
        item.isEnabled = false
        debugMenu.addItem(item)
      } else {
        let sectionHeader = NSMenuItem(title: "Connected", action: nil, keyEquivalent: "")
        sectionHeader.isEnabled = false
        debugMenu.addItem(sectionHeader)
        for integration in connectedIntegrations {
          let item = NSMenuItem(title: integrationMenuTitle(integration), action: nil, keyEquivalent: "")
          item.isEnabled = false
          debugMenu.addItem(item)
        }
      }

      if !needsAttentionIntegrations.isEmpty {
        debugMenu.addItem(.separator())
        let sectionHeader = NSMenuItem(title: "Needs Attention", action: nil, keyEquivalent: "")
        sectionHeader.isEnabled = false
        debugMenu.addItem(sectionHeader)
        for integration in needsAttentionIntegrations {
          let item = NSMenuItem(title: integrationMenuTitle(integration), action: nil, keyEquivalent: "")
          item.isEnabled = false
          debugMenu.addItem(item)
        }
      }
    }

    debugMenu.addItem(.separator())

    if snapshot.messageBreakdown.isEmpty {
      let item = NSMenuItem(title: "No message sync data yet", action: nil, keyEquivalent: "")
      item.isEnabled = false
      debugMenu.addItem(item)
    } else {
      for item in snapshot.messageBreakdown {
        let menuItem = NSMenuItem(title: platformMessageDebugTitle(item), action: nil, keyEquivalent: "")
        menuItem.isEnabled = false
        debugMenu.addItem(menuItem)
      }
    }

    debugMenu.addItem(.separator())

    let daemonToggleItem = debugMenu.addItem(
      withTitle: snapshot.daemonRunning || daemonStarting ? "Stop Daemon" : "Start Daemon",
      action: #selector(toggleDaemon),
      keyEquivalent: ""
    )
    daemonToggleItem.target = self

    debugMenu.addItem(
      withTitle: snapshot.updateSummary?.availableVersion.map { "Update Available: v\($0)" } ?? "Check for Updates",
      action: #selector(checkForUpdates),
      keyEquivalent: ""
    ).target = self

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
      image.size = statusItemImageSize(for: image)
      return image
    }

    return nil
  }

  private static func statusItemImageSize(for image: NSImage) -> NSSize {
    let imageSize = image.size
    guard imageSize.width > 0, imageSize.height > 0 else {
      return NSSize(width: statusItemImageHeight, height: statusItemImageHeight)
    }

    let aspectRatio = imageSize.width / imageSize.height
    return NSSize(width: statusItemImageHeight * aspectRatio, height: statusItemImageHeight)
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
func runMenuBarApp() throws {
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
  let dbPath = environmentPath("CUED_DB_PATH")
    ?? (Bundle.main.object(forInfoDictionaryKey: "CuedDBPath") as? String)
    ?? configuredCuedDBPath()
  let bundlePath = Bundle.main.bundlePath.trimmingCharacters(in: .whitespacesAndNewlines)
  if !bundlePath.isEmpty {
    terminateCompetingDaemonProcesses(currentAppPath: bundlePath)
  }
  let menuBarLease: SingletonLockLease
  do {
    menuBarLease = try SingletonLockLease.acquire(
      path: configuredMenuBarLockPath(),
      kind: "menu-bar",
      version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      probe: { _ in
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
          return false
        }
        let currentPID = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication
          .runningApplications(withBundleIdentifier: bundleIdentifier)
          .contains { $0.processIdentifier != currentPID }
      }
    )
  } catch SingletonLockError.held {
    signalExistingMenuBarInstance()
    Darwin.exit(0)
  }

  let app = NSApplication.shared
  let delegate = MenuBarAppController(
    dbPath: dbPath,
    daemonLaunchPath: daemonLaunchPath,
    daemonCommand: daemonCommand,
    setupCommand: setupCommand,
    permissionsCommand: permissionsCommand,
    menuBarLease: menuBarLease
  )
  app.delegate = delegate
  app.run()
}
