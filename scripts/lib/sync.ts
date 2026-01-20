import { readFileSync, existsSync } from "fs";
import {
  getIssue,
  getIssueLabels,
  addIssueComment,
  updateIssueStatus,
  syncProgressDocument,
  updateIssueDescription,
  getCurrentUser,
  getTeamMembers,
  assignIssue,
  addLabelsToIssue,
  requestReview,
  inferLabelsFromContent,
} from "./linear.js";
import type { PRD } from "./prd-generator.js";
import { getCompletionPercentage } from "./prd-generator.js";
import {
  parseProgressFile,
  toLinearDocumentContent,
  toCollapsibleProgressSection,
  getProgressFilePath,
} from "./progress.js";

export interface SyncOptions {
  updateStatus?: boolean;
  addComment?: boolean;
  syncDocument?: boolean;
  syncIssueDescription?: boolean;
  assignToSelf?: boolean;
  addLabels?: boolean;
  requestReviewOnComplete?: boolean;
}

/**
 * Sync PRD progress to Linear using Claude Code with Linear MCP
 */
export function syncToLinear(
  prdPath: string,
  options: SyncOptions = {
    updateStatus: true,
    addComment: true,
    syncDocument: true,
    syncIssueDescription: true,
    assignToSelf: true,
    addLabels: true,
    requestReviewOnComplete: true,
  }
): void {
  // Load PRD
  const prdContent = readFileSync(prdPath, "utf-8");
  const prd: PRD = JSON.parse(prdContent);

  if (!prd.linearIssueId) {
    throw new Error("PRD has no linearIssueId");
  }

  // Verify issue exists
  const issue = getIssue(prd.linearIssueId);
  if (!issue) {
    throw new Error(`Issue ${prd.linearIssueId} not found`);
  }

  const completion = getCompletionPercentage(prd);
  const completedTasks = prd.tasks.filter((t) => t.passes).length;
  const totalTasks = prd.tasks.length;

  console.log(`Syncing ${prd.linearIssueId} (${completion}% complete)`);

  // Assign to current user if not already assigned
  if (options.assignToSelf) {
    const currentUser = getCurrentUser();
    if (currentUser) {
      const assignSuccess = assignIssue(prd.linearIssueId, currentUser.id);
      if (assignSuccess) {
        console.log(`✓ Assigned to ${currentUser.name}`);
      } else {
        console.log("⚠ Could not assign issue");
      }
    }
  }

  // Add labels based on content (only add new labels, skip existing)
  if (options.addLabels) {
    const existingLabels = getIssueLabels(prd.linearIssueId);
    const existingLabelSet = new Set(existingLabels.map((l) => l.toLowerCase()));
    const inferredLabels = inferLabelsFromContent(prd.project, prd.description);
    const newLabels = inferredLabels.filter(
      (label) => !existingLabelSet.has(label.toLowerCase())
    );

    if (newLabels.length > 0) {
      const labelSuccess = addLabelsToIssue(prd.linearIssueId, newLabels);
      if (labelSuccess) {
        console.log(`✓ Labels added: ${newLabels.join(", ")}`);
      } else {
        console.log("⚠ Could not add labels");
      }
    } else if (existingLabels.length > 0) {
      console.log(`✓ Labels already present: ${existingLabels.join(", ")}`);
    }
  }

  // Load progress entries
  const progressPath = getProgressFilePath(prdPath);
  const progressEntries = existsSync(progressPath)
    ? parseProgressFile(progressPath)
    : [];

  // Sync progress document and get document URL
  let documentUrl: string | undefined;
  if (options.syncDocument) {
    const documentContent = toLinearDocumentContent(prd, progressEntries);
    const docResult = syncProgressDocument(
      prd.project,
      `${prd.project} - Progress Log`,
      documentContent
    );
    if (docResult.success) {
      console.log("✓ Progress document synced");
      if (docResult.documentId) {
        // Linear document URLs follow this pattern
        documentUrl = `https://linear.app/document/${docResult.documentId}`;
      }
    } else {
      console.log("⚠ Could not sync progress document");
    }
  }

  // Update issue description with collapsible progress section
  if (options.syncIssueDescription) {
    const collapsibleSection = toCollapsibleProgressSection(
      prd,
      progressEntries,
      documentUrl
    );
    const descSuccess = updateIssueDescription(prd.linearIssueId, collapsibleSection);
    if (descSuccess) {
      console.log("✓ Issue description updated with progress");
    } else {
      console.log("⚠ Could not update issue description");
    }
  }

  // Update issue status based on completion
  let targetStatus: "Todo" | "In Progress" | "In Review" | "Done";

  if (completion === 0) {
    targetStatus = "Todo";
  } else if (completion === 100) {
    targetStatus = "Done";
  } else if (completion >= 80) {
    targetStatus = "In Review";
  } else {
    targetStatus = "In Progress";
  }

  if (options.updateStatus) {
    const statusSuccess = updateIssueStatus(prd.linearIssueId, targetStatus);
    if (statusSuccess) {
      console.log(`✓ Issue status updated to ${targetStatus}`);
    } else {
      console.log("⚠ Could not update issue status");
    }
  }

  // Request review from team members when moving to In Review
  if (options.requestReviewOnComplete && targetStatus === "In Review") {
    const currentUser = getCurrentUser();
    const teamMembers = getTeamMembers();

    // Filter out current user from reviewers
    const reviewers = teamMembers.filter(
      (m) => currentUser && m.id !== currentUser.id
    );

    if (reviewers.length > 0) {
      const reviewerIds = reviewers.map((r) => r.id);
      const reviewSuccess = requestReview(prd.linearIssueId, reviewerIds);
      if (reviewSuccess) {
        console.log(
          `✓ Review requested from: ${reviewers.map((r) => r.name).join(", ")}`
        );
      } else {
        console.log("⚠ Could not request review");
      }
    }
  }

  // Add progress comment
  if (options.addComment && progressEntries.length > 0) {
    const recentEntries = progressEntries.slice(-3); // Last 3 entries
    const commentBody = `## Progress Update: ${completion}%

**${completedTasks}/${totalTasks} tasks completed**

### Recent Activity:
${recentEntries
  .map(
    (e) => `- **Task ${e.taskId}**: ${e.taskDescription}
  ${e.verificationResults.map((v) => `  - ${v}`).join("\n")}`
  )
  .join("\n\n")}

---
*Auto-synced from PRD execution*`;

    const commentSuccess = addIssueComment(prd.linearIssueId, commentBody);
    if (commentSuccess) {
      console.log("✓ Progress comment added");
    } else {
      console.log("⚠ Could not add comment");
    }
  }
}

