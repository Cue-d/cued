import Darwin
import Foundation
import XCTest
@testable import CuedNative

/// A unix-socket server that speaks the daemon's line protocol, for exercising `DaemonClient`.
private final class FakeDaemon: @unchecked Sendable {
  let path: String
  private let lock = NSLock()
  private var listenFD: Int32 = -1
  private var clientFDs: [Int32] = []
  private var subscriberFDs: [Int32] = []
  private var respond: @Sendable (String, [String: Any]) -> [String: Any]

  init(respond: @escaping @Sendable (String, [String: Any]) -> [String: Any]) throws {
    path = NSTemporaryDirectory() + "cued-\(UUID().uuidString.prefix(8)).sock"
    self.respond = respond
    try start()
  }

  func start() throws {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { buffer in
        _ = strlcpy(buffer, path, capacity)
      }
    }
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, listen(fd, 8) == 0 else {
      close(fd)
      throw POSIXError(.EADDRINUSE)
    }
    lock.withLock { listenFD = fd }
    Thread.detachNewThread { [weak self] in
      while true {
        let client = accept(fd, nil, nil)
        guard client >= 0, let self else { return }
        self.lock.withLock { self.clientFDs.append(client) }
        Thread.detachNewThread { [weak self] in self?.serve(client) }
      }
    }
  }

  private func serve(_ client: Int32) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while true {
      let count = read(client, &chunk, chunk.count)
      guard count > 0 else { return }
      buffer.append(chunk, count: count)
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<newline)
        buffer.removeSubrange(buffer.startIndex...newline)
        guard
          let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let id = request["id"] as? String,
          let command = request["command"] as? String
        else { continue }
        if command == "subscribe" {
          lock.withLock { subscriberFDs.append(client) }
        }
        var response = lock.withLock { respond }(command, request)
        if response["__silent"] != nil {
          // Take the request and never answer it.
          continue
        }
        if response.removeValue(forKey: "__hangUp") != nil {
          // Take the request, then drop the connection without answering.
          shutdown(client, SHUT_RDWR)
          close(client)
          return
        }
        if response.removeValue(forKey: "__requestAsId") != nil {
          // What daemons before 0.1.47 sent for a command they did not know.
          response["id"] = request
        } else {
          response["id"] = id
        }
        write(client, object: response)
      }
    }
  }

  private func write(_ fd: Int32, object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { _ = Darwin.write(fd, $0.baseAddress, $0.count) }
  }

  func push(topics: [String]) {
    for fd in lock.withLock({ subscriberFDs }) {
      write(fd, object: ["event": "changed", "topics": topics])
    }
  }

  var subscriberCount: Int {
    lock.withLock { subscriberFDs.count }
  }

  /// Simulates the daemon going away: every connection closes and nothing is listening.
  func stop() {
    let (listener, clients) = lock.withLock {
      let snapshot = (listenFD, clientFDs)
      listenFD = -1
      clientFDs = []
      subscriberFDs = []
      return snapshot
    }
    for fd in clients {
      shutdown(fd, SHUT_RDWR)
      close(fd)
    }
    if listener >= 0 {
      shutdown(listener, SHUT_RDWR)
      close(listener)
    }
    unlink(path)
  }
}

private final class EventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [[String]] = []

  func record(_ topics: [String]) {
    lock.withLock { events.append(topics) }
  }

  var all: [[String]] {
    lock.withLock { events }
  }
}

final class DaemonClientTests: XCTestCase {
  private func waitUntil(
    timeout: TimeInterval = 5,
    _ condition: @escaping () -> Bool
  ) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  func testRequestReturnsTheResultPayload() async throws {
    let daemon = try FakeDaemon { command, request in
      ["ok": true, "result": ["command": command, "platform": request["platform"] ?? NSNull()]]
    }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path)
    defer { client.close() }

