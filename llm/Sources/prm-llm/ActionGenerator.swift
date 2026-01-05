import AnyLanguageModel
import Foundation

// MARK: - Output Schema (parsed from raw JSON)

struct ParsedAction: Codable {
    let shouldAct: Bool
    let type: String?
    let priority: Int?
    let reason: String?
}

// MARK: - Action Generator

@available(macOS 26.0, *)
actor ActionGenerator {
    private let session: LanguageModelSession
    private let maxRetries = 2

    init() {
        // Use Apple Intelligence (Foundation Models) by default
        let model = SystemLanguageModel.default
        self.session = LanguageModelSession(model: model)
    }

    /// Analyze a single conversation and generate an action suggestion
    func analyzeConversation(_ conversationText: String) async throws -> ActionOutput {
        // Sanitize input text to prevent parsing issues
        let sanitizedText = sanitizeText(conversationText)

        // Try with retries
        var lastError: Error?

        for attempt in 0..<maxRetries {
            do {
                let promptText = buildPrompt(conversationText: sanitizedText)

                // Use the Prompt builder pattern for structured output requests
                let response = try await session.respond {
                    Prompt(promptText)
                }
                let responseText = response.content

                // Extract JSON from response
                guard let parsed = parseActionFromText(responseText) else {
                    throw GeneratorError.parseError(
                        "Could not parse JSON from response: \(responseText)")
                }

                // If no action needed, return nil
                guard parsed.shouldAct else {
                    return ActionOutput(action: nil)
                }

                let action = ActionSuggestionOutput(
                    type: normalizeActionType(parsed.type ?? "respond_to_message"),
                    priority: clamp(parsed.priority ?? 50, min: 0, max: 100),
                    payload: ActionPayload(reason: parsed.reason ?? ""),
                    remindAt: nil
                )

                return ActionOutput(action: action)

            } catch {
                lastError = error
                // Log retry attempt
                FileHandle.standardError.write(
                    Data(
                        "Retry \(attempt + 1)/\(maxRetries) failed: \(error.localizedDescription)\n"
                            .utf8)
                )
                continue
            }
        }

        // If all retries failed, throw the last error
        throw lastError ?? GeneratorError.unknownError
    }

    /// Parse action from LLM text response (looks for JSON in the response)
    private func parseActionFromText(_ text: String) -> ParsedAction? {
        // Try to find JSON object in the response
        // The LLM might wrap JSON in markdown code blocks like ```json ... ```
        var searchText = text

        // Remove markdown code block wrappers if present
        if let jsonBlockStart = searchText.range(of: "```json") {
            searchText = String(searchText[jsonBlockStart.upperBound...])
            if let jsonBlockEnd = searchText.range(of: "```") {
                searchText = String(searchText[..<jsonBlockEnd.lowerBound])
            }
        } else if let codeBlockStart = searchText.range(of: "```") {
            searchText = String(searchText[codeBlockStart.upperBound...])
            if let codeBlockEnd = searchText.range(of: "```") {
                searchText = String(searchText[..<codeBlockEnd.lowerBound])
            }
        }

        // Look for { ... } pattern
        guard let startIdx = searchText.firstIndex(of: "{"),
            let endIdx = searchText.lastIndex(of: "}")
        else {
            // No JSON found, try to parse boolean values from text
            let lower = text.lowercased()
            if lower.contains("shouldact=false") || lower.contains("shouldact: false")
                || lower.contains("\"shouldact\": false") || lower.contains("no action needed")
            {
                return ParsedAction(shouldAct: false, type: nil, priority: nil, reason: nil)
            }
            if lower.contains("shouldact=true") || lower.contains("shouldact: true")
                || lower.contains("\"shouldact\": true")
            {
                return ParsedAction(
                    shouldAct: true, type: "respond_to_message", priority: 50,
                    reason: "Needs response")
            }
            return nil
        }

        let jsonString = String(searchText[startIdx...endIdx])

        // Try to parse as JSON
        guard let jsonData = jsonString.data(using: .utf8) else {
            return nil
        }

        let decoder = JSONDecoder()

        // Try direct parsing
        if let action = try? decoder.decode(ParsedAction.self, from: jsonData) {
            return action
        }

        // Try with flexible key matching (case-insensitive)
        if let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
            let shouldAct =
                (dict["shouldAct"] as? Bool) ?? (dict["should_act"] as? Bool)
                ?? (dict["shouldact"] as? Bool) ?? false
            let type = (dict["type"] as? String) ?? (dict["actionType"] as? String)
            let priority =
                (dict["priority"] as? Int) ?? ((dict["priority"] as? Double).map { Int($0) })
            let reason = (dict["reason"] as? String)

            return ParsedAction(
                shouldAct: shouldAct, type: type, priority: priority, reason: reason)
        }

        return nil
    }

    /// Sanitize text to remove problematic characters
    private func sanitizeText(_ text: String) -> String {
        var result = text

        // Replace null bytes and other control characters (except newlines/tabs)
        result = result.unicodeScalars.filter { scalar in
            // Allow printable characters, newlines, tabs, and spaces
            scalar == "\n" || scalar == "\r" || scalar == "\t"
                || (scalar.value >= 0x20 && scalar.value < 0x7F)  // Basic ASCII printable
                || (scalar.value >= 0xA0)  // Extended characters (including emoji)
        }.map { Character($0) }.reduce("") { $0 + String($1) }

        // Limit text length to avoid overwhelming the model
        if result.count > 5000 {
            result = String(result.prefix(5000)) + "\n[truncated]"
        }

        return result
    }

    private func buildPrompt(conversationText: String) -> String {
        let jsonSchema = """
            {
                "shouldAct": boolean,
                "type": "respond_to_message" | "follow_up" | "eod_contact",
                "priority": number (0-100),
                "reason": "string"
            }
            """

        return """
            Analyze this conversation and determine if the user should take action.
            Respond with a JSON object only, no other text or explanation.

            \(conversationText)

            Response format (JSON only):
            \(jsonSchema)

            NEVER set shouldAct to true for automated or suspicious messages.
            If the message is NOT from a real person you know, set shouldAct to false.

            ALWAYS set shouldAct to FALSE for:
            - ANY message containing a link from an unknown sender
            - ANY message claiming your account is locked/suspended/compromised
            - ANY message with urgency like "act now", "24 hours", "48 hours", "immediately"
            - Messages from short codes (5-6 digit numbers) or unknown numbers
            - Phishing attempts pretending to be PayPal, Amazon, Netflix, banks, Apple, Google, etc.
            - Messages asking you to "verify", "confirm", or "update" account information
            - 2FA/verification codes, OTPs, or login codes
            - Delivery notifications, tracking updates, shipping alerts
            - Appointment reminders from businesses
            - Order confirmations or receipts
            - Marketing, promotional, or advertising texts
            - Political campaign or survey messages
            - Carrier/service provider notifications (AT&T, Verizon, T-Mobile, etc.)
            - Subscription or billing alerts
            - Contest/sweepstakes/lottery notifications
            - Coupon codes or discount offers
            - Chain messages or forwards
            - Any message with poor grammar that claims to be from a major company

            Set shouldAct to true ONLY if:
            - The message is clearly from a real person you have a relationship with
            - There's a genuine unanswered question from someone you know
            - You made a promise to a real person that you haven't fulfilled
            - It's a personal conversation, not an automated system

            Set shouldAct to false if:
            - The conversation is naturally concluded
            - The last message doesn't need a response (e.g., "thanks", "ok", "sounds good")
            - The user already responded and is waiting for a reply
            - You have ANY doubt about whether it's a real person

            Priority guide: 80+ urgent, 60-79 important, 40-59 routine, below 40 low
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
            return "respond_to_message"
        }
    }

    private func clamp(_ value: Int, min: Int, max: Int) -> Int {
        Swift.min(Swift.max(value, min), max)
    }
}

enum GeneratorError: LocalizedError {
    case unknownError
    case parseError(String)

    var errorDescription: String? {
        switch self {
        case .unknownError:
            return "Unknown error during action generation"
        case .parseError(let msg):
            return "Parse error: \(msg)"
        }
    }
}
