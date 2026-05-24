import AppKit
import Foundation
import Interface

enum AgentLaunchService {
  private static let codexBundleIdentifier = "com.openai.codex"

  nonisolated static func targetStatuses() -> [AgentTarget: AgentTargetStatus] {
    Dictionary(
      uniqueKeysWithValues: AgentTarget.allCases.map { target in
        (target, status(for: target))
      }
    )
  }

  @MainActor
  static func launch(
    exampleID: AgentExampleID,
    target: AgentTarget,
    userFocus: String? = nil
  ) -> AgentLaunchFeedback {
    let status = status(for: target)
    guard status.readiness == .ready else {
      return AgentLaunchFeedback(
        title: "\(target.title) is not ready",
        detail: status.remediation ?? status.detail,
        isError: true
      )
    }

    let repoPath = resolveRepoPath()
    let prompt = prompt(for: exampleID, repoPath: repoPath, userFocus: userFocus)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(prompt, forType: .string)

    switch target {
    case .codexApp:
      return launchCodexApp(repoPath: repoPath, prompt: prompt)
    case .codexCLI:
      return launchCommandFileAgent(
        title: "Opened Codex CLI",
        command: "cd \(shellEscape(repoPath)) && codex \(shellEscape(prompt))"
      )
    case .claudeCode:
      return launchCommandFileAgent(
        title: "Opened Claude Code",
        command: "cd \(shellEscape(repoPath)) && claude \(shellEscape(prompt))"
      )
    }
  }

  nonisolated static func focusInstruction(_ userFocus: String?) -> String {
    let focus = (userFocus ?? "")
      .split(whereSeparator: \.isWhitespace)
      .joined(separator: " ")
    guard !focus.isEmpty else {
      return """
        Pick the best candidate from local context.

        Choose exactly one high-signal candidate using metadata-first ranking:
        recency, unread or open-loop signal, two-way message volume, attachments,
        reactions, calls, and deterministic contact/source evidence. Keep the
        search bounded: inspect at most 15 candidate conversations or contacts,
        drill into one, and stop after one representative example.
        """
    }
    return """
      Use this user focus as the constraint: \(focus)

      Treat this focus as the required scope for all evidence selection and
      synthesis. If local Cued data does not support it, say "unsupported by local
      data", give the counts or metadata that prove it, and only then offer the
      nearest supported fallback. Do not broaden silently.
      """
  }

  nonisolated static func prompt(
    for exampleID: AgentExampleID,
    repoPath: String,
    userFocus: String?
  ) -> String {
    agentLaunchPrompt(for: exampleID, repoPath: repoPath, userFocus: userFocus)
  }

  private nonisolated static func status(for target: AgentTarget) -> AgentTargetStatus {
    switch target {
    case .codexApp:
      return codexAppStatus()
    case .codexCLI:
      return codexCLIStatus()
    case .claudeCode:
      return claudeCodeStatus()
    }
  }

  private nonisolated static func codexAppStatus() -> AgentTargetStatus {
    guard codexAppExists() else {
      return AgentTargetStatus(
        readiness: .missing,
        detail: "Codex.app was not found on this Mac.",
        remediation: "Install Codex.app, then reopen this page."
      )
    }

    let cliStatus = codexCLIStatus()
    if cliStatus.readiness == .notLoggedIn {
      return AgentTargetStatus(
        readiness: .notLoggedIn,
        detail: "Codex.app is installed, but Codex auth is not ready.",
        remediation: "Open Codex.app or run `codex login` before launching this example."
      )
    }

    return AgentTargetStatus(
      readiness: .ready,
      detail: cliStatus.readiness == .ready
        ? "Codex.app is installed and Codex auth is ready."
        : "Codex.app is installed. CLI auth preflight is unavailable, so the app may ask you to sign in."
    )
  }

  private nonisolated static func codexCLIStatus() -> AgentTargetStatus {
    let commandPath = commandPath("codex")
    let result = runShell("codex login status")
    let output = "\(result?.stdout ?? "")\n\(result?.stderr ?? "")"
    return codexCLIStatus(commandPath: commandPath, loginStatus: result?.status, output: output)
  }

  nonisolated static func codexCLIStatus(
    commandPath: String?,
    loginStatus: Int32?,
    output: String
  ) -> AgentTargetStatus {
    guard commandPath != nil else {
      return AgentTargetStatus(
        readiness: .missing,
        detail: "`codex` was not found on PATH.",
        remediation: "Install Codex CLI or make sure your shell PATH is available to Cued."
      )
    }

    if loginStatus == 0 && output.localizedCaseInsensitiveContains("logged in") {
      return AgentTargetStatus(readiness: .ready, detail: "Codex CLI is authenticated.")
    }

    return AgentTargetStatus(
      readiness: .notLoggedIn,
      detail: "Codex CLI is installed but not authenticated.",
      remediation: "Run `codex login`, then refresh this page."
    )
  }

