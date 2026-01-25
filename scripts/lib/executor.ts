import { spawnSync, spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import * as readline from "readline";
import type { Task, PRD } from "./prd-generator.js";
import { markTaskComplete, canExecuteTask } from "./prd-generator.js";
import {
  appendProgress,
  createProgressEntry,
  getProgressFilePath,
} from "./progress.js";

// =============================================================================
// RALPH-STYLE EXECUTION PROMPT
// =============================================================================
// This prompt mirrors the Ralph shell scripts.
// ONE Claude session executes multiple tasks in a loop.
// =============================================================================

const RALPH_LOOP_PROMPT = `
## CONTEXT

This is PRODUCTION CODE. Quality over speed.
Every shortcut becomes technical debt. Leave the codebase better than you found it.

## PRD FORMAT

The PRD JSON contains:
- tasks: Array of tasks with id, phase, mode, description, steps, passes, dependencies
- documentation: URLs to fetch before implementing (FETCH THESE FIRST)
- reference_repos: External repos with similar patterns
- decisions: Key architectural decisions

## YOUR TASK

1. Read the PRD and progress file to understand current state.

2. Find tasks where passes=false and dependencies are satisfied.
   Choose using this priority:
   - Architectural decisions and core abstractions (HIGH)
   - Integration points between modules (HIGH)
   - Standard features and implementation (MEDIUM)
   - Polish, cleanup, and quick wins (LOW)

3. If the PRD has documentation URLs, FETCH THEM before implementing.

4. PARALLELIZATION: If multiple tasks have ALL dependencies satisfied and NO dependency on each other,
   you MAY execute them in parallel using the Task tool to spawn sub-agents. Only parallelize tasks
   that are truly independent. When in doubt, execute sequentially.

5. For each task:
   a. Execute all steps in the task's steps array
   b. Run feedback loops - pnpm lint && pnpm typecheck (MUST pass)
   c. Commit with a descriptive message
   d. Update the PRD JSON: set passes=true for the completed task
   e. Update the progress file with date/time, task ID, files changed, decisions

6. Continue to the next task until:
   - All tasks are complete, OR
   - You've completed \${maxTasks} tasks this session

7. LINEAR SYNC: After completing a task, sync progress to Linear:
   - Run: cd scripts && pnpm prd sync \${prdPath}
   - This updates the Linear issue with completion status

8. If ALL tasks have passes=true, output: <complete>ALL_TASKS_DONE</complete>
`;

// Single task prompt (for --single mode or hitl tasks)
const SINGLE_TASK_PROMPT = `
## CONTEXT

This is PRODUCTION CODE. Quality over speed.

## YOUR TASK

Execute task \${taskId}: \${taskDescription}

### Steps:
\${steps}

### Documentation to Fetch:
\${documentation}

1. If documentation URLs are listed, FETCH THEM FIRST
2. Execute all steps above
3. Run: pnpm lint && pnpm typecheck (MUST pass)
4. Commit with descriptive message
5. Update the PRD JSON: set passes=true for task \${taskId}
6. Update the progress file

Complete THIS TASK ONLY.
`;

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
 * Build Ralph loop prompt (for multiple tasks in one session)
 */
function buildLoopPrompt(prdPath: string, maxTasks: number): string {
  const progressPath = getProgressFilePath(prdPath);

  const prompt = RALPH_LOOP_PROMPT
    .replace(/\$\{maxTasks\}/g, String(maxTasks))
    .replace(/\$\{prdPath\}/g, prdPath);

  return `@${prdPath} @${progressPath} ${prompt}`;
}

/**
 * Build single task prompt (for hitl or --single mode)
 */
function buildSingleTaskPrompt(task: Task, prd: PRD, prdPath: string): string {
  const progressPath = getProgressFilePath(prdPath);

  const vars = {
    taskId: task.id,
    taskDescription: task.description,
    steps: task.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    documentation: (prd.documentation || []).length > 0
      ? prd.documentation!.map((d) => `- ${d.title}: ${d.url}`).join("\n")
      : "none",
  };

  const prompt = SINGLE_TASK_PROMPT.replace(
    /\$\{(\w+)\}/g,
    (_, key) => vars[key as keyof typeof vars] ?? `\${${key}}`
  );

  return `@${prdPath} @${progressPath} ${prompt}`;
}

/**
 * Find the claude CLI binary
 */
function findClaudeBin(): string {
  const locations = [
    process.env.HOME + "/.local/bin/claude",
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const loc of locations) {
    try {
      const result = spawnSync("test", ["-x", loc], { encoding: "utf-8" });
      if (result.status === 0) {
        return loc;
      }
    } catch {
      continue;
    }
  }

  // Fall back to PATH
  const whichResult = spawnSync("which", ["claude"], { encoding: "utf-8" });
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    return whichResult.stdout.trim();
  }

  throw new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code");
}

