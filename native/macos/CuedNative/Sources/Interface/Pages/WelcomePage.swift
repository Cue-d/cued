import AppKit
import Combine
import SwiftUI

extension RootView {
  var welcomePage: some View {
    pageContainer {
      VStack(spacing: 10) {
        Image(systemName: "tray.and.arrow.down.fill")
          .font(.system(size: 34, weight: .semibold))
          .foregroundStyle(Color.accentColor)
          .frame(width: 62, height: 62)
          .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .fill(Color.accentColor.opacity(0.12))
          )

        Text("Welcome to Cued")
          .font(.largeTitle.weight(.semibold))

        Text("Local context for your agents.")
          .font(.body)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 62)

      VStack(spacing: 10) {
        workflowRow(
          icon: "lock.laptopcomputer",
          title: "Grant local access",
          detail: "Contacts and messages stay on this Mac."
        )
        workflowRow(
          icon: "arrow.triangle.2.circlepath",
          title: "Connect sources",
          detail: "Cued indexes into a local database."
        )
        workflowRow(
          icon: "terminal",
          title: "Use with agents",
          detail: "Codex and Claude Code can read the context you choose."
        )
      }
      .padding(.top, 22)
    }
  }

}
