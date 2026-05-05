import XCTest
@testable import CuedNative
@testable import CuedNativeUI

final class OnboardingUITests: XCTestCase {
  private func capability(_ availability: String = "available") -> InstallerCapabilityStatus {
    InstallerCapabilityStatus(availability: availability, onboardingVisible: true, reason: nil)
  }

  private func integration(
    platform: String,
    authState: String,
    enabled: Bool = true
  ) -> InstallerIntegrationStatus {
    InstallerIntegrationStatus(
      platform: platform,
      accountKey: platform == "slack" ? "workspace-a" : "local",
      displayName: platform == "contacts" ? "Contacts.app" : nil,
      authState: authState,
      enabled: enabled,
      capability: capability()
    )
  }

  private func configuration(
    platform: String,
    authState: String,
    supportsMultipleAccounts: Bool = false
  ) -> InstallerPlatformConfiguration {
    InstallerPlatformConfiguration(
      platform: platform,
      title: platform,
      capability: capability(),
      accounts: [integration(platform: platform, authState: authState)],
      placeholder: nil,
      supportsMultipleAccounts: supportsMultipleAccounts
    )
  }

  func testPermissionKeyMappingMatchesExpectedFlags() {
    XCTAssertEqual(onboardingPermissionKeys(for: ["--contacts"]), ["contacts"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--full-disk-access"]), ["full_disk_access"])
    XCTAssertEqual(onboardingPermissionKeys(for: ["--messages"]), ["messages_automation"])
    XCTAssertEqual(
      onboardingPermissionKeys(for: ["--all"]),
      ["contacts", "full_disk_access", "messages_automation"]
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

  func testCompletedLocalSourcesDoNotShowAccountRows() {
    XCTAssertFalse(
      installerShouldShowAccountRows(
        for: configuration(platform: "contacts", authState: "authorized")
      )
    )
    XCTAssertFalse(
      installerShouldShowAccountRows(
        for: configuration(platform: "imessage", authState: "authorized")
      )
    )
  }

  func testLocalSourceProblemsStillShowAccountRows() {
    XCTAssertTrue(
      installerShouldShowAccountRows(
        for: configuration(platform: "imessage", authState: "blocked")
      )
    )
    XCTAssertTrue(
      installerShouldShowAccountRows(
        for: configuration(platform: "contacts", authState: "check_failed")
      )
    )
  }

  func testRequestableConnectedSourcesStillShowAccountRows() {
    XCTAssertTrue(
      installerShouldShowAccountRows(
        for: configuration(platform: "linkedin", authState: "authenticated")
      )
    )
    XCTAssertTrue(
      installerShouldShowAccountRows(
        for: configuration(
          platform: "slack",
          authState: "authenticated",
          supportsMultipleAccounts: true
        )
      )
    )
  }
}
