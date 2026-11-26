import Foundation
import Network

enum DaemonClientError: Error, Equatable {
  /// The request never reached the daemon: nothing is listening, or the connection failed
  /// before the request was written. Safe to retry or send another way.
  case unavailable(String)
  /// The request was written and the connection dropped before the reply. The daemon may be
  /// carrying it out; sending it again could do the work twice.
  case connectionLost(String)
  /// No reply in time. The daemon may still be carrying the request out.
  case timedOut(command: String)
  /// The daemon answered and said no.
  case rejected(String)
  case malformedResponse
}

/// A persistent connection to the daemon's unix socket.
///
/// The app used to reach the daemon by launching the `cued` CLI for every request: a shell, then
/// a Node process that loads the whole CLI, about 280 ms before the daemon saw anything. This
/// speaks the daemon's own protocol (one JSON object per line) over one long-lived connection,
/// so a request costs a socket write and a read.
///
/// After `subscribe()` the daemon also pushes a line whenever state the UI shows has changed,
/// which is what lets the window re-read on change instead of polling. The connection is
/// re-established on demand, and a subscription re-arms itself when the daemon comes back.
final class DaemonClient: @unchecked Sendable {
  private struct Pending {
    let command: String
    let continuation: CheckedContinuation<Data, Error>
    /// Whether the request has been handed to the socket.
    var written = false
  }

  private let socketPath: String
  private let queue = DispatchQueue(label: "so.cued.desktop.daemon-client")
  private let onEvent: @Sendable ([String]) -> Void
  private let reconnectDelay: TimeInterval
  private let subscribeTimeout: TimeInterval

  // Everything below is confined to `queue`.
  private var connection: NWConnection?
  private var isReady = false
  private var buffer = Data()
  private var pending: [String: Pending] = [:]
  private var queuedLines: [(id: String, line: Data)] = []
  private var wantsSubscription = false
  private var subscribed = false
  private var reconnectScheduled = false
  private var closed = false

  /// - Parameter onEvent: called off the main thread with the topics of each pushed change. Also
  ///   called (with `["reconnected"]`) when a subscription is re-established, because anything
  ///   may have changed while the connection was down.
  init(
    socketPath: String,
    reconnectDelay: TimeInterval = 1,
    subscribeTimeout: TimeInterval = 5,
    onEvent: @escaping @Sendable ([String]) -> Void = { _ in }
  ) {
    self.socketPath = socketPath
    self.reconnectDelay = reconnectDelay
    self.subscribeTimeout = subscribeTimeout
    self.onEvent = onEvent
  }

