#!/bin/bash
# ralph-once.sh - Human-in-the-loop Ralph Wiggum iteration
# Run this manually, watch what Claude does, check the commit, run again.
#
# Best for: Phases 1-2 (Foundation, iMessage Sync)
# These are high-stakes, low-reversibility tasks where architectural
# decisions cascade through the entire codebase.
#
# Prerequisites for browser verification:
#   - Chrome browser running
#   - Claude in Chrome extension (v1.0.36+)
#   - Claude Code CLI (v2.0.73+)
#   - Dev server running: pnpm dev (in apps/web)

set -e

# Ensure PATH includes common locations for claude CLI
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Find claude command - check common locations
CLAUDE_CMD=""
for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude" "$(which claude 2>/dev/null)"; do
  if [ -x "$loc" ] 2>/dev/null; then
    CLAUDE_CMD="$loc"
    break
  fi
done

if [ -z "$CLAUDE_CMD" ]; then
  echo "========================================"
  echo "Error: Claude CLI not found"
  echo "========================================"
  echo ""
  echo "Install it with:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "Then run: claude --version"
  echo ""
  echo "If you're using Claude Code via VS Code/Cursor extension,"
  echo "you still need to install the CLI separately for Ralph."
  echo "========================================"
  exit 1
fi

echo "Using Claude CLI: $CLAUDE_CMD"

# Check if dev server is running
check_dev_server() {
  curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -q "200\|304"
}

DEV_SERVER_PID=""
if check_dev_server; then
  echo "Dev server already running at http://localhost:3000"
else
  echo "Dev server not running. Starting in background..."
  cd apps/web && pnpm dev > /tmp/ralph-dev-server.log 2>&1 &
  DEV_SERVER_PID=$!
  cd - > /dev/null

  # Wait for server to be ready (max 30 seconds)
  echo -n "Waiting for dev server"
  for i in {1..30}; do
    if check_dev_server; then
      echo " ready!"
      break
    fi
    echo -n "."
    sleep 1
  done

  if ! check_dev_server; then
    echo " failed to start. Check /tmp/ralph-dev-server.log"
    echo "Continuing anyway (UI verification may fail)..."
  fi
fi

echo "========================================"
echo "Ralph Wiggum - HITL Mode"
echo "========================================"
echo "Start time: $(date)"
echo ""

$CLAUDE_CMD --dangerously-skip-permissions "@prd.json @progress.txt \

## CONTEXT
This is PRODUCTION CODE that will be maintained long-term.
Quality over speed. Every shortcut becomes technical debt.
Leave the codebase better than you found it.

## PRD FORMAT
The prd.json file contains structured tasks with:
- id: Task identifier (e.g., '1.7')
- phase: 1-6
- mode: 'hitl' or 'afk'
- category: architectural, integration, functional, ui, testing
- description: What to implement
- steps: Verification steps (all must pass)
- passes: false (you set to true when complete)
- reference: (optional) URL to documentation for this task

## YOUR TASK
1. Read prd.json and progress.txt to understand current state.

2. Find tasks where passes=false. Choose the next task using this priority:
   - Architectural decisions and core abstractions (HIGH)
   - Integration points between modules (HIGH)
   - Unknown unknowns and spike work (HIGH)
   - Standard features and implementation (MEDIUM)
   - Polish, cleanup, and quick wins (LOW)
   Do NOT just pick the first one - pick the HIGHEST PRIORITY uncompleted task.

3. If the task has a 'reference' URL, fetch it to understand the implementation.

4. Keep changes SMALL and FOCUSED:
   - One logical change per commit
   - If the task feels too large, break it into subtasks first
   - Prefer multiple small commits over one large commit

5. Implement the task, then verify ALL steps in the task's 'steps' array pass.

6. Run ALL feedback loops:
   - TypeScript: pnpm lint && pnpm typecheck (MUST pass)
   - Tests: pnpm test (MUST pass if tests exist)
   - For Python: uv run ruff check . && uv run ruff format .
   Do NOT commit if any feedback loop fails. Fix issues first.

7. For UI tasks (category: 'ui'), use browser tools to verify:
   - Open http://localhost:3000 (or relevant route) in Chrome
   - Verify the UI renders correctly without console errors
   - Check that interactive elements (buttons, links, forms) work
   - Verify dark mode works if applicable
   - Take note of any visual issues

8. Run the code-simplifier:code-simplifier skill to review and simplify the code you wrote.

9. Commit with a descriptive message.

10. Update prd.json: set passes=true for the completed task.

11. Update progress.txt with:
    - Date/time
    - Task ID and description (e.g., '1.7 - Define Convex schema: users table')
    - Files changed
    - Key decisions made and WHY
    - Browser verification results (for UI tasks)
    - Any blockers or notes for next iteration
    Keep entries concise.

ONLY DO ONE TASK. Small steps compound into big progress."

echo ""
echo "========================================"
echo "Ralph iteration complete."
echo "End time: $(date)"
echo ""
if [ -n "$DEV_SERVER_PID" ]; then
  echo "Dev server running in background (PID: $DEV_SERVER_PID)"
  echo "  - Logs: /tmp/ralph-dev-server.log"
  echo "  - Stop: kill $DEV_SERVER_PID"
fi
echo ""
echo "Next steps:"
echo "  1. Review the commit: git log -1 --stat"
echo "  2. Check progress.txt for notes"
echo "  3. Check prd.json for updated passes status"
echo "  4. Run again: ./ralph-once.sh"
echo "========================================"
