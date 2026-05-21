import AppKit
import SwiftUI

enum ActionButtonVariant {
  case prominent
  case secondary
}

enum ActionButtonSize {
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

struct PermissionDescriptor {
  let key: String
  let title: String
  let subtitle: String
  let systemImage: String
  let accentColor: Color
  let supportsDirectRequest: Bool
  let supportsGuidedSettings: Bool
}

enum PermissionAction: Equatable {
  case requestPrompt
  case guideInSettings
  case none
}

func permissionDescriptor(for key: String) -> PermissionDescriptor {
  switch key {
  case "contacts":
    return PermissionDescriptor(
      key: key,
      title: "Contacts",
      subtitle: "Allow Cued to read Contacts.app so it can resolve people consistently across local data.",
      systemImage: "person.crop.circle.badge.checkmark",
      accentColor: Color(red: 0.05, green: 0.70, blue: 0.82),
      supportsDirectRequest: true,
      supportsGuidedSettings: true
    )
  case "full_disk_access":
    return PermissionDescriptor(
      key: key,
      title: "Full Disk Access",
      subtitle: "Required to read the Messages database for passive sync on this Mac.",
      systemImage: "internaldrive.fill",
      accentColor: Color(red: 0.91, green: 0.58, blue: 0.11),
      supportsDirectRequest: false,
      supportsGuidedSettings: true
    )
  case "messages_automation":
    return PermissionDescriptor(
      key: key,
      title: "Messages automation",
      subtitle: "Required only for AppleScript send and control flows in Messages. Passive sync does not use this.",
      systemImage: "paperplane.circle.fill",
      accentColor: Color(red: 0.15, green: 0.46, blue: 0.98),
      supportsDirectRequest: true,
      supportsGuidedSettings: true
    )
  case "diagnostics":
    return PermissionDescriptor(
      key: key,
      title: "Help improve Cued",
      subtitle: "Automatically send private, redacted crash and error reports so Cued can detect bugs, fix them, and ship updates faster.",
      systemImage: "waveform.badge.magnifyingglass",
      accentColor: Color(red: 0.32, green: 0.38, blue: 0.94),
      supportsDirectRequest: true,
      supportsGuidedSettings: false
    )
  default:
    return PermissionDescriptor(
      key: key,
      title: "Permission",
      subtitle: "Review this macOS permission.",
      systemImage: "hand.raised.fill",
      accentColor: .accentColor,
      supportsDirectRequest: false,
      supportsGuidedSettings: true,
    )
  }
}

func permissionAction(
  for permission: PermissionStatus,
  descriptor: PermissionDescriptor
) -> PermissionAction {
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

struct PermissionActionButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  let variant: ActionButtonVariant
  let size: ActionButtonSize

  init(
    variant: ActionButtonVariant = .prominent,
    size: ActionButtonSize = .compact
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
