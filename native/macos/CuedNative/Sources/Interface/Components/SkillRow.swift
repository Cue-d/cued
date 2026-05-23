import AppKit
import Combine
import SwiftUI

struct SkillRow: View {
  let status: SkillStatus
  let isPending: Bool
  let onInstall: () -> Void

  var body: some View {
    HStack(spacing: 14) {
      statusIcon(systemImage: "terminal", tint: Color(red: 0.12, green: 0.76, blue: 0.29))

      VStack(alignment: .leading, spacing: 3) {
        Text("Cued skill")
          .font(.headline)
          .foregroundStyle(.primary)
        Text(status.summary)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if status.installed {
        Image(systemName: "checkmark.circle.fill")
          .font(.title3.weight(.semibold))
          .foregroundStyle(.green)
          .accessibilityLabel("Cued skill installed")
      } else if isPending || status.status == "unknown" {
        ProgressView()
          .controlSize(.small)
          .frame(minWidth: 76)
      } else {
        Button("Install", action: onInstall)
          .buttonStyle(PermissionActionButtonStyle(variant: .secondary, size: .compact))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 15)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground())
  }
}
