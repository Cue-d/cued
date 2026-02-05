/**
 * LLM-based fuzzy match decision for contact resolution.
 * Uses Kimi K2.5 thinking via Vercel AI Gateway to analyze contact metadata
 * and decide if contacts are the same person.
 * Triggered for Tier 3 fuzzy matches (see MATCH_TIERS in thresholds.ts).
 */

import { generateObject } from "ai";
import { z } from "zod";
import { gateway, MODEL } from "../gateway";
import { withRetry } from "../utils";
import { LLM } from "./thresholds";

/** A message snippet for context */
export interface MessageSnippet {
  text: string;
  timestamp: string;
  platform: string;
  isFromContact: boolean;
  conversationType: "dm" | "group" | "channel";
}

/** A contact handle with type information */
export interface TypedHandle {
  type: "email" | "phone" | "linkedin" | "slack" | "other";
  value: string;
}

/** Input for LLM fuzzy match decision */
export interface ContactMatchInput {
  contact1: {
    displayName: string;
    company?: string;
    handles: string[] | TypedHandle[];
    recentMessages?: MessageSnippet[];
    notes?: string;
  };
  contact2: {
    displayName: string;
    company?: string;
    handles: string[] | TypedHandle[];
    recentMessages?: MessageSnippet[];
    notes?: string;
  };
  /** Jaro-Winkler fuzzy match score (TIER_3_LLM_REVIEW <= score < TIER_1_DETERMINISTIC) */
  fuzzyScore: number;
}

/** Zod schema for LLM fuzzy match decision output */
export const FuzzyMatchDecisionSchema = z.object({
  samePerson: z
    .boolean()
    .describe("Whether the two contacts likely refer to the same person"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the decision (0-1)"),
  reasoning: z
    .string()
    .describe("Brief explanation of why the contacts are or are not the same person"),
});

export type FuzzyMatchDecision = z.infer<typeof FuzzyMatchDecisionSchema>;

/** System prompt for contact matching decision */
const SYSTEM_PROMPT = `You are analyzing two contact records to determine if they refer to the same person.

Consider these factors:
1. **Names**: Are the names similar? Account for nicknames (Bob/Robert), typos, middle names, and name variations.
2. **Company**: If both have company info, do they match or conflict?
3. **Handles**: Do any email addresses, phone numbers, LinkedIn usernames, or social handles overlap or suggest the same person?
4. **Message Context**: If provided, do the message snippets suggest these are the same or different people? Look for context clues, topics, writing style, and any identifying information.

Be conservative: only return samePerson=true if you're reasonably confident they're the same person.
Return samePerson=false if there's significant evidence they're different people (e.g., different companies, conflicting handles, messages that clearly indicate different identities).`;

/**
 * Format handles for display, supporting both string[] and TypedHandle[]
 */
function formatHandles(handles: string[] | TypedHandle[]): string {
  if (handles.length === 0) return "";

  // Check if first element is a TypedHandle
  if (typeof handles[0] === "object" && "type" in handles[0]) {
    return (handles as TypedHandle[])
      .map((h) => `${h.type}: ${h.value}`)
      .join(", ");
  }
  return (handles as string[]).join(", ");
}

/**
 * Format message snippets for display
 */
function formatMessages(messages?: MessageSnippet[]): string {
  if (!messages || messages.length === 0) return "";

  return messages
    .map((m) => {
      const sender = m.isFromContact ? "Them" : "You";
      const convType = m.conversationType === "dm" ? "" : ` (${m.conversationType})`;
      const text = m.text.slice(0, 100);
      const ellipsis = m.text.length > 100 ? "..." : "";
      return `  - [${sender}, ${m.platform}${convType}]: "${text}${ellipsis}"`;
    })
    .join("\n");
}

/**
 * Build prompt with contact metadata for LLM analysis.
 */
function buildMatchPrompt(input: ContactMatchInput): string {
  const { contact1, contact2, fuzzyScore } = input;

  const formatContact = (
    c: ContactMatchInput["contact1"],
    label: string
  ): string => {
    const lines = [`${label}:`];
    lines.push(`  Name: ${c.displayName}`);
    if (c.company) lines.push(`  Company: ${c.company}`);
    if (c.notes) lines.push(`  Notes: ${c.notes.slice(0, 100)}${c.notes.length > 100 ? "..." : ""}`);
    const handlesStr = formatHandles(c.handles);
    if (handlesStr) {
      lines.push(`  Handles: ${handlesStr}`);
    }
    const messagesStr = formatMessages(c.recentMessages);
    if (messagesStr) {
      lines.push(`  Recent messages:\n${messagesStr}`);
    }
    return lines.join("\n");
  };

  return `Two contacts have a fuzzy name match score of ${(fuzzyScore * 100).toFixed(0)}%.

${formatContact(contact1, "Contact 1")}

${formatContact(contact2, "Contact 2")}

Are these the same person? Consider name similarity, company match, overlapping handles, and any context from messages.`;
}

/**
 * Use LLM to decide if two fuzzy-matched contacts are the same person.
 * Called for Tier 3 matches (0.60 <= fuzzyScore < 0.95).
 *
 * Uses Kimi K2.5 thinking via Vercel AI Gateway for reasoning capabilities.
 */
export async function decideFuzzyMatch(
  input: ContactMatchInput
): Promise<FuzzyMatchDecision> {
  const prompt = buildMatchPrompt(input);

  const { object } = await generateObject({
    model: gateway(MODEL),
    schema: FuzzyMatchDecisionSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object;
}

/**
 * Decide fuzzy match with retry on failure.
 * Returns safe default if LLM fails after retries.
 */
export async function decideFuzzyMatchWithRetry(
  input: ContactMatchInput,
  maxRetries = LLM.MAX_RETRIES
): Promise<FuzzyMatchDecision> {
  return withRetry(() => decideFuzzyMatch(input), {
    maxRetries,
    defaultValue: {
      samePerson: false,
      confidence: 0,
      reasoning: "LLM analysis failed after retries",
    },
    logPrefix: "decideFuzzyMatch",
  });
}
