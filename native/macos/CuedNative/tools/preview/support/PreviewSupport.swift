import AppKit
import Interface
import Foundation
import SwiftUI

public struct PreviewCase: Hashable, Sendable {
  public let name: String
  public let page: Int
  public let size: CGSize

  public init(name: String, page: Int, size: CGSize = Preview.defaultSize) {
    self.name = name
    self.page = page
    self.size = size
  }

  public var fileName: String {
    "\(name).png"
  }
}

public struct PreviewResult: Sendable {
  public let previewCase: PreviewCase
  public let url: URL
  public let metrics: PreviewMetrics
}

public struct PreviewMetrics: Sendable {
  public let width: Int
  public let height: Int
  public let byteCount: Int
  public let distinctSampledColors: Int
  public let nonBackgroundSampleCount: Int

  public var isVisuallyNonBlank: Bool {
    byteCount > 1_000 && distinctSampledColors >= 8 && nonBackgroundSampleCount >= 20
  }
}

public enum Preview {
  public static let defaultOutputDirectory = URL(fileURLWithPath: ".build/previews", isDirectory: true)
  public static let defaultSize = CGSize(
    width: RootViewModel.windowWidth,
    height: RootViewModel.windowHeight
  )

  public static let cases: [PreviewCase] = [
    PreviewCase(name: "welcome", page: 0),
    PreviewCase(name: "permissions-missing", page: 1),
    PreviewCase(name: "permissions-granted", page: 1),
    PreviewCase(name: "platforms-fresh", page: 2),
    PreviewCase(name: "platforms-mixed", page: 2),
    PreviewCase(name: "use-cases", page: 3),
    PreviewCase(name: "application-home", page: 4),
  ]

  @MainActor
  public static func render(
    _ previewCase: PreviewCase,
    outputDirectory: URL = defaultOutputDirectory
  ) throws -> PreviewResult {
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    let url = outputDirectory.appendingPathComponent(previewCase.fileName)
    let viewModel = makeViewModel(for: previewCase)
    viewModel.currentPage = previewCase.page

    let view = RootView(
      viewModel: viewModel,
      onRefresh: {},
      onGuidePermission: { _ in },
      onDismissPermissionGuide: {},
      onRequestPermission: { _ in },
      onInstallGlobalSkill: {},
      onEnableIntegration: { _, _ in },
      onRemoveIntegration: { _, _ in },
      onConnectIntegration: { _, _ in },
      onLaunchAgentExample: { _, _ in },
      onFinish: {}
    )
    .frame(width: previewCase.size.width, height: previewCase.size.height)

    let data = try ImageRenderer.pngData(for: AnyView(view), size: previewCase.size)
    try data.write(to: url, options: [.atomic])

    return PreviewResult(
      previewCase: previewCase,
      url: url,
      metrics: try PreviewMetricsReader.metrics(forPNG: url)
    )
  }

  @MainActor
  public static func renderAll(
    outputDirectory: URL = defaultOutputDirectory
  ) throws -> [PreviewResult] {
    try cases.map { try render($0, outputDirectory: outputDirectory) }
  }

  public static func previewCase(named name: String, size: CGSize? = nil) -> PreviewCase? {
    guard var previewCase = cases.first(where: { $0.name == name }) else {
      return nil
    }
    if let size {
      previewCase = PreviewCase(name: previewCase.name, page: previewCase.page, size: size)
    }
    return previewCase
  }

  @MainActor
  private static func makeViewModel(for previewCase: PreviewCase) -> RootViewModel {
    let viewModel = RootViewModel()
    let fixture = PreviewFixture(name: previewCase.name)
    viewModel.apply(
      permissions: fixture.permissions,
      globalSkill: fixture.globalSkill,
      allIntegrations: fixture.integrations,
      integrations: fixture.setupIntegrations
    )
    viewModel.applyAgentTargetStatuses(fixture.agentTargetStatuses)
    return viewModel
  }
}

private struct PreviewFixture {
  let name: String

