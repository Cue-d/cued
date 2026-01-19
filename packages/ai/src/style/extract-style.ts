import { generateObject } from "ai";
import { z } from "zod";
import { openai, FAST_MODEL } from "../openai";

/** Platform types for style profiles */
export type StylePlatform = "imessage" | "gmail" | "slack";

/** Style profile extracted from user messages */
export interface StyleProfile {
  greetingStyle: string;
  signOffStyle: string;
  avgLength: number;
  emojiFrequency: number; // 0-1
  formalityScore: number; // 1-5
  brevityScore: number; // 1-5
  hedgingPatterns: string[];
  punctuationNotes: string;
}

/** Input message for style extraction */
export interface StyleMessage {
  content: string;
  platform: StylePlatform;
  sentAt: number;
  recipientName?: string;
}

/** Zod schema for LLM style profile output */
const StyleProfileSchema = z.object({
  greetingStyle: z
    .string()
    .describe(
      'Greeting pattern: "none", "Hey", "Hi [name]", "Hello", etc. Use [name] as placeholder if they use names'
    ),
  signOffStyle: z
    .string()
    .describe(
      'Sign-off pattern: "none", "Thanks", "Best", "—[initial]", etc. Use [initial] if they sign with initials'
    ),
  avgLength: z
    .number()
    .describe("Average message length in characters"),
  emojiFrequency: z
    .number()
    .min(0)
    .max(1)
    .describe("Emoji usage frequency 0-1 (0=never, 1=every message)"),
  formalityScore: z
    .number()
    .min(1)
    .max(5)
    .describe("Formality 1-5 (1=very casual, 5=very formal)"),
  brevityScore: z
    .number()
    .min(1)
    .max(5)
    .describe("Brevity 1-5 (1=very verbose, 5=very terse)"),
  hedgingPatterns: z
    .array(z.string())
    .describe('Hedging phrases used: "I think", "maybe", "perhaps", "might", etc.'),
  punctuationNotes: z
    .string()
    .describe(
      "Punctuation habits: period usage, exclamation frequency, ellipsis usage, capitalization style"
    ),
});

/** System prompt for style extraction */
const STYLE_EXTRACTION_PROMPT = `You are analyzing a user's writing style from their sent messages.
Extract patterns to help generate responses that match their natural voice.

Focus on:
1. How they start messages (greetings)
2. How they end messages (sign-offs)
3. Message length tendencies
4. Emoji and punctuation usage
5. Formality level
6. Whether they hedge/soften statements
7. Any distinctive patterns

Be specific and concrete. Use "[name]" or "[initial]" as placeholders where they vary by recipient.`;

/**
 * Extract a style profile from a user's sent messages.
 * Analyzes patterns to create a compact profile for draft generation.
 *
 * @param messages - Array of sent messages to analyze (recommend 50-200)
 * @param platform - Platform to extract style for
 * @returns StyleProfile with extracted patterns
 */
export async function extractStyleProfile(
  messages: StyleMessage[],
  platform: StylePlatform
): Promise<StyleProfile> {
  // Filter to platform-specific messages
  const platformMessages = messages.filter((m) => m.platform === platform);

  if (platformMessages.length === 0) {
    return getDefaultStyleProfile();
  }

  // Sample up to 100 messages for analysis (prioritize recent)
  const sampled = platformMessages
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, 100);

  // Format messages for LLM
  const messageText = sampled
    .map((m, i) => `[${i + 1}] ${m.content}`)
    .join("\n\n");

  // Calculate basic stats
  const lengths = sampled.map((m) => m.content.length);
  const avgLength = Math.round(
    lengths.reduce((a, b) => a + b, 0) / lengths.length
  );

  const { object } = await generateObject({
    model: openai(FAST_MODEL),
    schema: StyleProfileSchema,
    system: STYLE_EXTRACTION_PROMPT,
    prompt: `Analyze these ${sampled.length} sent messages from ${platform} and extract the user's writing style:

${messageText}

Pre-calculated average length: ${avgLength} characters`,
  });

  return {
    greetingStyle: object.greetingStyle,
    signOffStyle: object.signOffStyle,
    avgLength: object.avgLength || avgLength,
    emojiFrequency: object.emojiFrequency,
    formalityScore: object.formalityScore,
    brevityScore: object.brevityScore,
    hedgingPatterns: object.hedgingPatterns,
    punctuationNotes: object.punctuationNotes,
  };
}

/**
 * Get default style profile when no messages available.
 * Neutral, middle-of-the-road settings.
 */
export function getDefaultStyleProfile(): StyleProfile {
  return {
    greetingStyle: "Hey",
    signOffStyle: "none",
    avgLength: 100,
    emojiFrequency: 0.1,
    formalityScore: 3,
    brevityScore: 3,
    hedgingPatterns: [],
    punctuationNotes: "Standard punctuation",
  };
}

/**
 * Merge a base style profile with per-contact overrides.
 * Used when generating drafts for a specific contact.
 */
export function applyStyleOverrides(
  baseProfile: StyleProfile,
  overrides?: {
    formality?: number;
    brevity?: number;
    warmth?: number;
  }
): StyleProfile {
  if (!overrides) return baseProfile;

  return {
    ...baseProfile,
    formalityScore: overrides.formality ?? baseProfile.formalityScore,
    brevityScore: overrides.brevity ?? baseProfile.brevityScore,
    // Warmth affects emoji frequency and greeting style
    emojiFrequency: overrides.warmth
      ? Math.min(1, baseProfile.emojiFrequency + (overrides.warmth - 3) * 0.1)
      : baseProfile.emojiFrequency,
  };
}

/**
 * Format style profile as a concise prompt section.
 * Used in draft generation system prompts.
 */
export function formatStyleForPrompt(profile: StyleProfile): string {
  const lines = [
    `Greeting: ${profile.greetingStyle}`,
    `Sign-off: ${profile.signOffStyle}`,
    `Avg length: ~${profile.avgLength} chars`,
    `Formality: ${profile.formalityScore}/5`,
    `Brevity: ${profile.brevityScore}/5`,
    `Emoji freq: ${Math.round(profile.emojiFrequency * 100)}%`,
  ];

  if (profile.hedgingPatterns.length > 0) {
    lines.push(`Hedging: "${profile.hedgingPatterns.slice(0, 3).join('", "')}"`);
  }

  if (profile.punctuationNotes !== "Standard punctuation") {
    lines.push(`Punctuation: ${profile.punctuationNotes}`);
  }

  return lines.join("\n");
}
