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
    static func main() {
        let args = CommandLine.arguments
        let prettyPrint = args.contains("--pretty")
        let outputJSON = prettyPrint || args.contains("--json") || isatty(fileno(stdout)) == 0
        let includeAll = args.contains("--include-all")
        let watchMode = args.contains("--watch")

        // Watch mode runs synchronously (blocks forever)
        if watchMode {
            runWatchMode(outputJSON: outputJSON)
            return
        }

        // Request contacts access synchronously
        if let error = requestAccessSync() {
            writeError(error.localizedDescription, json: outputJSON)
            exit(error == .accessDenied ? 2 : 1)
        }

        // Fetch and output contacts synchronously
        do {
            let fetcher = ContactsFetcher()
            try fetchAndOutputSync(
                fetcher: fetcher, outputJSON: outputJSON, prettyPrint: prettyPrint,
                includeAll: includeAll)
        } catch let error as ContactsError {
            writeError(error.localizedDescription, json: outputJSON)
            exit(1)
        } catch {
            writeError(error.localizedDescription, json: outputJSON)
            exit(1)
        }
    }

    /// Request contacts access synchronously, returns error if denied
    static func requestAccessSync() -> ContactsError? {
        let store = CNContactStore()
        let status = CNContactStore.authorizationStatus(for: .contacts)

        switch status {
        case .authorized, .limited:
            return nil
        case .notDetermined:
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            store.requestAccess(for: .contacts) { success, _ in
                granted = success
                semaphore.signal()
            }
            semaphore.wait()
            return granted ? nil : .accessDenied
        case .denied:
            return .accessDenied
        case .restricted:
            return .accessRestricted
        @unknown default:
            return .unknownAuthStatus("rawValue=\(status.rawValue)")
        }
    }

    /// Fetch and output contacts synchronously
    static func fetchAndOutputSync(
        fetcher: ContactsFetcher, outputJSON: Bool, prettyPrint: Bool, includeAll: Bool
    ) throws {
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
            encoder.outputFormatting =
                prettyPrint
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

    static func runWatchMode(outputJSON: Bool) {
        // Request contacts access first using CNContactStore directly (synchronous)
        let store = CNContactStore()
        let status = CNContactStore.authorizationStatus(for: .contacts)

        if status == .notDetermined {
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            store.requestAccess(for: .contacts) { success, _ in
                granted = success
                semaphore.signal()
            }
            semaphore.wait()

            if !granted {
                writeError("Contacts access denied", json: outputJSON)
                exit(2)
            }
        } else if status != .authorized {
            writeError("Contacts access denied", json: outputJSON)
            exit(2)
        }

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

        // Run the main run loop forever to receive notifications
        RunLoop.main.run()
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
            fflush(stdout)  // Ensure immediate output for streaming
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
