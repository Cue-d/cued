import Foundation

private let permissionRelaunchSetupIntentFilename = "permission-relaunch-setup.intent"
private let daemonEnvironmentFilename = "daemon.env"
private let runtimeConfigFilename = "config.json"
private let daemonEnvironmentAllowlist = Set([
  "CUED_DB_KEY",
  "CUED_GOOGLE_OAUTH_CLIENT_FILE",
  "CUED_BUNDLED_GOOGLE_OAUTH_CLIENT_FILE",
])

struct CuedRuntimeConfig: Decodable {
  let home: String?
  let dbPath: String?
  let repoPath: String?
  let skipAutoPrerequisites: Bool?
}

private struct RuntimeConfigPathSelection {
  let path: String
  let explicit: Bool
}

func trimmedEnvironmentPath(_ environment: [String: String], name: String) -> String? {
  trimmedPath(environment[name])
}

func trimmedPath(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed?.isEmpty == false ? trimmed : nil
}

func hasExplicitCuedConfigArgument(arguments: [String] = CommandLine.arguments) -> Bool {
  arguments.contains("--config") || arguments.contains("--cued-config")
    || arguments.contains { $0.hasPrefix("--config=") || $0.hasPrefix("--cued-config=") }
}

private func runtimeConfigPathSelection(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> RuntimeConfigPathSelection {
  for (index, argument) in arguments.enumerated() {
    if argument == "--config" || argument == "--cued-config" {
      if index + 1 < arguments.count, let value = trimmedPath(arguments[index + 1]) {
        return RuntimeConfigPathSelection(path: value, explicit: true)
      }
    }
    for name in ["--config=", "--cued-config="] {
      if argument.hasPrefix(name), let value = trimmedPath(String(argument.dropFirst(name.count))) {
        return RuntimeConfigPathSelection(path: value, explicit: true)
      }
    }
  }
  return RuntimeConfigPathSelection(path: "\(homeDirectory)/.cued/\(runtimeConfigFilename)", explicit: false)
}

func configuredCuedConfigPath(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  runtimeConfigPathSelection(arguments: arguments, homeDirectory: homeDirectory).path
}

func loadCuedRuntimeConfig(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> CuedRuntimeConfig {
  let selection = runtimeConfigPathSelection(arguments: arguments, homeDirectory: homeDirectory)
  let path = selection.path
  guard FileManager.default.fileExists(atPath: path),
    let data = FileManager.default.contents(atPath: path),
    let config = try? JSONDecoder().decode(CuedRuntimeConfig.self, from: data)
  else {
    if selection.explicit {
      let home = URL(fileURLWithPath: path).deletingLastPathComponent().path
      return CuedRuntimeConfig(home: home, dbPath: nil, repoPath: nil, skipAutoPrerequisites: nil)
    }
    return CuedRuntimeConfig(home: nil, dbPath: nil, repoPath: nil, skipAutoPrerequisites: nil)
  }
  return config
}

func configuredCuedHomePath(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  let config = loadCuedRuntimeConfig(arguments: arguments, homeDirectory: homeDirectory)
  if let cuedHome = trimmedPath(config.home) {
    return cuedHome
  }
  if let dbPath = trimmedPath(config.dbPath) {
    return URL(fileURLWithPath: dbPath).deletingLastPathComponent().path
  }
  return "\(homeDirectory)/.cued"
}

func configuredCuedDBPath(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  let config = loadCuedRuntimeConfig(arguments: arguments, homeDirectory: homeDirectory)
  return trimmedPath(config.dbPath)
    ?? "\(configuredCuedHomePath(arguments: arguments, homeDirectory: homeDirectory))/local.db"
}

func configuredDaemonEnvironmentPath(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  "\(configuredCuedHomePath(arguments: arguments, homeDirectory: homeDirectory))/\(daemonEnvironmentFilename)"
}

func loadConfiguredDaemonEnvironment(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> [String: String] {
  let path = configuredDaemonEnvironmentPath(arguments: arguments, homeDirectory: homeDirectory)
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
    if daemonEnvironmentAllowlist.contains(key) {
      values[key] = value
    }
  }
  return values
}

func permissionRelaunchSetupIntentPath(
  arguments: [String] = CommandLine.arguments,
  homeDirectory: String = NSHomeDirectory()
) -> String {
  "\(configuredCuedHomePath(arguments: arguments, homeDirectory: homeDirectory))/\(permissionRelaunchSetupIntentFilename)"
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
