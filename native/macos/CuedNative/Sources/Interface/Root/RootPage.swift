import Foundation

enum RootPage: Int, CaseIterable {
  case welcome
  case permissions
  case platforms
  case useCases
  case application

  var title: String {
    switch self {
    case .welcome:
      return "Welcome"
    case .permissions:
      return "Permissions"
    case .platforms:
      return "Platforms"
    case .useCases:
      return "Use cases"
    case .application:
      return "Cued Application"
    }
  }

  var shortTitle: String {
    switch self {
    case .application:
      return "App"
    default:
      return title
    }
  }
}

func rootPage(for index: Int) -> RootPage {
  RootPage(rawValue: index) ?? .welcome
}
