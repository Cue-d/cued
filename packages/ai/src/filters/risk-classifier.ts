/**
 * Risk classifier for auto-draft responses.
 * Determines approval requirements based on message content.
 */

/** Risk levels for draft responses */
export type RiskLevel = "low" | "medium" | "high";

/** Individual risk flag detected in a draft */
export interface RiskFlag {
  type:
    | "commitment"
    | "legal"
    | "financial"
    | "sensitive"
    | "deadline"
    | "apology"
    | "conflict";
  trigger: string; // The phrase that triggered the flag
  severity: RiskLevel;
}

/** Result of risk classification */
export interface RiskClassification {
  level: RiskLevel;
  flags: RiskFlag[];
  requiresApproval: boolean;
  autoApprovable: boolean;
}

// Patterns for low-risk (auto-approve) messages
const LOW_RISK_PATTERNS = [
  /^(got it|okay|ok|sounds good|perfect|great|thanks!?|thank you|cool|nice|yep|yup|yes|no|sure|alright|will do|on it)\.?$/i,
  /^(how about|what about|does) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm)?)\??$/i,
  /^(works for me|that works|sounds good to me)\.?$/i,
  /^(haha|lol|😂|😊|👍|🙏|❤️)+$/i,
];

// Patterns that indicate commitments
const COMMITMENT_PATTERNS = [
  /\bi('ll| will)\b/i,
  /\bpromise\b/i,
  /\bguarantee\b/i,
  /\bcommit\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})/i,
  /\bdeadline\b/i,
  /\bi can definitely\b/i,
  /\bcount on me\b/i,
];

// Patterns that indicate financial content
const FINANCIAL_PATTERNS = [
  /\$\d+/,
  /\b\d+k\b/i,
  /\bpay(ment|ing)?\b/i,
  /\binvoice\b/i,
  /\bprice\b/i,
  /\bcost\b/i,
  /\bbudget\b/i,
  /\bfee\b/i,
  /\bsalary\b/i,
  /\bcompensation\b/i,
  /\bequity\b/i,
  /\bstock\b/i,
  /\binvest(ment|or)?\b/i,
];

// Patterns that indicate legal content
const LEGAL_PATTERNS = [
  /\bcontract\b/i,
  /\bagreement\b/i,
  /\bterms\b/i,
  /\bliability\b/i,
  /\blawsuit\b/i,
  /\blegal\b/i,
  /\battorney\b/i,
  /\blawyer\b/i,
  /\bnda\b/i,
  /\bconfidential(ity)?\b/i,
  /\bindemnif/i,
  /\bwarrant(y|ies)?\b/i,
  /\bbinding\b/i,
  /\bsigned?\b/i,
];

// Patterns that indicate sensitive HR/personal content
const SENSITIVE_PATTERNS = [
  /\bfired?\b/i,
  /\bterminat(e|ed|ion)\b/i,
  /\blay ?off\b/i,
  /\bharass(ment|ing)?\b/i,
  /\bdiscriminat/i,
  /\bcomplaint\b/i,
  /\bgrievance\b/i,
  /\bmedical\b/i,
  /\bhealth\b/i,
  /\bpersonal (leave|matter|issue)\b/i,
  /\bdiagnos/i,
  /\bconfidential\b/i,
];

// Patterns that indicate conflict/escalation
const CONFLICT_PATTERNS = [
  /\bsorry but\b/i,
  /\bunfortunately\b/i,
  /\bdisappoint/i,
  /\bfrustrat/i,
  /\bupset\b/i,
  /\bangry\b/i,
  /\bunaccept/i,
  /\bescalat/i,
  /\bmanager\b/i,
  /\bsupervisor\b/i,
];

// Patterns that indicate apologies/blame
const APOLOGY_PATTERNS = [
  /\bi('m| am) sorry\b/i,
  /\bmy fault\b/i,
  /\bmy mistake\b/i,
  /\bi apologize\b/i,
  /\bour mistake\b/i,
  /\bwe apologize\b/i,
  /\bshould have\b/i,
  /\bshouldn't have\b/i,
];

// Patterns that indicate deadlines
const DEADLINE_PATTERNS = [
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bby \d{1,2}(\/|-)\d{1,2}\b/i,
  /\bby (end of|eod|eow|eom)\b/i,
  /\bdue (on|by)\b/i,
  /\bdeadline\b/i,
  /\basap\b/i,
  /\burgent\b/i,
];

/**
 * Check if a message matches any pattern in a list.
 * Returns the first matching pattern's matched text.
 */
function findMatch(
  text: string,
  patterns: RegExp[]
): { matched: boolean; trigger?: string } {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return { matched: true, trigger: match[0] };
    }
  }
  return { matched: false };
}

