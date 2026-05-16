import XCTest
@testable import CuedNative
@testable import CuedNativeUI

final class OnboardingUITests: XCTestCase {
  func testPermissionKeyMappingMatchesExpectedFlags() {
    XCTAssertEqual(onboardingPermissionKeys(for: ["--contacts"]), ["contacts"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--full-disk-access"]), ["full_disk_access"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--messages"]), ["messages_automation"])
    XCTAssertEqual(
      onboardingPermissionKeys(for: ["--all"]),
      ["contacts", "full_disk_access"]
    )
  }

  func testPermissionRefreshRetryIsScheduledForLiveVerifiableRequests() {
    XCTAssertFalse(onboardingShouldRetryPermissionRefresh(for: ["--contacts"]))
    XCTAssertTrue(onboardingShouldRetryPermissionRefresh(for: ["--full-disk-access"]))
    XCTAssertTrue(onboardingShouldRetryPermissionRefresh(for: ["--messages"]))
    XCTAssertTrue(onboardingShouldRetryPermissionRefresh(for: ["--all"]))
  }

  func testActivePermissionRefreshIsForcedForLiveVerifiableRequests() {
    XCTAssertFalse(onboardingShouldRefreshPermissionsActively(for: ["--contacts"]))
    XCTAssertTrue(onboardingShouldRefreshPermissionsActively(for: ["--full-disk-access"]))
    XCTAssertTrue(onboardingShouldRefreshPermissionsActively(for: ["--messages"]))
    XCTAssertTrue(onboardingShouldRefreshPermissionsActively(for: ["--all"]))
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

  func testPermissionGuideInstructionCopyMatchesPanelBehavior() {
    XCTAssertEqual(
      onboardingPermissionGuideInstructionSentence(for: .fullDiskAccess, hostAppName: "Cued"),
      "Drag Cued to the list above to allow Full Disk Access."
    )
    XCTAssertEqual(
      onboardingPermissionGuideInstructionSentence(for: .contacts, hostAppName: "Cued"),
      "Enable Cued in the list above to allow Contacts."
    )
    XCTAssertEqual(
      onboardingPermissionGuideInstructionSentence(for: .messagesAutomation, hostAppName: "Cued"),
      "Enable Cued in the list above to allow Messages automation."
    )
  }

  func testPermissionGuideStaysVisibleAcrossRefreshUntilPermissionIsGranted() {
    XCTAssertFalse(
      onboardingShouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: [
          InstallerPermissionStatus(
            key: "full_disk_access",
            status: "unknown",
            summary: "Waiting",
            requestFlags: ["--full-disk-access"]
          )
        ]
      )
    )

    XCTAssertTrue(
      onboardingShouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: [
          InstallerPermissionStatus(
            key: "full_disk_access",
            status: "granted",
            summary: "Granted",
            requestFlags: ["--full-disk-access"]
          )
        ]
      )
    )

    XCTAssertTrue(
      onboardingShouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: []
      )
    )
  }

  func testPermissionGuideFrameComparisonDetectsResizeWithoutMovement() {
    XCTAssertTrue(
      onboardingPermissionGuideFrameIsApproximatelyEqual(
        CGRect(x: 120, y: 80, width: 420, height: 126),
        CGRect(x: 120.4, y: 80.4, width: 420.3, height: 126.2)
      )
    )

    XCTAssertFalse(
      onboardingPermissionGuideFrameIsApproximatelyEqual(
        CGRect(x: 120, y: 80, width: 420, height: 126),
        CGRect(x: 120, y: 80, width: 470, height: 126)
      )
    )
  }
}
