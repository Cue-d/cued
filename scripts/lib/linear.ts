import { executeClaudePrompt, executeClaudeForJSON } from "./claude.js";

export interface ParsedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  overview: string;
  targetStack: string[];
  acceptanceCriteria: string[];
  decisions: Record<string, string>;
  references: string[];
}

export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state?: string;
  projectId?: string;
  teamId?: string;
}

/**
 * Fetch a Linear issue using Claude Code with Linear MCP
 */
export function getIssue(identifier: string): LinearIssueData | null {
  const prompt = `Using the Linear MCP, fetch the issue with identifier "${identifier}".

Return ONLY a JSON object with these fields (no markdown, no explanation):
{
  "id": "the issue UUID",
  "identifier": "the issue identifier like PRM-123",
  "title": "the issue title",
  "description": "the full issue description/body",
  "state": "the current state name",
  "projectId": "the project ID if any",
  "teamId": "the team ID"
}

If the issue is not found, return: {"error": "not found"}`;

  const result = executeClaudeForJSON<LinearIssueData | { error: string }>(prompt, {
    timeout: 60000,
  });

  if (!result.success || !result.data) {
    console.error("Failed to fetch issue:", result.error);
    return null;
  }

  if ("error" in result.data) {
    return null;
  }

  return result.data;
}

/**
 * Parse a Linear issue description into structured data
 * Flexible parsing - works with structured sections or plain text
 */
export function parseIssueDescription(
  description: string
): Omit<ParsedIssue, "id" | "identifier" | "title"> {
  const sections: Omit<ParsedIssue, "id" | "identifier" | "title"> = {
    description,
    overview: "",
    targetStack: [],
    acceptanceCriteria: [],
    decisions: {},
    references: [],
  };

  // Extract Overview section (multiple possible headers)
  const overviewMatch = description.match(
    /##\s*(?:Overview|Summary|Description|Goal)\s*\n([\s\S]*?)(?=\n## |$)/i
  );
  if (overviewMatch) {
    sections.overview = overviewMatch[1].trim();
  } else {
    // No explicit section - use first paragraph as overview
    const firstPara = description.split(/\n\n/)[0];
    if (firstPara && !firstPara.startsWith("##")) {
      sections.overview = firstPara.trim();
    }
  }

  // Extract Target Stack section (multiple possible headers)
  const stackMatch = description.match(
    /##\s*(?:Target Stack|Stack|Technologies|Tech Stack)\s*\n([\s\S]*?)(?=\n## |$)/i
  );
  if (stackMatch) {
    const stackLines = stackMatch[1].match(/^[-*]\s+(.+)$/gm) || [];
    sections.targetStack = stackLines.map((line) =>
      line.replace(/^[-*]\s+/, "").trim()
    );
  }

  // Extract Acceptance Criteria (multiple possible headers, with or without checkboxes)
  const criteriaMatch = description.match(
    /##\s*(?:Acceptance Criteria|Criteria|Requirements|Success Criteria)\s*\n([\s\S]*?)(?=\n## |$)/i
  );
  if (criteriaMatch) {
    // Try checkbox format first
    let criteriaLines = criteriaMatch[1].match(/^[-*]\s+\[[ x]\]\s+(.+)$/gim) || [];
    if (criteriaLines.length > 0) {
      sections.acceptanceCriteria = criteriaLines.map((line) =>
        line.replace(/^[-*]\s+\[[ x]\]\s+/i, "").trim()
      );
    } else {
      // Fall back to plain bullet list
      criteriaLines = criteriaMatch[1].match(/^[-*]\s+(.+)$/gm) || [];
      sections.acceptanceCriteria = criteriaLines.map((line) =>
        line.replace(/^[-*]\s+/, "").trim()
      );
    }
  }

  // Extract Key Decisions section (multiple possible headers)
  const decisionsMatch = description.match(
    /##\s*(?:Key Decisions|Decisions|Design Decisions|Technical Decisions)\s*\n([\s\S]*?)(?=\n## |$)/i
  );
  if (decisionsMatch) {
    // Try bold key format: **Key**: Value
    const decisionLines = decisionsMatch[1].match(/^[-*]\s+\*\*(.+?)\*\*:\s*(.+)$/gm) || [];
    for (const line of decisionLines) {
      const match = line.match(/^[-*]\s+\*\*(.+?)\*\*:\s*(.+)$/);
      if (match) {
        sections.decisions[match[1].trim()] = match[2].trim();
      }
    }
    // If no bold format, try plain bullet list as key-value
    if (Object.keys(sections.decisions).length === 0) {
      const plainDecisions = decisionsMatch[1].match(/^[-*]\s+(.+)$/gm) || [];
      plainDecisions.forEach((line, i) => {
        const cleaned = line.replace(/^[-*]\s+/, "").trim();
        sections.decisions[`decision_${i + 1}`] = cleaned;
      });
    }
  }

  // Extract References section
  const refsMatch = description.match(
    /##\s*(?:References|Links|Resources)\s*\n([\s\S]*?)(?=\n## |$)/i
  );
  if (refsMatch) {
    const refLines = refsMatch[1].match(/^[-*]\s+\[.+?\]\(.+?\)$/gm) || [];
    sections.references = refLines.map((line) =>
      line.replace(/^[-*]\s+/, "").trim()
    );
  }

  return sections;
}