  private nonisolated static func claudeCodeStatus() -> AgentTargetStatus {
    let commandPath = commandPath("claude")
    let result = runShell("claude auth status")
    let output = "\(result?.stdout ?? "")\n\(result?.stderr ?? "")"
    return claudeCodeStatus(commandPath: commandPath, authStatus: result?.status, output: output)
  }

  nonisolated static func claudeCodeStatus(
    commandPath: String?,
    authStatus: Int32?,
    output: String
  ) -> AgentTargetStatus {
    guard commandPath != nil else {
      return AgentTargetStatus(
        readiness: .missing,
        detail: "`claude` was not found on PATH.",
        remediation: "Install Claude Code or make sure your shell PATH is available to Cued."
      )
    }

    let lowercasedOutput = output.lowercased()
    let notLoggedIn = lowercasedOutput.contains("not logged")
      || lowercasedOutput.contains("please login")
      || lowercasedOutput.contains("not authenticated")
      || lowercasedOutput.contains("no active session")

    if authStatus == 0 && !notLoggedIn {
      return AgentTargetStatus(readiness: .ready, detail: "Claude Code is authenticated.")
    }

    return AgentTargetStatus(
      readiness: .notLoggedIn,
      detail: "Claude Code is installed but not authenticated.",
      remediation: "Run `claude auth login`, then refresh this page."
    )
  }

  private nonisolated static func codexAppExists() -> Bool {
    if FileManager.default.fileExists(atPath: "/Applications/Codex.app") {
      return true
    }
    if FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/Applications/Codex.app") {
      return true
    }
    return runShell("/usr/bin/mdfind 'kMDItemCFBundleIdentifier == \"\(codexBundleIdentifier)\"'")?
      .stdout
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .isEmpty == false
  }

  private nonisolated static func commandPath(_ command: String) -> String? {
    let result = runShell("command -v \(shellEscape(command))")
    guard result?.status == 0 else {
      return nil
    }
    let path = result?.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return path?.isEmpty == false ? path : nil
  }

  @MainActor
  private static func launchCodexApp(repoPath: String, prompt: String) -> AgentLaunchFeedback {
    var components = URLComponents()
    components.scheme = "codex"
    components.host = "new"
    components.queryItems = [
      URLQueryItem(name: "path", value: repoPath),
      URLQueryItem(name: "prompt", value: prompt),
    ]

    guard let url = components.url else {
      return AgentLaunchFeedback(
        title: "Codex App did not open",
        detail: "Could not build the Codex deep link. The prompt is copied as a fallback.",
        isError: true
      )
    }

    if NSWorkspace.shared.open(url) {
      return AgentLaunchFeedback(
        title: "Opened Codex App",
        detail: "Codex opened a new thread with the example prompt."
      )
    }

    return AgentLaunchFeedback(
      title: "Codex App did not open",
      detail: "The prompt is copied. Open Codex manually and paste it into a new session.",
      isError: true
    )
  }

  @MainActor
  private static func launchCommandFileAgent(
    title: String,
    command: String
  ) -> AgentLaunchFeedback {
    do {
      let scriptURL = try writeCommandFile(command: command)
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      process.arguments = ["-a", "Terminal", scriptURL.path]
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        return AgentLaunchFeedback(
          title: "\(title) failed",
          detail: "Terminal did not open the generated command file. The prompt is copied as a fallback.",
          isError: true
        )
      }
      return AgentLaunchFeedback(
        title: title,
        detail: "Terminal is running the agent in the Cued repo with the example prompt."
      )
    } catch {
      return AgentLaunchFeedback(
        title: "\(title) failed",
        detail: "Could not create the Terminal command file. The prompt is copied as a fallback.",
        isError: true
      )
    }
  }

  private nonisolated static func writeCommandFile(command: String) throws -> URL {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("cued-agent-launches", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let fileURL = directory.appendingPathComponent("cued-agent-\(UUID().uuidString).command")
    let script = """
      #!/bin/zsh
      \(command)
      """
    try script.write(to: fileURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fileURL.path)
    return fileURL
  }

  private nonisolated static func resolveRepoPath() -> String {
    let environment = ProcessInfo.processInfo.environment
    if let configured = trimmedEnvironmentPath(environment, name: "CUED_REPO_PATH"),
       isCuedRepo(configured) {
      return configured
    }

    let home = NSHomeDirectory()
    var candidates = [
      FileManager.default.currentDirectoryPath,
      Bundle.main.bundleURL.path,
      "\(home)/Documents/Development/cued",
      "\(home)/Documents/personal/cued",
    ]
    if let configuredCodexHome = trimmedEnvironmentPath(environment, name: "CODEX_HOME") {
      candidates.append("\(configuredCodexHome)/worktrees")
    }
    candidates.append("\(home)/.codex/worktrees")

    for candidate in candidates {
      if let repoPath = firstCuedRepo(atOrAbove: candidate) {
        return repoPath
      }
      if let repoPath = firstCuedRepoChild(in: candidate) {
        return repoPath
      }
    }

    return FileManager.default.currentDirectoryPath
  }

  private nonisolated static func firstCuedRepo(atOrAbove path: String) -> String? {
    var url = URL(fileURLWithPath: path)
    if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true {
      url.deleteLastPathComponent()
    }

    while url.path != "/" {
      if isCuedRepo(url.path) {
        return url.path
      }
      url.deleteLastPathComponent()
    }
    return nil
  }

  private nonisolated static func firstCuedRepoChild(in path: String) -> String? {
    let url = URL(fileURLWithPath: path)
    guard let children = try? FileManager.default.contentsOfDirectory(
      at: url,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ) else {
      return nil
    }

    for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
      guard (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
        continue
      }
      if isCuedRepo(child.path) {
        return child.path
      }
    }
    return nil
  }

  private nonisolated static func isCuedRepo(_ path: String) -> Bool {
    let fileManager = FileManager.default
    return fileManager.fileExists(atPath: "\(path)/package.json")
      && fileManager.fileExists(atPath: "\(path)/native/macos/CuedNative/Package.swift")
  }

  private nonisolated static func runShell(_ command: String) -> (status: Int32, stdout: String, stderr: String)? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-c", command]
    process.environment = shellEnvironment()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
      try process.run()
      let deadline = Date().addingTimeInterval(2.5)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.03)
      }
      if process.isRunning {
        process.terminate()
        Thread.sleep(forTimeInterval: 0.1)
        if process.isRunning {
          process.interrupt()
        }
        return (124, "", "Timed out running launch readiness command.")
      }
      let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      return (process.terminationStatus, stdout, stderr)
    } catch {
      return nil
    }
  }

  private nonisolated static func shellEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = defaultShellPath(environment["PATH"] ?? "")
    return environment
  }

  nonisolated static func defaultShellPath(_ path: String) -> String {
    let defaults = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "\(NSHomeDirectory())/.local/bin",
      "\(NSHomeDirectory())/.claude/local",
      "\(NSHomeDirectory())/.npm-global/bin",
      "\(NSHomeDirectory())/.nvm/versions/node/v24.4.0/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]
    return ([path] + defaults).filter { !$0.isEmpty }.joined(separator: ":")
  }

}

