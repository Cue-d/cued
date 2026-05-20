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
        Text("Debug")
          .font(.headline)

        ForEach(agentDebugExamples) { example in
          agentDebugRow(example)
          if example.id != agentDebugExamples.last?.id {
            Divider()
          }
        }
      }

      if let feedback = viewModel.agentLaunchFeedback {
        agentLaunchFeedback(feedback)
      }
    }
  }

  func workflowRow(icon: String, title: String, detail: String) -> some View {
    WorkflowRow(icon: icon, title: title, detail: detail)
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

  func agentDebugRow(_ example: AgentExample) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: example.icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(.secondary)
        .frame(width: 26, height: 26)

      VStack(alignment: .leading, spacing: 4) {
        Text(example.title)
          .font(.headline)
        Text(example.detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      VStack(alignment: .trailing, spacing: 7) {
        ForEach(AgentTarget.allCases) { target in
          let status = viewModel.agentTargetStatuses[target] ?? .unknown
          Button {
            viewModel.clearAgentLaunchFeedback()
            onLaunchAgentExample(example.id, target)
          } label: {
            Label(agentDebugButtonTitle(for: target, status: status), systemImage: agentDebugButtonIcon(for: target, status: status))
              .labelStyle(.titleAndIcon)
              .lineLimit(1)
          }
          .buttonStyle(PermissionActionButtonStyle(variant: .secondary, size: .compact))
          .disabled(status.readiness == .unknown)
          .help(agentDebugHelp(for: status))
        }
      }
      .frame(width: 158)
    }
    .padding(.vertical, 4)
  }

  func agentDebugButtonTitle(for target: AgentTarget, status: AgentTargetStatus) -> String {
    switch status.readiness {
    case .ready:
      return target.title
    case .unknown:
      return "Checking"
    case .missing:
      return "Unavailable"
    case .notLoggedIn:
      return "Auth needed"
    }
  }

  func agentDebugButtonIcon(for target: AgentTarget, status: AgentTargetStatus) -> String {
    switch status.readiness {
    case .ready:
      switch target {
      case .codexApp:
        return "app.badge"
      case .codexCLI:
        return "terminal"
      case .claudeCode:
        return "sparkles"
      }
    case .unknown:
      return "hourglass"
    case .missing:
      return "exclamationmark.triangle"
    case .notLoggedIn:
      return "person.crop.circle.badge.exclamationmark"
    }
  }

  func agentDebugHelp(for status: AgentTargetStatus) -> String {
    if let remediation = status.remediation {
      return "\(status.detail) \(remediation)"
    }
    return status.detail
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
