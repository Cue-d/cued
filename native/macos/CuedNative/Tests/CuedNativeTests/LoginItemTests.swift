import XCTest
import ServiceManagement
@testable import CuedNative

final class LoginItemTests: XCTestCase {
  func testLoginItemStatusName() {
    XCTAssertEqual(loginItemStatusName(.enabled), "enabled")
    XCTAssertEqual(loginItemStatusName(.requiresApproval), "requires_approval")
    XCTAssertEqual(loginItemStatusName(.notFound), "not_found")
    XCTAssertEqual(loginItemStatusName(.notRegistered), "not_registered")
  }
}
