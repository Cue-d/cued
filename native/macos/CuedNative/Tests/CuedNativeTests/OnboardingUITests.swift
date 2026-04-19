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
}
