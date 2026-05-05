import AppKit
import CoreGraphics
import Foundation

enum PermissionGuidePanel {
  case contacts
  case fullDiskAccess

  var settingsURL: URL {
    switch self {
    case .contacts:
      return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")!
    case .fullDiskAccess:
      return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    }
  }

  var emphasizedPermissionTerm: String {
    switch self {
    case .contacts:
      return "Contacts"
    case .fullDiskAccess:
      return "Full Disk Access"
    }
  }

  var usesDragSource: Bool {
    self == .fullDiskAccess
  }
}

func onboardingGuidePanel(for permissionKey: String) -> PermissionGuidePanel? {
  switch permissionKey {
  case "contacts":
    return .contacts
  case "full_disk_access":
    return .fullDiskAccess
  default:
    return nil
  }
}

func onboardingPermissionGuideURL(for permissionKey: String) -> String? {
  onboardingGuidePanel(for: permissionKey)?.settingsURL.absoluteString
}

func onboardingPermissionGuideUsesDragSource(for permissionKey: String) -> Bool {
  onboardingGuidePanel(for: permissionKey)?.usesDragSource == true
}

func onboardingPermissionGuideInstructionSentence(
  for panel: PermissionGuidePanel,
  hostAppName: String
) -> String {
  if panel.usesDragSource {
    return "Drag \(hostAppName) to the list above to allow \(panel.emphasizedPermissionTerm)."
  }

  return "Enable \(hostAppName) in the list above to allow \(panel.emphasizedPermissionTerm)."
}

func onboardingPermissionGuideFrameIsApproximatelyEqual(
  _ lhs: CGRect,
  _ rhs: CGRect,
  tolerance: CGFloat = 1
) -> Bool {
  abs(lhs.minX - rhs.minX) <= tolerance
    && abs(lhs.minY - rhs.minY) <= tolerance
    && abs(lhs.width - rhs.width) <= tolerance
    && abs(lhs.height - rhs.height) <= tolerance
}

@MainActor
final class PermissionGuideAssistant {
  static let shared = PermissionGuideAssistant()

  private var overlayController: PermissionGuideOverlayWindowController?
  private var trackingTimer: Timer?
  private var activationObserver: NSObjectProtocol?
  private var pendingRefreshWorkItem: DispatchWorkItem?
  private var lastPresentedSnapshot: SystemSettingsWindowSnapshot?

  func present(panel: PermissionGuidePanel) {
    dismiss()
    overlayController = PermissionGuideOverlayWindowController(
      hostApp: PermissionGuideHostApp.current(),
      panel: panel,
      sourceWindowFrame: PermissionGuideSourceLocator.currentWindowFrame()
    )
    NSWorkspace.shared.open(panel.settingsURL)
    startTracking()
  }

  func dismiss() {
    trackingTimer?.invalidate()
    trackingTimer = nil
    pendingRefreshWorkItem?.cancel()
    pendingRefreshWorkItem = nil
    lastPresentedSnapshot = nil

    if let activationObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
      self.activationObserver = nil
    }

    overlayController?.close()
    overlayController = nil
  }

  private func startTracking() {
    trackingTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
      Task { @MainActor in
        self?.refreshPosition()
      }
    }
    trackingTimer?.tolerance = 0.05

    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in
        self?.refreshPosition(immediate: true)
      }
    }

    refreshPosition(immediate: true)
  }

  private func refreshPosition(immediate: Bool = false) {
    guard let snapshot = SystemSettingsWindowLocator.frontmostWindow() else {
      pendingRefreshWorkItem?.cancel()
      pendingRefreshWorkItem = nil
      lastPresentedSnapshot = nil
      overlayController?.hide()
      return
    }

    if let lastPresentedSnapshot, snapshot.isApproximatelyEqual(to: lastPresentedSnapshot) {
      return
    }

    pendingRefreshWorkItem?.cancel()

    let applyUpdate = { [weak self] in
      guard let self else {
        return
      }
      self.overlayController?.present(settingsFrame: snapshot.frame, visibleFrame: snapshot.visibleFrame)
      self.lastPresentedSnapshot = snapshot
    }

    if immediate || lastPresentedSnapshot == nil {
      applyUpdate()
      return
    }

    let workItem = DispatchWorkItem(block: applyUpdate)
    pendingRefreshWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: workItem)
  }
}