private func agentLaunchPrompt(
  for exampleID: AgentExampleID,
  repoPath: String,
  userFocus: String?
) -> String {
  let focusInstruction = AgentLaunchService.focusInstruction(userFocus)
  let header = """
    You are operating in the Cued repo at \(repoPath).

    Use Cued's local data through the `cued` CLI. Keep private message contents out
    of fixtures, logs, commits, and broad summaries; synthesize only what the task
    needs. Prefer concrete source types, ids, counts, timestamps, and commands run
    over vague claims. Do not use `sqlite3`; use `cued sql "..."` for read-only
    SQL.

    \(focusInstruction)

    Start read-only:
    - `cued status`
    - `cued doctor`
    - `cued integrations status`
    - `cued logs --tail 200`
    - targeted `cued sql "..."` queries after inspecting the local schema

    Data readiness:
    - If projected data is readable but live source sync or integration health is
      degraded, continue read-only with a freshness caveat. Repair only when the
      needed projected data is unavailable.
    - If Cued is actively syncing or projecting but `cued status` and read-only SQL
      still work, do not repair. Report the projection/search-index backlog and
      continue with a freshness caveat.
    - Do not treat SQLite busy warnings during active projection as a reason to reset
      data. Never run `cued reset --source <source>` without explicit user
      confirmation.
    - Validate recency with both `max(messages.sent_at)` and
      `max(conversations.last_message_at)`. If they disagree materially, report the
      mismatch and avoid claiming full current coverage.

    SQL guardrails:
    - Cued timestamps are Unix epoch milliseconds; use
      `datetime(sent_at/1000,'unixepoch','localtime')`.
    - Start with metadata: ids, timestamps, direction, counts, type, platform,
      unread count, attachment count, reaction count, and source tables.
    - Do not select `messages.content`, `conversations.last_message_preview`,
      participant names, sender names, contact names, phone numbers, emails, or
      handles unless the task cannot be answered from metadata. If content is
      necessary, inspect at most 25 messages from one conversation/topic and return
      only synthesis, never raw bodies.
    - Before FTS, check
      `select count(*) from messages_fts` and
      `select count(*) from message_fts_index_queue`. If FTS is empty or queued,
      fall back to bounded `messages.content like ...` queries and say search
      indexing is not ready. `messages_fts.message_id` joins to `messages.id`.
    """

  switch exampleID {
  case .debugSync:
    return """
      \(header)

      Goal: debug why one Cued source is not producing useful local context.

      Work in this order:
      1. Inspect status, doctor output, recent logs, permissions, integration auth state, and recent sync jobs.
      2. Identify the single weakest source and the evidence for why it is weak.
      3. Try targeted local repair commands such as `cued integrations refresh`, `cued sync run`, or `cued sync resume` only when the evidence points there. Recommend `cued reset --source <source>` only after explicit user confirmation.
      4. Re-run the smallest verification command that proves whether context improved.

      End with: root cause, commands run, what changed, what was verified, and whether code escalation is required.
      """
  case .catchUp:
    return """
      \(header)

      Goal: pull Cued context from threads with the relevant people into a working project spec.

      This is the "Context for a Project" card. Treat the user focus as a mini request like "pull context from threads with X, Y, and Z people and add it to this spec." Use read-only Cued context to find the threads, people, decisions, constraints, and open questions that belong in the spec. If the focus names people, search threads involving those people plus the project/topic; if it names only a project, find the strongest related threads and participants.

      Return:
      - the project/spec boundary you inferred
      - the people and conversations consulted, cited by metadata
      - decisions, constraints, facts, preferences, and open questions to add
      - a drop-in spec section with only synthesized context
      - what is uncertain, missing, stale, or unsupported by local data

      Do not dump private messages. Cite local evidence by source type, conversation id, message id, timestamp, participant role, counts, and confidence.
      If projected data is readable, answer from it with any freshness caveat. Repair only when the needed projected data is unavailable.
      """
  case .followUps:
    return """
      \(header)

      Goal: recover what the user decided about X.

      This is the "Recover Decisions" card. Treat the user focus as the X in "what did I decide about X?" Use read-only Cued context to find decisions, commitments, reversals, settled preferences, unresolved disagreements, and later confirmations related to that topic. Avoid generic summaries and do not produce a broad inbox digest.

      If a user focus is provided, treat it as the decision topic. If no focus is provided, pick one recent topic with clear decision evidence and enough replayable history. Define what counts as a decision before searching: explicit acceptance/rejection, selected option, committed next step, owner/date assignment, repeated later behavior, or a message that resolves prior ambiguity.

      Return:
      - the decision question you answered
      - the recovered decision, current best answer, and confidence
      - a short decision timeline with evidence ids, timestamps, source types, and participant roles
      - contradictions, reversals, and stale assumptions
      - what should be checked before acting on the decision

      Keep this read-only unless a local Cued operational issue blocks the query. If projected data is readable, answer from it with any freshness caveat. Repair only when the needed projected data is unavailable.
      """
  case .prepPerson:
    return """
      \(header)

      Goal: act like a chief of staff over message context.

      This is the "Chief of Staff" card. Use read-only Cued context to tell the user about their day and design Codex automations or hooks that activate when messages arrive. Examples include: morning brief inputs, follow-up queues, meeting prep context, messages that should wake an agent, and hooks that fire when specific people, topics, or urgency signals appear.

      If a user focus is provided, it overrides the most active thread overall. Pick only a day-planning, automation, or hook candidate directly related to the focus. If no focus is provided, choose one repeated workflow with clear evidence and low noise.

      Return:
      - the chief-of-staff job to be done, such as day brief or message hook
      - trigger conditions or schedule, including message events that should activate it
      - context the agent should gather before acting
      - the exact output it should produce, such as a day brief, queue, or hook spec
      - actions that require confirmation, and cases where the agent should stay silent
      - how to measure value and false positives

      Do not send messages, create calendar events, mark work done, or mutate Cued. If projected data is readable, answer from it with any freshness caveat. Repair only when the needed projected data is unavailable.
      """
  case .findWarmIntros:
    return """
      \(header)

      Goal: find intros and relationship context for person Y, especially someone the user just met.

      This is the "Intros / Relationship Context" card. Treat the user focus as the Y in "who should I intro Y to?" Use read-only Cued context to answer who this person should meet, what relationship context matters, and what to remember after meeting them. A filled user focus may name the person, company, topic, or desired intro area.

      If the focus names a person, first identify the likely contact or conversation by deterministic local evidence. Then search for relationship context and possible intro targets using local conversations, contact handles/sources, prior messages, shared topics, and interaction strength. If the identity is ambiguous, say so and do not guess.

      Return:
      - the person/context you matched, with confidence and ambiguity notes
      - candidate intro targets or relationship-context notes
      - why each candidate fits, using metadata and synthesized evidence
      - suggested intro angle or question to ask the user before making the intro
      - people or paths to avoid because evidence is weak, stale, private, or noisy

      Do not send introductions or reveal private message bodies. If projected data is readable, answer from it with any freshness caveat. Repair only when the needed projected data is unavailable.
      """
  }
}
