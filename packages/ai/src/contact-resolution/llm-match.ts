/**
 * LLM-based fuzzy match decision for contact resolution.
 * Uses gpt-5-mini to analyze contact metadata and decide if contacts are the same person.
 * Triggered for Tier 3 fuzzy matches (confidence 0.60-0.94).
 */

import { generateObject } from "ai";
import { z } from "zod";
import { openai, FAST_MODEL } from "../openai";
import { withRetry } from "../utils";

/** Input for LLM fuzzy match decision */
export interface ContactMatchInput {
  contact1: {
    displayName: string;
    company?: string;
    handles: string[];
  };
  contact2: {
    displayName: string;
    company?: string;
    handles: string[];
  };
  /** Jaro-Winkler fuzzy match score (0.60-0.94) */
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

/** LLM confidence threshold to create action card */
export const LLM_CONFIDENCE_THRESHOLD = 0.70;

/** System prompt for contact matching decision */
const SYSTEM_PROMPT = `You are analyzing two contact records to determine if they refer to the same person.

Consider these factors:
1. **Names**: Are the names similar? Account for nicknames (Bob/Robert), typos, middle names, and name variations.
2. **Company**: If both have company info, do they match or conflict?
3. **Handles**: Do any email addresses, phone numbers, or social handles overlap or suggest the same person?

Be conservative: only return samePerson=true if you're reasonably confident they're the same person.
Return samePerson=false if there's significant evidence they're different people (e.g., different companies, conflicting handles).`;

/**
 * Build prompt with contact metadata for LLM analysis.
 */
function buildMatchPrompt(input: ContactMatchInput): string {
  const { contact1, contact2, fuzzyScore } = input;

  const formatContact = (c: ContactMatchInput["contact1"], label: string): string => {
    const lines = [`${label}:`];
    lines.push(`  Name: ${c.displayName}`);
    if (c.company) lines.push(`  Company: ${c.company}`);
    if (c.handles.length > 0) {
      lines.push(`  Handles: ${c.handles.join(", ")}`);
    }
    return lines.join("\n");
  };

  return `Two contacts have a fuzzy name match score of ${(fuzzyScore * 100).toFixed(0)}%.

${formatContact(contact1, "Contact 1")}

${formatContact(contact2, "Contact 2")}

Are these the same person? Consider name similarity, company match, and any overlapping handles.`;
}

/**
 * Use LLM to decide if two fuzzy-matched contacts are the same person.
 * Called for Tier 3 matches (0.60 <= fuzzyScore < 0.95).
 *
 * Token estimate: ~200-300 tokens input (2 contacts + prompt), ~50 tokens output
 * At gpt-5-mini pricing, ~$0.0001 per decision
 */
export async function decideFuzzyMatch(
  input: ContactMatchInput
): Promise<FuzzyMatchDecision> {
  const prompt = buildMatchPrompt(input);

  const { object } = await generateObject({
    model: openai(FAST_MODEL),
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
  maxRetries = 2
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