    let data = try await client.request("integrations-enable", fields: ["platform": "slack"])
    let result = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(result, ["command": "integrations-enable", "platform": "slack"])
  }

  func testRejectedRequestSurfacesTheDaemonsError() async throws {
    let daemon = try FakeDaemon { _, _ in ["ok": false, "error": "Unsupported command"] }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path)
    defer { client.close() }

    do {
      _ = try await client.request("nope")
      XCTFail("expected the request to be rejected")
    } catch {
      XCTAssertEqual(error as? DaemonClientError, .rejected("Unsupported command"))
    }
  }

  func testRequestFailsFastWhenNothingIsListening() async {
    let client = DaemonClient(socketPath: NSTemporaryDirectory() + "cued-missing.sock")
    defer { client.close() }
    let startedAt = Date()
    do {
      _ = try await client.request("ping", timeout: 5)
      XCTFail("expected the request to fail")
    } catch {
      guard case .unavailable = error as? DaemonClientError else {
        return XCTFail("expected .unavailable, got \(error)")
      }
    }
    // A daemon that is down must not cost the UI its full request timeout.
    XCTAssertLessThan(Date().timeIntervalSince(startedAt), 2)
  }

  func testSubscriptionDeliversPushedChanges() async throws {
    let daemon = try FakeDaemon { _, _ in ["ok": true, "result": ["subscribed": true]] }
    defer { daemon.stop() }
    let log = EventLog()
    let client = DaemonClient(socketPath: daemon.path) { log.record($0) }
    defer { client.close() }

    client.subscribe()
    let subscribed = await waitUntil { client.isSubscribed && daemon.subscriberCount == 1 }
    XCTAssertTrue(subscribed)
    daemon.push(topics: ["status", "skill"])
    let delivered = await waitUntil { !log.all.isEmpty }
    XCTAssertTrue(delivered)
    XCTAssertEqual(log.all, [["status", "skill"]])
  }

  func testSubscriptionSurvivesADaemonRestart() async throws {
    let daemon = try FakeDaemon { _, _ in ["ok": true, "result": ["subscribed": true]] }
    defer { daemon.stop() }
    let log = EventLog()
    let client = DaemonClient(socketPath: daemon.path, reconnectDelay: 0.05) { log.record($0) }
    defer { client.close() }

    client.subscribe()
    let subscribed = await waitUntil { client.isSubscribed }
    XCTAssertTrue(subscribed)

    daemon.stop()
    let noticed = await waitUntil { !client.isSubscribed }
    XCTAssertTrue(noticed)
    try daemon.start()

    // State may have changed while the daemon was away, so coming back counts as a change.
    let resubscribed = await waitUntil { log.all.contains(["reconnected"]) }
    XCTAssertTrue(resubscribed)
    XCTAssertTrue(client.isSubscribed)
  }

  func testARequestTheDaemonReceivedIsNotReportedAsUndelivered() async throws {
    let daemon = try FakeDaemon { _, _ in ["__hangUp": true] }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path)
    defer { client.close() }

    do {
      _ = try await client.request("integrations-connect", fields: ["platform": "slack"])
      XCTFail("expected the request to fail")
    } catch {
      // The daemon may be acting on it, so the caller must not send it again.
      guard case .connectionLost = error as? DaemonClientError else {
        return XCTFail("expected .connectionLost, got \(error)")
      }
    }
  }

  func testUnsupportedReplyFromAnOlderDaemonIsMatchedToItsRequest() async throws {
    let daemon = try FakeDaemon { _, _ in
      ["ok": false, "error": "Unsupported command", "__requestAsId": true]
    }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path)
    defer { client.close() }

    do {
      _ = try await client.request("subscribe", timeout: 2)
      XCTFail("expected the request to be rejected")
    } catch {
      XCTAssertEqual(error as? DaemonClientError, .rejected("Unsupported command"))
    }
  }

  func testASubscriptionTheDaemonNeverAnswersDoesNotHang() async throws {
    let daemon = try FakeDaemon { command, _ in
      command == "subscribe" ? ["__silent": true] : ["ok": true, "result": ["pong": true]]
    }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path, reconnectDelay: 0.05, subscribeTimeout: 0.1)
    defer { client.close() }

    client.subscribe()
    try await Task.sleep(for: .milliseconds(400))
    XCTAssertFalse(client.isSubscribed)
    // The handshake timed out and was retried rather than left pending forever.
    XCTAssertGreaterThan(daemon.subscriberCount, 1)
    _ = try await client.request("ping")
  }

  func testAnOlderDaemonThatRejectsSubscribeIsNotRetried() async throws {
    let daemon = try FakeDaemon { command, _ in
      command == "subscribe"
        ? ["ok": false, "error": "Unsupported command"]
        : ["ok": true, "result": ["pong": true]]
    }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path, reconnectDelay: 0.05)
    defer { client.close() }

    client.subscribe()
    _ = try await client.request("ping")
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertFalse(client.isSubscribed)
    // Requests still work on the same connection; only pushing is unavailable.
    _ = try await client.request("ping")
  }

  func testRoundTripStaysWithinTheResponsivenessTarget() async throws {
    let daemon = try FakeDaemon { _, _ in ["ok": true, "result": ["pong": true]] }
    defer { daemon.stop() }
    let client = DaemonClient(socketPath: daemon.path)
    defer { client.close() }
    _ = try await client.request("ping")

    var samples: [Double] = []
    for _ in 0..<200 {
      let startedAt = DispatchTime.now().uptimeNanoseconds
      _ = try await client.request("ping")
      samples.append(Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
    }
    samples.sort()
    let p95 = samples[Int(Double(samples.count) * 0.95)]
    // The transport's share of the 20 ms round-trip budget. Launching the CLI cost ~280 ms.
    XCTAssertLessThan(p95, 5, "p95 round trip was \(p95) ms")
  }
}

