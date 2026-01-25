#!/bin/bash
# afk-ralph.sh - Autonomous Ralph Wiggum loop
# Usage: ./afk-ralph.sh <prd-file> <iterations> [--sandbox]
#
# Example: ./afk-ralph.sh prds/slack-native-integration-prd.json 10
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

# Don't use set -e - we handle errors with retries in the main loop

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
PRD_FILE=""
ITERATIONS=""
USE_SANDBOX=false

for arg in "$@"; do
  case $arg in
    --sandbox)
      USE_SANDBOX=true
      ;;
    *)
      if [ -z "$PRD_FILE" ]; then
        PRD_FILE=$arg
      elif [ -z "$ITERATIONS" ]; then
        ITERATIONS=$arg
      fi
      ;;
  esac
done

if [ -z "$PRD_FILE" ] || [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 <prd-file> <iterations> [--sandbox]"
  echo ""
  echo "Examples:"
  echo "  ./afk-ralph.sh prds/slack-native-integration-prd.json 10"
  echo "  ./afk-ralph.sh prds/prm-38-prd.json 20 --sandbox"
  echo ""
  echo "Recommended iteration counts:"
  echo "  5-10   Small tasks, single phase"
  echo "  20-30  Full phase (e.g., AI Assistant)"
  echo "  50+    Multiple phases"
  exit 1
fi

# Derive progress file from PRD file
PROGRESS_FILE="${PRD_FILE%.json}-progress.txt"

# Verify PRD file exists
if [ ! -f "$PRD_FILE" ]; then
  echo "Error: PRD file not found: $PRD_FILE"
  exit 1
fi

START_TIME=$(date +%s)

echo "========================================"
echo "Ralph Wiggum - AFK Mode"
echo "========================================"
echo "PRD: $PRD_FILE"
echo "Progress: $PROGRESS_FILE"
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

  OUTPUT_FILE="/tmp/ralph-iteration-$i.txt"

  # Retry loop for transient API errors
  MAX_RETRIES=3
  RETRY_DELAY=5
  for ((retry=1; retry<=MAX_RETRIES; retry++)); do
    if $CLAUDE_CMD "@$PRD_FILE @$PROGRESS_FILE \

## CONTEXT
This is PRODUCTION CODE. Quality over speed.
Every shortcut becomes someone else's burden.
Fight entropy. Leave the codebase better than you found it.

## PRD FORMAT
The $PRD_FILE file contains structured tasks with:
- id: Task identifier (e.g., '3.2')
- phase: 1-7
- mode: 'hitl' or 'afk'
- category: architectural, integration, functional, ui, testing, refactor, documentation
- description: What to implement
- steps: Verification steps (all must pass)
- passes: false (you set to true when complete)
- depends_on: (optional) Array of task IDs that must complete first
- parallel_group: (optional) Group ID for tasks that can run in parallel (e.g., 'P1', 'P2')
- reference: (optional) URL to documentation for this task

The PRD also has a 'parallel_groups' object defining which tasks can run concurrently.

## YOUR TASK
1. Read $PRD_FILE and $PROGRESS_FILE to understand current state.

2. Find tasks where passes=false. Check dependencies:
   - A task can only start if all tasks in its 'depends_on' array have passes=true
   - Tasks in the same 'parallel_group' can be spawned as parallel sub-agents using the Task tool

3. For PARALLEL EXECUTION: If you find multiple tasks in the same parallel_group that are ready:
   - Use the Task tool to spawn multiple sub-agents, one per task
   - Run them IN PARALLEL (single message with multiple Task tool calls)
   - Each sub-agent should complete its task, commit, and update the PRD

4. For SEQUENTIAL EXECUTION: Choose tasks using this priority:
   - Architectural decisions and core abstractions (HIGH)
   - Integration points between modules (HIGH)
   - Unknown unknowns and spike work (HIGH)
   - Standard features and implementation (MEDIUM)
   - Polish, cleanup, and quick wins (LOW)

5. If the task has a 'reference' URL, fetch it to understand the implementation.

6. Keep changes SMALL and FOCUSED:
   - One logical change per commit
   - If the task feels too large, break it into subtasks
   - Run feedback loops after each change, not at the end

7. Implement the task, then verify ALL steps in the task's 'steps' array.

8. Run feedback loops (only relevant tests, not full suite):
   - TypeScript: pnpm typecheck (MUST pass)
   - Tests: Run ONLY tests related to the changed code (use --grep or file path)
   Do NOT commit if feedback loops fail.

9. IMMEDIATELY commit your changes using git:
   - git add <files you changed>
   - git commit -m 'fix(scope): description'
   This is REQUIRED. Do not skip this step. Do not batch commits.

10. Update $PRD_FILE: set passes=true for the completed task. Save the file.

11. Update $PROGRESS_FILE with:
    - Date/time and task ID + description
    - Files changed
    - Decisions made and WHY
    - Browser verification results (for UI tasks)
    - Blockers or notes for next iteration

12. Check if ALL tasks in $PRD_FILE have passes=true.
    If so, output exactly: <promise>COMPLETE</promise>

CRITICAL: You MUST commit before the iteration ends. No commit = failed iteration.
For single tasks: implement, test, commit, update PRD - ONE task per iteration." | tee "$OUTPUT_FILE"; then
      break  # Success, exit retry loop
    else
      echo "Claude command failed (attempt $retry/$MAX_RETRIES)"
      if [ $retry -lt $MAX_RETRIES ]; then
        echo "Retrying in ${RETRY_DELAY}s..."
        sleep $RETRY_DELAY
        RETRY_DELAY=$((RETRY_DELAY * 2))  # Exponential backoff
      else
        echo "All retries exhausted, continuing to next iteration..."
      fi
    fi
  done

  echo ""

  # Check for completion sigil
  if grep -q "<promise>COMPLETE</promise>" "$OUTPUT_FILE" 2>/dev/null; then
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
echo "  - $PROGRESS_FILE for what was done"
echo "  - $PRD_FILE for tasks with passes=false"
echo "  - git log --oneline -${ITERATIONS}"
echo ""
echo "Run again if more work remains."
echo "========================================"