private struct PermissionGuideHostApp {
  let displayName: String
  let bundleURL: URL
  let icon: NSImage

  static func current(bundle: Bundle = .main) -> PermissionGuideHostApp {
    let bundleURL = resolvedAppBundleURL(for: bundle)
    let displayName =
      Bundle(url: bundleURL)?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? Bundle(url: bundleURL)?.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
      ?? bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String
      ?? "Cued"

    let icon = resolvedIcon(for: bundleURL) ?? NSWorkspace.shared.icon(forFile: bundleURL.path)
    icon.size = NSSize(width: 64, height: 64)
    return PermissionGuideHostApp(displayName: displayName, bundleURL: bundleURL, icon: icon)
  }

  private static func resolvedAppBundleURL(for bundle: Bundle) -> URL {
    var candidate = bundle.bundleURL
    while candidate.pathComponents.count > 1 && candidate.pathExtension != "app" {
      candidate.deleteLastPathComponent()
    }
    return candidate.pathExtension == "app" ? candidate : bundle.bundleURL
  }

  private static func resolvedIcon(for bundleURL: URL) -> NSImage? {
    let resourceCandidates = [
      bundleURL.appendingPathComponent("Contents/Resources/cued-mark.png"),
      bundleURL.appendingPathComponent("Contents/Resources/AppIcon.icns"),
    ]

    for candidate in resourceCandidates {
      if let image = NSImage(contentsOf: candidate) {
        return image
      }
    }

    return nil
  }
}

private enum PermissionGuideSourceLocator {
  @MainActor
  static func currentWindowFrame() -> CGRect? {
    if let keyWindow = NSApp.keyWindow, keyWindow.isVisible {
      return keyWindow.frame
    }

    if let mainWindow = NSApp.mainWindow, mainWindow.isVisible {
      return mainWindow.frame
    }

    return NSApp.windows.first(where: \.isVisible)?.frame
  }
}

private final class PermissionGuideOverlayWindowController: NSWindowController {
  private let preferredContentSize = NSSize(width: 460, height: 126)
  private var currentFrame: CGRect?

