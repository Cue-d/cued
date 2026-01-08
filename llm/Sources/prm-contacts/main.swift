import Foundation

/// PRM Contacts CLI - Fetches all contacts from macOS Contacts.app
///
/// Usage: prm-contacts [options]
///
/// Options:
///   --json          Output JSON (default when not a tty)
///   --pretty        Pretty-print JSON output (implies --json)
///   --include-all   Include contacts without phone/email (default: filter them out)
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

        do {
            let fetcher = ContactsFetcher()

            // Request access if needed
            try await fetcher.requestAccessIfNeeded()

            // Fetch contacts
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

        } catch let error as ContactsError {
            writeError(error.localizedDescription, json: outputJSON)
            exit(error == .accessDenied ? 2 : 1)
        } catch {
            writeError(error.localizedDescription, json: outputJSON)
            exit(1)
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
