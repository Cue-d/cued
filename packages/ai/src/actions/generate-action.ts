import { generateObject } from "ai";
import { z } from "zod";
import { openai, FAST_MODEL } from "../openai";
import { classifyRisk, type RiskClassification } from "../filters/risk-classifier";
import { type StyleProfile, formatStyleForPrompt } from "../style/extract-style";
import { type SimilarReply, formatSimilarRepliesForPrompt } from "../style/retrieve-similar";
import { type UserPolicy, formatPoliciesForPrompt } from "../style/extract-policies";

/** Action types that can be suggested by the LLM */
const ACTION_TYPES = ["respond", "follow_up", "send_message"] as const;

/** Draft option labels */
const DRAFT_LABELS = ["direct", "diplomatic", "boundary"] as const;
type DraftLabel = (typeof DRAFT_LABELS)[number];

/** Risk flag from the classifier */
export interface RiskFlag {
  type: string;
  trigger: string;
}

/** A single draft option with metadata */
export interface DraftOption {
  text: string;
  label: DraftLabel;
  confidence: number; // 0-1
  assumptions: string[];
  styleSources: string[];
  riskFlags: RiskFlag[];
}

/** Zod schema for LLM action suggestion output (legacy single response) */
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

/** Zod schema for multi-option draft generation */
const MultiOptionDraftSchema = z.object({
  shouldCreateAction: z
    .boolean()
    .describe("Whether an action should be created for this conversation"),
  type: z
    .enum(ACTION_TYPES)
    .nullable()
    .describe("Action type if action needed"),
  priority: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe("Priority score 0-100"),
  reason: z
    .string()
    .nullable()
    .describe("Brief explanation"),
  draftOptions: z
    .array(
      z.object({
        text: z.string().describe("The draft response text"),
        label: z
          .enum(DRAFT_LABELS)
          .describe("Tone label: direct (concise), diplomatic (warmer), boundary (decline/pushback)"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("Confidence 0-1 that this is appropriate"),
        assumptions: z
          .array(z.string())
          .describe("Key assumptions made in this draft"),
      })
    )
    .describe("2-3 draft options with different tones. For yes/no questions, provide at least 2 options."),
  remindAt: z
    .string()
    .nullable()
    .describe("ISO timestamp for follow_up reminders"),
});

type MultiOptionDraft = z.infer<typeof MultiOptionDraftSchema>;

/** Extended action suggestion with multi-option drafts */
export interface ActionSuggestionWithOptions extends Omit<ActionSuggestion, "suggestedResponse"> {
  suggestedResponse: string | null; // Legacy field for backwards compat
  draftOptions: DraftOption[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}

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

/** Extended input for multi-option draft generation */
export interface GenerateActionWithStyleInput extends GenerateActionInput {
  /** User's style profile for this platform */
  styleProfile?: StyleProfile;
  /** Per-contact style overrides */
  styleOverrides?: {
    formality?: number;
    brevity?: number;
    warmth?: number;
    relationship?: string;
  };
  /** Similar past replies for in-context learning */
  similarReplies?: SimilarReply[];
  /** User policies/rules to follow */
  userPolicies?: UserPolicy[];
}

/** Truncate text to max length, adding ellipsis if needed */
function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
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
 * Uses gpt-4o-mini for cost efficiency with structured output.
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
    model: openai(FAST_MODEL),
    schema: ActionSuggestionSchema,
    system: SYSTEM_PROMPT,
    prompt: `Analyze this conversation and decide if an action is needed:\n\n${contextPrompt}`,
  });

  return object;
}

/** Delay execution for exponential backoff */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate action with retry on failure.
 * Returns a safe default if LLM fails after retries.
 */
export async function generateActionWithRetry(
  input: GenerateActionInput,
  maxRetries = 2
): Promise<ActionSuggestion> {
  const totalAttempts = maxRetries + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await generateAction(input);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < totalAttempts) {
        await delay(1000 * attempt);
      }
    }
  }

  console.error("generateAction failed after retries:", lastError?.message);
  return {
    shouldCreateAction: false,
    type: null,
    priority: null,
    reason: `LLM analysis failed: ${lastError?.message ?? "unknown error"}`,
    suggestedResponse: null,
    remindAt: null,
  };
}

