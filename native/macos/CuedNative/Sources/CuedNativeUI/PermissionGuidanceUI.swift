import AppKit
import SwiftUI

enum InstallerRoundedButtonVariant {
  case prominent
  case secondary
}

enum InstallerRoundedButtonSize {
  case compact
  case regular
  case icon

  var minWidth: CGFloat {
    switch self {
    case .compact:
      74
    case .regular:
      92
    case .icon:
      32
    }
  }

  var minHeight: CGFloat {
    switch self {
    case .compact:
      30
    case .regular:
      32
    case .icon:
      32
    }
  }

  var horizontalPadding: CGFloat {
    switch self {
    case .compact:
      15
    case .regular:
      16
    case .icon:
      0
    }
  }

  var font: Font {
    switch self {
    case .compact:
      .system(size: 12, weight: .semibold)
    case .regular:
      .system(size: 13, weight: .semibold)
    case .icon:
      .system(size: 13, weight: .semibold)
    }
  }
}

struct InstallerPermissionDescriptor {
  let key: String
  let title: String
  let subtitle: String
  let systemImage: String
  let accentColor: Color
  let settingsLabel: String
  let walkthroughTitle: String
  let walkthroughBody: String
  let requestButtonTitle: String
  let supportsDirectRequest: Bool
  let supportsGuidedSettings: Bool
  let needsDragAndDrop: Bool
  let steps: [String]
}

enum InstallerPermissionActionKind: Equatable {
  case requestPrompt
  case guideInSettings
  case none
}

func installerPermissionDescriptor(for key: String) -> InstallerPermissionDescriptor {
  switch key {
  case "contacts":
    return InstallerPermissionDescriptor(
      key: key,
      title: "Contacts",
      subtitle: "Allow Cued to read Contacts.app so it can resolve people consistently across local data.",
      systemImage: "person.crop.circle.badge.checkmark",
      accentColor: Color(red: 0.05, green: 0.70, blue: 0.82),
      settingsLabel: "Contacts",
      walkthroughTitle: "Confirm Contacts access for Cued",
      walkthroughBody: "Use the macOS prompt first. If you already dismissed it, turn Cued back on in the Contacts privacy list.",
      requestButtonTitle: "Request access",
      supportsDirectRequest: true,
      supportsGuidedSettings: true,
      needsDragAndDrop: false,
      steps: [
        "Request the system prompt from Cued.",
        "If needed, reopen Settings and enable Cued under Contacts.",
        "Return here and refresh.",
      ]
    )
  case "full_disk_access":
    return InstallerPermissionDescriptor(
      key: key,
      title: "Full Disk Access",
      subtitle: "Required to read the Messages database for passive sync on this Mac.",
      systemImage: "internaldrive.fill",
      accentColor: Color(red: 0.91, green: 0.58, blue: 0.11),
      settingsLabel: "Full Disk Access",
      walkthroughTitle: "Drag Cued into Full Disk Access",
      walkthroughBody: "This is the manual step. Open the pane, drag the Cued app into the list, enable it, then restart the app identity if macOS asks.",
      requestButtonTitle: "Guide in Settings",
      supportsDirectRequest: false,
      supportsGuidedSettings: true,
      needsDragAndDrop: true,
      steps: [
        "Open the Full Disk Access pane.",
        "Drag Cued into the list and switch it on.",
        "Return to Cued after macOS finishes updating access.",
      ]
    )
  default:
    return InstallerPermissionDescriptor(
      key: key,
      title: "Permission",
      subtitle: "Review this macOS permission.",
      systemImage: "hand.raised.fill",
      accentColor: .accentColor,
      settingsLabel: "Privacy",
      walkthroughTitle: "Review this permission",
      walkthroughBody: "Open Settings and complete the requested step.",
      requestButtonTitle: "Open Settings",
      supportsDirectRequest: false,
      supportsGuidedSettings: true,
      needsDragAndDrop: false,
      steps: ["Open Settings.", "Complete the permission step.", "Return to Cued."],
    )
  }
}

func installerPermissionActionKind(
  for permission: InstallerPermissionStatus,
  descriptor: InstallerPermissionDescriptor
) -> InstallerPermissionActionKind {
  if descriptor.supportsDirectRequest && permission.status == "unknown" {
    return .requestPrompt
  }

  if descriptor.supportsGuidedSettings {
    return .guideInSettings
  }

  if descriptor.supportsDirectRequest {
    return .requestPrompt
  }

  return .none
}

struct InstallerPermissionActionButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  let variant: InstallerRoundedButtonVariant
  let size: InstallerRoundedButtonSize

  init(
    variant: InstallerRoundedButtonVariant = .prominent,
    size: InstallerRoundedButtonSize = .compact
  ) {
    self.variant = variant
    self.size = size
  }

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(size.font)
      .foregroundStyle(foregroundColor(isPressed: configuration.isPressed))
      .padding(.horizontal, size.horizontalPadding)
      .frame(minWidth: size.minWidth, minHeight: size.minHeight)
      .background(
        Capsule(style: .continuous)
          .fill(backgroundColor(isPressed: configuration.isPressed))
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder(borderColor(isPressed: configuration.isPressed), lineWidth: 1)
          )
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.94 : 1) : 0.64)
  }

  private func foregroundColor(isPressed: Bool) -> Color {
    switch variant {
    case .prominent:
      return .white.opacity(isEnabled ? (isPressed ? 0.96 : 1) : 0.78)
    case .secondary:
      return .primary.opacity(isEnabled ? (isPressed ? 0.84 : 1) : 0.62)
    }
  }

  private func backgroundColor(isPressed: Bool) -> Color {
    switch variant {
    case .prominent:
      return Color.accentColor.opacity(isEnabled ? (isPressed ? 0.86 : 1) : 0.42)
    case .secondary:
      return Color(NSColor.controlBackgroundColor).opacity(isEnabled ? (isPressed ? 0.9 : 1) : 0.72)
    }
  }

  private func borderColor(isPressed: Bool) -> Color {
    switch variant {
    case .prominent:
      return Color.white.opacity(isEnabled ? (isPressed ? 0.1 : 0.14) : 0.1)
    case .secondary:
      return Color(NSColor.separatorColor).opacity(isEnabled ? (isPressed ? 0.34 : 0.42) : 0.24)
    }
  }
}
