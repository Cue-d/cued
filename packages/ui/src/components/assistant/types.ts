export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
}

export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: "partial-call" | "call" | "result";
  result?: unknown;
}

export interface MessageWithToolInvocations extends AssistantMessage {
  toolInvocations?: ToolInvocation[];
}

export interface SearchResult {
  _id: string;
  content: string;
  sentAt: number;
  conversationId: string;
  platform: string;
  isFromMe: boolean;
  senderName?: string;
}

export interface ContactResult {
  _id: string;
  displayName: string;
  company?: string;
  handles: Array<{
    handleType: string;
    handle: string;
    platform: string;
  }>;
}

export interface ConversationResult {
  _id: string;
  platform: string;
  conversationType: string;
  participantNames: string[];
  lastMessageText?: string;
  lastMessageAt?: number;
}

export interface ActionResult {
  actionId: string;
  type: string;
  priority: number;
  reason?: string;
  draftMessage?: string;
}

export interface MemoryResult {
  id: string;
  memory: string;
  created_at?: string;
}

export type ToolArtifact =
  | { type: "search_results"; data: SearchResult[] }
  | { type: "contact"; data: ContactResult }
  | { type: "contacts"; data: ContactResult[] }
  | { type: "conversations"; data: ConversationResult[] }
  | { type: "action_created"; data: ActionResult }
  | { type: "memories"; data: MemoryResult[] };

export interface SuggestedPrompt {
  title: string;
  prompt: string;
}
