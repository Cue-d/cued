import { generateObject } from "ai";
import { z } from "zod";
import { truncate } from "@cued/shared";
import { gateway, MODEL } from "../gateway";
import { withRetry } from "../utils";

/** Action types that can be suggested by the LLM */
const ACTION_TYPES = ["respond", "follow_up", "send_message"] as const;

/** Zod schema for LLM action suggestion output */
export const ActionSuggestionSchema = z.object({
  shouldCreateAction: z
    .boolean()
    .describe("Whether an action should be created for this conversation"),
  type: z
    .enum(ACTION_TYPES)
    .nullable()
    .describe("Action type: respond (reply needed), follow_up (reminder), send_message (outreach). Null if no action needed."),
  priority: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe("Priority score 0-100 (higher = more urgent). Null if no action needed."),
  reason: z
    .string()
    .nullable()
    .describe("Brief explanation of why this action is needed or why not"),
  suggestedResponse: z
    .string()
    .nullable()
    .describe("Draft response text for the user to review and edit. Null if no action needed."),
  remindAt: z
    .string()
    .nullable()
    .describe("ISO timestamp for when to remind (for follow_up type). Null if not applicable."),
});

export type ActionSuggestion = z.infer<typeof ActionSuggestionSchema>;

/** Contact information for context */
export interface ContactInfo {
  displayName: string;
  company?: string;
  notes?: string;
  isKnownContact: boolean;
  /** Tags or categories for the contact */
  tags?: string[];
  /** Contact importance score (0-100) */
  importance?: number;
}

/** Memory about a contact from past interactions */
export interface ContactMemory {
  /** The memory content (fact, preference, context) */
  memory: string;
  /** When this memory was created */
  createdAt?: string;
}

/** Recent action for context (to avoid duplicates) */
export interface RecentAction {
  type: string; // "respond", "follow_up", etc.
  status: "pending" | "completed" | "discarded" | "snoozed" | "expired";
  createdAt: number; // timestamp in ms
}

/** Message in conversation history */
export interface ActionMessage {
  content: string;
  isFromMe: boolean;
  sentAt: number;
  senderName?: string;
}

/** Input for action generation */
export interface GenerateActionInput {
  contact: ContactInfo;
  messages: ActionMessage[];
  platform: "imessage" | "gmail" | "slack" | "linkedin" | "twitter" | "signal" | "whatsapp";
  hoursSinceLastMessage: number;
  /** Recent actions for this conversation (to avoid duplicates) */
  recentActions?: RecentAction[];
  /** Memories about this contact from past interactions */
  contactMemories?: ContactMemory[];
}