/**
 * Execute Ralph-style loop: ONE Claude session handles multiple tasks
 * This is the preferred execution mode - matches the Ralph shell scripts.
 * Uses streaming output so progress is visible in real-time.
 */
export async function executeLoop(
  prdPath: string,
  options: {
    maxTasks?: number;
    dryRun?: boolean;
  } = {}
): Promise<{ success: boolean; output: string }> {
  const maxTasks = options.maxTasks ?? 10;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Ralph Loop - Executing up to ${maxTasks} tasks`);
  console.log(`PRD: ${prdPath}`);
  console.log(`${"=".repeat(60)}\n`);

  if (options.dryRun) {
    console.log("(DRY RUN - showing prompt that would be sent)\n");
    const prompt = buildLoopPrompt(prdPath, maxTasks);
    console.log(prompt);
    return { success: true, output: "Dry run complete" };
  }

  try {
    const claudeBin = findClaudeBin();
    const prompt = buildLoopPrompt(prdPath, maxTasks);

    // Build args: --dangerously-skip-permissions for AFK mode
    const args = ["--dangerously-skip-permissions", "-p", prompt];

    console.log(`Running: ${claudeBin} --dangerously-skip-permissions -p "..."\n`);

    // Use spawn for real-time streaming output
    return new Promise((resolve) => {
      const child = spawn(claudeBin, args, {
        cwd: process.cwd(),
        shell: false,
        stdio: ["inherit", "pipe", "pipe"], // inherit stdin, pipe stdout/stderr for streaming
      });

      let output = "";
      let errorOutput = "";

      // Stream stdout in real-time
      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          const text = data.toString();
          output += text;
          process.stdout.write(text); // Real-time output
        });
      }

      // Stream stderr in real-time
      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          errorOutput += text;
          process.stderr.write(text); // Real-time errors
        });
      }

      // Set timeout (6 hour)
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ success: false, output: "Execution timed out after 6 hour" });
      }, 6 * 60 * 60 * 1000);

      child.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          resolve({ success: false, output: errorOutput || `Exit code: ${code}` });
          return;
        }

        // Check if all tasks are done
        if (output.includes("<complete>ALL_TASKS_DONE</complete>")) {
          console.log("\n✓ All tasks completed!");
        }

        resolve({ success: true, output });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ success: false, output: error.message });
      });
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, output: errorMessage };
  }
}

/**
 * Execute a single task using Claude Code CLI
 */
export async function executeTask(
  task: Task,
  prd: PRD,
  prdPath: string
): Promise<ExecutionResult> {
  const prompt = buildSingleTaskPrompt(task, prd, prdPath);

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
    const claudeBin = findClaudeBin();

    // Build arguments for Claude CLI
    // -p = prompt, --dangerously-skip-permissions = run without permission prompts (for afk mode)
    const args = task.mode === "afk"
      ? ["--dangerously-skip-permissions", "-p", prompt]
      : ["-p", prompt]; // hitl mode still needs permissions

    console.log(`Running: ${claudeBin} ${args[0]} -p "..."`);

    // Execute using Claude Code CLI
    // Use spawn for streaming output, but collect for return value
    const result = spawnSync(claudeBin, args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB for large outputs
      cwd: process.cwd(),
      shell: false,
      stdio: ["inherit", "pipe", "pipe"], // inherit stdin for interactive mode
      timeout: 10 * 60 * 1000, // 10 minute timeout per task
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

    const output = result.stdout || "";

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
 * Execute all incomplete tasks in a PRD using Ralph-style loop
 *
 * This is the PREFERRED execution mode:
 * - ONE Claude session handles multiple tasks
 * - Claude reads PRD, picks tasks, executes, updates PRD, repeats
 * - Matches the behavior of the Ralph shell scripts
 */
export async function executePRD(
  prd: PRD,
  prdPath: string,
  options: {
    phase?: number;
    dryRun?: boolean;
    stopOnError?: boolean;
    maxTasks?: number;
    legacy?: boolean; // Use old per-task spawning (for debugging)
  } = {}
): Promise<{ prd: PRD; results: Map<string, ExecutionResult> }> {
  const results = new Map<string, ExecutionResult>();

  // Count remaining tasks for display
  let tasks = prd.tasks.filter((t) => !t.passes);
  if (options.phase !== undefined) {
    tasks = tasks.filter((t) => t.phase === options.phase);
  }

  console.log(`\nPRD: ${prd.project}`);
  console.log(`Remaining tasks: ${tasks.length}`);

  if (options.dryRun) {
    console.log("\n(DRY RUN - showing what would execute)\n");

    // Show tasks that would run
    tasks.sort((a, b) => {
      const phaseA = a.phase ?? Number.MAX_SAFE_INTEGER;
      const phaseB = b.phase ?? Number.MAX_SAFE_INTEGER;
      if (phaseA !== phaseB) return phaseA - phaseB;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });

    for (const task of tasks) {
      if (!canExecuteTask(prd, task.id)) {
        console.log(`Skipping task ${task.id} - dependencies not met`);
      } else {
        console.log(`[DRY RUN] Would execute: Task ${task.id} - ${task.description}`);
      }
    }

    // Re-read PRD to get final state
    const finalPRD = JSON.parse(readFileSync(prdPath, "utf-8"));
    const completed = finalPRD.tasks.filter((t: Task) => t.passes).length;
    console.log(`\nFinal completion: ${Math.round((completed / finalPRD.tasks.length) * 100)}%`);

    return { prd: finalPRD, results };
  }

  // Use Ralph-style loop (preferred)
  if (!options.legacy) {
    const maxTasks = options.maxTasks ?? tasks.length;
    const loopResult = await executeLoop(prdPath, { maxTasks, dryRun: false });

    if (!loopResult.success) {
      console.error(`\nExecution failed: ${loopResult.output}`);
    }

    // Re-read PRD to get updated state
    const finalPRD = JSON.parse(readFileSync(prdPath, "utf-8"));
    const completed = finalPRD.tasks.filter((t: Task) => t.passes).length;
    console.log(`\nFinal completion: ${Math.round((completed / finalPRD.tasks.length) * 100)}%`);

    return { prd: finalPRD, results };
  }

  // Legacy mode: spawn Claude for each task (kept for debugging)
  console.log("\n(Legacy mode: spawning Claude per task)\n");
  let currentPRD = { ...prd };
  const progressPath = getProgressFilePath(prdPath);

  tasks.sort((a, b) => {
    const phaseA = a.phase ?? Number.MAX_SAFE_INTEGER;
    const phaseB = b.phase ?? Number.MAX_SAFE_INTEGER;
    if (phaseA !== phaseB) return phaseA - phaseB;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });

  for (const task of tasks) {
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
