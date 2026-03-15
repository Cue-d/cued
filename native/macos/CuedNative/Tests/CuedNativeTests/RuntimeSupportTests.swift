import XCTest
@testable import CuedNative

final class RuntimeSupportTests: XCTestCase {
  func testConfiguredCuedHomePathPrefersExplicitHome() {
    let homePath = configuredCuedHomePath(
      environment: [
        "CUED_HOME": " /tmp/cued-home ",
        "CUED_DB_PATH": "/tmp/ignored/local.db",
      ],
      homeDirectory: "/Users/test"
    )

    XCTAssertEqual(homePath, "/tmp/cued-home")
  }

  func testConfiguredCuedDBPathFallsBackFromDBPathOrHomeDirectory() {
    XCTAssertEqual(
      configuredCuedDBPath(
        environment: ["CUED_DB_PATH": " /tmp/cued/local.db "],
        homeDirectory: "/Users/test"
      ),
      "/tmp/cued/local.db"
    )

    XCTAssertEqual(
      configuredCuedDBPath(environment: [:], homeDirectory: "/Users/test"),
      "/Users/test/.cued/local.db"
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
