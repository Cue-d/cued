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

  func testPermissionGuideURLsMatchExpectedSystemSettingsPanes() {
    XCTAssertEqual(
      onboardingPermissionGuideURL(for: "contacts"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
    )
    XCTAssertEqual(
      onboardingPermissionGuideURL(for: "full_disk_access"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    )
    XCTAssertEqual(
      onboardingPermissionGuideURL(for: "messages_automation"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    )
    XCTAssertNil(onboardingPermissionGuideURL(for: "missing"))
  }

  func testOnlyFullDiskAccessUsesDragGuide() {
    XCTAssertFalse(onboardingPermissionGuideUsesDragSource(for: "contacts"))
    XCTAssertTrue(onboardingPermissionGuideUsesDragSource(for: "full_disk_access"))
    XCTAssertFalse(onboardingPermissionGuideUsesDragSource(for: "messages_automation"))
  }
}
