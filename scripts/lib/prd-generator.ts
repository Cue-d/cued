import { z } from "zod";
import { executeClaudePrompt } from "./claude.js";
import type { ParsedIssue } from "./linear.js";

// =============================================================================
// PRD GENERATION PROMPT
// =============================================================================
// This prompt is the heart of PRD generation. Edit carefully.
// Uses ${} interpolation - all variables come from ParsedIssue.
// =============================================================================

const PRD_GENERATION_PROMPT = `
## CONTEXT

You are generating a PRD (Product Requirements Document) for a Linear issue.
This PRD will be executed by AI agents autonomously.
Quality over speed. Every task must be verifiable.

## FEATURE

Title: \${title}
Linear ID: \${identifier}

Overview:
\${overview}

Target Stack:
\${targetStack}

Acceptance Criteria:
\${acceptanceCriteria}

Key Decisions:
\${decisions}

## PRD FORMAT

Generate a JSON PRD with this structure:

{
  "project": "Feature name",
  "description": "Brief description",
  "linearIssueId": "\${identifier}",
  "target_stack": ["packages/foo/", "apps/bar/"],
  "decisions": {"key": "value"},
  "documentation": [
    {"url": "https://docs.example.com", "title": "API Docs", "reason": "Needed for X"}
  ],
  "reference_repos": [
    {"url": "https://github.com/org/repo", "description": "Similar pattern for Y"}
  ],
  "tasks": [...]
}

## DOCUMENTATION DISCOVERY

CRITICAL: Identify documentation an AI agent should fetch before implementing:

1. **Official Docs** - API refs, SDK guides, framework docs
2. **Reference Repos** - Open-source projects with similar patterns
3. **Internal Patterns** - Link to existing code if mentioned

Examples:
- Slack integration → Slack Web API docs, mautrix/slack repo
- Convex mutations → Convex docs for mutations
- Electron IPC → Electron IPC docs

Include REAL URLs. AI agents will fetch these before executing tasks.

## TASK STRUCTURE

Each task:
{
  "id": "1.1",              // phase.task format
  "phase": 1,               // 1=Foundation, 2=Core, 3=Integration, 4=Polish, 5=Testing
  "mode": "afk",            // "afk" (autonomous) or "hitl" (human review needed)
  "category": "setup",      // setup, integration, functional, ui, testing, refactor
  "description": "What this accomplishes",
  "steps": [
    "Step 1 - specific file/function",
    "Step 2 - specific action",
    "Verify: pnpm typecheck && pnpm lint - must pass"
  ],
  "passes": false,
  "dependencies": ["1.0"]   // optional - task IDs that must complete first
}

## TASK REQUIREMENTS

1. **Verifiable** - Every task ends with: "Verify: pnpm typecheck && pnpm lint - must pass"
2. **Specific** - Include file paths, function names, not vague descriptions
3. **Small** - 3-7 steps max. If larger, split into subtasks.
4. **Dependencies** - If task B needs task A's output, add dependencies array

## MODES

- "afk": Straightforward implementation, can run autonomously
- "hitl": Architectural decisions, security-sensitive, needs human review

## OUTPUT

Return ONLY valid JSON. No markdown. No explanation. Just the PRD object.
`;

// =============================================================================
// SCHEMAS
// =============================================================================

// Zod schemas for validation - intentionally flexible to support PRD-specific needs
const TaskSchema = z.object({
  id: z.string(), // Flexible ID format (e.g., "1.1", "setup", "test-auth")
  phase: z.number().int().positive().optional(), // Optional - some PRDs may not use phases
  mode: z.enum(["hitl", "afk"]).default("afk"),
  category: z.string().optional(), // Flexible category - PRD author decides
  description: z.string().min(1),
  steps: z.array(z.string()).min(1),
  passes: z.boolean().default(false),
  error: z.string().optional(), // Capture failures for retry
  dependencies: z.array(z.string()).optional(),
});

const DocumentationSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  reason: z.string().optional(), // Why this doc is relevant
});

const PRDSchema = z.object({
  project: z.string(),
  description: z.string(),
  linearIssueId: z.string().optional(),
  target_stack: z.array(z.string()).optional(),
  decisions: z.record(z.string()).optional(),
  // Documentation fields for AI context
  documentation: z.array(DocumentationSchema).optional(), // Relevant web docs to search
  reference_repos: z.array(z.object({
    url: z.string(),
    description: z.string(),
  })).optional(), // External repos to explore for patterns
  tasks: z.array(TaskSchema),
  // Allow arbitrary additional fields for PRD-specific needs
}).passthrough();

export type Task = z.infer<typeof TaskSchema>;
export type PRD = z.infer<typeof PRDSchema>;

/**
 * Interpolate the PRD prompt with issue data
 */
function buildPrompt(issue: ParsedIssue): string {
  const vars = {
    title: issue.title,
    identifier: issue.identifier,
    overview: issue.overview || issue.description || "(no overview provided)",
    targetStack: issue.targetStack.length > 0
      ? issue.targetStack.map((t) => `- ${t}`).join("\n")
      : "(not specified - infer from overview)",
    acceptanceCriteria: issue.acceptanceCriteria.length > 0
      ? issue.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")
      : "(derive from overview)",
    decisions: Object.keys(issue.decisions).length > 0
      ? Object.entries(issue.decisions).map(([k, v]) => `- **${k}**: ${v}`).join("\n")
      : "(none specified)",
  };

  // Simple template interpolation: replace ${key} with vars[key]
  return PRD_GENERATION_PROMPT.replace(
    /\$\{(\w+)\}/g,
    (_, key) => vars[key as keyof typeof vars] ?? `\${${key}}`
  );
}

/**
 * Generate PRD tasks from a parsed Linear issue using Claude Code CLI
 */
export function generatePRD(issue: ParsedIssue): PRD {
  const prompt = buildPrompt(issue);

  const response = executeClaudePrompt(prompt, { timeout: 180000 }); // 3 min timeout for generation

  if (!response.success) {
    throw new Error(`Failed to generate PRD: ${response.error}`);
  }

  // Parse JSON from response (handle markdown code blocks)
  let jsonStr = response.output;
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  const parsed = JSON.parse(jsonStr);

  // Ensure Linear issue ID is set
  parsed.linearIssueId = issue.identifier;

  // Validate with Zod
  return PRDSchema.parse(parsed);
}

/**
 * Validate a PRD against the schema
 */
export function validatePRD(prd: unknown): PRD {
  return PRDSchema.parse(prd);
}

/**
 * Get incomplete tasks from a PRD
 */
export function getIncompleteTasks(prd: PRD): Task[] {
  return prd.tasks.filter((task) => !task.passes);
}

/**
 * Get tasks by phase
 */
export function getTasksByPhase(prd: PRD, phase: number): Task[] {
  return prd.tasks.filter((task) => task.phase === phase);
}

/**
 * Calculate completion percentage
 */
export function getCompletionPercentage(prd: PRD): number {
  const total = prd.tasks.length;
  const completed = prd.tasks.filter((t) => t.passes).length;
  return Math.round((completed / total) * 100);
}

/**
 * Mark a task as completed
 */
export function markTaskComplete(prd: PRD, taskId: string): PRD {
  return {
    ...prd,
    tasks: prd.tasks.map((task) =>
      task.id === taskId ? { ...task, passes: true } : task
    ),
  };
}

/**
 * Check if a task's dependencies are satisfied
 */
export function canExecuteTask(prd: PRD, taskId: string): boolean {
  const task = prd.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  if (!task.dependencies || task.dependencies.length === 0) return true;

  return task.dependencies.every((depId) => {
    const dep = prd.tasks.find((t) => t.id === depId);
    return dep?.passes === true;
  });
}
