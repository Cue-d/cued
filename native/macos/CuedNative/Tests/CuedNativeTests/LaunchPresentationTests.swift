import XCTest
@testable import CuedNative

final class LaunchPresentationTests: XCTestCase {
  func testIncompleteOnboardingShowsFirstOnboardingPage() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: nil,
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false
      ),
      .onboarding(forceActivePermissionRefresh: false, resetToFirstPage: true)
    )

    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.35",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false
      ),
      .onboarding(forceActivePermissionRefresh: false, resetToFirstPage: true)
    )
  }

  func testCompletedOnboardingDoesNotOverrideNormalOpenBehavior() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.36",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false
      ),
      .none
    )
  }

  func testPermissionRelaunchIntentForcesActivePermissionRefresh() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.36",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: true
      ),
      .onboarding(forceActivePermissionRefresh: true, resetToFirstPage: true)
    )
  }
}
