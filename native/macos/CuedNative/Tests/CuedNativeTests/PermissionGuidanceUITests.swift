import XCTest
@testable import CuedNativeUI

final class PermissionGuidanceUITests: XCTestCase {
  func testPermissionActionRequestsPromptWhileStatusIsUnknown() {
    let permission = InstallerPermissionStatus(
      key: "contacts",
      status: "unknown",
      summary: "Contacts access has not been checked yet.",
      requestFlags: ["--contacts"]
    )

    XCTAssertEqual(
      installerPermissionActionKind(
        for: permission,
        descriptor: installerPermissionDescriptor(for: permission.key)
      ),
      .requestPrompt
    )
  }

  func testPermissionActionFallsBackToGuideAfterPromptNeedsAttention() {
    let permission = InstallerPermissionStatus(
      key: "contacts",
      status: "needs_action",
      summary: "Contacts access needs attention.",
      requestFlags: ["--contacts"]
    )

    XCTAssertEqual(
      installerPermissionActionKind(
        for: permission,
        descriptor: installerPermissionDescriptor(for: permission.key)
      ),
      .guideInSettings
    )
  }

  func testPermissionActionGuidesManualPermissions() {
    let permission = InstallerPermissionStatus(
      key: "full_disk_access",
      status: "needs_action",
      summary: "Full Disk Access is required.",
      requestFlags: ["--full-disk-access"]
    )

    XCTAssertEqual(
      installerPermissionActionKind(
        for: permission,
        descriptor: installerPermissionDescriptor(for: permission.key)
      ),
      .guideInSettings
    )
  }
}