/**
 * Fetch and parse a Linear issue
 */
export function fetchAndParseIssue(identifier: string): ParsedIssue | null {
  const issue = getIssue(identifier);
  if (!issue) return null;

  const parsed = parseIssueDescription(issue.description || "");

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...parsed,
  };
}

/**
 * Update Linear issue status using Claude Code with Linear MCP
 */
export function updateIssueStatus(
  issueIdentifier: string,
  status: "Todo" | "In Progress" | "In Review" | "Done"
): boolean {
  const prompt = `Using the Linear MCP, update issue "${issueIdentifier}" to status "${status}".

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Add a comment to a Linear issue using Claude Code with Linear MCP
 */
export function addIssueComment(
  issueIdentifier: string,
  body: string
): boolean {
  const prompt = `Using the Linear MCP, add a comment to issue "${issueIdentifier}" with this body:

${JSON.stringify(body)}

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Create or update a Linear document for progress tracking
 * Returns the document ID if successful
 */
export function syncProgressDocument(
  projectName: string,
  title: string,
  content: string
): { success: boolean; documentId?: string } {
  const prompt = `Using the Linear MCP, create or update a document in project "${projectName}" with:
- Title: ${JSON.stringify(title)}
- Content: ${JSON.stringify(content)}

If a document with this title exists, update it. Otherwise create a new one.

Return: {"success": true, "documentId": "the-doc-id"} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{
    success: boolean;
    documentId?: string;
    error?: string;
  }>(prompt, { timeout: 60000 });

  if (result.success && result.data?.success) {
    return { success: true, documentId: result.data.documentId };
  }
  return { success: false };
}

/**
 * Update issue description with appended progress section
 */
export function updateIssueDescription(
  issueIdentifier: string,
  progressMarkdown: string
): boolean {
  const prompt = `Using the Linear MCP:
1. First get the current description of issue "${issueIdentifier}"
2. Check if it already has a "## 🤖 AI Progress Log" section
3. If it does, replace that section with the new content below
4. If it doesn't, append the new section at the end

New progress section to add/replace:
${JSON.stringify(progressMarkdown)}

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 60000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Get the current authenticated user from Linear
 */
export function getCurrentUser(): { id: string; name: string; email: string } | null {
  const prompt = `Using the Linear MCP, get the currently authenticated user (me/viewer).

Return ONLY a JSON object (no markdown):
{
  "id": "user UUID",
  "name": "user display name",
  "email": "user email"
}`;

  const result = executeClaudeForJSON<{ id: string; name: string; email: string }>(
    prompt,
    { timeout: 30000 }
  );

  if (!result.success || !result.data) {
    return null;
  }

  return result.data;
}

/**
 * Get all team members for review assignment
 */
export function getTeamMembers(
  teamId?: string
): Array<{ id: string; name: string; email: string }> {
  const teamFilter = teamId ? ` for team ${teamId}` : "";
  const prompt = `Using the Linear MCP, list all team members${teamFilter}.

Return ONLY a JSON array (no markdown):
[
  {"id": "user UUID", "name": "display name", "email": "email"}
]`;

  const result = executeClaudeForJSON<Array<{ id: string; name: string; email: string }>>(
    prompt,
    { timeout: 30000 }
  );

  return result.data || [];
}

/**
 * Assign an issue to a user
 */
export function assignIssue(issueIdentifier: string, userId: string): boolean {
  const prompt = `Using the Linear MCP, assign issue "${issueIdentifier}" to user with ID "${userId}".

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Get existing labels on an issue
 */
export function getIssueLabels(issueIdentifier: string): string[] {
  const prompt = `Using the Linear MCP, get the labels currently on issue "${issueIdentifier}".

Return ONLY a JSON array of label names (no markdown):
["label1", "label2"]

If no labels, return: []`;

  const result = executeClaudeForJSON<string[]>(prompt, { timeout: 30000 });

  return result.data || [];
}

/**
 * Add labels to an issue based on type
 */
export function addLabelsToIssue(
  issueIdentifier: string,
  labels: string[]
): boolean {
  const labelList = labels.join(", ");
  const prompt = `Using the Linear MCP, add these labels to issue "${issueIdentifier}": ${labelList}

If a label doesn't exist, create it first. Common labels: feature, bug, enhancement, documentation, infrastructure.

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Request review from team members (add as subscribers/followers)
 */
export function requestReview(
  issueIdentifier: string,
  reviewerIds: string[]
): boolean {
  const reviewerList = reviewerIds.join(", ");
  const prompt = `Using the Linear MCP, add these users as subscribers to issue "${issueIdentifier}" for review: ${reviewerList}

Also add a comment mentioning them for review: "Requesting review from team members."

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Link a PR URL to a Linear issue
 */
export function linkPRToIssue(
  issueIdentifier: string,
  prUrl: string,
  title?: string
): boolean {
  const linkTitle = title || `PR: ${prUrl.split("/").pop()}`;
  const prompt = `Using the Linear MCP, add a link to issue "${issueIdentifier}" with:
- URL: ${prUrl}
- Title: ${linkTitle}

Use the update_issue tool with the links parameter.

Confirm with: {"success": true} or {"success": false, "error": "reason"}`;

  const result = executeClaudeForJSON<{ success: boolean; error?: string }>(
    prompt,
    { timeout: 30000 }
  );

  return result.success && result.data?.success === true;
}

/**
 * Get existing links on an issue
 */
export function getIssueLinks(
  issueIdentifier: string
): Array<{ url: string; title: string }> {
  const prompt = `Using the Linear MCP, get the links/attachments currently on issue "${issueIdentifier}".

Return ONLY a JSON array (no markdown):
[{"url": "https://...", "title": "Link title"}]

If no links, return: []`;

  const result = executeClaudeForJSON<Array<{ url: string; title: string }>>(
    prompt,
    { timeout: 30000 }
  );

  return result.data || [];
}

/**
 * Determine appropriate labels based on issue content
 */
export function inferLabelsFromContent(
  title: string,
  description: string
): string[] {
  const labels: string[] = [];
  const content = `${title} ${description}`.toLowerCase();

  // Feature indicators
  if (
    content.includes("add") ||
    content.includes("implement") ||
    content.includes("create") ||
    content.includes("new feature")
  ) {
    labels.push("feature");
  }

  // Bug indicators
  if (
    content.includes("fix") ||
    content.includes("bug") ||
    content.includes("error") ||
    content.includes("broken")
  ) {
    labels.push("bug");
  }

  // Enhancement indicators
  if (
    content.includes("improve") ||
    content.includes("enhance") ||
    content.includes("optimize") ||
    content.includes("refactor")
  ) {
    labels.push("enhancement");
  }

  // Documentation indicators
  if (
    content.includes("doc") ||
    content.includes("readme") ||
    content.includes("documentation")
  ) {
    labels.push("documentation");
  }

  // Infrastructure indicators
  if (
    content.includes("ci") ||
    content.includes("deploy") ||
    content.includes("infrastructure") ||
    content.includes("build")
  ) {
    labels.push("infrastructure");
  }

  // Default to feature if no labels detected
  if (labels.length === 0) {
    labels.push("feature");
  }

  return labels;
}
