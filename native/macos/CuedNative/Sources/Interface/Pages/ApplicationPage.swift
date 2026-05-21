import AppKit
import Combine
import SwiftUI

extension RootView {
  var applicationPage: some View {
    pageContainer {
      Text("Status")
        .font(.largeTitle.weight(.semibold))

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
      }

      card(spacing: 12) {
        LazyVGrid(
          columns: [
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
          ],
          spacing: 10
        ) {
          metricTile(
            label: "Messages",
            value: statusMetricValue(viewModel.relationshipSummary.messages),
            breakdown: platformBreakdown(for: .messages)
          )
          metricTile(
            label: "Contacts",
            value: statusMetricValue(viewModel.relationshipSummary.contacts),
            breakdown: platformBreakdown(for: .contacts)
          )
          metricTile(
            label: "Phone calls",
            value: statusMetricValue(viewModel.relationshipSummary.phoneCalls),
            breakdown: platformBreakdown(for: .phoneCalls)
          )
        }
      }

      card(spacing: 14) {
        Text("Repair")
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

  func workflowRow(
    icon: String,
    title: String,
    detail: String,
    tint: Color = .secondary
  ) -> some View {
    WorkflowRow(icon: icon, title: title, detail: detail, tint: tint)
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

  func metricTile(
    label: String,
    value: String,
    breakdown: [PlatformMetricBreakdown]
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      AnimatedMetricValue(value: value)
      Text(label)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.primary)

      VStack(alignment: .leading, spacing: 7) {
        ForEach(breakdown.prefix(3)) { item in
          platformMetricRow(item)
        }
      }
      .frame(minHeight: 77, alignment: .top)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(rowBackground(cornerRadius: 10))
  }

  func platformMetricRow(_ item: PlatformMetricBreakdown) -> some View {
    HStack(spacing: 7) {
      MiniPlatformIcon(platform: item.platform)
      Text(item.title)
        .font(.caption.weight(.medium))
        .lineLimit(1)
      Spacer(minLength: 4)
      Text(formatCount(item.value))
        .font(.caption.weight(.semibold))
        .fontDesign(.rounded)
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
  }

  func platformBreakdown(for metric: RelationshipMetric) -> [PlatformMetricBreakdown] {
    viewModel.platformConfigurations.compactMap { configuration in
      let value = configuration.knownAccounts.reduce(0) { total, integration in
        guard let stats = integration.projectionStats else {
          return total
        }
        switch metric {
        case .messages:
          return total + stats.projectedMessages
        case .contacts:
          return total + stats.projectedContacts
        case .phoneCalls:
          let observedCalls = stats.rawEventsBySchema["call.observed@1"] ?? 0
          return total + observedCalls
        }
      }
      guard value > 0 else {
        return nil
      }
      return PlatformMetricBreakdown(
        platform: configuration.platform,
        title: configuration.title,
        value: value
      )
    }
    .sorted { lhs, rhs in
      if lhs.value == rhs.value {
        return lhs.title < rhs.title
      }
      return lhs.value > rhs.value
    }
  }

  func statusMetricValue(_ value: Int) -> String {
    if !viewModel.hasLoadedSnapshot {
      return "..."
    }
    return formatCount(value)
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

      HStack(spacing: 7) {
        ForEach(preferredAgentTargets) { target in
          let status = viewModel.agentTargetStatuses[target] ?? .unknown
          Button {
            viewModel.clearAgentLaunchFeedback()
            onLaunchAgentExample(example.id, target)
          } label: {
            Label(agentDebugButtonTitle(for: target, status: status), systemImage: agentDebugButtonIcon(for: target, status: status))
              .labelStyle(.titleAndIcon)
              .lineLimit(1)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(PermissionActionButtonStyle(variant: agentDebugButtonVariant(for: target, status: status), size: .compact))
          .disabled(status.readiness == .unknown)
          .help(agentDebugHelp(for: status))
        }
      }
      .frame(width: 250)
    }
    .padding(.vertical, 4)
  }

  var preferredAgentTargets: [AgentTarget] {
    if viewModel.agentTargetStatuses[.codexApp]?.readiness != .missing {
      return [.codexApp, .claudeCode]
    }
    return [.codexCLI, .claudeCode]
  }

  func agentDebugButtonTitle(for target: AgentTarget, status: AgentTargetStatus) -> String {
    switch status.readiness {
    case .ready:
      return target.shortTitle
    case .unknown:
      return "..."
    case .missing:
      return "Unavailable"
    case .notLoggedIn:
      return "Auth needed"
    }
  }

  func agentDebugButtonVariant(for target: AgentTarget, status: AgentTargetStatus) -> ActionButtonVariant {
    .secondary
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
      if !viewModel.hasLoadedSnapshot {
        return "Loading the local Cued snapshot from this Mac."
      }
      return "Sources appear after the daemon reports supported integrations."
    }
    return "Connected, pending, and paused source state in one place."
  }

  var localDatabaseSummary: String {
    "~/.cued/local.db"
  }

}

enum RelationshipMetric {
  case messages
  case contacts
  case phoneCalls
}

struct PlatformMetricBreakdown: Identifiable {
  let platform: String
  let title: String
  let value: Int

  var id: String { "\(platform):\(title)" }
}

struct AnimatedMetricValue: View {
  let value: String

  @State private var displayedValue: String
  @State private var isTicking = false

  init(value: String) {
    self.value = value
    _displayedValue = State(initialValue: value)
  }

  var body: some View {
    Text(displayedValue)
      .font(.system(size: 30, weight: .semibold, design: .rounded))
      .minimumScaleFactor(0.74)
      .lineLimit(1)
      .monospacedDigit()
      .blur(radius: isTicking ? 2.4 : 0)
      .opacity(isTicking ? 0.58 : 1)
      .offset(y: isTicking ? -1.5 : 0)
      .frame(maxWidth: .infinity, alignment: .leading)
      .animation(.easeOut(duration: 0.14), value: isTicking)
      .onChange(of: value) { nextValue in
        guard nextValue != displayedValue else {
          return
        }
        isTicking = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) {
          displayedValue = nextValue
          isTicking = false
        }
      }
  }
}

struct MiniPlatformIcon: View {
  let platform: String

  var body: some View {
    ZStack {
      Circle()
        .fill(platformAccentColor(for: platform).opacity(0.18))
      Circle()
        .strokeBorder(platformAccentColor(for: platform).opacity(0.38), lineWidth: 0.75)
      PlatformIcon(platform: platform)
        .frame(width: 16, height: 16)
        .scaleEffect(0.4)
    }
    .frame(width: 18, height: 18)
  }
}
