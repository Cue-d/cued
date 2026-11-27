import Foundation
import XCTest
@testable import Interface

final class SignInBrowserStatusTests: XCTestCase {
  func testDecodesTheDaemonSnapshotField() throws {
    // Shape of `signInBrowser` in the daemon's onboarding snapshot, extra fields included.
    let json = """
      {"sessionId":"s1","platform":"linkedin","accountKey":"default","updatedAt":1,
       "stage":"downloading","receivedBytes":44040192,"totalBytes":157286400,"error":null}
      """
    let status = try JSONDecoder().decode(SignInBrowserStatus.self, from: Data(json.utf8))

    XCTAssertEqual(status.platform, "linkedin")
    XCTAssertEqual(status.message, "Downloading sign-in browser, 42 of 150 MB")
    XCTAssertEqual(try XCTUnwrap(status.fractionComplete), 0.28, accuracy: 0.001)
    XCTAssertFalse(status.isFailed)
  }

  func testStagesWithoutASizeAreIndeterminate() {
    let unknownSize = SignInBrowserStatus(
      platform: "slack",
      accountKey: "a",
      stage: "downloading",
      receivedBytes: 3 * 1024 * 1024
    )
    XCTAssertNil(unknownSize.fractionComplete)
    XCTAssertEqual(unknownSize.message, "Downloading sign-in browser, 3 MB")

    let verifying = SignInBrowserStatus(platform: "slack", accountKey: "a", stage: "verifying")
    XCTAssertNil(verifying.fractionComplete)
    XCTAssertEqual(verifying.message, "Checking the downloaded sign-in browser")
  }

  func testFailureShowsTheDaemonsReason() {
    let failed = SignInBrowserStatus(
      platform: "discord",
      accountKey: "default",
      stage: "failed",
      error: "The sign-in browser could not be downloaded (HTTP 503)."
    )
    XCTAssertTrue(failed.isFailed)
    XCTAssertEqual(failed.message, "The sign-in browser could not be downloaded (HTTP 503).")
    XCTAssertTrue(
      SignInBrowserStatus(platform: "discord", accountKey: "default", stage: "failed").message
        .contains("could not be set up")
    )
  }

  @MainActor
  func testSnapshotStateReachesTheViewModel() {
    let viewModel = RootViewModel()
    let status = SignInBrowserStatus(platform: "linkedin", accountKey: "default", stage: "launching")
    viewModel.apply(
      permissions: [],
      globalSkill: defaultSkillStatus(),
      relationshipSummary: RelationshipSummary(),
      allIntegrations: [],
      integrations: [],
      signInBrowser: status
    )
    XCTAssertEqual(viewModel.signInBrowser, status)

    viewModel.apply(
      permissions: [],
      globalSkill: defaultSkillStatus(),
      relationshipSummary: RelationshipSummary(),
      allIntegrations: [],
      integrations: []
    )
    XCTAssertNil(viewModel.signInBrowser)
  }
}
