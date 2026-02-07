// Re-export types from artifacts for backwards compatibility
export type {
  SearchResult,
  ContactResult,
  ConversationResult,
  ActionResult,
  ActionSearchResult,
} from "./artifacts"

export interface SuggestedPrompt {
  title: string
  prompt: string
}

// Re-export message types from chat-message
export type {
  AssistantMessage,
  MessageWithToolInvocations,
  ToolInvocation,
} from "./chat-message"
