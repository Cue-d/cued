import AppKit
import Combine
import SwiftUI

struct ExampleCard: View {
  let icon: String
  let title: String
  let detail: String
  let promptPreview: String?
  let targetStatuses: [AgentTarget: AgentTargetStatus]
  let onLaunch: ((AgentTarget) -> Void)?

  init(
    icon: String,
    title: String,
    detail: String,
    promptPreview: String? = nil,
    targetStatuses: [AgentTarget: AgentTargetStatus] = [:],
    onLaunch: ((AgentTarget) -> Void)? = nil
  ) {
    self.icon = icon
    self.title = title
    self.detail = detail
    self.promptPreview = promptPreview
    self.targetStatuses = targetStatuses
    self.onLaunch = onLaunch
  }

  init(
    example: AgentExample,
    targetStatuses: [AgentTarget: AgentTargetStatus],
    onLaunch: @escaping (AgentTarget) -> Void
  ) {
    self.init(
      icon: example.icon,
      title: example.title,
      detail: example.detail,
      promptPreview: example.promptPreview,
      targetStatuses: targetStatuses,
      onLaunch: onLaunch
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        iconTile
        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .font(.headline)
          Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      if let promptPreview {
        promptPill(promptPreview)
      }

      Spacer(minLength: 0)

      if onLaunch != nil {
        targetButtons
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, minHeight: onLaunch == nil ? 124 : 214, alignment: .topLeading)
    .background(rowBackground(cornerRadius: 12))
  }

  private var iconTile: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(Color.accentColor.opacity(0.12))
        .overlay(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .strokeBorder(Color.accentColor.opacity(0.22), lineWidth: 1)
        )

      Image(systemName: icon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Color.accentColor)
    }
    .frame(width: 34, height: 34)
  }

  private func promptPill(_ text: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "quote.opening")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(text)
        .font(.caption.weight(.medium))
        .foregroundStyle(.primary)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color(NSColor.controlBackgroundColor))
    )
  }

  private var targetButtons: some View {
    VStack(alignment: .leading, spacing: 7) {
      ForEach(AgentTarget.allCases) { target in
        let status = targetStatuses[target] ?? .unknown
        Button {
          onLaunch?(target)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: buttonIcon(for: target, status: status))
              .font(.system(size: 12, weight: .semibold))
              .frame(width: 14)
            Text(buttonTitle(for: target, status: status))
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .secondary,
            size: .compact
          )
        )
        .disabled(status.readiness == .unknown)
        .help(helpText(for: target, status: status))
      }
    }
  }

  private func buttonTitle(for target: AgentTarget, status: AgentTargetStatus) -> String {
    switch status.readiness {
    case .ready:
      return target.title
    case .unknown:
      return "Checking \(target.title)"
    case .missing:
      return "\(target.title) unavailable"
    case .notLoggedIn:
      return "\(target.title) auth needed"
    }
  }

  private func buttonIcon(for target: AgentTarget, status: AgentTargetStatus) -> String {
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

  private func helpText(for target: AgentTarget, status: AgentTargetStatus) -> String {
    if let remediation = status.remediation {
      return "\(status.detail) \(remediation)"
    }
    return status.detail
  }
}
