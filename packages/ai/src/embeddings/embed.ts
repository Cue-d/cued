/**
 * Embedding utilities for action intelligence.
 * Generates embeddings for messages to enable similarity search and skip logic.
 */
import { embed, embedMany } from "ai";
import { EMBEDDING_MODEL } from "@cued/shared";
import { getEncoding } from "js-tiktoken";
import { gateway } from "../gateway";

// Lazy-loaded encoder for token counting (text-embedding-3-small uses cl100k_base)
let encoder: ReturnType<typeof getEncoding> | null = null;
function getEncoder() {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

/**
 * Message context for building embedding input.
 */
export interface MessageContext {
  content: string;
  isFromMe: boolean;
  senderName?: string;
}

/**
 * Platform metadata for richer embedding context.
 * Helps recognize patterns like "Slack #random channel" or "LinkedIn group messages".
 */
export interface EmbeddingMetadata {
  /** Conversation type: dm, group, channel */
  conversationType?: "dm" | "group" | "channel";
  /** Channel/group/thread name for non-DM conversations */
  conversationName?: string;
  /** All participant names (for group chats) */
  participantNames?: string[];
  /** Workspace identifier (Slack team name, Gmail account) */
  workspaceName?: string;
}

/**
 * Build embedding input from message context.
 * Format: Platform metadata / Context messages / Trigger message
 *
 * Including rich metadata helps the model recognize patterns like:
 * - "Slack #general channel messages" vs "Slack DMs"
 * - "LinkedIn group messages" vs "LinkedIn connection requests"
 * - "Multi-person group chats" where user often doesn't respond
 */
export function buildEmbeddingInput(
  triggerMessage: { content: string; senderName?: string },
  contextMessages: MessageContext[],
  platform: string,
  contactName: string,
  metadata?: EmbeddingMetadata
): string {
  const lines: string[] = [];

  // Platform and conversation type
  lines.push(`Platform: ${platform}`);
  if (metadata?.conversationType) {
    lines.push(`Type: ${metadata.conversationType}`);
  }

  // Channel/group name (important for Slack channels, LinkedIn groups)
  if (metadata?.conversationName && metadata.conversationType !== "dm") {
    lines.push(`Channel: ${metadata.conversationName}`);
  }

  // Participants (for group chats - helps identify patterns like "3+ person threads")
  if (metadata?.participantNames && metadata.participantNames.length > 1) {
    lines.push(`Participants: ${metadata.participantNames.join(", ")}`);
  } else {
    lines.push(`Contact: ${contactName}`);
  }

  // Workspace (helps distinguish work vs personal contexts)
  if (metadata?.workspaceName) {
    lines.push(`Workspace: ${metadata.workspaceName}`);
  }

  lines.push("---");

  // Add context messages (last N messages before trigger)
  for (const msg of contextMessages) {
    const sender = msg.isFromMe ? "Me" : (msg.senderName ?? contactName);
    lines.push(`${sender}: ${msg.content}`);
  }

  // Add trigger message
  const triggerSender = triggerMessage.senderName ?? contactName;
  lines.push(`${triggerSender}: ${triggerMessage.content}`);

  return lines.join("\n");
}

/**
 * Max tokens for text-embedding-3-small model (8192 limit, use 8000 for safety).
 *
 * TODO: Consider chunked embeddings table for better semantic coverage.
 *
 * Current approach (truncation):
 * + Simple, no schema changes
 * + Metadata header + trigger message preserved (truncates middle context)
 * + Sufficient for skip-logic pattern matching
 * - Loses old context in very long threads
 *
 * Future option (embeddings table with chunks):
 * + Full semantic coverage for long conversations
 * + Could embed more per-contact data (bio, notes, history)
 * + Better for semantic search/recommendations across all contacts
 * - Requires new `embeddingChunks` table with FK to actions/contacts
 * - Complex retrieval: multi-chunk search, deduplication, aggregation
 * - More API calls and storage costs
 * - Similarity scoring gets complicated (max? average? weighted?)
 */
const MAX_EMBEDDING_TOKENS = 8000;

/**
 * Truncate embedding input to fit within token limit.
 * Preserves: metadata header (before ---) + trigger message (last line)
 * Truncates: middle context messages (oldest first)
 */
function truncateForEmbedding(text: string): string {
  const enc = getEncoder();
  const tokens = enc.encode(text);

  if (tokens.length <= MAX_EMBEDDING_TOKENS) {
    return text;
  }

  // Split into header (metadata), context (middle), and trigger (last line)
  const lines = text.split("\n");
  const separatorIndex = lines.indexOf("---");

  // If no separator found, fall back to simple end truncation
  if (separatorIndex === -1) {
    const truncatedTokens = tokens.slice(-MAX_EMBEDDING_TOKENS);
    return enc.decode(truncatedTokens);
  }

  // Header = everything up to and including "---"
  const headerLines = lines.slice(0, separatorIndex + 1);
  const header = headerLines.join("\n");

  // Trigger = last line (the trigger message)
  const triggerLine = lines[lines.length - 1];

  // Context = everything between header and trigger
  const contextLines = lines.slice(separatorIndex + 1, -1);

  // Calculate token budgets
  const headerTokens = enc.encode(header + "\n").length;
  const triggerTokens = enc.encode("\n" + triggerLine).length;
  const availableForContext = MAX_EMBEDDING_TOKENS - headerTokens - triggerTokens;

  if (availableForContext <= 0) {
    // Header + trigger alone exceed limit, trim to fit
    const triggerTokens = enc.encode(triggerLine);
    if (triggerTokens.length >= MAX_EMBEDDING_TOKENS) {
      return enc.decode(triggerTokens.slice(-MAX_EMBEDDING_TOKENS));
    }

    const headerBudget = MAX_EMBEDDING_TOKENS - triggerTokens.length - 1;
    if (headerBudget <= 0) {
      return enc.decode(triggerTokens.slice(-MAX_EMBEDDING_TOKENS));
    }

    const headerTokens = enc.encode(header);
    const truncatedHeader = enc.decode(headerTokens.slice(0, headerBudget));
    return `${truncatedHeader}\n${triggerLine}`;
  }

  // Keep as many recent context lines as fit (newest = closest to trigger)
  const keptContextLines: string[] = [];
  let contextTokenCount = 0;

  for (let i = contextLines.length - 1; i >= 0; i--) {
    const lineTokens = enc.encode(contextLines[i] + "\n").length;
    if (contextTokenCount + lineTokens <= availableForContext) {
      keptContextLines.unshift(contextLines[i]);
      contextTokenCount += lineTokens;
    } else {
      break; // Stop when we can't fit more
    }
  }

  return header + "\n" + keptContextLines.join("\n") + (keptContextLines.length > 0 ? "\n" : "") + triggerLine;
}

/**
 * Embed a single text using OpenAI embeddings.
 */
export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(`openai/${EMBEDDING_MODEL}`),
    value: truncateForEmbedding(text),
  });
  return embedding;
}

/**
 * Embed multiple texts in a batch for efficiency.
 * Returns embeddings in the same order as inputs.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { embeddings } = await embedMany({
    model: gateway.textEmbeddingModel(`openai/${EMBEDDING_MODEL}`),
    values: texts.map(truncateForEmbedding),
  });
  return embeddings;
}
