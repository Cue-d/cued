import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Task, PRD } from "./prd-generator.js";

export interface ProgressEntry {
  date: string;
  taskId: string;
  taskDescription: string;
  filesChanged: string[];
  decisions: string[];
  verificationResults: string[];
  notes: string[];
}

/**
 * Format a date for progress logs
 */
function formatDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Parse existing progress file
 */
export function parseProgressFile(filePath: string): ProgressEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf-8");
  const entries: ProgressEntry[] = [];

  // Split by date headers (## YYYY-MM-DD)
  const sections = content.split(/^## (\d{4}-\d{2}-\d{2})/gm);

  for (let i = 1; i < sections.length; i += 2) {
    const date = sections[i];
    const body = sections[i + 1] || "";

    // Extract task ID from header
    const taskMatch = body.match(/Task[s]?\s+([\d.]+(?:\s*[,+&]\s*[\d.]+)*)/i);
    const taskId = taskMatch ? taskMatch[1].split(/\s*[,+&]\s*/)[0] : "";

    // Extract task description
    const descMatch = body.match(/Task[s]?\s+[\d.,+&\s]+-\s*(.+?)(?=\n|$)/i);
    const taskDescription = descMatch ? descMatch[1].trim() : "";

    // Extract files changed
    const filesMatch = body.match(/### Files Changed\s*\n([\s\S]*?)(?=\n### |$)/i);
    const filesChanged = filesMatch
      ? (filesMatch[1].match(/^[-*]\s+(.+)$/gm) || []).map((l) =>
          l.replace(/^[-*]\s+/, "").trim()
        )
      : [];

    // Extract decisions
    const decisionsMatch = body.match(/### Decisions\s*\n([\s\S]*?)(?=\n### |$)/i);
    const decisions = decisionsMatch
      ? (decisionsMatch[1].match(/^[-*]\s+(.+)$/gm) || []).map((l) =>
          l.replace(/^[-*]\s+/, "").trim()
        )
      : [];

    // Extract verification results
    const verifyMatch = body.match(/### Verification Results\s*\n([\s\S]*?)(?=\n### |$)/i);
    const verificationResults = verifyMatch
      ? (verifyMatch[1].match(/^[-*]\s+(.+)$/gm) || []).map((l) =>
          l.replace(/^[-*]\s+/, "").trim()
        )
      : [];

    // Extract notes
    const notesMatch = body.match(/### Notes\s*\n([\s\S]*?)(?=\n## |$)/i);
    const notes = notesMatch
      ? (notesMatch[1].match(/^[-*]\s+(.+)$/gm) || []).map((l) =>
          l.replace(/^[-*]\s+/, "").trim()
        )
      : [];

    entries.push({
      date,
      taskId,
      taskDescription,
      filesChanged,
      decisions,
      verificationResults,
      notes,
    });
  }

  return entries;
}

/**
 * Format a progress entry for the log file
 */
export function formatProgressEntry(entry: ProgressEntry): string {
  const lines: string[] = [];

  lines.push(`## ${entry.date}: Task ${entry.taskId} - ${entry.taskDescription}`);
  lines.push("");

  if (entry.filesChanged.length > 0) {
    lines.push("### Files Changed");
    entry.filesChanged.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }

  if (entry.decisions.length > 0) {
    lines.push("### Decisions");
    entry.decisions.forEach((d) => lines.push(`- ${d}`));
    lines.push("");
  }

  if (entry.verificationResults.length > 0) {
    lines.push("### Verification Results");
    entry.verificationResults.forEach((v) => lines.push(`- ${v}`));
    lines.push("");
  }

  if (entry.notes.length > 0) {
    lines.push("### Notes");
    entry.notes.forEach((n) => lines.push(`- ${n}`));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Append a progress entry to the end of the log file.
 * New entries are added at the bottom (chronological order).
 */
export function appendProgress(filePath: string, entry: ProgressEntry): void {
  const existingContent = existsSync(filePath)
    ? readFileSync(filePath, "utf-8")
    : "";
  const formattedEntry = formatProgressEntry(entry);

  // Add header only for new files
  const fileHeader = existingContent
    ? ""
    : `# ${entry.taskDescription.split(" - ")[0] || "Project"} Progress Log\n\n`;

  // Write: header (if new) + existing content + new entry at end
  writeFileSync(filePath, fileHeader + existingContent + formattedEntry);
}

/**
 * Create a progress entry from task execution
 */
export function createProgressEntry(
  task: Task,
  result: {
    filesChanged?: string[];
    decisions?: string[];
    verificationResults?: string[];
    notes?: string[];
  }
): ProgressEntry {
  return {
    date: formatDate(),
    taskId: task.id,
    taskDescription: task.description,
    filesChanged: result.filesChanged || [],
    decisions: result.decisions || [],
    verificationResults: result.verificationResults || [],
    notes: result.notes || [],
  };
}

/**
 * Get the progress file path for a PRD
 */
export function getProgressFilePath(prdPath: string): string {
  return prdPath.replace(/-prd\.json$/, "-progress.txt").replace(/\.json$/, "-progress.txt");
}

/**
 * Generate a summary of all progress
 */
export function generateProgressSummary(entries: ProgressEntry[]): string {
  const lines: string[] = [];

  lines.push("# Progress Summary");
  lines.push("");
  lines.push(`Total entries: ${entries.length}`);
  lines.push("");

  // Group by date
  const byDate = new Map<string, ProgressEntry[]>();
  for (const entry of entries) {
    const existing = byDate.get(entry.date) || [];
    existing.push(entry);
    byDate.set(entry.date, existing);
  }

  for (const [date, dateEntries] of byDate) {
    lines.push(`## ${date}`);
    lines.push("");
    for (const entry of dateEntries) {
      lines.push(`- Task ${entry.taskId}: ${entry.taskDescription}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Convert progress entries to Linear document format
 */
export function toLinearDocumentContent(prd: PRD, entries: ProgressEntry[]): string {
  const lines: string[] = [];

  lines.push(`# ${prd.project} - Progress Log`);
  lines.push("");
  lines.push(`**Linear Issue**: ${prd.linearIssueId || "N/A"}`);
  lines.push(`**Description**: ${prd.description}`);
  lines.push("");

  // Completion status
  const completed = prd.tasks.filter((t) => t.passes).length;
  const total = prd.tasks.length;
  const pct = Math.round((completed / total) * 100);
  lines.push(`## Status: ${completed}/${total} tasks (${pct}%)`);
  lines.push("");

  // Progress entries
  lines.push("## Progress Log");
  lines.push("");

  for (const entry of entries) {
    lines.push(formatProgressEntry(entry));
  }

  return lines.join("\n");
}

/**
 * Generate a collapsible progress section for issue description
 * Uses HTML <details> tag supported by Linear's markdown
 */
export function toCollapsibleProgressSection(
  prd: PRD,
  entries: ProgressEntry[],
  documentUrl?: string
): string {
  const lines: string[] = [];
  const completed = prd.tasks.filter((t) => t.passes).length;
  const total = prd.tasks.length;
  const pct = Math.round((completed / total) * 100);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 🤖 AI Progress Log");
  lines.push("");
  lines.push(`**Status**: ${completed}/${total} tasks (${pct}%)`);
  lines.push("");

  // Progress bar
  const filledBlocks = Math.floor(pct / 10);
  const progressBar = "█".repeat(filledBlocks) + "░".repeat(10 - filledBlocks);
  lines.push(`\`${progressBar}\` ${pct}%`);
  lines.push("");

  // Link to full document if available
  if (documentUrl) {
    lines.push(`📄 [Full Progress Document](${documentUrl})`);
    lines.push("");
  }

  // Recent activity in collapsible
  if (entries.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Recent Activity (click to expand)</summary>");
    lines.push("");

    // Show last 5 entries
    const recentEntries = entries.slice(-5);
    for (const entry of recentEntries) {
      lines.push(`### ${entry.date}: Task ${entry.taskId}`);
      lines.push(`${entry.taskDescription}`);
      lines.push("");

      if (entry.filesChanged.length > 0) {
        lines.push("**Files**: " + entry.filesChanged.slice(0, 3).join(", "));
        if (entry.filesChanged.length > 3) {
          lines.push(`  _(+${entry.filesChanged.length - 3} more)_`);
        }
      }

      if (entry.verificationResults.length > 0) {
        lines.push("**Verification**:");
        entry.verificationResults.forEach((v) => lines.push(`- ${v}`));
      }
      lines.push("");
    }

    lines.push("</details>");
  }

  // Task checklist in collapsible
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Task Checklist</summary>");
  lines.push("");
  for (const task of prd.tasks) {
    const checkbox = task.passes ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} **${task.id}**: ${task.description}`);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("_Auto-updated by AI agent_");

  return lines.join("\n");
}
