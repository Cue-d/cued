import Foundation
import XCTest
@testable import CuedNative

final class SQLiteChangeWatcherTests: XCTestCase {
  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var changes = 0
    private var lost = 0

    func noteChange() { lock.withLock { changes += 1 } }
    func noteLost() { lock.withLock { lost += 1 } }
    var changeCount: Int { lock.withLock { changes } }
    var lostCount: Int { lock.withLock { lost } }
  }

  private var directory: URL!
  private var databasePath: String!
  private let queue = DispatchQueue(label: "so.cued.tests.sqlite-change-watcher")

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    databasePath = directory.appendingPathComponent("test.db").path
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func append(_ suffix: String) throws {
    let path = databasePath + suffix
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(atPath: path, contents: nil)
    }
    let handle = try XCTUnwrap(FileHandle(forWritingAtPath: path))
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data("page".utf8))
  }

  /// Waits until `counter` has seen more changes than `count`, then lets coalescing settle.
  private func expectChange(after count: Int, _ counter: Counter, _ message: String) {
    let deadline = Date().addingTimeInterval(3)
    while counter.changeCount <= count && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.01)
    }
    XCTAssertGreaterThan(counter.changeCount, count, message)
    Thread.sleep(forTimeInterval: 0.05)
  }

  private func makeWatcher(_ counter: Counter) -> SQLiteChangeWatcher {
    SQLiteChangeWatcher(
      databasePath: databasePath,
      queue: queue,
      coalesceInterval: .milliseconds(10),
      onChange: { counter.noteChange() },
      onDirectoryLost: { counter.noteLost() }
    )
  }

  private func watchedFileNames(_ watcher: SQLiteChangeWatcher) -> Set<String> {
    Set(queue.sync { watcher.watchedFilePaths }.map { URL(fileURLWithPath: $0).lastPathComponent })
  }

  func testAppendsReachWatcherAcrossDeletionAndReplacement() throws {
    try append("")
    try append("-wal")
    let counter = Counter()
    let watcher = makeWatcher(counter)
    XCTAssertTrue(queue.sync { watcher.start() })
    defer { queue.sync { watcher.stop() } }
    XCTAssertEqual(watchedFileNames(watcher), ["test.db", "test.db-wal"])

    var count = counter.changeCount
    try append("-wal")
    expectChange(after: count, counter, "An append to the existing WAL must be reported")

    count = counter.changeCount
    try FileManager.default.removeItem(atPath: databasePath + "-wal")
    expectChange(after: count, counter, "Deleting the WAL must be reported")
    XCTAssertEqual(watchedFileNames(watcher), ["test.db"])

    count = counter.changeCount
    try append("-wal")
    expectChange(after: count, counter, "Recreating the WAL must be reported")
    XCTAssertEqual(watchedFileNames(watcher), ["test.db", "test.db-wal"])
    count = counter.changeCount
    try append("-wal")
    expectChange(after: count, counter, "An append to the recreated WAL must be reported")

    count = counter.changeCount
    let replacement = directory.appendingPathComponent("replacement.db").path
    FileManager.default.createFile(atPath: replacement, contents: Data("new".utf8))
    XCTAssertEqual(rename(replacement, databasePath), 0)
    expectChange(after: count, counter, "Replacing the database file must be reported")
    count = counter.changeCount
    try append("")
    expectChange(after: count, counter, "An append to the replacement database must be reported")

    count = counter.changeCount
    try append("-shm")
    expectChange(after: count, counter, "Creating the shared-memory file must be reported")
    XCTAssertEqual(watchedFileNames(watcher), ["test.db", "test.db-wal", "test.db-shm"])
  }

  func testUnrelatedFilesAndSilenceRaiseNothing() throws {
    try append("-wal")
    let counter = Counter()
    let watcher = makeWatcher(counter)
    XCTAssertTrue(queue.sync { watcher.start() })
    defer { queue.sync { watcher.stop() } }
    try Data("noise".utf8).write(to: directory.appendingPathComponent("other.db"))
    try Data("noise".utf8).write(to: directory.appendingPathComponent("other.db"), options: .atomic)
    Thread.sleep(forTimeInterval: 0.3)
    XCTAssertEqual(counter.changeCount, 0)
  }

  func testBurstIsCoalesced() throws {
    try append("-wal")
    let counter = Counter()
    let watcher = SQLiteChangeWatcher(
      databasePath: databasePath,
      queue: queue,
      coalesceInterval: .milliseconds(200),
      onChange: { counter.noteChange() },
      onDirectoryLost: { counter.noteLost() }
    )
    XCTAssertTrue(queue.sync { watcher.start() })
    defer { queue.sync { watcher.stop() } }
    for _ in 0..<500 {
      try append("-wal")
    }
    Thread.sleep(forTimeInterval: 0.6)
    // One report at once and one when the coalescing window ends.
    XCTAssertGreaterThanOrEqual(counter.changeCount, 1)
    XCTAssertLessThanOrEqual(counter.changeCount, 3)
  }

  func testRemovedDirectoryIsReported() throws {
    let counter = Counter()
    let watcher = makeWatcher(counter)
    XCTAssertTrue(queue.sync { watcher.start() })
    try FileManager.default.removeItem(at: directory)
    let deadline = Date().addingTimeInterval(3)
    while counter.lostCount == 0 && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.01)
    }
    XCTAssertEqual(counter.lostCount, 1)
  }

  func testMissingDirectoryCannotStart() {
    let watcher = SQLiteChangeWatcher(
      databasePath: directory.appendingPathComponent("missing/test.db").path,
      queue: queue,
      onChange: {},
      onDirectoryLost: {}
    )
    XCTAssertFalse(queue.sync { watcher.start() })
  }
}
