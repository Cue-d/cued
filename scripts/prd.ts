#!/usr/bin/env npx tsx

/**
 * Minimal CLI for viewing GitHub issues.
 *
 * The actual work is done by ralph-once.sh and afk-ralph.sh,
 * which pass GitHub issues directly to Claude.
 */

import { spawnSync } from "child_process";

const command = process.argv[2];

function gh(args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf-8" });
  return result.stdout || "";
}

switch (command) {
  case "list":
  case "issues":
    console.log("Open GitHub Issues:\n");
    console.log(gh(["issue", "list", "--state", "open"]));
    break;

  case "view":
    const num = process.argv[3];
    if (!num) {
      console.error("Usage: pnpm prd view <issue-number>");
      process.exit(1);
    }
    console.log(gh(["issue", "view", num]));
    break;

  default:
    console.log(`
Ralph PRD System
================

GitHub issues are the work items. No PRD files needed.

Commands:
  pnpm prd list          List open GitHub issues
  pnpm prd view <num>    View a specific issue

Execution:
  ./ralph-once.sh                    Single iteration (HITL)
  ./ralph-once.sh --issue 123        Target specific issue
  ./ralph-once.sh --port 3001        Custom dev server port
  ./afk-ralph.sh 10                  10 iterations (AFK)
  ./afk-ralph.sh 10 --issue 123      Target specific issue
  ./afk-ralph.sh 10 --port 3001      Custom dev server port

Worktrees are managed by Conductor via conductor.json.

Files:
  prds/prompt.md         Instructions for Claude
  progress.txt           Log of completed work
`);
}