/**
 * Get sync status for a PRD
 */
export function getSyncStatus(prdPath: string): {
  linearIssueId: string | undefined;
  completion: number;
  issueStatus: string | undefined;
  hasDocument: boolean;
} {
  const prdContent = readFileSync(prdPath, "utf-8");
  const prd: PRD = JSON.parse(prdContent);

  const completion = getCompletionPercentage(prd);

  if (!prd.linearIssueId) {
    return {
      linearIssueId: undefined,
      completion,
      issueStatus: undefined,
      hasDocument: false,
    };
  }

  const issue = getIssue(prd.linearIssueId);

  return {
    linearIssueId: prd.linearIssueId,
    completion,
    issueStatus: issue?.state,
    hasDocument: false, // Would need to implement document search
  };
}

/**
 * Generate a completion report for Linear
 */
export function generateCompletionReport(prd: PRD): string {
  const completion = getCompletionPercentage(prd);
  const completedTasks = prd.tasks.filter((t) => t.passes);
  const pendingTasks = prd.tasks.filter((t) => !t.passes);

  // Group by phase (tasks without phase go to phase 0)
  const phases = new Map<number, { completed: number; total: number }>();
  for (const task of prd.tasks) {
    const phaseNum = task.phase ?? 0;
    const phase = phases.get(phaseNum) || { completed: 0, total: 0 };
    phase.total++;
    if (task.passes) phase.completed++;
    phases.set(phaseNum, phase);
  }

  const lines: string[] = [];

  lines.push(`# ${prd.project} - Completion Report`);
  lines.push("");
  lines.push(`## Overall: ${completion}%`);
  lines.push("");

  lines.push("## By Phase");
  for (const [phase, stats] of phases) {
    const pct = Math.round((stats.completed / stats.total) * 100);
    const bar =
      "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    lines.push(
      `- Phase ${phase}: ${bar} ${pct}% (${stats.completed}/${stats.total})`
    );
  }
  lines.push("");

  if (completedTasks.length > 0) {
    lines.push("## Completed Tasks");
    for (const task of completedTasks) {
      lines.push(`- [x] ${task.id}: ${task.description}`);
    }
    lines.push("");
  }

  if (pendingTasks.length > 0) {
    lines.push("## Pending Tasks");
    for (const task of pendingTasks) {
      lines.push(`- [ ] ${task.id}: ${task.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
