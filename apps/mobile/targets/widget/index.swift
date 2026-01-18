import WidgetKit
import SwiftUI

/// Main entry point for PRM widgets
/// WidgetBundle allows grouping multiple widgets
@main
struct PRMWidgetBundle: WidgetBundle {
    var body: some Widget {
        ActionCountWidget()
        ActionsListWidget()
    }
}
