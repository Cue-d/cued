import XCTest
@testable import CuedNative

final class RuntimeSupportTests: XCTestCase {
  private var tempURLs: [URL] = []

  override func tearDown() {
    for url in tempURLs {
      try? FileManager.default.removeItem(at: url)
    }
    tempURLs.removeAll()
    super.tearDown()
  }

  private func writeConfig(_ json: String) throws -> String {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("cued-runtime-config-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    tempURLs.append(directory)
    let path = directory.appendingPathComponent("config.json")
    try json.write(to: path, atomically: true, encoding: .utf8)
    return path.path
  }

  func testConfiguredCuedHomePathPrefersExplicitHome() throws {
    let configPath = try writeConfig(#"{"home":" /tmp/cued-home ","dbPath":"/tmp/ignored/local.db"}"#)
    let homePath = configuredCuedHomePath(
      arguments: ["Cued", "--config", configPath],
      homeDirectory: "/Users/test"
    )

    XCTAssertEqual(homePath, "/tmp/cued-home")
  }

  func testConfiguredCuedDBPathFallsBackFromDBPathOrHomeDirectory() throws {
    let configPath = try writeConfig(#"{"dbPath":" /tmp/cued/local.db "}"#)
    XCTAssertEqual(
      configuredCuedDBPath(
        arguments: ["Cued", "--config", configPath],
        homeDirectory: "/Users/test"
      ),
      "/tmp/cued/local.db"
    )

    XCTAssertEqual(
      configuredCuedDBPath(arguments: ["Cued"], homeDirectory: "/Users/test"),
      "/Users/test/.cued/local.db"
    )
  }

  func testExplicitMissingConfigDoesNotFallBackToRealHome() throws {
    let missingPath = FileManager.default.temporaryDirectory
      .appendingPathComponent("missing-cued-config-\(UUID().uuidString)")
      .appendingPathComponent("config.json")
      .path

    XCTAssertEqual(
      configuredCuedHomePath(
        arguments: ["Cued", "--config", missingPath],
        homeDirectory: "/Users/test"
      ),
      URL(fileURLWithPath: missingPath).deletingLastPathComponent().path
    )
    XCTAssertEqual(
      configuredCuedDBPath(
        arguments: ["Cued", "--config", missingPath],
        homeDirectory: "/Users/test"
      ),
      "\(URL(fileURLWithPath: missingPath).deletingLastPathComponent().path)/local.db"
    )
  }

  func testPermissionRelaunchSetupIntentPathUsesConfiguredCuedHome() throws {
    let homeConfigPath = try writeConfig(#"{"home":" /tmp/cued-home "}"#)
    XCTAssertEqual(
      permissionRelaunchSetupIntentPath(
        arguments: ["Cued", "--config", homeConfigPath],
        homeDirectory: "/Users/test"
      ),
      "/tmp/cued-home/permission-relaunch-setup.intent"
    )

    let dbConfigPath = try writeConfig(#"{"dbPath":" /tmp/cued/local.db "}"#)
    XCTAssertEqual(
      permissionRelaunchSetupIntentPath(
        arguments: ["Cued", "--config", dbConfigPath],
        homeDirectory: "/Users/test"
      ),
      "/tmp/cued/permission-relaunch-setup.intent"
    )
  }

  func testDaemonEnvironmentOnlyLoadsCredentialAllowlist() throws {
    let homeURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("cued-daemon-env-\(UUID().uuidString)", isDirectory: true)
    tempURLs.append(homeURL)
    let configPath = try writeConfig(#"{"home":"\#(homeURL.path)"}"#)
    let daemonEnvPath = homeURL.appendingPathComponent("daemon.env")
    try FileManager.default.createDirectory(
      at: daemonEnvPath.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try """
      CUED_DB_KEY=secret
      CUED_PROJECTION_BATCH_SIZE=1000
      CUED_GOOGLE_OAUTH_CLIENT_FILE=/tmp/google.json
      """.write(to: daemonEnvPath, atomically: true, encoding: .utf8)

    XCTAssertEqual(
      loadConfiguredDaemonEnvironment(arguments: ["Cued", "--config", configPath]),
      [
        "CUED_DB_KEY": "secret",
        "CUED_GOOGLE_OAUTH_CLIENT_FILE": "/tmp/google.json",
      ]
    )
  }

  func testBuildShellCommandEscapesValuesAndSortsExports() {
    let command = buildShellCommand(
      "cued setup",
      environment: [
        "B_KEY": "two words",
        "A_KEY": "O'Brien",
      ]
    )

    XCTAssertEqual(
      command,
      "export A_KEY='O'\"'\"'Brien'; export B_KEY='two words'; cued setup"
    )
  }

  func testDecodeCLIJSONRejectsBadStatusAndInvalidPayload() {
    struct Sample: Decodable, Equatable {
      let ok: Bool
    }

    XCTAssertEqual(
      decodeCLIJSON(Sample.self, status: 0, stdout: #"{"ok":true}"#),
      Sample(ok: true)
    )
    XCTAssertNil(decodeCLIJSON(Sample.self, status: 1, stdout: #"{"ok":true}"#))
    XCTAssertNil(decodeCLIJSON(Sample.self, status: 0, stdout: "{"))
  }
}
