import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

/// Data model for widget timeline entries
struct ActionCountEntry: TimelineEntry {
    let date: Date
    let count: Int

    static var placeholder: ActionCountEntry {
        ActionCountEntry(date: Date(), count: 3)
    }
}

// MARK: - Timeline Provider

/// Provides timeline data for the widget
struct ActionCountProvider: TimelineProvider {
    /// App Group identifier for shared data access
    private let appGroupId = "group.so.cued.app"
    private let countKey = "pendingActionCount"

    /// Reads the pending action count from shared UserDefaults
    private func getActionCount() -> Int {
        guard let userDefaults = UserDefaults(suiteName: appGroupId) else {
            return 0
        }
        return userDefaults.integer(forKey: countKey)
    }

    /// Placeholder shown while widget loads
    func placeholder(in context: Context) -> ActionCountEntry {
        ActionCountEntry.placeholder
    }

    /// Snapshot for widget gallery preview
    func getSnapshot(in context: Context, completion: @escaping (ActionCountEntry) -> Void) {
        let entry = ActionCountEntry(date: Date(), count: getActionCount())
        completion(entry)
    }

    /// Timeline for widget updates
    func getTimeline(in context: Context, completion: @escaping (Timeline<ActionCountEntry>) -> Void) {
        let entry = ActionCountEntry(date: Date(), count: getActionCount())
        // Refresh every 15 minutes (minimum allowed by iOS)
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }
}

// MARK: - Widget View

/// Main widget view displaying pending action count
struct ActionCountWidgetView: View {
    var entry: ActionCountEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        ZStack {
            // Background gradient
            ContainerRelativeShape()
                .fill(
                    LinearGradient(
                        colors: [Color.blue.opacity(0.1), Color.blue.opacity(0.05)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            VStack(spacing: 4) {
                // Action count number
                Text("\(entry.count)")
                    .font(.system(size: family == .systemSmall ? 48 : 64, weight: .bold, design: .rounded))
                    .foregroundColor(.primary)

                // Label
                Text(entry.count == 1 ? "Action" : "Actions")
                    .font(.system(size: family == .systemSmall ? 14 : 16, weight: .medium))
                    .foregroundColor(.secondary)

                // Subtitle when count > 0
                if entry.count > 0 {
                    Text("Tap to review")
                        .font(.system(size: family == .systemSmall ? 10 : 12))
                        .foregroundColor(.blue)
                }
            }
            .padding()
        }
    }
}

// MARK: - Widget Configuration

/// Widget definition and configuration
struct ActionCountWidget: Widget {
    let kind: String = "ActionCountWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ActionCountProvider()) { entry in
            ActionCountWidgetView(entry: entry)
        }
        .configurationDisplayName("Cued Actions")
        .description("Shows your pending action count")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

// MARK: - Preview

#Preview(as: .systemSmall) {
    ActionCountWidget()
} timeline: {
    ActionCountEntry(date: Date(), count: 0)
    ActionCountEntry(date: Date(), count: 5)
    ActionCountEntry(date: Date(), count: 12)
}
