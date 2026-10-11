import Foundation
import XCTest
@testable import CuedNative

final class SingletonLeaseTests: XCTestCase {
  func testHeartbeatIsVisibleAndPreventsSecondOwner() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("menu-bar.lock").path
    let lease = try SingletonLockLease.acquire(path: path, kind: "test", version: nil, probe: { _ in false })
    defer { lease.release() }
    let before = try XCTUnwrap(SingletonLockLease.read(path: path))
    Thread.sleep(forTimeInterval: 0.01)
    lease.heartbeat()
    let after = try XCTUnwrap(SingletonLockLease.read(path: path))
    XCTAssertGreaterThan(after.updatedAt, before.updatedAt)
    XCTAssertEqual(after.pid, before.pid)
    XCTAssertThrowsError(try SingletonLockLease.acquire(path: path, kind: "test", version: nil, probe: { _ in false }))
  }

  func testOldOwnerCannotOverwriteOrRemoveReplacementLease() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("menu-bar.lock").path
    let oldLease = try SingletonLockLease.acquire(path: path, kind: "old", version: nil, probe: { _ in false })
    try FileManager.default.removeItem(atPath: path)
    let replacement = try SingletonLockLease.acquire(path: path, kind: "new", version: nil, probe: { _ in false })
    defer { replacement.release() }
    oldLease.heartbeat()
    oldLease.release()
    XCTAssertEqual(SingletonLockLease.read(path: path)?.kind, "new")
  }
}
