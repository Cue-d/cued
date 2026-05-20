import XCTest
@testable import Interface

final class PermissionGuidanceTests: XCTestCase {
  func testPermissionActionRequestsPromptWhileStatusIsUnknown() {
    let permission = PermissionStatus(
      key: "contacts",
      status: "unknown",
      summary: "Contacts access has not been checked yet.",
      requestFlags: ["--contacts"]
    )

    XCTAssertEqual(
      permissionAction(
        for: permission,
        descriptor: permissionDescriptor(for: permission.key)
      ),
      .requestPrompt
    )
  }

  func testPermissionActionFallsBackToGuideAfterPromptNeedsAttention() {
    let permission = PermissionStatus(
      key: "messages_automation",
      status: "needs_action",
      summary: "Messages automation needs attention.",
      requestFlags: ["--messages"]
    )

    XCTAssertEqual(
      permissionAction(
        for: permission,
        descriptor: permissionDescriptor(for: permission.key)
      ),
      .guideInSettings
    )
  }

  func testPermissionActionGuidesManualPermissions() {
    let permission = PermissionStatus(
      key: "full_disk_access",
      status: "needs_action",
      summary: "Full Disk Access is required.",
      requestFlags: ["--full-disk-access"]
    )

    XCTAssertEqual(
      permissionAction(
        for: permission,
        descriptor: permissionDescriptor(for: permission.key)
      ),
      .guideInSettings
    )
  }
}
