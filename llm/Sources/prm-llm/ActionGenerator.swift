import AnyLanguageModel
import Foundation

// MARK: - Generable Schema for LLM Output

/// Action suggestion from the LLM for a single conversation
@Generable
struct ActionSuggestion {
    @Guide(description: "Whether the user should take action on this conversation. Set to false if the conversation is concluded, doesn't need a reply, or the user already responded.")
    var shouldAct: Bool
    
    @Guide(description: "Action type: 'respond_to_message' for unanswered messages needing a reply, 'follow_up' for promises or commitments you made that need following through, 'eod_contact' for new contacts that need context added")
    var type: String
    
    @Guide(description: "Priority from 0-100. Higher means more urgent. Use 80+ for time-sensitive items, 60-79 for important but not urgent, 40-59 for routine follow-ups, below 40 for low priority.")
    var priority: Int
    
    @Guide(description: "Brief reason explaining why this action is needed, what the context is")
    var reason: String
}

// MARK: - Action Generator

@available(macOS 26.0, *)
actor ActionGenerator {
    private let session: LanguageModelSession
    
    init() {
        // Use Apple Intelligence (Foundation Models) by default
        let model = SystemLanguageModel.default
        self.session = LanguageModelSession(model: model)
    }
    
    /// Analyze a single conversation and generate an action suggestion
    func analyzeConversation(_ conversationText: String) async throws -> ActionOutput {
        let prompt = buildPrompt(conversationText: conversationText)
        
        let response = try await session.respond(
            to: prompt,
            generating: ActionSuggestion.self
        )
        
        let suggestion = response.content
        
        // If no action needed, return nil
        guard suggestion.shouldAct else {
            return ActionOutput(action: nil)
        }
        
        let action = ActionSuggestionOutput(
            type: normalizeActionType(suggestion.type),
            priority: clamp(suggestion.priority, min: 0, max: 100),
            payload: ActionPayload(reason: suggestion.reason),
            remindAt: nil
        )
        
        return ActionOutput(action: action)
    }
    
    private func buildPrompt(conversationText: String) -> String {
        return """
        You are analyzing a conversation to determine if the user should take action.
        
        Consider:
        1. Is there an unanswered question or request from the other person?
        2. Did the user make a promise or commitment they haven't fulfilled?
        3. Is this a new contact that needs context/notes added?
        4. How long has it been since the last message?
        
        Action types:
        - respond_to_message: The other person sent a message that needs a reply
        - follow_up: The user promised something or needs to follow up on a commitment
        - eod_contact: A new contact the user should add notes/context about
        
        Set shouldAct to FALSE if:
        - The conversation is naturally concluded
        - The last message doesn't require a response (like "thanks!", "ok", "sounds good")
        - The user already responded and is waiting for the other person
        - It's just a notification or automated message
        
        Here is the conversation:
        
        \(conversationText)
        
        Analyze this conversation and determine if the user should take action.
        """
    }
    
    private func normalizeActionType(_ type: String) -> String {
        let normalized = type.lowercased().trimmingCharacters(in: .whitespaces)
        switch normalized {
        case "respond_to_message", "respond", "reply":
            return "respond_to_message"
        case "follow_up", "followup", "follow-up":
            return "follow_up"
        case "eod_contact", "eod", "new_contact":
            return "eod_contact"
        default:
            return "respond_to_message"  // Default fallback
        }
    }
    
    private func clamp(_ value: Int, min: Int, max: Int) -> Int {
        Swift.min(Swift.max(value, min), max)
    }
}
