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
  case repairCued
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
    icon: "tray.full",
    title: "Catch Up",
    detail: "Summarize what changed across recent messages and call out the open loops.",
    promptPreview: "Catch me up on what I should respond to"
  ),
  AgentExample(
    id: .followUps,
    icon: "clock.arrow.circlepath",
    title: "Draft Follow-Ups",
    detail: "Find stale or unanswered threads and propose next actions.",
    promptPreview: "Use Cued context to build a follow-up list"
  ),
  AgentExample(
    id: .prepPerson,
    icon: "person.text.rectangle",
    title: "Prep For A Person",
    detail: "Summarize recent relationship context before a reply or meeting.",
    promptPreview: "Write a compact person brief from local history"
  ),
  AgentExample(
    id: .findWarmIntros,
    icon: "person.2.wave.2",
    title: "Find Warm Intros",
    detail: "Search local context for people who could help with a company, role, or topic.",
    promptPreview: "Find the strongest warm intro paths"
  ),
]

public let agentDebugExamples: [AgentExample] = [
  AgentExample(
    id: .repairCued,
    icon: "stethoscope",
    title: "Repair Cued",
    detail: "Inspect status, doctor output, logs, and local DB state before touching code.",
    promptPreview: "Investigate and repair Cued locally"
  ),
  AgentExample(
    id: .debugSync,
    icon: "arrow.triangle.2.circlepath",
    title: "Debug Sync",
    detail: "Find why a source is not producing useful local context.",
    promptPreview: "Check permissions, integration state, and recent syncs"
  ),
]

public func defaultAgentTargetStatuses() -> [AgentTarget: AgentTargetStatus] {
  Dictionary(uniqueKeysWithValues: AgentTarget.allCases.map { ($0, .unknown) })
}