  init(hostApp: PermissionGuideHostApp, panel: PermissionGuidePanel, sourceWindowFrame: CGRect?) {
    let window = PassiveOverlayPanel(
      contentRect: NSRect(origin: .zero, size: preferredContentSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    super.init(window: window)

    window.isOpaque = false
    window.backgroundColor = .clear
    window.level = .statusBar
    window.hasShadow = true
    window.hidesOnDeactivate = false
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]

    window.contentView = PermissionGuideOverlayView(
      frame: NSRect(origin: .zero, size: preferredContentSize),
      hostApp: hostApp,
      panel: panel
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func present(settingsFrame: CGRect, visibleFrame: CGRect) {
    guard let window else {
      return
    }

    let size = contentSize(for: settingsFrame, visibleFrame: visibleFrame)
    let frame = CGRect(origin: anchoredOrigin(for: settingsFrame, visibleFrame: visibleFrame, size: size), size: size)

    if let previousFrame = currentFrame,
       onboardingPermissionGuideFrameIsApproximatelyEqual(previousFrame, frame) {
      window.orderFrontRegardless()
      return
    }

    currentFrame = frame
    window.alphaValue = 1
    window.setFrame(frame, display: true)
    window.orderFrontRegardless()
  }

  func hide() {
    window?.orderOut(nil)
  }

  private func contentSize(for settingsFrame: CGRect, visibleFrame: CGRect) -> CGSize {
    let sidebarWidth: CGFloat = 176
    let horizontalPadding: CGFloat = 56
    let availableSettingsWidth = max(380, settingsFrame.width - sidebarWidth - horizontalPadding)
    let visibleWidth = max(380, visibleFrame.width - 24)
    let width = min(preferredContentSize.width, availableSettingsWidth, visibleWidth)
    return CGSize(width: width, height: preferredContentSize.height)
  }

  private func anchoredOrigin(for settingsFrame: CGRect, visibleFrame: CGRect, size: CGSize) -> CGPoint {
    let sidebarWidth: CGFloat = 176
    let minX = visibleFrame.minX + 12
    let maxX = visibleFrame.maxX - size.width - 12
    let minY = visibleFrame.minY + 12
    let maxY = visibleFrame.maxY - size.height - 12

    let preferredX = settingsFrame.minX + sidebarWidth + max(18, (settingsFrame.width - sidebarWidth - size.width) / 2)
    let preferredY = settingsFrame.minY + 16

    return CGPoint(
      x: min(max(preferredX, minX), maxX),
      y: min(max(preferredY, minY), maxY)
    )
  }
}

private final class PassiveOverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class PermissionGuideOverlayView: NSView {
  private weak var materialView: NSVisualEffectView?
  private weak var tintView: NSView?
  private weak var motionBlurOverlay: NSView?
  private let motionWhiteLayer = CAShapeLayer()
  private let motionAccentLayer = CAShapeLayer()

  init(frame frameRect: NSRect, hostApp: PermissionGuideHostApp, panel: PermissionGuidePanel) {
    super.init(frame: frameRect)
    translatesAutoresizingMaskIntoConstraints = false
    setup(hostApp: hostApp, panel: panel)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  private func setup(hostApp: PermissionGuideHostApp, panel: PermissionGuidePanel) {
    let materialView = NSVisualEffectView()
    materialView.translatesAutoresizingMaskIntoConstraints = false
    materialView.material = .hudWindow
    materialView.blendingMode = .behindWindow
    materialView.state = .active
    materialView.wantsLayer = true
    materialView.layer?.cornerRadius = 22
    materialView.layer?.masksToBounds = true
    materialView.layer?.borderWidth = 0.5
    materialView.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.18).cgColor
    addSubview(materialView)
    self.materialView = materialView

    let tint = NSView()
    tint.translatesAutoresizingMaskIntoConstraints = false
    tint.wantsLayer = true
    tint.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.92).cgColor
    materialView.addSubview(tint)
    self.tintView = tint

    let motionBlurOverlay = NSView()
    motionBlurOverlay.translatesAutoresizingMaskIntoConstraints = false
    motionBlurOverlay.wantsLayer = true
    motionBlurOverlay.layer?.opacity = 0
    materialView.addSubview(motionBlurOverlay)
    self.motionBlurOverlay = motionBlurOverlay

    configureMotionBlurLayers()

    let arrow = NSImageView()
    arrow.translatesAutoresizingMaskIntoConstraints = false
    arrow.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)
    arrow.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 24, weight: .bold)
    arrow.contentTintColor = NSColor.systemBlue
    arrow.wantsLayer = true
    materialView.addSubview(arrow)

    let detailLabel = NSTextField(labelWithAttributedString: instructionText(for: panel, hostApp: hostApp))
    detailLabel.translatesAutoresizingMaskIntoConstraints = false
    detailLabel.maximumNumberOfLines = 2
    materialView.addSubview(detailLabel)

    let instructionView: NSView
    if panel.usesDragSource {
      instructionView = AppBundleDragView(hostApp: hostApp)
    } else {
      instructionView = ToggleHintView(hostApp: hostApp)
    }
    instructionView.translatesAutoresizingMaskIntoConstraints = false
    materialView.addSubview(instructionView)

    NSLayoutConstraint.activate([
      widthAnchor.constraint(equalToConstant: frame.width),
      heightAnchor.constraint(equalToConstant: frame.height),
      materialView.leadingAnchor.constraint(equalTo: leadingAnchor),
      materialView.trailingAnchor.constraint(equalTo: trailingAnchor),
      materialView.topAnchor.constraint(equalTo: topAnchor),
      materialView.bottomAnchor.constraint(equalTo: bottomAnchor),
      tint.leadingAnchor.constraint(equalTo: materialView.leadingAnchor),
      tint.trailingAnchor.constraint(equalTo: materialView.trailingAnchor),
      tint.topAnchor.constraint(equalTo: materialView.topAnchor),
      tint.bottomAnchor.constraint(equalTo: materialView.bottomAnchor),
      motionBlurOverlay.leadingAnchor.constraint(equalTo: materialView.leadingAnchor),
      motionBlurOverlay.trailingAnchor.constraint(equalTo: materialView.trailingAnchor),
      motionBlurOverlay.topAnchor.constraint(equalTo: materialView.topAnchor),
      motionBlurOverlay.bottomAnchor.constraint(equalTo: materialView.bottomAnchor),
      arrow.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 24),
      arrow.topAnchor.constraint(equalTo: materialView.topAnchor, constant: 14),
      arrow.widthAnchor.constraint(equalToConstant: 28),
      arrow.heightAnchor.constraint(equalToConstant: 28),
      detailLabel.leadingAnchor.constraint(equalTo: arrow.trailingAnchor, constant: 12),
      detailLabel.centerYAnchor.constraint(equalTo: arrow.centerYAnchor),
      detailLabel.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -22),
      instructionView.leadingAnchor.constraint(equalTo: materialView.leadingAnchor, constant: 24),
      instructionView.trailingAnchor.constraint(equalTo: materialView.trailingAnchor, constant: -24),
      instructionView.topAnchor.constraint(equalTo: detailLabel.bottomAnchor, constant: 14),
      instructionView.heightAnchor.constraint(equalToConstant: 44),
    ])

    startArrowBounce(on: arrow)
  }

  override func layout() {
    super.layout()

    guard let motionBlurOverlay else {
      return
    }

    let bounds = motionBlurOverlay.bounds.insetBy(dx: 1, dy: 1)
    let path = CGPath(
      roundedRect: bounds,
      cornerWidth: 22,
      cornerHeight: 22,
      transform: nil
    )
    motionWhiteLayer.frame = motionBlurOverlay.bounds
    motionAccentLayer.frame = motionBlurOverlay.bounds
    motionWhiteLayer.path = path
    motionAccentLayer.path = path
  }

  func prepareForArrivalAnimation() {
    wantsLayer = true
    layer?.opacity = 0.82
    layer?.transform = CATransform3DMakeScale(0.97, 0.97, 1)
    materialView?.alphaValue = 0.9
  }

  func animateArrival() {
    guard let layer else {
      return
    }

    layer.removeAllAnimations()

    let opacity = CABasicAnimation(keyPath: "opacity")
    opacity.fromValue = 0.82
    opacity.toValue = 1

    let scale = CAKeyframeAnimation(keyPath: "transform")
    scale.values = [
      CATransform3DMakeScale(0.97, 0.97, 1),
      CATransform3DMakeScale(1.014, 1.014, 1),
      CATransform3DIdentity,
    ]
    scale.keyTimes = [0, 0.7, 1]
    scale.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1),
      CAMediaTimingFunction(name: .easeOut),
    ]

    let group = CAAnimationGroup()
    group.animations = [opacity, scale]
    group.duration = 0.5
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1)
    group.fillMode = .forwards
    group.isRemovedOnCompletion = false
    layer.add(group, forKey: "permissionGuideArrival")

    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.5
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1)
      materialView?.animator().alphaValue = 1
    }
  }

  func animateReposition(delta: CGVector) {
    guard let layer,
          let motionBlurOverlay,
          let motionLayer = motionBlurOverlay.layer,
          hypot(delta.dx, delta.dy) > 1 else {
      return
    }

    let offset = motionBlurOffset(for: delta)
    motionLayer.removeAllAnimations()
    layer.removeAnimation(forKey: "permissionGuideReposition")
    materialView?.layer?.removeAnimation(forKey: "permissionGuideRepositionMaterial")

    motionWhiteLayer.transform = CATransform3DMakeTranslation(-offset.width * 0.65, -offset.height * 0.65, 0)
    motionAccentLayer.transform = CATransform3DMakeTranslation(-offset.width, -offset.height, 0)
    motionBlurOverlay.alphaValue = 0.72

    let settle = CAKeyframeAnimation(keyPath: "transform")
    settle.values = [
      CATransform3DMakeTranslation(-offset.width * 0.22, -offset.height * 0.22, 0),
      CATransform3DMakeTranslation(offset.width * 0.04, offset.height * 0.04, 0),
      CATransform3DIdentity,
    ]
    settle.keyTimes = [0, 0.72, 1]
    settle.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1),
      CAMediaTimingFunction(name: .easeOut),
    ]

    let settleGroup = CAAnimationGroup()
    settleGroup.animations = [settle]
    settleGroup.duration = 0.38
    settleGroup.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1)
    settleGroup.fillMode = .forwards
    settleGroup.isRemovedOnCompletion = false
    layer.add(settleGroup, forKey: "permissionGuideReposition")

    let materialOpacity = CABasicAnimation(keyPath: "opacity")
    materialOpacity.fromValue = 0.94
    materialOpacity.toValue = 1
    materialOpacity.duration = 0.38
    materialOpacity.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1)
    materialView?.layer?.add(materialOpacity, forKey: "permissionGuideRepositionMaterial")

    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.38
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.24, 1)
      motionBlurOverlay.animator().alphaValue = 0
    }
  }

  private func startArrowBounce(on arrow: NSImageView) {
    guard let layer = arrow.layer else {
      return
    }

    layer.removeAnimation(forKey: "permissionGuideArrowBounce")

    let animation = CAKeyframeAnimation(keyPath: "transform.translation.y")
    animation.values = [0, -5, 0]
    animation.keyTimes = [0, 0.45, 1]
    animation.duration = 1.1
    animation.repeatCount = .infinity
    animation.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut),
      CAMediaTimingFunction(name: .easeInEaseOut),
    ]
    layer.add(animation, forKey: "permissionGuideArrowBounce")
  }

  private func instructionText(
    for panel: PermissionGuidePanel,
    hostApp: PermissionGuideHostApp
  ) -> NSAttributedString {
    let sentence = onboardingPermissionGuideInstructionSentence(
      for: panel,
      hostAppName: hostApp.displayName
    )
    let attributed = NSMutableAttributedString(
      string: sentence,
      attributes: [
        .font: NSFont.systemFont(ofSize: 14, weight: .regular),
        .foregroundColor: NSColor.labelColor,
      ]
    )

    let boldTerms = [hostApp.displayName, panel.emphasizedPermissionTerm]
    for term in boldTerms {
      let range = (sentence as NSString).range(of: term)
      if range.location != NSNotFound {
        attributed.addAttributes(
          [.font: NSFont.systemFont(ofSize: 14, weight: .semibold)],
          range: range
        )
      }
    }

    return attributed
  }

  private func configureMotionBlurLayers() {
    guard let motionLayer = motionBlurOverlay?.layer else {
      return
    }

    motionWhiteLayer.fillColor = NSColor.clear.cgColor
    motionWhiteLayer.strokeColor = NSColor.white.withAlphaComponent(0.14).cgColor
    motionWhiteLayer.lineWidth = 1
    motionWhiteLayer.shadowColor = NSColor.white.withAlphaComponent(0.22).cgColor
    motionWhiteLayer.shadowOpacity = 1
    motionWhiteLayer.shadowRadius = 8
    motionWhiteLayer.shadowOffset = .zero

    motionAccentLayer.fillColor = NSColor.clear.cgColor
    motionAccentLayer.strokeColor = NSColor.systemBlue.withAlphaComponent(0.12).cgColor
    motionAccentLayer.lineWidth = 1
    motionAccentLayer.shadowColor = NSColor.systemBlue.withAlphaComponent(0.16).cgColor
    motionAccentLayer.shadowOpacity = 1
    motionAccentLayer.shadowRadius = 12
    motionAccentLayer.shadowOffset = .zero

    motionLayer.addSublayer(motionWhiteLayer)
    motionLayer.addSublayer(motionAccentLayer)
  }

  private func motionBlurOffset(for delta: CGVector) -> CGSize {
    let distance = max(1, hypot(delta.dx, delta.dy))
    let scale = min(16, max(5, distance * 0.18))
    return CGSize(width: (delta.dx / distance) * scale, height: (delta.dy / distance) * scale)
  }
}

