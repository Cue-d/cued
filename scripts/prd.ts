#!/usr/bin/env npx tsx

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, basename } from "path";

import { fetchAndParseIssue, linkPRToIssue, getIssue } from "./lib/linear.js";
import {
  generatePRD,
  validatePRD,
  getCompletionPercentage,
  getIncompleteTasks,
  type PRD,
} from "./lib/prd-generator.js";
import { executePRD, executeInteractive } from "./lib/executor.js";
import { syncToLinear, getSyncStatus, generateCompletionReport } from "./lib/sync.js";
import { parseProgressFile, getProgressFilePath } from "./lib/progress.js";

const program = new Command();

program
  .name("prd")
  .description("PRD management CLI - Linear to PRD to Execution pipeline")
  .version("1.0.0");

/**
 * Pull a Linear issue and generate a PRD
 */
program
  .command("pull <linear-id>")
  .description("Fetch Linear issue and generate PRD")
  .option("-o, --output <path>", "Output path for PRD JSON")
  .option("--dry-run", "Preview without writing files")
  .action((linearId: string, options) => {
    console.log(`Fetching Linear issue: ${linearId}`);

    try {
      // Fetch and parse issue
      const issue = fetchAndParseIssue(linearId);
      if (!issue) {
        console.error(`Issue ${linearId} not found`);
        process.exit(1);
      }

      console.log(`Found: ${issue.title}`);
      console.log(`Acceptance Criteria: ${issue.acceptanceCriteria.length}`);
      console.log(`Target Stack: ${issue.targetStack.join(", ")}`);
      console.log("");

      // Generate PRD
      console.log("Generating PRD tasks...");
      const prd = generatePRD(issue);

      console.log(`Generated ${prd.tasks.length} tasks across ${new Set(prd.tasks.map((t) => t.phase)).size} phases`);

      // Output
      const outputPath = options.output || `prds/${linearId.toLowerCase()}-prd.json`;

      if (options.dryRun) {
        console.log("\n--- DRY RUN ---");
        console.log(JSON.stringify(prd, null, 2));
      } else {
        writeFileSync(outputPath, JSON.stringify(prd, null, 2));
        console.log(`\nPRD written to: ${outputPath}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Run PRD tasks
 */
program
  .command("run <prd-file>")
  .description("Execute PRD tasks")
  .option("-p, --phase <number>", "Only run tasks in this phase", parseInt)
  .option("-i, --interactive", "Interactive mode with step-by-step confirmation")
  .option("--dry-run", "Preview tasks without executing")
  .option("--stop-on-error", "Stop execution on first error")
  .action(async (prdFile: string, options) => {
    const prdPath = resolve(prdFile);

    if (!existsSync(prdPath)) {
      console.error(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    try {
      const prdContent = readFileSync(prdPath, "utf-8");
      const prd = validatePRD(JSON.parse(prdContent));

      const incomplete = getIncompleteTasks(prd);
      const completion = getCompletionPercentage(prd);

      console.log(`PRD: ${prd.project}`);
      console.log(`Completion: ${completion}%`);
      console.log(`Remaining tasks: ${incomplete.length}`);
      console.log("");

      if (incomplete.length === 0) {
        console.log("All tasks completed!");
        return;
      }

      if (options.interactive) {
        await executeInteractive(prd, prdPath);
      } else {
        await executePRD(prd, prdPath, {
          phase: options.phase,
          dryRun: options.dryRun,
          stopOnError: options.stopOnError,
        });
      }

      // Show final status
      const updatedContent = readFileSync(prdPath, "utf-8");
      const updatedPrd = validatePRD(JSON.parse(updatedContent));
      const newCompletion = getCompletionPercentage(updatedPrd);

      console.log(`\nFinal completion: ${newCompletion}%`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Sync progress to Linear
 */
program
  .command("sync <prd-file>")
  .description("Sync PRD progress to Linear")
  .option("--no-status", "Don't update issue status")
  .option("--no-comment", "Don't add progress comment")
  .option("--no-document", "Don't sync progress document")
  .option("--no-description", "Don't update issue description with progress")
  .action((prdFile: string, options) => {
    const prdPath = resolve(prdFile);

    if (!existsSync(prdPath)) {
      console.error(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    try {
      syncToLinear(prdPath, {
        updateStatus: options.status,
        addComment: options.comment,
        syncDocument: options.document,
        syncIssueDescription: options.description,
      });

      console.log("\nSync complete!");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Show PRD status
 */
program
  .command("status <prd-file>")
  .description("Show PRD completion status")
  .option("--linear", "Also fetch Linear issue status")
  .action((prdFile: string, options) => {
    const prdPath = resolve(prdFile);

    if (!existsSync(prdPath)) {
      console.error(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    try {
      const prdContent = readFileSync(prdPath, "utf-8");
      const prd = validatePRD(JSON.parse(prdContent));

      const completion = getCompletionPercentage(prd);
      const completed = prd.tasks.filter((t) => t.passes).length;
      const total = prd.tasks.length;

      console.log(`\n${prd.project}`);
      console.log("=".repeat(prd.project.length));
      console.log("");
      console.log(`Completion: ${completion}% (${completed}/${total} tasks)`);
      console.log(`Linear Issue: ${prd.linearIssueId || "N/A"}`);
      console.log("");

      // Show by phase (tasks without phase go to phase 0)
      const phases = new Map<number, { completed: number; total: number }>();
      for (const task of prd.tasks) {
        const phaseNum = task.phase ?? 0;
        const phase = phases.get(phaseNum) || { completed: 0, total: 0 };
        phase.total++;
        if (task.passes) phase.completed++;
        phases.set(phaseNum, phase);
      }

      console.log("By Phase:");
      for (const [phase, stats] of phases) {
        const pct = Math.round((stats.completed / stats.total) * 100);
        const bar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
        console.log(`  Phase ${phase}: ${bar} ${pct}%`);
      }

      // Check progress file
      const progressPath = getProgressFilePath(prdPath);
      if (existsSync(progressPath)) {
        const entries = parseProgressFile(progressPath);
        console.log(`\nProgress log: ${entries.length} entries`);
        if (entries.length > 0) {
          const recent = entries.slice(-3);
          console.log("\nRecent activity:");
          for (const entry of recent) {
            console.log(`  - ${entry.date}: Task ${entry.taskId} - ${entry.taskDescription}`);
          }
        }
      }

      // Fetch Linear status if requested
      if (options.linear && prd.linearIssueId) {
        console.log("\nLinear status:");
        const syncStatus = getSyncStatus(prdPath);
        console.log(`  Issue status: ${syncStatus.issueStatus || "Unknown"}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Generate completion report
 */
program
  .command("report <prd-file>")
  .description("Generate completion report")
  .option("-o, --output <path>", "Output file (default: stdout)")
  .action((prdFile: string, options) => {
    const prdPath = resolve(prdFile);

    if (!existsSync(prdPath)) {
      console.error(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    try {
      const prdContent = readFileSync(prdPath, "utf-8");
      const prd = validatePRD(JSON.parse(prdContent));

      const report = generateCompletionReport(prd);

      if (options.output) {
        writeFileSync(options.output, report);
        console.log(`Report written to: ${options.output}`);
      } else {
        console.log(report);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Validate a PRD file
 */
program
  .command("validate <prd-file>")
  .description("Validate PRD JSON against schema")
  .action((prdFile: string) => {
    const prdPath = resolve(prdFile);

    if (!existsSync(prdPath)) {
      console.error(`PRD file not found: ${prdPath}`);
      process.exit(1);
    }

    try {
      const prdContent = readFileSync(prdPath, "utf-8");
      const prd = validatePRD(JSON.parse(prdContent));

      console.log(`✓ Valid PRD: ${prd.project}`);
      console.log(`  - ${prd.tasks.length} tasks`);
      console.log(`  - ${new Set(prd.tasks.map((t) => t.phase)).size} phases`);
      console.log(`  - Linear issue: ${prd.linearIssueId || "N/A"}`);
    } catch (error) {
      console.error("✗ Invalid PRD:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Link a PR to a Linear issue
 */
program
  .command("link-pr <linear-id> <pr-url>")
  .description("Link a PR URL to a Linear issue")
  .option("-t, --title <title>", "Custom title for the link")
  .action((linearId: string, prUrl: string, options) => {
    console.log(`Linking PR to ${linearId}...`);

    // Validate URL format
    if (!prUrl.startsWith("https://github.com/")) {
      console.warn("Warning: URL does not appear to be a GitHub PR URL");
    }

    try {
      // Verify issue exists
      const issue = getIssue(linearId);
      if (!issue) {
        console.error(`Issue ${linearId} not found`);
        process.exit(1);
      }

      const success = linkPRToIssue(linearId, prUrl, options.title);

      if (success) {
        console.log(`✓ PR linked to ${linearId}`);
        console.log(`  URL: ${prUrl}`);
      } else {
        console.error("Failed to link PR");
        process.exit(1);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
