import Contacts
import Foundation

/// PRM Contacts CLI - Fetches all contacts from macOS Contacts.app
///
/// Usage: prm-contacts [options]
///
/// Options:
///   --json          Output JSON (default when not a tty)
///   --pretty        Pretty-print JSON output (implies --json)
///   --include-all   Include contacts without phone/email (default: filter them out)
///   --watch         Watch for contact changes (outputs JSON lines, runs indefinitely)
///
/// Output: JSON to stdout, errors to stderr
///
/// Exit codes:
///   0 - Success
///   1 - General error
///   2 - Access denied (permission issue)

@main
struct PRMContacts {
    static func main() async {
        let args = CommandLine.arguments
        let prettyPrint = args.contains("--pretty")
        let outputJSON = prettyPrint || args.contains("--json") || isatty(fileno(stdout)) == 0
        let includeAll = args.contains("--include-all")
        let watchMode = args.contains("--watch")

        do {
            let fetcher = ContactsFetcher()

            // Request access if needed
            try await fetcher.requestAccessIfNeeded()

            if watchMode {
                // Watch mode: output events when contacts change
                await runWatchMode()
            } else {
                // Normal mode: fetch and output contacts
                try await fetchAndOutput(fetcher: fetcher, outputJSON: outputJSON, prettyPrint: prettyPrint, includeAll: includeAll)
            }

        } catch let error as ContactsError {
            writeError(error.localizedDescription, json: outputJSON)
            exit(error == .accessDenied ? 2 : 1)
        } catch {
            writeError(error.localizedDescription, json: outputJSON)
            exit(1)
        }
    }

    static func fetchAndOutput(fetcher: ContactsFetcher, outputJSON: Bool, prettyPrint: Bool, includeAll: Bool) async throws {
        let startTime = CFAbsoluteTimeGetCurrent()
        let contacts = try fetcher.fetchAllContacts(includeAll: includeAll)
        let elapsed = CFAbsoluteTimeGetCurrent() - startTime

        if outputJSON {
            let output = ContactsOutput(
                contacts: contacts,
                count: contacts.count,
                elapsedSeconds: elapsed
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = prettyPrint
                ? [.prettyPrinted, .sortedKeys]
                : [.sortedKeys]
            let data = try encoder.encode(output)
            if let json = String(data: data, encoding: .utf8) {
                print(json)
            }
        } else {
            // Human-readable output
            print("Contacts: \(contacts.count)")
            print("Time: \(String(format: "%.3f", elapsed))s")
            for contact in contacts.prefix(5) {
                print("  - \(contact.name): \(contact.phones.joined(separator: ", "))")
            }
            if contacts.count > 5 {
                print("  ... and \(contacts.count - 5) more")
            }
        }
    }

    static func runWatchMode() async {
        // Output started event
        outputWatchEvent(.started, message: "Watching for contact changes")

        // Set up notification observer for contact store changes
        NotificationCenter.default.addObserver(
            forName: .CNContactStoreDidChange,
            object: nil,
            queue: .main
        ) { _ in
            outputWatchEvent(.changed, message: "Contacts changed")
        }

        // Run the main dispatch queue to receive notifications
        dispatchMain()
    }

    static func outputWatchEvent(_ type: WatchEventType, message: String?) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let event = WatchEvent(
            type: type,
            timestamp: formatter.string(from: Date()),
            message: message
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(event),
           let json = String(data: data, encoding: .utf8)
        {
            print(json)
            fflush(stdout) // Ensure immediate output for streaming
        }
    }

    static func writeError(_ message: String, json: Bool) {
        if json {
            let error = ErrorOutput(error: message)
            if let data = try? JSONEncoder().encode(error),
                let str = String(data: data, encoding: .utf8)
            {
                FileHandle.standardError.write(Data(str.utf8))
                FileHandle.standardError.write(Data("\n".utf8))
            }
        } else {
            FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
        }
    }
}