/**
 * Classify the risk level of a draft response.
 * Determines whether user approval is required before sending.
 *
 * @param draftText - The draft response text to classify
 * @param incomingMessage - Optional: the message being replied to (for context)
 * @returns Risk classification with flags and approval requirement
 */
export function classifyRisk(
  draftText: string,
  incomingMessage?: string
): RiskClassification {
  const text = draftText.trim();
  const flags: RiskFlag[] = [];

  // Check if it's a simple, auto-approvable message
  for (const pattern of LOW_RISK_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: "low",
        flags: [],
        requiresApproval: false,
        autoApprovable: true,
      };
    }
  }

  // Check for high-risk patterns
  const legalMatch = findMatch(text, LEGAL_PATTERNS);
  if (legalMatch.matched) {
    flags.push({
      type: "legal",
      trigger: legalMatch.trigger!,
      severity: "high",
    });
  }

  const sensitiveMatch = findMatch(text, SENSITIVE_PATTERNS);
  if (sensitiveMatch.matched) {
    flags.push({
      type: "sensitive",
      trigger: sensitiveMatch.trigger!,
      severity: "high",
    });
  }

  // Check for medium-risk patterns
  const commitmentMatch = findMatch(text, COMMITMENT_PATTERNS);
  if (commitmentMatch.matched) {
    flags.push({
      type: "commitment",
      trigger: commitmentMatch.trigger!,
      severity: "medium",
    });
  }

  const financialMatch = findMatch(text, FINANCIAL_PATTERNS);
  if (financialMatch.matched) {
    flags.push({
      type: "financial",
      trigger: financialMatch.trigger!,
      severity: "medium",
    });
  }

  const deadlineMatch = findMatch(text, DEADLINE_PATTERNS);
  if (deadlineMatch.matched) {
    flags.push({
      type: "deadline",
      trigger: deadlineMatch.trigger!,
      severity: "medium",
    });
  }

  const apologyMatch = findMatch(text, APOLOGY_PATTERNS);
  if (apologyMatch.matched) {
    flags.push({
      type: "apology",
      trigger: apologyMatch.trigger!,
      severity: "high",
    });
  }

  const conflictMatch = findMatch(text, CONFLICT_PATTERNS);
  if (conflictMatch.matched) {
    flags.push({
      type: "conflict",
      trigger: conflictMatch.trigger!,
      severity: "high",
    });
  }

  // Determine overall risk level
  const hasHighRisk = flags.some((f) => f.severity === "high");
  const hasMediumRisk = flags.some((f) => f.severity === "medium");

  let level: RiskLevel;
  if (hasHighRisk) {
    level = "high";
  } else if (hasMediumRisk) {
    level = "medium";
  } else {
    level = "low";
  }

  return {
    level,
    flags,
    requiresApproval: level !== "low",
    autoApprovable: level === "low" && flags.length === 0,
  };
}

/**
 * Determine the overall risk level for multiple draft options.
 * Returns the highest risk level among all options.
 */
export function getOverallRiskLevel(
  classifications: RiskClassification[]
): RiskLevel {
  const levels = classifications.map((c) => c.level);
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

/**
 * Format risk flags as a human-readable warning.
 * Used in UI to explain why approval is needed.
 */
export function formatRiskWarning(flags: RiskFlag[]): string {
  if (flags.length === 0) return "";

  const warnings = flags.map((f) => {
    switch (f.type) {
      case "commitment":
        return `Contains commitment: "${f.trigger}"`;
      case "legal":
        return `Contains legal language: "${f.trigger}"`;
      case "financial":
        return `Contains financial reference: "${f.trigger}"`;
      case "sensitive":
        return `Contains sensitive content: "${f.trigger}"`;
      case "deadline":
        return `Contains deadline: "${f.trigger}"`;
      case "apology":
        return `Contains apology: "${f.trigger}"`;
      case "conflict":
        return `Potential conflict escalation: "${f.trigger}"`;
      default:
        return `Flag: "${f.trigger}"`;
    }
  });

  return warnings.join("\n");
}
