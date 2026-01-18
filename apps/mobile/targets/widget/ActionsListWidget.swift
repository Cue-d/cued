import WidgetKit
import SwiftUI
import UIKit

// MARK: - Data Models

/// Action item from React Native app
struct ActionItem: Codable, Identifiable {
    let id: String
    let contactName: String
    let platform: String?
    let type: String
}

/// Timeline entry containing action list
struct ActionsListEntry: TimelineEntry {
    let date: Date
    let actions: [ActionItem]

    static var placeholder: ActionsListEntry {
        ActionsListEntry(date: Date(), actions: [
            ActionItem(id: "1", contactName: "John Smith", platform: "imessage", type: "respond"),
            ActionItem(id: "2", contactName: "Sarah Johnson", platform: "gmail", type: "respond"),
            ActionItem(id: "3", contactName: "Mike Chen", platform: "slack", type: "follow_up"),
        ])
    }
}

// MARK: - Timeline Provider

struct ActionsListProvider: TimelineProvider {
    private let appGroupId = "group.com.prm.mobile"
    private let actionsKey = "actionsList"

    /// Reads actions list from shared UserDefaults
    private func getActions() -> [ActionItem] {
        guard let userDefaults = UserDefaults(suiteName: appGroupId),
              let jsonString = userDefaults.string(forKey: actionsKey),
              let data = jsonString.data(using: .utf8) else {
            return []
        }

        do {
            return try JSONDecoder().decode([ActionItem].self, from: data)
        } catch {
            return []
        }
    }

    func placeholder(in context: Context) -> ActionsListEntry {
        ActionsListEntry.placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (ActionsListEntry) -> Void) {
        let entry = ActionsListEntry(date: Date(), actions: getActions())
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ActionsListEntry>) -> Void) {
        let entry = ActionsListEntry(date: Date(), actions: getActions())
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }
}

// MARK: - Platform Icon View

struct PlatformIcon: View {
    let platform: String?

    private var icon: (name: String, color: Color) {
        switch platform {
        case "imessage": ("message.fill", .green)
        case "gmail": ("envelope.fill", .red)
        case "slack": ("number.square.fill", .purple)
        case "linkedin": ("briefcase.fill", .blue)
        case "twitter": ("at", .cyan)
        default: ("person.fill", .gray)
        }
    }

    var body: some View {
        Image(systemName: icon.name)
            .foregroundColor(icon.color)
            .font(.system(size: 14))
    }
}

// MARK: - Action Row View

struct ActionRowView: View {
    let action: ActionItem

    var body: some View {
        HStack(spacing: 8) {
            PlatformIcon(platform: action.platform)
                .frame(width: 20)

            Text(action.contactName)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.primary)
                .lineLimit(1)

            Spacer()
        }
    }
}

// MARK: - Widget View

struct ActionsListWidgetView: View {
    var entry: ActionsListEntry
    @Environment(\.widgetFamily) var family

    private var maxItems: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        case .systemLarge: return 8
        default: return 4
        }
    }

    var body: some View {
        ZStack {
            // Background
            ContainerRelativeShape()
                .fill(Color(UIColor.systemBackground))

            if entry.actions.isEmpty {
                emptyView
            } else {
                contentView
            }
        }
    }

    private var emptyView: some View {
        VStack(spacing: 4) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 32))
                .foregroundColor(.green)

            Text("All caught up!")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.primary)
        }
    }

    private var contentView: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Reply to")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)

                Spacer()

                if entry.actions.count > maxItems {
                    Text("+\(entry.actions.count - maxItems)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.bottom, 8)

            // Action list
            VStack(alignment: .leading, spacing: 6) {
                ForEach(entry.actions.prefix(maxItems)) { action in
                    ActionRowView(action: action)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(12)
    }
}

// MARK: - Widget Configuration

struct ActionsListWidget: Widget {
    let kind: String = "ActionsListWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ActionsListProvider()) { entry in
            ActionsListWidgetView(entry: entry)
        }
        .configurationDisplayName("Contacts to Reply")
        .description("People waiting for your response")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

// MARK: - Preview

#Preview(as: .systemSmall) {
    ActionsListWidget()
} timeline: {
    ActionsListEntry(date: Date(), actions: [])
    ActionsListEntry.placeholder
}

#Preview(as: .systemMedium) {
    ActionsListWidget()
} timeline: {
    ActionsListEntry.placeholder
}
