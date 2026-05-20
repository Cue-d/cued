import XCTest
@testable import CuedNative
@testable import Interface

final class RootViewTests: XCTestCase {
  func testPermissionKeyMappingMatchesExpectedFlags() {
    XCTAssertEqual(permissionKeys(for: ["--contacts"]), ["contacts"])
    XCTAssertEqual(permissionKeys(for: ["--full-disk-access"]), ["full_disk_access"])
    XCTAssertEqual(permissionKeys(for: ["--messages"]), ["messages_automation"])
    XCTAssertEqual(
      permissionKeys(for: ["--all"]),
      ["contacts", "full_disk_access"]
    )
  }

  func testActivePermissionRefreshIsForcedForLiveVerifiableRequests() {
    XCTAssertFalse(shouldActivelyRefreshPermissions(for: ["--contacts"]))
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--full-disk-access"]))
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--messages"]))
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--all"]))
  }

  func testPermissionGuideURLsMatchExpectedSystemSettingsPanes() {
    XCTAssertEqual(
      permissionGuideURL(for: "contacts"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
    )
    XCTAssertEqual(
      permissionGuideURL(for: "full_disk_access"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    )
    XCTAssertEqual(
      permissionGuideURL(for: "messages_automation"),
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    )
    XCTAssertNil(permissionGuideURL(for: "missing"))
  }

  func testOnlyFullDiskAccessUsesDragGuide() {
    XCTAssertFalse(permissionGuideUsesDragSource(for: "contacts"))
    XCTAssertTrue(permissionGuideUsesDragSource(for: "full_disk_access"))
    XCTAssertFalse(permissionGuideUsesDragSource(for: "messages_automation"))
  }

  func testPermissionGuideInstructionCopyMatchesPanelBehavior() {
    XCTAssertEqual(
      permissionGuideInstructionSentence(for: .fullDiskAccess, hostAppName: "Cued"),
      "Drag Cued to the list above to allow Full Disk Access."
    )
    XCTAssertEqual(
      permissionGuideInstructionSentence(for: .contacts, hostAppName: "Cued"),
      "Enable Cued in the list above to allow Contacts."
    )
    XCTAssertEqual(
      permissionGuideInstructionSentence(for: .messagesAutomation, hostAppName: "Cued"),
      "Enable Cued in the list above to allow Messages automation."
    )
  }

  func testPermissionGuideStaysVisibleAcrossRefreshUntilPermissionIsGranted() {
    XCTAssertFalse(
      shouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: [
          PermissionStatus(
            key: "full_disk_access",
            status: "unknown",
            summary: "Waiting",
            requestFlags: ["--full-disk-access"]
          )
        ]
      )
    )

    XCTAssertTrue(
      shouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: [
          PermissionStatus(
            key: "full_disk_access",
            status: "granted",
            summary: "Granted",
            requestFlags: ["--full-disk-access"]
          )
        ]
      )
    )

    XCTAssertTrue(
      shouldDismissPermissionGuide(
        activePermissionKey: "full_disk_access",
        permissions: []
      )
    )
  }

  func testPermissionGuideFrameComparisonDetectsResizeWithoutMovement() {
    XCTAssertTrue(
      permissionGuideFrameIsApproximatelyEqual(
        CGRect(x: 120, y: 80, width: 420, height: 126),
        CGRect(x: 120.4, y: 80.4, width: 420.3, height: 126.2)
      )
    )

    XCTAssertFalse(
      permissionGuideFrameIsApproximatelyEqual(
        CGRect(x: 120, y: 80, width: 420, height: 126),
        CGRect(x: 120, y: 80, width: 470, height: 126)
      )
    )
  }
}
