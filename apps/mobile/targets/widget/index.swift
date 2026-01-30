import WidgetKit
import SwiftUI

/// Main entry point for Cued widgets
/// WidgetBundle allows grouping multiple widgets
@main
struct CuedWidgetBundle: WidgetBundle {
    var body: some Widget {
        ActionCountWidget()
        ActionsListWidget()
    }
}
