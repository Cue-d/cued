import AppKit
import Combine
import SwiftUI

extension RootView {
  var useCasesPage: some View {
    pageContainer {
      Text("Examples")
        .font(.largeTitle.weight(.semibold))

      Text("Open a focused Cued prompt in the tool you already use.")
        .font(.body)
        .foregroundStyle(.secondary)

      if let feedback = viewModel.agentLaunchFeedback {
        agentLaunchFeedback(feedback)
      }

      LazyVGrid(
        columns: [
          GridItem(.flexible(), spacing: 12),
          GridItem(.flexible(), spacing: 12),
        ],
        spacing: 12
      ) {
        ForEach(agentExamples) { example in
          ExampleCard(
            example: example,
            targetStatuses: viewModel.agentTargetStatuses,
            onLaunch: { target in
              viewModel.clearAgentLaunchFeedback()
              onLaunchAgentExample(example.id, target)
            }
          )
        }
      }
      .padding(.top, 10)
    }
  }

  func agentLaunchFeedback(_ feedback: AgentLaunchFeedback) -> some View {
    HStack(spacing: 10) {
      Image(systemName: feedback.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
        .foregroundStyle(feedback.isError ? Color.orange : Color.green)
      VStack(alignment: .leading, spacing: 2) {
        Text(feedback.title)
          .font(.subheadline.weight(.semibold))
        Text(feedback.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(rowBackground(cornerRadius: 14))
  }

}