private final class AppBundleDragView: NSView, NSDraggingSource {
  private let hostApp: PermissionGuideHostApp
  private let pillView = NSView()

  init(hostApp: PermissionGuideHostApp) {
    self.hostApp = hostApp
    super.init(frame: .zero)
    wantsLayer = true
    setup()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func mouseDown(with event: NSEvent) {
    let draggingItem = NSDraggingItem(pasteboardWriter: hostApp.bundleURL as NSURL)
    draggingItem.setDraggingFrame(bounds, contents: dragImage())

    let session = beginDraggingSession(with: [draggingItem], event: event, source: self)
    session.animatesToStartingPositionsOnCancelOrFail = true
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    .copy
  }

  private func setup() {
    layer?.backgroundColor = NSColor.clear.cgColor

    pillView.translatesAutoresizingMaskIntoConstraints = false
    pillView.wantsLayer = true
    pillView.layer?.cornerRadius = 12
    pillView.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.98).cgColor
    pillView.layer?.borderWidth = 1
    pillView.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.16).cgColor
    addSubview(pillView)

    let iconView = NSImageView(image: hostApp.icon)
    iconView.translatesAutoresizingMaskIntoConstraints = false
    iconView.imageScaling = .scaleProportionallyUpOrDown
    pillView.addSubview(iconView)

