import Foundation
import IOKit.ps

@MainActor
final class PowerStatePublisher {
  private let path: String
  private var source: CFRunLoopSource?
  private var observer: NSObjectProtocol?

  init(path: String) { self.path = path }

  func start() {
    let context = Unmanaged.passUnretained(self).toOpaque()
    source = IOPSNotificationCreateRunLoopSource({ context in
      guard let context else { return }
      // The source is installed on the main run loop.
      MainActor.assumeIsolated {
        Unmanaged<PowerStatePublisher>.fromOpaque(context).takeUnretainedValue().publish()
      }
    }, context)?.takeRetainedValue()
    if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
    observer = NotificationCenter.default.addObserver(
      forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.publish() }
    }
    publish()
  }

  func stop() {
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    source = nil
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    try? FileManager.default.removeItem(atPath: path)
  }

  func publish() {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let supply = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return }
    let payload: [String: Any] = [
      "onBattery": (supply as String) == kIOPSBatteryPowerValue,
      "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
      "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
      "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }
}
