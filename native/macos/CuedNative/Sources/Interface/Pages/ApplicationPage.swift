import AppKit
import Combine
import SwiftUI

extension RootView {
  var applicationPage: some View {
    pageContainer {
      Text("Cued Application")
        .font(.largeTitle.weight(.semibold))

      Text("Your local sync and relationship context surface.")
        .font(.body)
        .foregroundStyle(.secondary)

      card(spacing: 14) {
        appSummaryRow(
          label: "Local DB",
          value: localDatabaseSummary,
          status: "Ready"
        )
        Divider()
        appSummaryRow(
          label: "Sources",
          value: sourceSummary,
          status: "\(connectedPlatformCount)/\(max(viewModel.platformConfigurations.count, 1))"
        )
        Divider()
        appSummaryRow(
          label: "Sync Health",
          value: syncHealthSummary,
          status: syncHealthStatus
        )
        Divider()
        appSummaryRow(
          label: "Notes",
          value: applicationNotes,
          status: applicationNotesStatus
        )
      }

      card(spacing: 10) {
        Text("Relationship context")
          .font(.headline)
        Text("Recent people, stale threads, unanswered messages, and agent-ready context will live here after setup.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      card(spacing: 14) {
        workflowRow(
          icon: "shippingbox.fill",
          title: "Debug bundle",
          detail: "Collect logs, source state, and a redacted local DB summary."
        )
        workflowRow(
          icon: "arrow.branch",
          title: "Draft repair PR",
          detail: "Let an agent inspect, patch, test, and propose a local branch."
        )
      }

      LazyVGrid(
        columns: [
          GridItem(.flexible(), spacing: 12),
          GridItem(.flexible(), spacing: 12),
        ],
        spacing: 12
      ) {
        ExampleCard(
          icon: "chevron.left.forwardslash.chevron.right",
          title: "Open in Codex",
          detail: "Start a local repair agent with the current app context."
        )
        ExampleCard(
          icon: "sparkles",
          title: "Open in Claude Code",
          detail: "Hand the debug bundle to Claude Code for a patch proposal."
        )
      }

      Button("Create draft repair PR") {}
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .prominent,
            size: .regular
          )
        )
        .disabled(true)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  func workflowRow(icon: String, title: String, detail: String) -> some View {
    WorkflowRow(icon: icon, title: title, detail: detail)
  }

  func useCaseTile(icon: String, title: String, detail: String) -> some View {
    ExampleCard(icon: icon, title: title, detail: detail)
  }

  func appSummaryRow(label: String, value: String, status: String) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(label)
          .font(.headline)
        Text(value)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      Text(status)
        .font(.caption.weight(.semibold))
        .fontDesign(.monospaced)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
          Capsule(style: .continuous)
            .fill(Color(NSColor.controlBackgroundColor))
        )
    }
  }

  var connectedPlatformCount: Int {
    viewModel.platformConfigurations.filter(isPlatformComplete).count
  }

  var sourceSummary: String {
    if viewModel.platformConfigurations.isEmpty {
      return "Sources appear after the daemon reports supported integrations."
    }
    return "Connected, pending, and paused source state in one place."
  }

  var syncHealthStatus: String {
    connectedPlatformCount > 0 ? "OK" : "Setup"
  }

  var syncHealthSummary: String {
    connectedPlatformCount > 0
      ? "Recent runs, retries, throttling, and source errors will be summarized here."
      : "Complete access and sources before sync health becomes useful."
  }

  var applicationNotesStatus: String {
    if !viewModel.allPermissionsGranted {
      return "Action"
    }
    if connectedPlatformCount == 0 {
      return "Setup"
    }
    return "Clear"
  }

  var applicationNotes: String {
    if !viewModel.allPermissionsGranted {
      return "Some local permissions still need attention before Cued can sync fully."
    }
    if connectedPlatformCount == 0 {
      return "No source is connected yet. Connect a platform before asking an agent to debug sync health."
    }
    return "No active application issues are reported from setup state."
  }

  var localDatabaseSummary: String {
    "~/.cued/local.db"
  }

}
