import XCTest
@testable import CuedNative

final class LaunchPresentationTests: XCTestCase {
  func testIncompleteOnboardingShowsFirstOnboardingPage() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: nil,
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false,
        savedOnboardingPage: 3,
        permissionsPage: 1
      ),
      .onboarding(forceActivePermissionRefresh: false, initialPage: 3)
    )

    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.35",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false,
        savedOnboardingPage: 2,
        permissionsPage: 1
      ),
      .onboarding(forceActivePermissionRefresh: false, initialPage: 2)
    )
  }

  func testCompletedOnboardingDoesNotOverrideNormalOpenBehavior() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.36",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: false,
        savedOnboardingPage: 4,
        permissionsPage: 1
      ),
      .none
    )
  }

  func testPermissionRelaunchIntentForcesActivePermissionRefresh() {
    XCTAssertEqual(
      launchPresentationForCuedOpen(
        onboardingCompletedVersion: "0.1.36",
        currentVersion: "0.1.36",
        hasPermissionRelaunchSetupIntent: true,
        savedOnboardingPage: 4,
        permissionsPage: 1
      ),
      .onboarding(forceActivePermissionRefresh: true, initialPage: 1)
    )
  }
}