/** Format timestamp as relative time */
function formatRelativeTime(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Format timestamp (ms) as relative time from now */
function formatTimestampRelative(timestamp: number): string {
  const hours = (Date.now() - timestamp) / (1000 * 60 * 60);
  return formatRelativeTime(hours);
}

/** Build context prompt from conversation data */
function buildContextPrompt(input: GenerateActionInput): string {
  const { contact, messages, platform, hoursSinceLastMessage, recentActions, contactMemories } = input;

  // Contact info section
  const contactLines = [`Contact: ${contact.displayName}`];
  if (contact.company) contactLines.push(`Company: ${contact.company}`);
  if (contact.notes) contactLines.push(`Notes: ${truncate(contact.notes, 200)}`);
  if (contact.tags && contact.tags.length > 0) {
    contactLines.push(`Tags: ${contact.tags.join(", ")}`);
  }
  if (contact.importance !== undefined) {
    let importanceLabel: string;
    if (contact.importance >= 80) {
      importanceLabel = "High";
    } else if (contact.importance >= 50) {
      importanceLabel = "Medium";
    } else {
      importanceLabel = "Low";
    }
    contactLines.push(`Importance: ${importanceLabel}`);
  }
  contactLines.push(`Known contact: ${contact.isKnownContact ? "Yes" : "No"}`);

  // Message history (last 10, truncate long messages)
  const recentMessages = messages.slice(-10);
  const messageLines = recentMessages.map((msg) => {
    const sender = msg.isFromMe ? "Me" : msg.senderName || contact.displayName;
    const content = truncate(msg.content, 500);
    return `[${sender}]: ${content}`;
  });

  // Handle empty conversations
  if (messageLines.length === 0) {
    messageLines.push("[No messages in conversation]");
  }

  // Recent actions section (to avoid duplicates)
  let recentActionsSection = "";
  if (recentActions && recentActions.length > 0) {
    const actionLines = recentActions.map((action) => {
      return `- ${action.type} (${action.status}, ${formatTimestampRelative(action.createdAt)})`;
    });
    recentActionsSection = `\n## Recent Actions\n${actionLines.join("\n")}\n`;
  }

  // Memories section (context from past interactions)
  let memoriesSection = "";
  if (contactMemories && contactMemories.length > 0) {
    const memoryLines = contactMemories.slice(0, 10).map((mem) => {
      return `- ${truncate(mem.memory, 200)}`;
    });
    memoriesSection = `\n## What You Know About This Person\n${memoryLines.join("\n")}\n`;
  }

  return `## Context
Platform: ${platform}
Time since last message: ${formatRelativeTime(hoursSinceLastMessage)}

## Contact Information
${contactLines.join("\n")}
${memoriesSection}${recentActionsSection}
## Recent Messages (oldest to newest)
${messageLines.join("\n")}`;
}

/** System prompt for action generation */
const SYSTEM_PROMPT = `You are an AI assistant helping a user manage their personal relationships.
Your task is to analyze a conversation and decide if the user needs to take action.

## Guidelines for Creating Actions

Create an action when:
- The other person asked a direct question that hasn't been answered
- The other person made a request or asked for help
- A commitment was made that needs follow-up
- The conversation ended mid-discussion and needs continuation
- Professional context (recruiter, business contact) requires timely response
- An important contact (high importance) has been waiting for a response

Do NOT create an action when:
- The user sent the last message and is waiting for a reply
- The conversation reached a natural conclusion (goodbyes, thanks)
- It's a group chat where others might respond
- The message is purely informational with no expected response
- It's an automated message (OTP, verification, delivery notification)
- A similar action was recently discarded (user dismissed it)
- A pending action of the same type already exists

## Using Contact Context
When context about the contact is available:
- Use memories to personalize suggested responses
- Reference shared history or past topics when relevant
- Adjust priority based on contact importance and relationship
- Consider company/professional context for business relationships
- Use tags to understand the relationship type (friend, colleague, etc.)

## Action Types
- respond: Direct reply is needed to the conversation
- follow_up: Set a reminder to check back later
- send_message: Proactive outreach is appropriate

## Priority Guidelines (0-100)
- 80-100: Urgent business/professional, time-sensitive commitments, high-importance contacts
- 60-79: Important personal messages, questions awaiting answers
- 40-59: Non-urgent but should be addressed soon
- 20-39: Low priority, nice-to-respond
- 0-19: Very low priority, optional response

## Response Guidelines
When suggesting a response:
- Match the tone and formality of the conversation
- Use context from memories to make responses more personal
- Reference relevant shared context when appropriate
- Keep it concise and natural
- Don't over-explain or be overly formal
- For professional contexts, be appropriately polite`;

/**
 * Generate an action suggestion for a conversation using LLM.
 * Uses Kimi K2.5 thinking via Vercel AI Gateway.
 */
export async function generateAction(
  input: GenerateActionInput
): Promise<ActionSuggestion> {
  // Handle edge case: empty conversation
  if (input.messages.length === 0) {
    return {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "Empty conversation - no context to analyze",
      suggestedResponse: null,
      remindAt: null,
    };
  }

  // Handle edge case: user sent last message (waiting for reply)
  const lastMessage = input.messages[input.messages.length - 1];
  if (lastMessage?.isFromMe) {
    return {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "User sent the last message - waiting for reply",
      suggestedResponse: null,
      remindAt: null,
    };
  }

  // Deterministic check: if pending action exists, skip LLM
  const hasPendingAction = input.recentActions?.some(
    (action) => action.status === "pending"
  );
  if (hasPendingAction) {
    return {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "Pending action already exists for this conversation",
      suggestedResponse: null,
      remindAt: null,
    };
  }

  // Deterministic check: no new messages since most recent action
  if (input.recentActions && input.recentActions.length > 0) {
    const mostRecentAction = input.recentActions[0]; // Already sorted by createdAt desc
    const mostRecentMessageTime = lastMessage?.sentAt ?? 0;

    if (mostRecentMessageTime <= mostRecentAction.createdAt) {
      return {
        shouldCreateAction: false,
        type: null,
        priority: null,
        reason: "No new messages since last action was created",
        suggestedResponse: null,
        remindAt: null,
      };
    }
  }

  const contextPrompt = buildContextPrompt(input);

  const { object } = await generateObject({
    model: gateway(MODEL),
    schema: ActionSuggestionSchema,
    system: SYSTEM_PROMPT,
    prompt: `Analyze this conversation and decide if an action is needed:\n\n${contextPrompt}`,
  });

  return object;
}

/**
 * Generate action with retry on failure.
 * Returns a safe default if LLM fails after retries.
 */
export async function generateActionWithRetry(
  input: GenerateActionInput,
  maxRetries = 2
): Promise<ActionSuggestion> {
  return withRetry(() => generateAction(input), {
    maxRetries,
    defaultValue: {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "LLM analysis failed after retries",
      suggestedResponse: null,
      remindAt: null,
    },
    logPrefix: "generateAction",
  });
}
