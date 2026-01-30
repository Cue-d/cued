/**
 * Embedding utilities for action intelligence.
 * Generates embeddings for messages to enable similarity search and skip logic.
 */
import { embed, embedMany } from "ai";
import { EMBEDDING_MODEL } from "@cued/shared";
import { gateway } from "../gateway";

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
 * Embed a single text using OpenAI embeddings.
 */
export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(`openai/${EMBEDDING_MODEL}`),
    value: text,
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
    values: texts,
  });
  return embeddings;
}

