import AppKit
import Combine
import SwiftUI

func statusIcon(
  systemImage: String,
  tint: Color
) -> some View {
  StatusIcon(systemImage: systemImage, tint: tint)
}

func rowBackground(cornerRadius: CGFloat = 10, emphasized: Bool = false) -> some View {
  RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    .fill(
      emphasized
        ? Color.accentColor.opacity(0.1)
        : Color(NSColor.controlBackgroundColor)
    )
    .overlay(
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(
          emphasized
            ? Color.accentColor.opacity(0.68)
            : Color(NSColor.separatorColor).opacity(0.62),
          lineWidth: 1
        )
    )
}

struct StatusIcon: View {
  let systemImage: String
  let tint: Color

  var body: some View {
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [
              tint.opacity(0.98),
              tint.opacity(0.78),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      Circle()
        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.75)

      Image(systemName: systemImage)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
    }
    .frame(width: 40, height: 40)
  }
}
