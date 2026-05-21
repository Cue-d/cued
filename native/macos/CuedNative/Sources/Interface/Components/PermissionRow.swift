import AppKit
import Combine
import SwiftUI

extension RootView {
  func permissionRow(_ permission: PermissionStatus) -> some View {
    let descriptor = permissionDescriptor(for: permission.key)
    return PermissionRow(
      descriptor: descriptor,
      isGranted: permission.status == "granted",
      onToggle: permission.key == "diagnostics"
        ? { enabled in
          viewModel.setPermissionStatus(
            key: "diagnostics",
            status: enabled ? "granted" : "needs_action",
            summary: enabled
              ? "Redacted diagnostic reporting is enabled"
              : "Redacted diagnostic reporting is disabled",
            requestFlags: [enabled ? "--telemetry-enable" : "--telemetry-disable"]
          )
          onRequestPermission([enabled ? "--telemetry-enable" : "--telemetry-disable"])
        }
        : nil,
      onAllow: {
        handlePermissionAction(for: permission, descriptor: descriptor)
      }
    )
  }

  var skillRow: some View {
    SkillRow(
      status: viewModel.globalSkillStatus,
      isPending: pendingGlobalSkillInstall,
      onInstall: {
          pendingGlobalSkillInstall = true
          onInstallGlobalSkill()
      }
    )
  }

  func handlePermissionAction(
    for permission: PermissionStatus,
    descriptor: PermissionDescriptor
  ) {
    switch permissionAction(for: permission, descriptor: descriptor) {
    case .requestPrompt:
      onRequestPermission(permission.requestFlags)
    case .guideInSettings:
      showPermissionGuide(for: permission.key)
    case .none:
      return
    }
  }

  func showPermissionGuide(for permissionKey: String) {
    activePermissionGuideKey = permissionKey
    onGuidePermission(permissionKey)
  }

}

struct PermissionRow: View {
  let descriptor: PermissionDescriptor
  let isGranted: Bool
  let onToggle: ((Bool) -> Void)?
  let onAllow: () -> Void

  var body: some View {
    HStack(spacing: 14) {
      statusIcon(
        systemImage: descriptor.systemImage,
        tint: descriptor.accentColor
      )

      VStack(alignment: .leading, spacing: 3) {
        Text(descriptor.title)
          .font(.headline)
          .foregroundStyle(.primary)
        Text(descriptor.subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let onToggle {
        Toggle("", isOn: Binding(
          get: { isGranted },
          set: { onToggle($0) }
        ))
        .toggleStyle(.switch)
        .labelsHidden()
        .accessibilityLabel(descriptor.title)
      } else if isGranted {
        Image(systemName: "checkmark.circle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(.green)
          .accessibilityLabel("\(descriptor.title) access granted")
      } else {
        Button("Allow", action: onAllow)
          .buttonStyle(PermissionActionButtonStyle(variant: .prominent, size: .compact))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground())
  }
}
