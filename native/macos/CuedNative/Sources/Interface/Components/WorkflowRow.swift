import AppKit
import Combine
import SwiftUI

struct WorkflowRow: View {
  let icon: String
  let title: String
  let detail: String
  let tint: Color

  init(
    icon: String,
    title: String,
    detail: String,
    tint: Color = .secondary
  ) {
    self.icon = icon
    self.title = title
    self.detail = detail
    self.tint = tint
  }

  var body: some View {
    HStack(spacing: 12) {
      statusIcon(systemImage: icon, tint: tint)

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.headline)
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground(cornerRadius: 10))
  }
}
