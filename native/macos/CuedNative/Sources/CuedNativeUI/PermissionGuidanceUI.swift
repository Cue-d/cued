import AppKit
import SwiftUI

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
  case "messages_automation":
    return InstallerPermissionDescriptor(
      key: key,
      title: "Messages automation",
      subtitle: "Required only for AppleScript send and control flows in Messages. Passive sync does not use this.",
      systemImage: "paperplane.circle.fill",
      accentColor: Color(red: 0.15, green: 0.46, blue: 0.98),
      settingsLabel: "Automation",
      walkthroughTitle: "Allow Cued to control Messages",
      walkthroughBody: "After the Apple Events prompt appears, approve it. If you already denied it, open Automation in Settings and turn Cued back on for Messages.",
      requestButtonTitle: "Request access",
      supportsDirectRequest: true,
      supportsGuidedSettings: true,
      needsDragAndDrop: false,
      steps: [
        "Request the Messages automation prompt.",
        "Approve the Cued to Messages automation request.",
        "If it was denied, reopen Automation in Settings and toggle Cued on.",
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

struct InstallerPermissionActionButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(.white)
      .padding(.horizontal, 15)
      .frame(minWidth: 74, minHeight: 30)
      .background(
        Capsule(style: .continuous)
          .fill(Color.accentColor.opacity(configuration.isPressed ? 0.86 : 1))
      )
      .opacity(configuration.isPressed ? 0.92 : 1)
  }
}
