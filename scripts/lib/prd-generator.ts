import { z } from "zod";
import { executeClaudePrompt } from "./claude.js";
import type { ParsedIssue } from "./linear.js";

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

const PRDSchema = z.object({
  project: z.string(),
  description: z.string(),
  linearIssueId: z.string().optional(),
  target_stack: z.array(z.string()).optional(),
  decisions: z.record(z.string()).optional(),
  tasks: z.array(TaskSchema),
  // Allow arbitrary additional fields for PRD-specific needs
}).passthrough();

export type Task = z.infer<typeof TaskSchema>;
export type PRD = z.infer<typeof PRDSchema>;

/**
 * Generate PRD tasks from a parsed Linear issue using Claude Code CLI
 */
export function generatePRD(issue: ParsedIssue): PRD {
  const prompt = `You are a software architect creating a PRD with executable tasks.

Generate a PRD for this feature:

## Title
${issue.title}

## Overview
${issue.overview || issue.description}

## Target Stack
${issue.targetStack.length > 0 ? issue.targetStack.map((t) => `- ${t}`).join("\n") : "(not specified)"}

## Acceptance Criteria
${issue.acceptanceCriteria.length > 0 ? issue.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n") : "(derive from overview)"}

## Key Decisions
${Object.keys(issue.decisions).length > 0 ? Object.entries(issue.decisions).map(([k, v]) => `- **${k}**: ${v}`).join("\n") : "(none specified)"}

## Task Requirements

**CRITICAL: Every task must be verifiable.** Each task's final step(s) MUST include verification:

1. **Run typecheck**: \`pnpm typecheck\` must pass with no errors
2. **Run linting**: \`pnpm lint\` must pass
3. **Run formatting**: Code must be properly formatted
4. **Run tests**: If tests exist for the modified code, they must pass

Example verification step: "Verify: run \`pnpm typecheck && pnpm lint && pnpm test\` - all must pass"

## Task Structure Guidelines

1. **IDs**: Use "phase.task" format (e.g., "1.1", "2.3") or descriptive names ("setup", "auth-flow")

2. **Phases** (optional but recommended):
   - Phase 1: Foundation/Setup
   - Phase 2: Core Implementation
   - Phase 3: Integration
   - Phase 4: Polish
   - Phase 5: Testing & Verification

3. **Modes**:
   - "hitl": Requires human review (architectural decisions, security, complex logic)
   - "afk": Can run autonomously (straightforward implementation)

4. **Steps**: 3-7 specific steps per task:
   - Actionable (start with verb)
   - Specific (file paths, function names)
   - Verifiable (concrete outcome)
   - MUST end with verification step

## Output Format

Return ONLY valid JSON (no markdown):
{
  "project": "${issue.title}",
  "description": "Brief description",
  "linearIssueId": "${issue.identifier}",
  "target_stack": ${JSON.stringify(issue.targetStack.length > 0 ? issue.targetStack : [])},
  "decisions": ${JSON.stringify(issue.decisions)},
  "tasks": [
    {
      "id": "1.1",
      "phase": 1,
      "mode": "afk",
      "category": "setup",
      "description": "What this task accomplishes",
      "steps": [
        "Step 1 - specific action",
        "Step 2 - specific action",
        "Verify: run typecheck, lint, and tests - all must pass"
      ],
      "passes": false
    }
  ]
}

Generate tasks that satisfy ALL acceptance criteria. Every task must end with a verification step.`;

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
