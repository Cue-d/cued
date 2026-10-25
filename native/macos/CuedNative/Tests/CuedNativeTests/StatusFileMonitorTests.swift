import Foundation
import XCTest
@testable import CuedNative

@MainActor
final class StatusFileMonitorTests: XCTestCase {
  func testCachedRunningFlagDoesNotHideDeadDaemon() {
    let store = AppStatusStore(dbPath: "/nonexistent/cued-test.db")
    let dead = store.parseStatusPayload(
      ["socketRunning": true, "daemonRunning": true, "daemon": ["pid": Int(Int32.max)]],
      daemonLockState: (running: false, pid: nil, updatedAt: nil)
    )
    XCTAssertFalse(dead.daemonRunning)
    let live = store.parseStatusPayload(
      ["socketRunning": true, "daemon": ["pid": Int(ProcessInfo.processInfo.processIdentifier)]],
      daemonLockState: (running: false, pid: nil, updatedAt: nil)
    )
    XCTAssertTrue(live.daemonRunning)
  }

  func testCreationReplacementAndUnrelatedWrites() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("status.json")
    var notifications = 0
    let monitor = StatusFileMonitor(path: path.path) { notifications += 1 }
    monitor.start()
    defer { monitor.stop() }
    try await Task.sleep(for: .milliseconds(100))
    try Data("one".utf8).write(to: path, options: .atomic)
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertEqual(notifications, 1, "First publication must update the menu")
    try Data("two".utf8).write(to: path, options: .atomic)
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertEqual(notifications, 2, "Atomic replacement must retain observation")
    try Data("noise".utf8).write(to: directory.appendingPathComponent("daemon.lock"))
    try Data("two".utf8).write(to: path, options: .atomic)
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertEqual(notifications, 2, "Unrelated and identical writes must not rebuild the menu")
    monitor.stop()
    try await Task.sleep(for: .milliseconds(100))
    try Data("three".utf8).write(to: path, options: .atomic)
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertEqual(notifications, 2, "Stopping must cancel observation")
  }
}
