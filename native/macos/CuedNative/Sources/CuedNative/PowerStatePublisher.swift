import AppKit
import Foundation

@MainActor
final class PowerStatePublisher {
  private let path: String
  private var workspaceObservers: [NSObjectProtocol] = []
  private var sleeping = false
  private var lastWakeAt = 0

  init(path: String) { self.path = path }

  func start() {
    let center = NSWorkspace.shared.notificationCenter
    for (name, isSleeping) in [(NSWorkspace.willSleepNotification, true), (NSWorkspace.didWakeNotification, false)] {
      workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self else { return }
          self.sleeping = isSleeping
          if !isSleeping { self.lastWakeAt = Int(Date().timeIntervalSince1970 * 1000) }
          self.publish()
        }
      })
    }
    publish()
  }

  func stop() {
    for token in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    workspaceObservers.removeAll()
    try? FileManager.default.removeItem(atPath: path)
  }

  private func publish() {
    let payload: [String: Any] = [
      "sleeping": sleeping,
      "lastWakeAt": lastWakeAt,
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
      "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }
}
