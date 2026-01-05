import Foundation

// MARK: - Output Models (to Python as JSON)

struct ActionOutput: Codable {
    let action: ActionSuggestionOutput?
    
    // Explicitly encode null for action when it's nil
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
    }
    
    enum CodingKeys: String, CodingKey {
        case action
    }
}

struct ActionSuggestionOutput: Codable {
    let type: String
    let priority: Int
    let payload: ActionPayload
    let remindAt: Int?

    enum CodingKeys: String, CodingKey {
        case type
        case priority
        case payload
        case remindAt = "remind_at"
    }
}

struct ActionPayload: Codable {
    let reason: String
}
