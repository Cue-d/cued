import AppKit
import Combine
import SwiftUI

extension RootView {
  var useCasesPage: some View {
    pageContainer {
      Text("Use cases")
        .font(.largeTitle.weight(.semibold))

      Text("Choose where Cued context should show up.")
        .font(.body)
        .foregroundStyle(.secondary)

      LazyVGrid(
        columns: [
          GridItem(.flexible(), spacing: 12),
          GridItem(.flexible(), spacing: 12),
        ],
        spacing: 12
      ) {
        useCaseTile(icon: "terminal", title: "Open in Codex", detail: "Debug sync or query context.")
        useCaseTile(icon: "sparkles", title: "Open in Claude Code", detail: "Investigate repo issues locally.")
        useCaseTile(icon: "command", title: "Use from CLI", detail: "Run focused local queries.")
        useCaseTile(icon: "clock.arrow.circlepath", title: "Follow-up queue", detail: "Find stale or unanswered threads.")
      }
      .padding(.top, 10)
    }
  }

}
