import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import * as readline from "readline";
import type { Task, PRD } from "./prd-generator.js";
import { markTaskComplete, canExecuteTask } from "./prd-generator.js";
import {
  appendProgress,
  createProgressEntry,
  getProgressFilePath,
} from "./progress.js";

export interface ExecutionResult {
  success: boolean;
  output: string;
  filesChanged: string[];
  decisions: string[];
  verificationResults: string[];
  notes: string[];
}

/**
 * Prompt user for confirmation (hitl mode)
 */
async function promptUser(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Format task for Claude Code prompt
 */
function formatTaskPrompt(task: Task, prd: PRD): string {
  return `Execute this task from the PRD for "${prd.project}":

## Task ${task.id}: ${task.description}

### Category: ${task.category}

### Steps:
${task.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

### Context:
- Target Stack: ${(prd.target_stack || []).join(", ") || "not specified"}
- Key Decisions: ${Object.entries(prd.decisions || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ") || "none specified"}

Execute all steps and verify completion. Report:
1. Files changed
2. Any decisions made
3. Verification results
4. Notes for future reference`;
}

/**
 * Execute a single task using Claude Code CLI
 */
export async function executeTask(
  task: Task,
  prd: PRD,
  prdPath: string
): Promise<ExecutionResult> {
  const prompt = formatTaskPrompt(task, prd);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Executing Task ${task.id}: ${task.description}`);
  console.log(`Mode: ${task.mode.toUpperCase()}`);
  console.log(`${"=".repeat(60)}\n`);

  // For hitl mode, ask for confirmation
  if (task.mode === "hitl") {
    console.log("Steps:");
    task.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.log("");

    const proceed = await promptUser("Proceed with this task?");
    if (!proceed) {
      return {
        success: false,
        output: "User skipped task",
        filesChanged: [],
        decisions: [],
        verificationResults: ["Task skipped by user"],
        notes: [],
      };
    }
  }

  try {
    // Execute using Claude Code CLI with spawnSync to avoid command injection
    const result = spawnSync("claude", ["--print", prompt], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
      cwd: process.cwd(),
      shell: false,
    });

    if (result.error) {
      return {
        success: false,
        output: result.error.message,
        filesChanged: [],
        decisions: [],
        verificationResults: [`Task failed: ${result.error.message}`],
        notes: [],
      };
    }

    if (result.status !== 0) {
      return {
        success: false,
        output: result.stderr || `Exit code: ${result.status}`,
        filesChanged: [],
        decisions: [],
        verificationResults: [`Task failed: ${result.stderr || `Exit code: ${result.status}`}`],
        notes: [],
      };
    }

    const output = result.stdout;

    // Parse output for structured data (simplified)
    const executionResult: ExecutionResult = {
      success: true,
      output,
      filesChanged: extractSection(output, "Files changed"),
      decisions: extractSection(output, "Decisions"),
      verificationResults: extractSection(output, "Verification"),
      notes: extractSection(output, "Notes"),
    };

    return executionResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: errorMessage,
      filesChanged: [],
      decisions: [],
      verificationResults: [`Task failed: ${errorMessage}`],
      notes: [],
    };
  }
}

/**
 * Extract a section from Claude's output
 */
function extractSection(output: string, sectionName: string): string[] {
  const regex = new RegExp(
    `(?:#{1,3}\\s*)?${sectionName}[:\\s]*\\n([\\s\\S]*?)(?=\\n#{1,3}|$)`,
    "i"
  );
  const match = output.match(regex);

  if (!match) return [];

  const lines = match[1]
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0);

  return lines;
}

/**
 * Execute all incomplete tasks in a PRD
 */
export async function executePRD(
  prd: PRD,
  prdPath: string,
  options: {
    phase?: number;
    dryRun?: boolean;
    stopOnError?: boolean;
  } = {}
): Promise<{ prd: PRD; results: Map<string, ExecutionResult> }> {
  const results = new Map<string, ExecutionResult>();
  let currentPRD = { ...prd };
  const progressPath = getProgressFilePath(prdPath);

  // Get tasks to execute
  let tasks = currentPRD.tasks.filter((t) => !t.passes);

  if (options.phase !== undefined) {
    tasks = tasks.filter((t) => t.phase === options.phase);
  }

  // Sort by phase and ID (undefined phase comes last)
  tasks.sort((a, b) => {
    const phaseA = a.phase ?? Number.MAX_SAFE_INTEGER;
    const phaseB = b.phase ?? Number.MAX_SAFE_INTEGER;
    if (phaseA !== phaseB) return phaseA - phaseB;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  console.log(`\nExecuting ${tasks.length} tasks...`);
  if (options.dryRun) {
    console.log("(DRY RUN - no changes will be made)\n");
  }

  for (const task of tasks) {
    // Check dependencies
    if (!canExecuteTask(currentPRD, task.id)) {
      console.log(`Skipping task ${task.id} - dependencies not met`);
      continue;
    }

    if (options.dryRun) {
      console.log(`[DRY RUN] Would execute: Task ${task.id} - ${task.description}`);
      continue;
    }

    const result = await executeTask(task, currentPRD, prdPath);
    results.set(task.id, result);

    if (result.success) {
      // Mark task complete and save PRD
      currentPRD = markTaskComplete(currentPRD, task.id);
      writeFileSync(prdPath, JSON.stringify(currentPRD, null, 2));

      // Log progress
      const progressEntry = createProgressEntry(task, result);
      appendProgress(progressPath, progressEntry);

      console.log(`\n✓ Task ${task.id} completed`);
    } else {
      console.log(`\n✗ Task ${task.id} failed: ${result.output}`);

      if (options.stopOnError) {
        console.log("Stopping execution due to error");
        break;
      }
    }
  }

  return { prd: currentPRD, results };
}

/**
 * Interactive execution with step-by-step confirmation
 */
export async function executeInteractive(
  prd: PRD,
  prdPath: string
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    const tasks = prd.tasks.filter((t) => !t.passes);

    for (const task of tasks) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Task ${task.id}: ${task.description}`);
      console.log(`Phase: ${task.phase} | Mode: ${task.mode} | Category: ${task.category}`);
      console.log(`${"=".repeat(60)}`);
      console.log("\nSteps:");
      task.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
      console.log("");

      const action = await question(
        "Action: [e]xecute, [s]kip, [q]uit: "
      );

      if (action.toLowerCase() === "q") {
        console.log("Exiting...");
        break;
      }

      if (action.toLowerCase() === "s") {
        console.log("Skipped");
        continue;
      }

      if (action.toLowerCase() === "e") {
        const result = await executeTask(task, prd, prdPath);

        if (result.success) {
          prd = markTaskComplete(prd, task.id);
          writeFileSync(prdPath, JSON.stringify(prd, null, 2));

          const progressEntry = createProgressEntry(task, result);
          appendProgress(getProgressFilePath(prdPath), progressEntry);

          console.log("✓ Task completed");
        } else {
          console.log(`✗ Task failed: ${result.output}`);
        }
      }
    }
  } finally {
    rl.close();
  }
}
