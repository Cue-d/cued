import AppKit
import Foundation
import IOKit.ps

/// Publishes sleep, wake and power source to `power-state.json` for the daemon. The daemon
/// reads it to defer sync around sleep and to poll less on battery or in Low Power Mode.
/// Everything here is event-driven: nothing polls.
@MainActor
final class PowerStatePublisher {
  private let path: String
  private var workspaceObservers: [NSObjectProtocol] = []
  private var lowPowerObserver: NSObjectProtocol?
  private var powerSourceRunLoopSource: CFRunLoopSource?
  private var sleeping = false
  private var lastWakeAt = 0
  private var lastPublished: [String: AnyHashable]?

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
    lowPowerObserver = NotificationCenter.default.addObserver(
      forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.publishIfChanged() }
    }
    // Called on the main run loop whenever the power source or battery level changes.
    let context = Unmanaged.passUnretained(self).toOpaque()
    powerSourceRunLoopSource = IOPSNotificationCreateRunLoopSource({ context in
      guard let context else { return }
      MainActor.assumeIsolated {
        Unmanaged<PowerStatePublisher>.fromOpaque(context).takeUnretainedValue().publishIfChanged()
      }
    }, context)?.takeRetainedValue()
    if let powerSourceRunLoopSource {
      CFRunLoopAddSource(CFRunLoopGetMain(), powerSourceRunLoopSource, .commonModes)
    }
    publish()
  }

  func stop() {
    for token in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    workspaceObservers.removeAll()
    if let lowPowerObserver { NotificationCenter.default.removeObserver(lowPowerObserver) }
    lowPowerObserver = nil
    if let powerSourceRunLoopSource {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), powerSourceRunLoopSource, .commonModes)
    }
    powerSourceRunLoopSource = nil
    try? FileManager.default.removeItem(atPath: path)
  }

  /// Battery level changes arrive often while unplugged; only a change in what we publish
  /// is written.
  private func publishIfChanged() {
    if currentState() != lastPublished { publish() }
  }

  private func currentState() -> [String: AnyHashable] {
    [
      "sleeping": sleeping,
      "lastWakeAt": lastWakeAt,
      "onBattery": Self.isOnBattery(),
      "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
    ]
  }

  static func isOnBattery() -> Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue()
    else { return false }
    return (source as String) == kIOPSBatteryPowerValue
  }

  private func publish() {
    let state = currentState()
    lastPublished = state
    var payload: [String: Any] = state
    payload["updatedAt"] = Int(Date().timeIntervalSince1970 * 1000)
    payload["pid"] = ProcessInfo.processInfo.processIdentifier
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }
}