    let label = NSTextField(labelWithString: hostApp.displayName)
    label.translatesAutoresizingMaskIntoConstraints = false
    label.font = .systemFont(ofSize: 14, weight: .semibold)
    label.textColor = NSColor.labelColor
    pillView.addSubview(label)

    NSLayoutConstraint.activate([
      pillView.leadingAnchor.constraint(equalTo: leadingAnchor),
      pillView.trailingAnchor.constraint(equalTo: trailingAnchor),
      pillView.topAnchor.constraint(equalTo: topAnchor),
      pillView.bottomAnchor.constraint(equalTo: bottomAnchor),
      pillView.heightAnchor.constraint(equalToConstant: 34),
      iconView.leadingAnchor.constraint(equalTo: pillView.leadingAnchor, constant: 8),
      iconView.centerYAnchor.constraint(equalTo: pillView.centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 20),
      iconView.heightAnchor.constraint(equalToConstant: 20),
      label.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 8),
      label.trailingAnchor.constraint(lessThanOrEqualTo: pillView.trailingAnchor, constant: -10),
      label.centerYAnchor.constraint(equalTo: pillView.centerYAnchor),
    ])
  }

  private func dragImage() -> NSImage {
    guard let representation = bitmapImageRepForCachingDisplay(in: bounds) else {
      return NSImage(size: bounds.size)
    }

    cacheDisplay(in: bounds, to: representation)
    let image = NSImage(size: bounds.size)
    image.addRepresentation(representation)
    return image
  }
}

