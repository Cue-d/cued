import Foundation

private let permissionRelaunchSetupIntentFilename = "permission-relaunch-setup.intent"
private let daemonEnvironmentFilename = "daemon.env"

func trimmedEnvironmentPath(_ environment: [String: String], name: String) -> String? {
  let value = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines)
  return value?.isEmpty == false ? value : nil
}

func configuredCuedHomePath(
  environment: [String: String],
  homeDirectory: String = NSHomeDirectory()
) -> String {
  if let cuedHome = trimmedEnvironmentPath(environment, name: "CUED_HOME") {
    return cuedHome
  }
  if let dbPath = trimmedEnvironmentPath(environment, name: "CUED_DB_PATH") {
    return URL(fileURLWithPath: dbPath).deletingLastPathComponent().path
  }
  return "\(homeDirectory)/.cued"
}

func configuredCuedDBPath(
  environment: [String: String],
  homeDirectory: String = NSHomeDirectory()
) -> String {
  trimmedEnvironmentPath(environment, name: "CUED_DB_PATH")
    ?? "\(configuredCuedHomePath(environment: environment, homeDirectory: homeDirectory))/local.db"
}

func configuredDaemonEnvironmentPath(
  environment: [String: String] = ProcessInfo.processInfo.environment,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  "\(configuredCuedHomePath(environment: environment, homeDirectory: homeDirectory))/\(daemonEnvironmentFilename)"
}

func loadConfiguredDaemonEnvironment(
  environment: [String: String] = ProcessInfo.processInfo.environment,
  homeDirectory: String = NSHomeDirectory()
) -> [String: String] {
  let path = configuredDaemonEnvironmentPath(environment: environment, homeDirectory: homeDirectory)
  guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
    return [:]
  }

  var values: [String: String] = [:]
  for rawLine in contents.components(separatedBy: .newlines) {
    let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty || line.hasPrefix("#") {
      continue
    }
    let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else {
      continue
    }
    let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
    let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
    if key.hasPrefix("CUED_"), key.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) {
      values[key] = value
    }
  }
  return values
}

func permissionRelaunchSetupIntentPath(
  environment: [String: String] = ProcessInfo.processInfo.environment,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  "\(configuredCuedHomePath(environment: environment, homeDirectory: homeDirectory))/\(permissionRelaunchSetupIntentFilename)"
}

func markPermissionRelaunchSetupIntent() {
  let path = permissionRelaunchSetupIntentPath()
  let directoryURL = URL(fileURLWithPath: path).deletingLastPathComponent()
  do {
    try FileManager.default.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try "1\n".write(toFile: path, atomically: true, encoding: .utf8)
  } catch {
    // Best effort only. Losing this marker should not block the permission flow.
  }
}

func consumePermissionRelaunchSetupIntent() -> Bool {
  let path = permissionRelaunchSetupIntentPath()
  guard FileManager.default.fileExists(atPath: path) else {
    return false
  }
  try? FileManager.default.removeItem(atPath: path)
  return true
}

func shellEscape(_ value: String) -> String {
  "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
}

func buildShellCommand(_ command: String, environment: [String: String]) -> String {
  let exports = environment
    .sorted { $0.key < $1.key }
    .map { "export \($0.key)=\(shellEscape($0.value))" }
    .joined(separator: "; ")
  return exports.isEmpty ? command : "\(exports); \(command)"
}

func decodeCLIJSON<T: Decodable>(_ type: T.Type, status: Int32, stdout: String) -> T? {
  guard status == 0, let data = stdout.data(using: .utf8) else {
    return nil
  }
  return try? JSONDecoder().decode(type, from: data)
}