/** System prompt for multi-option draft generation with style matching */
const MULTI_OPTION_SYSTEM_PROMPT = `You are a "voice prosthetic" - an AI that drafts messages in the user's exact voice.

## Core Rules
1. Match the user's writing style EXACTLY based on their previous messages
2. Never auto-send. Generate drafts for user review only.
3. For yes/no questions, ALWAYS provide at least 2 options (accept + decline)

## Style Matching (in priority order)
1. **Previous Messages in This Conversation** - COPY exactly how the user writes to this person
2. **Similar Past Replies** - Use as examples of the user's voice
3. **Style Profile** - General patterns as fallback

Copy these elements exactly from the user's previous messages:
- How they address (or don't address) the recipient
- Greetings and sign-offs
- Message length and structure
- Emoji and punctuation usage
- Tone and formality level

## Draft Options
Generate 2-3 options:
- "direct": Concise, to the point
- "diplomatic": Warmer, softer
- "boundary": For declining or pushing back

## User Policies
If provided, you MUST follow them.`;

/** Try to infer relationship from tags */
function inferRelationshipFromTags(tags?: string[]): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  const lowerTags = tags.map((t) => t.toLowerCase());

  // Family relationships
  if (lowerTags.some((t) => ["parent", "mom", "dad", "mother", "father"].includes(t))) return "parent";
  if (lowerTags.some((t) => ["sibling", "brother", "sister"].includes(t))) return "sibling";
  if (lowerTags.some((t) => ["family", "relative", "grandparent", "aunt", "uncle", "cousin"].includes(t))) return "family";

  // Professional relationships
  if (lowerTags.some((t) => ["work", "colleague", "coworker", "boss", "manager"].includes(t))) return "colleague";
  if (lowerTags.some((t) => ["client", "customer"].includes(t))) return "client";
  if (lowerTags.some((t) => ["investor", "vc", "founder"].includes(t))) return "investor";
  if (lowerTags.some((t) => ["recruiter", "hr"].includes(t))) return "recruiter";

  // Personal relationships
  if (lowerTags.some((t) => ["friend", "close friend", "bestie", "bff"].includes(t))) return "friend";
  if (lowerTags.some((t) => ["partner", "spouse", "husband", "wife", "girlfriend", "boyfriend"].includes(t))) return "partner";

  return undefined;
}

/**
 * Build context prompt for multi-option generation including style.
 */
function buildContextPromptWithStyle(input: GenerateActionWithStyleInput): string {
  const { contact, messages, platform, hoursSinceLastMessage, recentActions, contactMemories } = input;

  const sections: string[] = [];

  // Contact info with relationship context
  const relationship = input.styleOverrides?.relationship || inferRelationshipFromTags(contact.tags);
  const contactLines = [`Name: ${contact.displayName}`];
  if (relationship) contactLines.push(`Relationship: ${relationship}`);
  if (contact.company) contactLines.push(`Company: ${contact.company}`);
  if (contact.tags && contact.tags.length > 0) contactLines.push(`Tags: ${contact.tags.join(", ")}`);
  sections.push(`## Contact\n${contactLines.join("\n")}`);

  // User's previous messages in THIS conversation - most important for style
  const userMessagesInConvo = messages.filter((m) => m.isFromMe);
  if (userMessagesInConvo.length > 0) {
    const exampleLines = userMessagesInConvo.slice(-5).map((msg) => {
      const timeAgo = formatTimestampRelative(msg.sentAt);
      return `[Me, ${timeAgo}]: ${truncate(msg.content, 300)}`;
    });
    sections.push(`## Your Previous Messages (copy this style)\n${exampleLines.join("\n")}`);
  }

  // Memories about this person
  if (contactMemories && contactMemories.length > 0) {
    const memoryLines = contactMemories.slice(0, 5).map((mem) => `- ${truncate(mem.memory, 150)}`);
    sections.push(`## Context\n${memoryLines.join("\n")}`);
  }

  // Recent conversation with sender and timestamp
  const recentMessages = messages.slice(-10);
  const messageLines = recentMessages.map((msg) => {
    const sender = msg.isFromMe ? "Me" : msg.senderName || contact.displayName;
    const timeAgo = formatTimestampRelative(msg.sentAt);
    return `[${sender}, ${timeAgo}]: ${truncate(msg.content, 400)}`;
  });
  if (messageLines.length === 0) messageLines.push("[No messages]");
  sections.push(`## Conversation (${platform})\n${messageLines.join("\n")}`);

  // Style profile
  if (input.styleProfile) {
    sections.push(`## Your Writing Style\n${formatStyleForPrompt(input.styleProfile)}`);
  }

  // Similar past replies
  if (input.similarReplies && input.similarReplies.length > 0) {
    sections.push(formatSimilarRepliesForPrompt(input.similarReplies));
  }

  // User policies
  if (input.userPolicies && input.userPolicies.length > 0) {
    sections.push(formatPoliciesForPrompt(input.userPolicies));
  }

  return sections.join("\n\n");
}

