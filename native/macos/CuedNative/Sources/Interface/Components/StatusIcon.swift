import AppKit
import Combine
import SwiftUI

func statusIcon(
  systemImage: String,
  tint: Color
) -> some View {
  StatusIcon(systemImage: systemImage, tint: tint)
}

func rowBackground(cornerRadius: CGFloat = 20) -> some View {
  RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    .fill(Color(NSColor.controlBackgroundColor))
    .overlay(
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(Color(NSColor.separatorColor).opacity(0.32), lineWidth: 1)
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
