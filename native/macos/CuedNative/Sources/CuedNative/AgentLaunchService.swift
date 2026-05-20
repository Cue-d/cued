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
        command: "cd \(shellEscape(repoPath)) && codex",
        pasteDelay: 1.8
      )
    case .claudeCode:
      return launchTerminalAgent(
        title: "Opened Claude Code",
        command: "cd \(shellEscape(repoPath)) && claude",
        pasteDelay: 2.2
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
    command: String,
    pasteDelay: Double
  ) -> AgentLaunchFeedback {
    let script = """
      tell application "Terminal"
        activate
        do script \(appleScriptString(command))
      end tell
      delay \(pasteDelay)
      tell application "System Events"
        keystroke "v" using command down
        delay 0.2
        key code 36
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
        title: "Terminal automation needs attention",
        detail: "\(message). The prompt is copied, so you can paste it manually.",
        isError: true
      )
    }

    return AgentLaunchFeedback(
      title: title,
      detail: "Terminal is running the agent in the Cued repo with the copied example prompt."
    )
  }

  private nonisolated static func resolveRepoPath() -> String {
    let environment = ProcessInfo.processInfo.environment
    if let configured = trimmedEnvironmentPath(environment, name: "CUED_REPO_PATH"),
       isCuedRepo(configured) {
      return configured
    }

    var candidates = [FileManager.default.currentDirectoryPath]
    candidates.append(Bundle.main.bundleURL.path)
    candidates.append("\(NSHomeDirectory())/Documents/personal/cued")

    for candidate in candidates {
      if let repoPath = firstCuedRepo(atOrAbove: candidate) {
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

      Goal: catch me up on what changed recently across my local Cued sources.

      Use Cued read-only context to identify messages, conversations, and people that likely need attention. Prioritize concrete open loops: unanswered asks, time-sensitive messages, relationship follow-ups, and context I should know before replying.

      Return a compact list grouped by person or thread. For each item include why it matters, the source channel, the last relevant context, and a suggested reply or next action. If Cued itself is unhealthy, repair the local runtime first using the ladder above.
      """
  case .followUps:
    return """
      \(header)

      Goal: use local Cued context to find stale or unanswered conversations and draft a compact follow-up list.

      Keep this read-only unless a local Cued operational issue blocks the query. If Cued itself is unhealthy, repair the local runtime first using the ladder above, then return the follow-up candidates with source context and suggested next action.
      """
  case .prepPerson:
    return """
      \(header)

      Goal: prepare a compact brief for a person using local Cued context.

      If the person is ambiguous, ask for the person or infer likely matches from local contacts. Summarize recent context, open loops, relevant source channels, and a practical next reply or meeting prep note. Keep the work local and read-only unless Cued needs operational repair first.
      """
  case .findWarmIntros:
    return """
      \(header)

      Goal: find the strongest warm intro paths from my local Cued context.

      Ask for the company, role, person, or topic if it is not already clear. Search local contacts and conversation history for people connected to that target or adjacent context. Rank paths by relationship strength, recency, and evidence from prior messages.

      Return the best intro paths with why each person is relevant, the confidence level, and a short draft ask. Keep the work read-only unless Cued needs operational repair first.
      """
  }
}
