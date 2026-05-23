import XCTest
@testable import CuedNative
@testable import Interface

final class RootViewTests: XCTestCase {
  func testPermissionKeyMappingMatchesExpectedFlags() {
    XCTAssertEqual(permissionKeys(for: ["--contacts"]), ["contacts"])
    XCTAssertEqual(permissionKeys(for: ["--full-disk-access"]), ["full_disk_access"])
    XCTAssertEqual(
      permissionKeys(for: ["--all"]),
      ["contacts", "full_disk_access"]
    )
  }

  func testPermissionRequestFlagsExcludeSwiftContacts() {
    XCTAssertEqual(permissionRequestFlagsExcludingSwiftContacts(for: ["contacts"]), [])
    XCTAssertEqual(
      permissionRequestFlagsExcludingSwiftContacts(for: ["contacts", "full_disk_access"]),
      ["--full-disk-access"]
    )
    XCTAssertEqual(
      permissionRequestFlagsExcludingSwiftContacts(for: ["full_disk_access"]),
      ["--full-disk-access"]
    )
  }

  func testActivePermissionRefreshIsForcedForLiveVerifiableRequests() {
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--contacts"]))
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--full-disk-access"]))
    XCTAssertTrue(shouldActivelyRefreshPermissions(for: ["--all"]))
  }

  func testActivePermissionSnapshotRefreshOnlyRefreshesPermissions() {
    XCTAssertEqual(
      onboardingSnapshotArguments(refreshPermissions: true),
      ["onboarding", "snapshot", "--refresh-permissions"]
    )
    XCTAssertEqual(
      onboardingSnapshotArguments(refreshPermissions: false),
      ["onboarding", "snapshot"]
    )
  }

  func testFastContactsPermissionStatusMapping() {
    XCTAssertEqual(
      RootWindowController.fastContactsPermissionStatus(authorizationStatus: .authorized).status,
      "granted"
    )
    XCTAssertEqual(
      RootWindowController.fastContactsPermissionStatus(authorizationStatus: .notDetermined).status,
      "unknown"
    )
    XCTAssertEqual(
      RootWindowController.fastContactsPermissionStatus(authorizationStatus: .denied).status,
      "needs_action"
    )
    XCTAssertEqual(
      RootWindowController.fastContactsPermissionStatus(authorizationStatus: .restricted).status,
      "needs_action"
    )
  }

  func testFastFullDiskAccessStatusReportsMissingDatabaseAsUnknown() {
    let missingPath = NSTemporaryDirectory().appending("missing-cued-chat.db")

    let status = RootWindowController.fastFullDiskAccessPermissionStatus(messagesDBPath: missingPath)

    XCTAssertEqual(status.key, "full_disk_access")
    XCTAssertEqual(status.status, "unknown")
  }

  func testCodexCLIStatusReportsMissingAuthAndReadyStates() {
    XCTAssertEqual(
      AgentLaunchService.codexCLIStatus(commandPath: nil, loginStatus: nil, output: "").readiness,
      .missing
    )
    XCTAssertEqual(
      AgentLaunchService.codexCLIStatus(commandPath: "/usr/local/bin/codex", loginStatus: 1, output: "not logged in").readiness,
      .notLoggedIn
    )
    XCTAssertEqual(
      AgentLaunchService.codexCLIStatus(commandPath: "/usr/local/bin/codex", loginStatus: 0, output: "Logged in using ChatGPT").readiness,
      .ready
    )
  }

  func testClaudeCodeStatusReportsMissingAuthAndReadyStates() {
    XCTAssertEqual(
      AgentLaunchService.claudeCodeStatus(commandPath: nil, authStatus: nil, output: "").readiness,
      .missing
    )
    XCTAssertEqual(
      AgentLaunchService.claudeCodeStatus(commandPath: "/opt/homebrew/bin/claude", authStatus: 1, output: "Please login").readiness,
      .notLoggedIn
    )
    XCTAssertEqual(
      AgentLaunchService.claudeCodeStatus(commandPath: "/opt/homebrew/bin/claude", authStatus: 0, output: "{\"authenticated\":true}").readiness,
      .ready
    )
  }

  func testAgentLaunchShellPathIncludesUserLocalBins() {
    let path = AgentLaunchService.defaultShellPath("/custom/bin")

    XCTAssertTrue(path.contains("/custom/bin"))
    XCTAssertTrue(path.contains("\(NSHomeDirectory())/.local/bin"))
    XCTAssertTrue(path.contains("\(NSHomeDirectory())/.claude/local"))
    XCTAssertTrue(path.contains("\(NSHomeDirectory())/.npm-global/bin"))
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

  @MainActor
  func testPermissionStatusCanBeUpdatedOptimistically() {
    let viewModel = RootViewModel()

    viewModel.setPermissionStatus(
      key: "diagnostics",
      status: "disabled",
      summary: "Redacted diagnostic reporting is disabled",
      requestFlags: ["--telemetry-disable"]
    )

    let diagnostics = viewModel.permissionStatuses.first { $0.key == "diagnostics" }
    XCTAssertEqual(diagnostics?.status, "disabled")
    XCTAssertEqual(diagnostics?.summary, "Redacted diagnostic reporting is disabled")
    XCTAssertEqual(diagnostics?.requestFlags, ["--telemetry-disable"])
  }

  @MainActor
  func testDisabledDiagnosticsDoNotBlockPermissionsFlow() {
    let viewModel = RootViewModel()
    viewModel.apply(
      permissions: [
        PermissionStatus(
          key: "contacts",
          status: "granted",
          summary: "Contacts access is authorized",
          requestFlags: ["--contacts"]
        ),
        PermissionStatus(
          key: "full_disk_access",
          status: "granted",
          summary: "Full Disk Access is available",
          requestFlags: ["--full-disk-access"]
        ),
        PermissionStatus(
          key: "diagnostics",
          status: "disabled",
          summary: "Redacted diagnostic reporting is disabled",
          requestFlags: ["--telemetry-enable"]
        ),
      ],
      globalSkill: defaultSkillStatus(),
      relationshipSummary: RelationshipSummary(),
      allIntegrations: [],
      integrations: []
    )
    viewModel.currentPage = RootPage.permissions.rawValue

    XCTAssertTrue(viewModel.allPermissionsGranted)
    XCTAssertEqual(viewModel.buttonTitle, "Continue")
  }
}