  var permissions: [PermissionStatus] {
    switch name {
    case "permissions-granted", "platforms-mixed":
      return [
        permission("contacts", "granted", "Contacts access is granted", ["--contacts"]),
        permission("full_disk_access", "granted", "Full Disk Access is granted", ["--full-disk-access"]),
      ]
    default:
      return [
        permission("contacts", "needs_action", "Contacts permission is required", ["--contacts"]),
        permission("full_disk_access", "needs_action", "Full Disk Access is required", ["--full-disk-access"]),
      ]
    }
  }

  var globalSkill: SkillStatus {
    switch name {
    case "permissions-missing":
      defaultPreviewSkillStatus()
    default:
      SkillStatus(
        installed: true,
        status: "installed",
        summary: "The global Cued skill is installed."
      )
    }
  }

  var integrations: [IntegrationStatus] {
    switch name {
    case "platforms-mixed":
      return [
        integration("contacts", "local", "Contacts.app", "authorized", true, contactsStats),
        integration("imessage", "local", "Messages", "authorized", true, messagesStats),
        integration("gmail", "harvard", "Harvard Gmail", "authenticated", true, gmailStats),
        integration("slack", "T123", "Cued HQ", "check_failed", true, nil),
        integration("whatsapp", "default", "WhatsApp", "in_progress", true, nil),
      ]
    default:
      return []
    }
  }

  var setupIntegrations: [IntegrationStatus] {
    let actual = integrations
    return [
      firstActual("contacts", actual) ?? integration("contacts", "local", "Contacts.app", fallbackState(for: "contacts"), true, nil),
      firstActual("imessage", actual) ?? integration("imessage", "local", "Messages", fallbackState(for: "imessage"), true, nil),
      firstActual("slack", actual) ?? integration("slack", "default", "Slack", "missing", true, nil),
      firstActual("discord", actual) ?? integration("discord", "default", "Discord", "missing", true, nil),
      firstActual("gmail", actual) ?? integration("gmail", "default", "Gmail", "missing", true, nil),
      firstActual("linkedin", actual) ?? integration("linkedin", "default", "LinkedIn", "missing", true, nil),
      firstActual("whatsapp", actual) ?? integration("whatsapp", "default", "WhatsApp", "missing", true, nil),
      firstActual("signal", actual) ?? integration("signal", "default", "Signal", "missing", true, nil),
    ]
  }

  var agentTargetStatuses: [AgentTarget: AgentTargetStatus] {
    Dictionary(
      uniqueKeysWithValues: AgentTarget.allCases.map { target in
        (
          target,
          AgentTargetStatus(
            readiness: .ready,
            detail: "\(target.title) is ready for preview."
          )
        )
      }
    )
  }

  private var contactsStats: ProjectionStats {
    ProjectionStats(rawEvents: 1_240, projectedContacts: 1_118)
  }

  private var messagesStats: ProjectionStats {
    ProjectionStats(rawEvents: 34_920, projectedContacts: 997, projectedConversations: 318, projectedMessages: 28_441)
  }

  private var gmailStats: ProjectionStats {
    ProjectionStats(rawEvents: 9_330, projectedContacts: 204, projectedConversations: 86, projectedMessages: 7_412)
  }

  private func fallbackState(for platform: String) -> String {
    switch name {
    case "permissions-granted":
      platform == "contacts" || platform == "imessage" ? "authorized" : "missing"
    default:
      platform == "contacts" || platform == "imessage" ? "not_determined" : "missing"
    }
  }

  private func firstActual(
    _ platform: String,
    _ integrations: [IntegrationStatus]
  ) -> IntegrationStatus? {
    integrations.first { $0.platform == platform }
  }

  private func permission(
    _ key: String,
    _ status: String,
    _ summary: String,
    _ requestFlags: [String]
  ) -> PermissionStatus {
    PermissionStatus(
      key: key,
      status: status,
      summary: summary,
      requestFlags: requestFlags
    )
  }