private final class ToggleHintView: NSView {
  init(hostApp: PermissionGuideHostApp) {
    super.init(frame: .zero)
    wantsLayer = true
    setup(hostApp: hostApp)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  private func setup(hostApp: PermissionGuideHostApp) {
    let background = NSView()
    background.translatesAutoresizingMaskIntoConstraints = false
    background.wantsLayer = true
    background.layer?.cornerRadius = 14
    background.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.9).cgColor
    addSubview(background)

    let iconView = NSImageView(image: hostApp.icon)
    iconView.translatesAutoresizingMaskIntoConstraints = false
    iconView.imageScaling = .scaleProportionallyUpOrDown
    background.addSubview(iconView)

    let title = NSTextField(labelWithString: hostApp.displayName)
    title.translatesAutoresizingMaskIntoConstraints = false
    title.font = .systemFont(ofSize: 14, weight: .semibold)
    background.addSubview(title)

    let subtitle = NSTextField(labelWithString: "Enable this entry above")
    subtitle.translatesAutoresizingMaskIntoConstraints = false
    subtitle.font = .systemFont(ofSize: 12, weight: .medium)
    subtitle.textColor = NSColor.secondaryLabelColor
    background.addSubview(subtitle)

    let switchView = NSView()
    switchView.translatesAutoresizingMaskIntoConstraints = false
    switchView.wantsLayer = true
    switchView.layer?.cornerRadius = 12
    switchView.layer?.backgroundColor = NSColor.systemBlue.cgColor
    background.addSubview(switchView)

    let knob = NSView()
    knob.translatesAutoresizingMaskIntoConstraints = false
    knob.wantsLayer = true
    knob.layer?.cornerRadius = 10
    knob.layer?.backgroundColor = NSColor.white.cgColor
    switchView.addSubview(knob)

    NSLayoutConstraint.activate([
      background.leadingAnchor.constraint(equalTo: leadingAnchor),
      background.trailingAnchor.constraint(equalTo: trailingAnchor),
      background.topAnchor.constraint(equalTo: topAnchor),
      background.bottomAnchor.constraint(equalTo: bottomAnchor),
      iconView.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 14),
      iconView.centerYAnchor.constraint(equalTo: background.centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 22),
      iconView.heightAnchor.constraint(equalToConstant: 22),
      title.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
      title.topAnchor.constraint(equalTo: background.topAnchor, constant: 10),
      subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
      subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 2),
      switchView.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -14),
      switchView.centerYAnchor.constraint(equalTo: background.centerYAnchor),
      switchView.widthAnchor.constraint(equalToConstant: 44),
      switchView.heightAnchor.constraint(equalToConstant: 24),
      knob.widthAnchor.constraint(equalToConstant: 20),
      knob.heightAnchor.constraint(equalToConstant: 20),
      knob.centerYAnchor.constraint(equalTo: switchView.centerYAnchor),
      knob.trailingAnchor.constraint(equalTo: switchView.trailingAnchor, constant: -2),
    ])
  }
}

