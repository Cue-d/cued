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
  static func launch(exampleID: AgentExampleID, target: AgentTarget) -> AgentLaunchFeedback {
    let status = status(for: target)
    guard status.readiness == .ready else {
      return AgentLaunchFeedback(
        title: "\(target.title) is not ready",
        detail: status.remediation ?? status.detail,
        isError: true
      )
    }

    let repoPath = resolveRepoPath()
    let prompt = prompt(for: exampleID, repoPath: repoPath)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(prompt, forType: .string)

    switch target {
    case .codexApp:
      return launchCodexApp(repoPath: repoPath)
    case .codexCLI:
      return launchTerminalAgent(
        title: "Opened Codex CLI",
        command: "cd \(shellEscape(repoPath)) && codex \(shellEscape(prompt))"
      )
    case .claudeCode:
      return launchTerminalAgent(
        title: "Opened Claude Code",
        command: "cd \(shellEscape(repoPath)) && claude \(shellEscape(prompt))"
      )
    }
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
  private static func launchCodexApp(repoPath: String) -> AgentLaunchFeedback {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-b", codexBundleIdentifier, repoPath]
    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        return AgentLaunchFeedback(
          title: "Codex App did not open",
          detail: "The prompt is copied. Open Codex manually and paste it into a new session.",
          isError: true
        )
      }
      return AgentLaunchFeedback(
        title: "Opened Codex App",
        detail: "The example prompt is copied. Paste it if Codex does not focus the composer automatically."
      )
    } catch {
      return AgentLaunchFeedback(
        title: "Codex App did not open",
        detail: "Open Codex manually and paste the copied prompt.",
        isError: true
      )
    }
  }

  @MainActor
  private static func launchTerminalAgent(
    title: String,
    command: String
  ) -> AgentLaunchFeedback {
    let script = """
      tell application "Terminal"
        activate
        do script \(appleScriptString(command))
      end tell
      """

    guard let appleScript = NSAppleScript(source: script) else {
      return AgentLaunchFeedback(
        title: "\(title) failed",
        detail: "Could not build the Terminal automation script.",
        isError: true
      )
    }

    var error: NSDictionary?
    appleScript.executeAndReturnError(&error)
    if let message = error?[NSAppleScript.errorMessage] as? String {
      return AgentLaunchFeedback(
        title: "Terminal automation permission needed",
        detail: "\(message). Allow Cued to control Terminal in Privacy & Security > Automation. The prompt is copied as a fallback.",
        isError: true
      )
    }

    return AgentLaunchFeedback(
      title: title,
      detail: "Terminal is running the agent in the Cued repo with the example prompt."
    )
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
    process.arguments = ["-lc", command]
    process.environment = shellEnvironment()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
      try process.run()
      process.waitUntilExit()
      let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      return (process.terminationStatus, stdout, stderr)
    } catch {
      return nil
    }
  }

  private nonisolated static func shellEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let path = environment["PATH"] ?? ""
    let defaults = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "\(NSHomeDirectory())/.nvm/versions/node/v24.4.0/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]
    environment["PATH"] = ([path] + defaults).filter { !$0.isEmpty }.joined(separator: ":")
    return environment
  }

  private nonisolated static func appleScriptString(_ value: String) -> String {
    "\"\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
  }
}

private func prompt(for exampleID: AgentExampleID, repoPath: String) -> String {
  let header = """
    You are operating in the Cued repo at \(repoPath).

    Treat Cued as an on-device self-repair system, not an auto PR generator. Use local state first: daemon status, doctor output, logs, permissions, integration state, ~/.cued/local.db, sync/rebuild/reset flows, and the cued CLI.

    Repair ladder:
    Level 0: observe
    Level 1: local CLI repair
    Level 2: verify
    Level 3: code escalation
    Level 4: branch repair

    Record a short repair timeline as you work. Only inspect or edit source code if local repair fails or proves a code defect. If escalation is required, carry evidence: repro command, doctor/log excerpts, bad state, expected vs actual, and suggested tests.
    """

  switch exampleID {
  case .repairCued:
    return """
      \(header)

      Goal: investigate and repair the current Cued installation locally.

      Start with:
      - cued status
      - cued doctor
      - cued logs
      - inspect ~/.cued/local.db read-only if the failure points at stored state

      Try operational repair before code:
      - cued integrations refresh
      - cued sync run
      - cued sync resume
      - cued rebuild
      - cued skill install-global

      Verify the issue is gone before calling the task complete.
      """
  case .debugSync:
    return """
      \(header)

      Goal: debug why one Cued source is not producing useful local context.

      Start with status, doctor, recent logs, permissions, integration auth state, and recent sync jobs. Prefer targeted local repair commands such as `cued integrations refresh`, `cued sync run`, `cued sync resume`, or `cued reset --source <source>` only when the evidence points there.

      End with what changed, what was verified, and whether code escalation is required.
      """
  case .catchUp:
    return """
      \(header)

      Goal: prove where local context changes the answer.

      Use Cued read-only context to pick one recent question, thread, or relationship where a generic model would miss important context. Compare:
      - what an agent would say with no local history
      - what changes after reading relevant Cued messages, contacts, calls, and source metadata
      - what action becomes possible because of the context

      Return a compact before/after analysis with citations to local source types, not private message dumps. End with the smallest product improvement that would make this context easier for future agents to use. If Cued itself is unhealthy, repair the local runtime first using the ladder above.
      """
  case .followUps:
    return """
      \(header)

      Goal: find a real workflow where Cued turns messages into useful work.

      Search recent local context for a concrete workflow: follow-up drafting, meeting prep, recruiting, sales/customer development, school/project coordination, or another repeated task visible in the data. Avoid generic summaries.

      Return:
      - the workflow you found
      - the local evidence that makes it real
      - the exact output an agent should produce
      - how to measure whether it created value

      Keep this read-only unless a local Cued operational issue blocks the query. If Cued itself is unhealthy, repair the local runtime first using the ladder above.
      """
  case .prepPerson:
    return """
      \(header)

      Goal: turn repeated local context into accumulated understanding.

      Pick a person, project, or recurring topic from local Cued context. Build a durable brief that would still be useful next week: stable facts, open loops, preferences, unresolved questions, recent changes, and what an agent should remember before acting.

      Explain which parts came from replayable history versus one-off recent messages. Do not dump private messages; synthesize. Keep the work local and read-only unless Cued needs operational repair first.
      """
  case .findWarmIntros:
    return """
      \(header)

      Goal: design explicit intent and triggers for an always-on Cued agent.

      Use local context to identify where a background agent would create value and where it would be noisy. Pick one candidate workflow and define:
      - the user intent it serves
      - the trigger conditions that should wake the agent up
      - the context it needs before acting
      - the action it may take
      - the cases where it should stay silent or ask first

      Return a small trigger spec that could be implemented or evaluated. Keep the work read-only unless Cued needs operational repair first.
      """
  }
}