  private func integration(
    _ platform: String,
    _ accountKey: String,
    _ displayName: String,
    _ authState: String,
    _ enabled: Bool,
    _ projectionStats: ProjectionStats?
  ) -> IntegrationStatus {
    IntegrationStatus(
      platform: platform,
      accountKey: accountKey,
      displayName: displayName,
      authState: authState,
      enabled: enabled,
      projectionStats: projectionStats,
      capability: capability(for: platform)
    )
  }

  private func capability(for platform: String) -> CapabilityStatus {
    if platform == "contacts" {
      return CapabilityStatus(
        availability: permissions.first(where: { $0.key == "contacts" })?.status == "granted" ? "available" : "requires_permission",
        setupVisible: true
      )
    }
    if platform == "imessage" {
      return CapabilityStatus(
        availability: permissions.first(where: { $0.key == "full_disk_access" })?.status == "granted" ? "available" : "requires_permission",
        setupVisible: true
      )
    }
    return CapabilityStatus(availability: "available", setupVisible: true)
  }
}

public func defaultPreviewSkillStatus() -> SkillStatus {
  SkillStatus(
    installed: false,
    status: "unknown",
    summary: "Checks whether the global Cued skill is available to your agents."
  )
}

public enum ImageRenderer {
  @MainActor
  public static func pngData(for view: AnyView, size: CGSize) throws -> Data {
    _ = NSApplication.shared
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(origin: .zero, size: size)
    host.setFrameSize(size)
    host.layoutSubtreeIfNeeded()

    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
      throw PreviewError.renderFailed("Could not allocate bitmap.")
    }

    bitmap.size = size
    host.cacheDisplay(in: host.bounds, to: bitmap)

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
      throw PreviewError.renderFailed("Could not encode PNG.")
    }
    return data
  }
}

public enum PreviewMetricsReader {
  public static func metrics(forPNG url: URL) throws -> PreviewMetrics {
    let data = try Data(contentsOf: url)
    guard let image = NSImage(data: data),
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff) else {
      throw PreviewError.renderFailed("Could not read PNG metrics.")
    }

    let background = sampledColor(bitmap, x: 0, y: 0)
    var colors = Set<Int>()
    var nonBackground = 0
    let stepX = max(1, bitmap.pixelsWide / 32)
    let stepY = max(1, bitmap.pixelsHigh / 32)

    for y in stride(from: 0, to: bitmap.pixelsHigh, by: stepY) {
      for x in stride(from: 0, to: bitmap.pixelsWide, by: stepX) {
        let color = sampledColor(bitmap, x: x, y: y)
        colors.insert(color)
        if colorDistance(color, background) > 18 {
          nonBackground += 1
        }
      }
    }

    return PreviewMetrics(
      width: bitmap.pixelsWide,
      height: bitmap.pixelsHigh,
      byteCount: data.count,
      distinctSampledColors: colors.count,
      nonBackgroundSampleCount: nonBackground
    )
  }

  private static func sampledColor(_ bitmap: NSBitmapImageRep, x: Int, y: Int) -> Int {
    guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
      return 0
    }

    let red = Int((color.redComponent * 255).rounded())
    let green = Int((color.greenComponent * 255).rounded())
    let blue = Int((color.blueComponent * 255).rounded())
    return (red << 16) | (green << 8) | blue
  }

  private static func colorDistance(_ lhs: Int, _ rhs: Int) -> Int {
    let lr = (lhs >> 16) & 0xff
    let lg = (lhs >> 8) & 0xff
    let lb = lhs & 0xff
    let rr = (rhs >> 16) & 0xff
    let rg = (rhs >> 8) & 0xff
    let rb = rhs & 0xff
    return abs(lr - rr) + abs(lg - rg) + abs(lb - rb)
  }
}

public enum PreviewError: Error, CustomStringConvertible {
  case invalidOption(String)
  case unknownCase(String)
  case renderFailed(String)

  public var description: String {
    switch self {
    case .invalidOption(let message):
      "Invalid option: \(message)"
    case .unknownCase(let name):
      "Unknown preview case: \(name)"
    case .renderFailed(let message):
      "Render failed: \(message)"
    }
  }
}
