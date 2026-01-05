import Foundation

/// PRM LLM CLI - Analyzes a single conversation using Apple Intelligence
///
/// Usage: prm-llm < conversation.txt > output.json
///
/// Input: Plain text conversation (one per invocation)
/// Output: JSON with action suggestion (or null if no action needed)

func runCLI() async {
    do {
        // Read plain text from stdin
        let conversationText = try readStdin()

        // Generate action using LLM
        let output = try await analyzeWithLLM(conversationText)

        // Write JSON to stdout
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let outputData = try encoder.encode(output)

        if let outputString = String(data: outputData, encoding: .utf8) {
            print(outputString)
        }

    } catch let error as DecodingError {
        // Provide more details for decoding errors
        let message: String
        switch error {
        case .dataCorrupted(let context):
            message = "Data corrupted: \(context.debugDescription)"
        case .keyNotFound(let key, let context):
            message = "Key '\(key.stringValue)' not found: \(context.debugDescription)"
        case .typeMismatch(let type, let context):
            message = "Type mismatch for \(type): \(context.debugDescription)"
        case .valueNotFound(let type, let context):
            message = "Value of type \(type) not found: \(context.debugDescription)"
        @unknown default:
            message = error.localizedDescription
        }
        writeError("Decoding error: \(message)")
        exit(1)
    } catch {
        writeError(error.localizedDescription)
        exit(1)
    }
}

func writeError(_ message: String) {
    let errorOutput = ErrorOutput(error: message)
    if let errorData = try? JSONEncoder().encode(errorOutput),
        let errorString = String(data: errorData, encoding: .utf8)
    {
        FileHandle.standardError.write(Data(errorString.utf8))
        FileHandle.standardError.write(Data("\n".utf8))
    } else {
        FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    }
}

func readStdin() throws -> String {
    var lines: [String] = []

    // Check if stdin has data (not a tty)
    if isatty(FileHandle.standardInput.fileDescriptor) == 0 {
        while let line = readLine(strippingNewline: false) {
            lines.append(line)
        }
    }

    let text = lines.joined()

    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw PRMLLMError.noInput
    }

    return text
}

func analyzeWithLLM(_ conversationText: String) async throws -> ActionOutput {
    if #available(macOS 26.0, *) {
        let generator = ActionGenerator()
        return try await generator.analyzeConversation(conversationText)
    } else {
        // Fallback for older macOS - return no action
        // Python will use heuristic-based generation
        throw PRMLLMError.unsupportedOS
    }
}

struct ErrorOutput: Codable {
    let error: String
}

enum PRMLLMError: LocalizedError {
    case noInput
    case unsupportedOS

    var errorDescription: String? {
        switch self {
        case .noInput:
            return "No input provided. Pipe conversation text to stdin."
        case .unsupportedOS:
            return "Apple Intelligence requires macOS 26.0 (Tahoe) or later."
        }
    }
}

// Entry point - using top-level async code for Swift 6
let task = Task {
    await runCLI()
}

// Wait for completion
_ = await task.value
