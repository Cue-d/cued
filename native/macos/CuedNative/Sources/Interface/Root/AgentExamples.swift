import AppKit
import Combine
import SwiftUI

public enum AgentTarget: String, CaseIterable, Identifiable, Sendable {
  case codexApp
  case codexCLI
  case claudeCode

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .codexApp:
      return "Codex App"
    case .codexCLI:
      return "Codex CLI"
    case .claudeCode:
      return "Claude Code"
    }
  }

  public var shortTitle: String {
    switch self {
    case .codexApp:
      return "Codex"
    case .codexCLI:
      return "CLI"
    case .claudeCode:
      return "Claude"
    }
  }
}

public enum AgentTargetReadiness: String, Sendable {
  case unknown
  case ready
  case missing
  case notLoggedIn
}

public struct AgentTargetStatus: Sendable {
  public let readiness: AgentTargetReadiness
  public let detail: String
  public let remediation: String?

  public init(
    readiness: AgentTargetReadiness,
    detail: String,
    remediation: String? = nil
  ) {
    self.readiness = readiness
    self.detail = detail
    self.remediation = remediation
  }

  public static let unknown = AgentTargetStatus(
    readiness: .unknown,
    detail: "Checking launch readiness."
  )
}

public enum AgentExampleID: String, CaseIterable, Identifiable, Sendable {
  case debugSync
  case catchUp
  case followUps
  case prepPerson
  case findWarmIntros

  public var id: String { rawValue }
}

public struct AgentExample: Identifiable, Sendable {
  public let id: AgentExampleID
  public let icon: String
  public let title: String
  public let detail: String
  public let promptPreview: String

  public init(
    id: AgentExampleID,
    icon: String,
    title: String,
    detail: String,
    promptPreview: String
  ) {
    self.id = id
    self.icon = icon
    self.title = title
    self.detail = detail
    self.promptPreview = promptPreview
  }
}

public struct AgentLaunchFeedback: Identifiable, Sendable {
  public let id = UUID()
  public let title: String
  public let detail: String
  public let isError: Bool

  public init(title: String, detail: String, isError: Bool = false) {
    self.title = title
    self.detail = detail
    self.isError = isError
  }
}

public let agentExamples: [AgentExample] = [
  AgentExample(
    id: .catchUp,
    icon: "point.3.connected.trianglepath.dotted",
    title: "Context Use",
    detail: "Find where local context changes what the agent should do.",
    promptPreview: "Show where context changes the answer"
  ),
  AgentExample(
    id: .followUps,
    icon: "rectangle.3.group.bubble.left",
    title: "Workflow Value",
    detail: "Turn recent messages into useful work, not a generic summary.",
    promptPreview: "Find a real workflow Cued can improve"
  ),
  AgentExample(
    id: .prepPerson,
    icon: "arrow.trianglehead.clockwise",
    title: "Accumulated Understanding",
    detail: "Build a durable brief from replayable local history.",
    promptPreview: "Turn repeated context into understanding"
  ),
  AgentExample(
    id: .findWarmIntros,
    icon: "scope",
    title: "Intent And Triggers",
    detail: "Decide when an always-on agent should act or stay quiet.",
    promptPreview: "Design explicit triggers from local context"
  ),
]

public func defaultAgentTargetStatuses() -> [AgentTarget: AgentTargetStatus] {
  Dictionary(uniqueKeysWithValues: AgentTarget.allCases.map { ($0, .unknown) })
}
