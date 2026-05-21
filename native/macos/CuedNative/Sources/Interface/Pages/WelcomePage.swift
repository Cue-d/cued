import AppKit
import Combine
import SwiftUI

extension RootView {
  var welcomePage: some View {
    pageContainer {
      VStack(spacing: 10) {
        CuedMarkIcon(size: 64, cornerRadius: 18)

        Text("Welcome to Cued")
          .font(.largeTitle.weight(.semibold))

        Text("Sync all messaging platforms locally for your agents.")
          .font(.body)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 62)

      VStack(spacing: 10) {
        workflowRow(
          icon: "lock.laptopcomputer",
          title: "Grant local access",
          detail: "Contacts and messages stay on this Mac.",
          tint: Color(red: 0.12, green: 0.68, blue: 0.78)
        )
        workflowRow(
          icon: "arrow.triangle.2.circlepath",
          title: "Connect sources",
          detail: "Cued indexes into a local database.",
          tint: Color(red: 0.28, green: 0.52, blue: 0.96)
        )
        workflowRow(
          icon: "terminal",
          title: "Use with agents",
          detail: "Codex and Claude Code can read the context you choose.",
          tint: Color(red: 0.12, green: 0.76, blue: 0.29)
        )
      }
      .padding(.top, 22)
    }
  }

}

private struct CuedMarkIcon: View {
  let size: CGFloat
  let cornerRadius: CGFloat

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(Color(red: 0.96, green: 0.95, blue: 0.91))
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.75)

      if let image = cuedMarkImage() {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .antialiased(true)
          .aspectRatio(contentMode: .fit)
          .padding(size * 0.18)
      } else {
        Text("C")
          .font(.system(size: size * 0.46, weight: .black, design: .rounded))
          .foregroundStyle(.white)
      }
    }
    .frame(width: size, height: size)
    .shadow(color: Color.black.opacity(0.12), radius: 12, y: 4)
  }

  private func cuedMarkImage() -> NSImage? {
    let candidates = [
      Bundle.module.url(forResource: "cued-mark", withExtension: "png"),
      Bundle.main.url(forResource: "cued-mark", withExtension: "png"),
      Bundle.main.resourceURL?.appendingPathComponent("cued-mark.png"),
    ]
    for url in candidates.compactMap({ $0 }) {
      if let image = NSImage(contentsOf: url) {
        return image
      }
    }
    return nil
  }
}
