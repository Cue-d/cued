import { generateObject } from "ai";
import { z } from "zod";
import { truncate } from "@prm/shared";
import { openai, FAST_MODEL } from "../openai";

/** A user policy/rule extracted from behavior patterns */
export interface UserPolicy {
  rule: string; // The extracted rule
  confidence: number; // 0-1 confidence in the rule
  evidence: string[]; // Examples that support the rule
  category:
    | "scheduling"
    | "communication"
    | "commitment"
    | "delegation"
    | "boundary"
    | "other";
}

/** Message history item for policy extraction */
export interface PolicyExtractionMessage {
  content: string;
  sentAt: number;
  isFromMe: boolean;
  conversationId: string;
  recipientName?: string;
}

/** Zod schema for policy extraction output */
const PolicyExtractionSchema = z.object({
  policies: z.array(
    z.object({
      rule: z
        .string()
        .describe("The rule/policy stated in imperative form, e.g., 'Never schedule before 10am'"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Confidence 0-1 based on how consistent the pattern is"),
      evidence: z
        .array(z.string())
        .describe("2-3 brief examples from the messages that support this rule"),
      category: z.enum([
        "scheduling",
        "communication",
        "commitment",
        "delegation",
        "boundary",
        "other",
      ]),
    })
  ),
});

/** System prompt for policy extraction */
const POLICY_EXTRACTION_PROMPT = `You are analyzing a user's message history to extract implicit rules and policies they follow.

Look for patterns like:
- Scheduling preferences (preferred times, days they avoid, buffer requirements)
- Communication preferences (who gets CC'd, preferred channels, response times)
- Commitment patterns (how they hedge, what they avoid committing to)
- Delegation patterns (what they handle vs. defer to others)
- Boundaries (topics they redirect, requests they decline)

Only extract rules that have strong evidence across multiple messages.
Express rules in imperative form: "Always...", "Never...", "Prefer...", "Avoid..."
Be specific - "Never schedule before 10am" not "Prefers later mornings"`;

/**
 * Extract user policies from message history.
 * Detects implicit rules from behavior patterns.
 *
 * @param messages - User's message history (both sent and received)
 * @param limit - Max number of policies to extract
 * @returns Array of extracted policies with confidence scores
 */
export async function extractUserPolicies(
  messages: PolicyExtractionMessage[],
  limit = 10
): Promise<UserPolicy[]> {
  if (messages.length < 20) {
    // Not enough data for reliable policy extraction
    return [];
  }

  // Focus on user's sent messages and what they were responding to
  const userMessages = messages.filter((m) => m.isFromMe);
  if (userMessages.length < 10) {
    return [];
  }

  // Sample recent messages for analysis
  const sampled = userMessages
    .sort((a, b) => b.sentAt - a.sentAt)
    .slice(0, 150);

  // Group by conversation to understand context
  const conversationGroups = new Map<string, PolicyExtractionMessage[]>();
  for (const msg of messages) {
    const existing = conversationGroups.get(msg.conversationId) || [];
    existing.push(msg);
    conversationGroups.set(msg.conversationId, existing);
  }

  // Format messages with context
  const formattedMessages = sampled.map((msg) => {
    const convoMessages = conversationGroups.get(msg.conversationId) || [];
    const sorted = convoMessages.sort((a, b) => a.sentAt - b.sentAt);
    const msgIndex = sorted.findIndex(
      (m) => m.sentAt === msg.sentAt && m.content === msg.content
    );

    // Get the message being replied to
    let context = "";
    if (msgIndex > 0) {
      const prevMsg = sorted[msgIndex - 1];
      if (!prevMsg.isFromMe) {
        context = `[Replying to: "${truncate(prevMsg.content, 100)}"]\n`;
      }
    }

    const recipient = msg.recipientName ? ` to ${msg.recipientName}` : "";
    return `${context}[User${recipient}]: ${msg.content}`;
  });

  const { object } = await generateObject({
    model: openai(FAST_MODEL),
    schema: PolicyExtractionSchema,
    system: POLICY_EXTRACTION_PROMPT,
    prompt: `Analyze these ${sampled.length} messages and extract the user's implicit policies and rules:

${formattedMessages.join("\n\n")}

Extract up to ${limit} high-confidence policies.`,
  });

  return object.policies
    .filter((p) => p.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Format policies for inclusion in a draft generation prompt.
 * Creates a concise constraints section.
 */
export function formatPoliciesForPrompt(policies: UserPolicy[]): string {
  if (policies.length === 0) {
    return "";
  }

  const lines = policies.map((p) => `- ${p.rule}`);
  return `## User's Rules (must follow):\n${lines.join("\n")}`;
}

/**
 * Check if a draft violates any user policies.
 * Returns list of violated policies with explanations.
 */
export function checkPolicyViolations(
  draftText: string,
  policies: UserPolicy[]
): Array<{ policy: UserPolicy; explanation: string }> {
  const violations: Array<{ policy: UserPolicy; explanation: string }> = [];

  for (const policy of policies) {
    const rule = policy.rule.toLowerCase();
    const draft = draftText.toLowerCase();

    // Simple heuristic checks for common policy patterns
    if (rule.includes("never") || rule.includes("don't") || rule.includes("avoid")) {
      // Check for negative rules
      const keywords = extractKeywords(rule);
      for (const keyword of keywords) {
        if (draft.includes(keyword)) {
          violations.push({
            policy,
            explanation: `Draft contains "${keyword}" which may violate: "${policy.rule}"`,
          });
          break;
        }
      }
    }

    // Check scheduling constraints
    if (policy.category === "scheduling") {
      const timeMatch = draft.match(
        /\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/i
      );
      if (timeMatch) {
        // Could add more sophisticated time checking here
        violations.push({
          policy,
          explanation: `Draft mentions time "${timeMatch[0]}" - verify against: "${policy.rule}"`,
        });
      }
    }

    // Check commitment constraints
    if (
      policy.category === "commitment" &&
      (draft.includes("i will") ||
        draft.includes("i'll") ||
        draft.includes("promise") ||
        draft.includes("definitely"))
    ) {
      violations.push({
        policy,
        explanation: `Draft contains commitment language - verify against: "${policy.rule}"`,
      });
    }
  }

  return violations;
}

/**
 * Extract key nouns/verbs from a rule for matching.
 */
function extractKeywords(rule: string): string[] {
  const stopWords = new Set([
    "never",
    "always",
    "don't",
    "do",
    "not",
    "avoid",
    "prefer",
    "a",
    "an",
    "the",
    "to",
    "for",
    "with",
    "without",
    "before",
    "after",
    "during",
    "i",
    "me",
    "my",
    "we",
    "our",
  ]);

  return rule
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}
