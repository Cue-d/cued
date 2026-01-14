#!/bin/bash
# afk-ralph.sh - Autonomous Ralph Wiggum loop
# Usage: ./afk-ralph.sh <iterations> [--sandbox]
#
# Best for: Phases 3-6 (AI Assistant, Gmail, Slack, Polish)
# Only use this AFTER the foundation is solid:
# - Turborepo building successfully
# - Convex schema deployed
# - Auth working end-to-end
# - At least one successful sync
#
# Options:
#   --sandbox    Run in Docker sandbox (recommended for overnight runs)
#
# Prerequisites for chrome debugging:
#   - Chrome browser running
#   - Claude in Chrome extension (v1.0.36+)
#   - Dev server running: pnpm dev (in apps/web)

set -e

# Ensure PATH includes common locations for claude CLI
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Find claude command - check common locations
CLAUDE_BIN=""
for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude" "$(which claude 2>/dev/null)"; do
  if [ -x "$loc" ] 2>/dev/null; then
    CLAUDE_BIN="$loc"
    break
  fi
done

if [ -z "$CLAUDE_BIN" ]; then
  echo "========================================"
  echo "Error: Claude CLI not found"
  echo "========================================"
  echo ""
  echo "Install it with:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "Then run: claude --version"
  echo "========================================"
  exit 1
fi

echo "Using Claude CLI: $CLAUDE_BIN"

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

# Parse arguments
ITERATIONS=""
USE_SANDBOX=false

for arg in "$@"; do
  case $arg in
    --sandbox)
      USE_SANDBOX=true
      shift
      ;;
    *)
      if [ -z "$ITERATIONS" ]; then
        ITERATIONS=$arg
      fi
      ;;
  esac
done

if [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 <iterations> [--sandbox]"
  echo ""
  echo "Examples:"
  echo "  ./afk-ralph.sh 10              # Run 10 iterations"
  echo "  ./afk-ralph.sh 20 --sandbox    # Run 20 iterations in Docker sandbox"
  echo ""
  echo "Recommended iteration counts:"
  echo "  5-10   Small tasks, single phase"
  echo "  20-30  Full phase (e.g., AI Assistant)"
  echo "  50+    Multiple phases"
  exit 1
fi

START_TIME=$(date +%s)

echo "========================================"
echo "Ralph Wiggum - AFK Mode"
echo "========================================"
echo "Iterations: $ITERATIONS"
echo "Sandbox: $USE_SANDBOX"
echo "Start time: $(date)"
echo ""
echo "Go make coffee. Come back to commits."
echo "========================================"
echo ""

# Build the Claude command
CLAUDE_CMD="$CLAUDE_BIN --dangerously-skip-permissions -p"
if [ "$USE_SANDBOX" = true ]; then
  CLAUDE_CMD="docker sandbox run claude --dangerously-skip-permissions -p"
  echo "Running in Docker sandbox for safety."
  echo ""
fi

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "-----------------------------------"
  echo "Iteration $i of $ITERATIONS"
  echo "Time: $(date)"
  echo "-----------------------------------"

  result=$($CLAUDE_CMD "@prd.json @progress.txt \

## CONTEXT
This is PRODUCTION CODE. Quality over speed.
Every shortcut becomes someone else's burden.
Fight entropy. Leave the codebase better than you found it.

## PRD FORMAT
The prd.json file contains structured tasks with:
- id: Task identifier (e.g., '3.2')
- phase: 1-6
- mode: 'hitl' or 'afk'
- category: architectural, integration, functional, ui, testing
- description: What to implement
- steps: Verification steps (all must pass)
- passes: false (you set to true when complete)
- reference: (optional) URL to documentation for this task

## YOUR TASK
1. Read prd.json and progress.txt to understand current state.

2. Find tasks where passes=false. Choose using this priority:
   - Architectural decisions and core abstractions (HIGH)
   - Integration points between modules (HIGH)
   - Unknown unknowns and spike work (HIGH)
   - Standard features and implementation (MEDIUM)
   - Polish, cleanup, and quick wins (LOW)

3. If the task has a 'reference' URL, fetch it to understand the implementation.

4. Keep changes SMALL and FOCUSED:
   - One logical change per commit
   - If the task feels too large, break it into subtasks
   - Run feedback loops after each change, not at the end

5. Implement the task, then verify ALL steps in the task's 'steps' array.

6. Run ALL feedback loops:
   - TypeScript: pnpm lint && pnpm typecheck (MUST pass)
   - Tests: pnpm test (MUST pass if tests exist)
   Do NOT commit if any feedback loop fails.

7. Run the code-simplifier:code-simplifier skill to reivew and simplify your code.

8. Commit with a descriptive message.

9. Update prd.json: set passes=true for the completed task.

10. Update progress.txt with:
    - Date/time and task ID + description
    - Files changed
    - Decisions made and WHY
    - Browser verification results (for UI tasks)
    - Blockers or notes for next iteration

11. Check if ALL tasks in prd.json have passes=true.
    If so, output exactly: <promise>COMPLETE</promise>

ONLY WORK ON A SINGLE TASK.")

  echo "$result"
  echo ""

  # Check for completion sigil
  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    MINUTES=$((DURATION / 60))

    echo "========================================"
    echo "PRD COMPLETE!"
    echo "========================================"
    echo "Iterations: $i"
    echo "Total time: ${MINUTES} minutes"
    echo "End time: $(date)"
    echo ""
    if [ -n "$DEV_SERVER_PID" ]; then
      echo "Stopping dev server (PID: $DEV_SERVER_PID)..."
      kill $DEV_SERVER_PID 2>/dev/null || true
    fi
    echo ""
    echo "Review the commits: git log --oneline -${i}"
    echo "========================================"
    exit 0
  fi

  # Brief pause to avoid rate limiting
  sleep 2
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MINUTES=$((DURATION / 60))

echo "========================================"
echo "Completed $ITERATIONS iterations"
echo "========================================"
echo "Total time: ${MINUTES} minutes"
echo "End time: $(date)"
echo ""
if [ -n "$DEV_SERVER_PID" ]; then
  echo "Stopping dev server (PID: $DEV_SERVER_PID)..."
  kill $DEV_SERVER_PID 2>/dev/null || true
fi
echo ""
echo "Check status:"
echo "  - progress.txt for what was done"
echo "  - prd.json for tasks with passes=false"
echo "  - git log --oneline -${ITERATIONS}"
echo ""
echo "Run again if more work remains."
echo "========================================"
