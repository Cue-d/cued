import Foundation

/// Contact matching Python's FetchedContact model.
///
/// Note: The `notes` field from Python's model is intentionally omitted because
/// fetching contact notes requires the com.apple.developer.contacts.notes
/// entitlement, which requires Apple approval. Python sets notes=None for
/// all contacts fetched via this CLI.
struct Contact: Codable {
    let name: String
    let emails: [String]
    let phones: [String]
    let company: String?
}

/// Success output with contacts array and timing metadata
struct ContactsOutput: Codable {
    let contacts: [Contact]
    let count: Int
    let elapsedSeconds: Double

    enum CodingKeys: String, CodingKey {
        case contacts, count
        case elapsedSeconds = "elapsed_seconds"
    }
}

/// Error output for JSON mode
struct ErrorOutput: Codable {
    let error: String
}