/**
 * Generate action suggestion with multiple draft options.
 * Uses style profile and similar replies for voice matching.
 */
export async function generateActionWithOptions(
  input: GenerateActionWithStyleInput
): Promise<ActionSuggestionWithOptions> {
  // Handle edge cases same as legacy function
  if (input.messages.length === 0) {
    return {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "Empty conversation - no context to analyze",
      suggestedResponse: null,
      draftOptions: [],
      riskLevel: "low",
      requiresApproval: false,
      remindAt: null,
    };
  }

  const lastMessage = input.messages[input.messages.length - 1];
  if (lastMessage?.isFromMe) {
    return {
      shouldCreateAction: false,
      type: null,
      priority: null,
      reason: "User sent the last message - waiting for reply",
      suggestedResponse: null,
      draftOptions: [],
      riskLevel: "low",
      requiresApproval: false,
      remindAt: null,
    };
  }

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
      draftOptions: [],
      riskLevel: "low",
      requiresApproval: false,
      remindAt: null,
    };
  }

  if (input.recentActions && input.recentActions.length > 0) {
    const mostRecentAction = input.recentActions[0];
    const mostRecentMessageTime = lastMessage?.sentAt ?? 0;
    if (mostRecentMessageTime <= mostRecentAction.createdAt) {
      return {
        shouldCreateAction: false,
        type: null,
        priority: null,
        reason: "No new messages since last action was created",
        suggestedResponse: null,
        draftOptions: [],
        riskLevel: "low",
        requiresApproval: false,
        remindAt: null,
      };
    }
  }

  const contextPrompt = buildContextPromptWithStyle(input);

  const { object } = await generateObject({
    model: openai(FAST_MODEL),
    schema: MultiOptionDraftSchema,
    system: MULTI_OPTION_SYSTEM_PROMPT,
    prompt: `Analyze this conversation and generate draft response options:\n\n${contextPrompt}`,
  });

  // Process draft options: classify risk and format sources
  const draftOptions: DraftOption[] = (object.draftOptions || []).map((opt) => {
    const riskResult = classifyRisk(opt.text, lastMessage?.content);
    const styleSources = input.similarReplies
      ?.slice(0, 2)
      .map((r) => {
        const date = new Date(r.sentAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        return r.recipientName
          ? `Similar reply to ${r.recipientName} on ${date}`
          : `Past reply on ${date}`;
      }) || [];

    return {
      text: opt.text,
      label: opt.label,
      confidence: opt.confidence,
      assumptions: opt.assumptions,
      styleSources,
      riskFlags: riskResult.flags.map((f) => ({
        type: f.type,
        trigger: f.trigger,
      })),
    };
  });

  // Determine overall risk level from all options
  const overallRisk = draftOptions.reduce<"low" | "medium" | "high">(
    (highest, opt) => {
      const risk = classifyRisk(opt.text);
      if (risk.level === "high") return "high";
      if (risk.level === "medium" && highest !== "high") return "medium";
      return highest;
    },
    "low"
  );

  const requiresApproval = overallRisk !== "low";

  // Legacy support: use first option's text as suggestedResponse
  const suggestedResponse = draftOptions.length > 0 ? draftOptions[0].text : null;

  return {
    shouldCreateAction: object.shouldCreateAction,
    type: object.type,
    priority: object.priority,
    reason: object.reason,
    remindAt: object.remindAt,
    suggestedResponse,
    draftOptions,
    riskLevel: overallRisk,
    requiresApproval,
  };
}

/**
 * Generate action with options and retry on failure.
 */
export async function generateActionWithOptionsRetry(
  input: GenerateActionWithStyleInput,
  maxRetries = 2
): Promise<ActionSuggestionWithOptions> {
  const totalAttempts = maxRetries + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await generateActionWithOptions(input);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < totalAttempts) {
        await delay(1000 * attempt);
      }
    }
  }

  console.error("generateActionWithOptions failed after retries:", lastError?.message);
  return {
    shouldCreateAction: false,
    type: null,
    priority: null,
    reason: `LLM analysis failed: ${lastError?.message ?? "unknown error"}`,
    suggestedResponse: null,
    draftOptions: [],
    riskLevel: "low",
    requiresApproval: false,
    remindAt: null,
  };
}