  /// Sends one request and returns the JSON of its `result`.
  func request(
    _ command: String,
    fields: [String: any Sendable] = [:],
    timeout: TimeInterval = 10
  ) async throws -> Data {
    let id = UUID().uuidString
    var payload: [String: Any] = fields
    payload["id"] = id
    payload["command"] = command
    guard var line = try? JSONSerialization.data(withJSONObject: payload) else {
      throw DaemonClientError.malformedResponse
    }
    line.append(0x0A)
    let requestLine = line

    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard !self.closed else {
          continuation.resume(throwing: DaemonClientError.unavailable("client closed"))
          return
        }
        self.enqueue(id: id, command: command, line: requestLine, timeout: timeout, continuation)
      }
    }
  }

  /// Asks the daemon to push change events on this connection, now and after every reconnect.
  func subscribe() {
    queue.async {
      guard !self.closed, !self.wantsSubscription else { return }
      self.wantsSubscription = true
      self.sendSubscription(announceReconnect: false)
    }
  }

  func unsubscribe() {
    queue.async {
      self.wantsSubscription = false
      self.subscribed = false
      // The daemon has no unsubscribe: dropping the connection is how a subscription ends.
      self.dropConnection(reason: "unsubscribed")
    }
  }

  /// Whether the daemon accepted the subscription. False against a daemon too old to push
  /// events, in which case the caller has to poll.
  var isSubscribed: Bool {
    queue.sync { subscribed }
  }

  func close() {
    queue.async {
      self.closed = true
      self.wantsSubscription = false
      self.dropConnection(reason: "client closed")
    }
  }

  // MARK: - Connection (queue-confined)

  private func enqueue(
    id: String,
    command: String,
    line: Data,
    timeout: TimeInterval,
    _ continuation: CheckedContinuation<Data, Error>
  ) {
    pending[id] = Pending(command: command, continuation: continuation)
    send(line, id: id)
    queue.asyncAfter(deadline: .now() + timeout) {
      guard let waiter = self.pending.removeValue(forKey: id) else { return }
      waiter.continuation.resume(throwing: DaemonClientError.timedOut(command: command))
    }
  }

  private func send(_ line: Data, id: String) {
    guard let connection = ensureConnection() else { return }
    if isReady {
      pending[id]?.written = true
      connection.send(content: line, completion: .contentProcessed { _ in })
    } else {
      queuedLines.append((id: id, line: line))
    }
  }

  private func ensureConnection() -> NWConnection? {
    if let connection {
      return connection
    }
    let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
    self.connection = connection
    isReady = false
    buffer.removeAll(keepingCapacity: true)
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection, self.connection === connection else { return }
      switch state {
      case .ready:
        self.isReady = true
        let lines = self.queuedLines
        self.queuedLines.removeAll()
        for (id, line) in lines {
          self.pending[id]?.written = true
          connection.send(content: line, completion: .contentProcessed { _ in })
        }
        self.receive(on: connection)
      case .failed(let error):
        self.dropConnection(reason: error.localizedDescription)
      case .waiting(let error):
        // A unix socket with nothing listening never becomes ready by waiting.
        self.dropConnection(reason: error.localizedDescription)
      case .cancelled:
        self.dropConnection(reason: "connection cancelled")
      default:
        break
      }
    }
    connection.start(queue: queue)
    return connection
  }

  private func receive(on connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
      [weak self, weak connection] data, _, isComplete, error in
      guard let self, let connection, self.connection === connection else { return }
      if let data, !data.isEmpty {
        self.buffer.append(data)
        self.drainLines()
      }
      if isComplete || error != nil {
        self.dropConnection(reason: error?.localizedDescription ?? "daemon closed the connection")
        return
      }
      self.receive(on: connection)
    }
  }

  private func drainLines() {
    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<newline)
      buffer.removeSubrange(buffer.startIndex...newline)
      guard !line.isEmpty,
            let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
      else {
        continue
      }
      if message["event"] is String {
        onEvent(message["topics"] as? [String] ?? [])
        continue
      }
      // A daemon that does not know a command used to echo the whole request back as the id.
      let id = message["id"] as? String ?? (message["id"] as? [String: Any])?["id"] as? String
      guard let id, let waiter = pending.removeValue(forKey: id) else {
        continue
      }
      if message["ok"] as? Bool == true {
        let result = message["result"] ?? NSNull()
        if let data = try? JSONSerialization.data(
          withJSONObject: result,
          options: [.fragmentsAllowed]
        ) {
          waiter.continuation.resume(returning: data)
        } else {
          waiter.continuation.resume(throwing: DaemonClientError.malformedResponse)
        }
      } else {
        waiter.continuation.resume(
          throwing: DaemonClientError.rejected(message["error"] as? String ?? "request failed")
        )
      }
    }
  }

  private func dropConnection(reason: String) {
    let dropped = connection
    connection = nil
    isReady = false
    subscribed = false
    queuedLines.removeAll()
    buffer.removeAll(keepingCapacity: true)
    dropped?.stateUpdateHandler = nil
    dropped?.cancel()
    let waiters = Array(pending.values)
    pending.removeAll()
    for waiter in waiters {
      waiter.continuation.resume(
        throwing: waiter.written
          ? DaemonClientError.connectionLost(reason)
          : DaemonClientError.unavailable(reason)
      )
    }
    scheduleResubscribe()
  }

  // MARK: - Subscription (queue-confined)

  private func sendSubscription(announceReconnect: Bool) {
    let id = UUID().uuidString
    guard let body = try? JSONSerialization.data(
      withJSONObject: ["id": id, "command": "subscribe"]
    ) else {
      return
    }
    let line = body + Data([0x0A])
    Task { [weak self] in
      guard let self else { return }
      let accepted: Bool
      do {
        _ = try await self.sendRaw(id: id, command: "subscribe", line: line)
        accepted = true
      } catch DaemonClientError.rejected {
        // A daemon that predates subscriptions. Retrying will not change its answer.
        self.queue.async { self.wantsSubscription = false }
        return
      } catch {
        accepted = false
      }
      self.queue.async {
        guard self.wantsSubscription else { return }
        if accepted {
          self.subscribed = true
          if announceReconnect {
            self.onEvent(["reconnected"])
          }
        } else {
          self.scheduleResubscribe()
        }
      }
    }
  }

  private func sendRaw(id: String, command: String, line: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard !self.closed else {
          continuation.resume(throwing: DaemonClientError.unavailable("client closed"))
          return
        }
        // Bounded: a daemon that never answers must not leave the subscription in limbo.
        self.enqueue(
          id: id,
          command: command,
          line: line,
          timeout: self.subscribeTimeout,
          continuation
        )
      }
    }
  }

  private func scheduleResubscribe() {
    guard wantsSubscription, !closed, !reconnectScheduled else { return }
    reconnectScheduled = true
    queue.asyncAfter(deadline: .now() + reconnectDelay) {
      self.reconnectScheduled = false
      guard self.wantsSubscription, !self.closed, !self.subscribed else { return }
      self.sendSubscription(announceReconnect: true)
    }
  }
}
