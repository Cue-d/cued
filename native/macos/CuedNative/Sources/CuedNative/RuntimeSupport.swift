import Foundation

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
