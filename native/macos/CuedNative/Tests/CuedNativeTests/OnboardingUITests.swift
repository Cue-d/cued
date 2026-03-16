import XCTest
@testable import CuedNative

final class OnboardingUITests: XCTestCase {
  func testPermissionKeyMappingMatchesExpectedFlags() {
    XCTAssertEqual(onboardingPermissionKeys(for: ["--contacts"]), ["contacts"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--full-disk-access"]), ["full_disk_access"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--messages"]), ["messages_automation"])
    XCTAssertEqual(
      onboardingPermissionKeys(for: ["--all"]),
      ["contacts", "full_disk_access", "messages_automation"]
    )
  }

  func testLivePermissionRefreshIsOnlyForcedForMessagesRequests() {
    XCTAssertFalse(onboardingShouldRefreshPermissionsLive(for: ["--contacts"]))
    XCTAssertFalse(onboardingShouldRefreshPermissionsLive(for: ["--full-disk-access"]))
    XCTAssertTrue(onboardingShouldRefreshPermissionsLive(for: ["--messages"]))
    XCTAssertTrue(onboardingShouldRefreshPermissionsLive(for: ["--all"]))
  }
}
