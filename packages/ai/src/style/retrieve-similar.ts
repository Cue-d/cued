import { embed } from "ai";
import { truncate } from "@prm/shared";
import { openai } from "../openai";

/** Platform types */
export type StylePlatform = "imessage" | "gmail" | "slack";

/** A retrieved similar message from user's history */
export interface SimilarReply {
  content: string;
  sentAt: number;
  platform: StylePlatform;
  recipientName?: string;
  incomingMessage?: string; // What they were replying to
  similarity: number; // 0-1 cosine similarity
}

/** Message to search against */
export interface SearchableMessage {
  _id: string;
  content: string;
  sentAt: number;
  platform: StylePlatform;
  isFromMe: boolean;
  senderName?: string;
  conversationId: string;
}

/** Conversation context for retrieval */
export interface ConversationContext {
  conversationId: string;
  contactName: string;
  platform: StylePlatform;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embed a text using OpenAI embeddings.
 * Uses text-embedding-3-small for cost efficiency.
 */
async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: text,
  });
  return embedding;
}

/**
 * Find similar past replies from user's sent messages.
 * Used for in-context learning during draft generation.
 *
 * @param incomingMessage - The message to reply to
 * @param sentMessages - User's sent message history
 * @param context - Conversation context (contact, platform)
 * @param limit - Max number of similar replies to return
 * @returns Array of similar past replies sorted by relevance
 */
export async function retrieveSimilarReplies(
  incomingMessage: string,
  sentMessages: SearchableMessage[],
  context: ConversationContext,
  limit = 5
): Promise<SimilarReply[]> {
  if (sentMessages.length === 0) {
    return [];
  }

  // Embed the incoming message
  const queryEmbedding = await embedText(incomingMessage);

  // Group messages by conversation to find what user was replying to
  const messagesByConversation = new Map<string, SearchableMessage[]>();
  for (const msg of sentMessages) {
    const existing = messagesByConversation.get(msg.conversationId) || [];
    existing.push(msg);
    messagesByConversation.set(msg.conversationId, existing);
  }

  // Score each sent message
  const candidates: Array<{
    message: SearchableMessage;
    incomingMessage?: string;
    similarity: number;
  }> = [];

  // Embed sent messages in batches for efficiency
  const userSentMessages = sentMessages.filter((m) => m.isFromMe);

  // For very large histories, sample to avoid excessive API calls
  const sampled =
    userSentMessages.length > 200
      ? userSentMessages.sort((a, b) => b.sentAt - a.sentAt).slice(0, 200)
      : userSentMessages;

  // Embed all sampled messages
  const embeddings = await Promise.all(
    sampled.map((m) => embedText(m.content))
  );

  for (let i = 0; i < sampled.length; i++) {
    const msg = sampled[i];
    const similarity = cosineSimilarity(queryEmbedding, embeddings[i]);

    // Find what they were replying to (previous message in same conversation)
    const conversationMessages =
      messagesByConversation.get(msg.conversationId) || [];
    const sortedConvo = conversationMessages.sort(
      (a, b) => a.sentAt - b.sentAt
    );
    const msgIndex = sortedConvo.findIndex((m) => m._id === msg._id);
    const previousMsg =
      msgIndex > 0 ? sortedConvo[msgIndex - 1] : undefined;

    // Boost score for same platform and same contact
    let boostedSimilarity = similarity;
    if (msg.platform === context.platform) {
      boostedSimilarity *= 1.1;
    }
    if (msg.conversationId === context.conversationId) {
      boostedSimilarity *= 1.2;
    }

    candidates.push({
      message: msg,
      incomingMessage:
        previousMsg && !previousMsg.isFromMe
          ? previousMsg.content
          : undefined,
      similarity: Math.min(1, boostedSimilarity),
    });
  }

  // Sort by similarity and take top results
  candidates.sort((a, b) => b.similarity - a.similarity);

  return candidates.slice(0, limit).map((c) => ({
    content: c.message.content,
    sentAt: c.message.sentAt,
    platform: c.message.platform as StylePlatform,
    recipientName: c.message.senderName,
    incomingMessage: c.incomingMessage,
    similarity: c.similarity,
  }));
}

/**
 * Format similar replies for inclusion in a prompt.
 * Creates a concise reference section for in-context learning.
 */
export function formatSimilarRepliesForPrompt(
  replies: SimilarReply[]
): string {
  if (replies.length === 0) {
    return "";
  }

  const formatted = replies.map((r, i) => {
    const date = new Date(r.sentAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    let entry = `[${i + 1}] ${date}`;
    if (r.recipientName) {
      entry += ` to ${r.recipientName}`;
    }
    entry += `:\n`;
    if (r.incomingMessage) {
      entry += `  Replying to: "${truncate(r.incomingMessage, 100)}"\n`;
    }
    entry += `  Your reply: "${truncate(r.content, 200)}"`;
    return entry;
  });

  return `## Similar Past Replies\n${formatted.join("\n\n")}`;
}
