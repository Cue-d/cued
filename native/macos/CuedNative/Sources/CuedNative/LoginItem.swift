import Foundation
import ServiceManagement

struct LoginItemStatusResponse: Encodable {
  let enabled: Bool
  let status: String
  let requiresApproval: Bool
  let found: Bool
}

func loginItemStatusName(_ status: SMAppService.Status) -> String {
  switch status {
  case .enabled:
    return "enabled"
  case .requiresApproval:
    return "requires_approval"
  case .notFound:
    return "not_found"
  case .notRegistered:
    return "not_registered"
  @unknown default:
    return "unknown"
  }
}

func currentLoginItemStatus() -> LoginItemStatusResponse {
  let status = SMAppService.mainApp.status
  return LoginItemStatusResponse(
    enabled: status == .enabled,
    status: loginItemStatusName(status),
    requiresApproval: status == .requiresApproval,
    found: status != .notFound
  )
}

func enableLoginItem() throws -> LoginItemStatusResponse {
  try SMAppService.mainApp.register()
  return currentLoginItemStatus()
}

func disableLoginItem() throws -> LoginItemStatusResponse {
  try SMAppService.mainApp.unregister()
  return currentLoginItemStatus()
}