/// Drives the real client against a real daemon. Skipped unless a daemon socket is supplied,
/// which the responsiveness benchmark does: `pnpm test:perf:responsiveness --exec "swift test
/// --package-path native/macos/CuedNative --filter DaemonClientLiveTests"`.
final class DaemonClientLiveTests: XCTestCase {
  func testSnapshotRoundTripAndChangeNotificationAgainstARealDaemon() async throws {
    guard let socketPath = ProcessInfo.processInfo.environment["CUED_PERF_DAEMON_SOCKET"] else {
      throw XCTSkip("CUED_PERF_DAEMON_SOCKET is not set")
    }
    let log = EventLog()
    let client = DaemonClient(socketPath: socketPath) { log.record($0) }
    defer { client.close() }

    // Exactly what the settings window does on every refresh: request, then decode.
    var samples: [Double] = []
    var integrationCount = 0
    for _ in 0..<100 {
      let startedAt = DispatchTime.now().uptimeNanoseconds
      let data = try await client.request("onboarding-snapshot")
      let snapshot = try JSONDecoder().decode(RootSnapshotResponse.self, from: data)
      samples.append(Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
      integrationCount = snapshot.setupIntegrations.count
    }
    samples.sort()
    let p50 = samples[samples.count / 2]
    let p95 = samples[Int(Double(samples.count) * 0.95)]
    print(
      "swift client snapshot round trip: p50 \(String(format: "%.2f", p50)) ms, "
        + "p95 \(String(format: "%.2f", p95)) ms (\(integrationCount) setup integrations)"
    )
    XCTAssertGreaterThan(integrationCount, 0)
    XCTAssertLessThan(p95, 20, "snapshot p95 round trip was \(p95) ms")

    // A change made over the socket is announced to a subscribed client without any polling.
    client.subscribe()
    var deadline = Date().addingTimeInterval(5)
    while !client.isSubscribed, Date() < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(client.isSubscribed)
    let before = log.all.count
    let changedAt = DispatchTime.now().uptimeNanoseconds
    _ = try await client.request(
      "integrations-disable",
      fields: ["platform": "gmail", "accountKey": "perf-b@example.com"]
    )
    deadline = Date().addingTimeInterval(5)
    while log.all.count == before, Date() < deadline {
      try await Task.sleep(for: .milliseconds(1))
    }
    let notifyMs = Double(DispatchTime.now().uptimeNanoseconds - changedAt) / 1_000_000
    print("swift client change notification: \(String(format: "%.2f", notifyMs)) ms")
    XCTAssertGreaterThan(log.all.count, before, "no change event arrived")
    _ = try await client.request(
      "integrations-enable",
      fields: ["platform": "gmail", "accountKey": "perf-b@example.com"]
    )
  }
}