private struct SystemSettingsWindowSnapshot {
  let frame: CGRect
  let visibleFrame: CGRect

  func isApproximatelyEqual(to other: SystemSettingsWindowSnapshot) -> Bool {
    abs(frame.minX - other.frame.minX) < 1 &&
      abs(frame.minY - other.frame.minY) < 1 &&
      abs(frame.width - other.frame.width) < 1 &&
      abs(frame.height - other.frame.height) < 1 &&
      abs(visibleFrame.minX - other.visibleFrame.minX) < 1 &&
      abs(visibleFrame.minY - other.visibleFrame.minY) < 1 &&
      abs(visibleFrame.width - other.visibleFrame.width) < 1 &&
      abs(visibleFrame.height - other.visibleFrame.height) < 1
  }
}

private enum SystemSettingsWindowLocator {
  static let bundleIdentifier = "com.apple.systempreferences"

  static func frontmostWindow() -> SystemSettingsWindowSnapshot? {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier else {
      return nil
    }

    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
      return nil
    }

    guard let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], .zero) as? [[String: Any]] else {
      return nil
    }

    let candidates = windowInfo.compactMap { info -> SystemSettingsWindowSnapshot? in
      guard let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t, ownerPID == app.processIdentifier else {
        return nil
      }
      guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else {
        return nil
      }
      guard let rawBounds = info[kCGWindowBounds as String] as? [String: CGFloat] else {
        return nil
      }

      let bounds = CGRect(
        x: rawBounds["X"] ?? 0,
        y: rawBounds["Y"] ?? 0,
        width: rawBounds["Width"] ?? 0,
        height: rawBounds["Height"] ?? 0
      )

      guard bounds.width > 320, bounds.height > 240 else {
        return nil
      }

      let geometry = convertQuartzBounds(bounds)
      return SystemSettingsWindowSnapshot(frame: geometry.frame, visibleFrame: geometry.visibleFrame)
    }

    return candidates.max { lhs, rhs in
      lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
    }
  }

  private static func convertQuartzBounds(_ bounds: CGRect) -> (frame: CGRect, visibleFrame: CGRect) {
    struct ScreenGeometry {
      let appKitFrame: CGRect
      let visibleFrame: CGRect
      let quartzFrame: CGRect
    }

    let screens = NSScreen.screens.compactMap { screen -> ScreenGeometry? in
      guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
        return nil
      }

      let displayID = CGDirectDisplayID(number.uint32Value)
      return ScreenGeometry(
        appKitFrame: screen.frame,
        visibleFrame: screen.visibleFrame,
        quartzFrame: CGDisplayBounds(displayID)
      )
    }

    let matched = screens.max { lhs, rhs in
      lhs.quartzFrame.intersection(bounds).width * lhs.quartzFrame.intersection(bounds).height
        < rhs.quartzFrame.intersection(bounds).width * rhs.quartzFrame.intersection(bounds).height
    }

    guard let matched else {
      return (bounds, NSScreen.main?.visibleFrame ?? bounds)
    }

    let localX = bounds.minX - matched.quartzFrame.minX
    let localY = bounds.minY - matched.quartzFrame.minY
    let appKitFrame = CGRect(
      x: matched.appKitFrame.minX + localX,
      y: matched.appKitFrame.maxY - localY - bounds.height,
      width: bounds.width,
      height: bounds.height
    )
    return (appKitFrame, matched.visibleFrame)
  }
}
