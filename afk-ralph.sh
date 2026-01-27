#!/bin/bash
# afk-ralph.sh - Autonomous Ralph loop
#
# Usage: ./afk-ralph.sh <iterations> [--issue <number>] [--port <number>] [--sandbox]
#
# GitHub issues are the work items. No PRD files needed.
# Worktrees are managed by Conductor via conductor.json.

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

ITERATIONS=""
ISSUE_NUMBER=""
PORT=""
USE_SANDBOX=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --issue) ISSUE_NUMBER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --sandbox) USE_SANDBOX=true; shift ;;
    *) [ -z "$ITERATIONS" ] && ITERATIONS="$1"; shift ;;
  esac
done

# Find available port starting from 3000
find_available_port() {
  local port=$1
  while lsof -i :"$port" >/dev/null 2>&1; do
    ((port++))
  done
  echo "$port"
}

# Auto-select port if not specified
if [ -z "$PORT" ]; then
  PORT=$(find_available_port 3000)
  echo "Auto-selected port $PORT"
fi

if [ -z "$ITERATIONS" ]; then
  echo "Usage: $0 <iterations> [--sandbox] [--issue <number>] [--port <number>]"
  exit 1
fi

# Find claude
CLAUDE_BIN=""
for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude" "$(which claude 2>/dev/null)"; do
  if [ -x "$loc" ] 2>/dev/null; then
    CLAUDE_BIN="$loc"
    break
  fi
done

if [ -z "$CLAUDE_BIN" ]; then
  echo "Error: Claude CLI not found"
  exit 1
fi

# Check dev server
check_dev_server() {
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null | grep -q "200\|304"
}

if ! check_dev_server; then
  echo "Starting dev server on port $PORT..."
  (cd apps/web && pnpm dev -p "$PORT" > "/tmp/ralph-dev-server-$PORT.log" 2>&1) &
  for i in {1..30}; do
    check_dev_server && break
    sleep 1
  done
fi

echo "========================================"
echo "Ralph - AFK Mode ($ITERATIONS iterations, port $PORT)"
echo "========================================"

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "--- Iteration $i/$ITERATIONS ---"

  # Fetch issues (specific or all open)
  if [ -n "$ISSUE_NUMBER" ]; then
    issues=$(gh issue view "$ISSUE_NUMBER" --json number,title,body,comments | jq '[.]')
  else
    issues=$(gh issue list --state open --json number,title,body,comments)
  fi

  # Build context with environment info
  context="Dev server: http://localhost:$PORT

$issues"

  OUTPUT_FILE="/tmp/ralph-iteration-$i.txt"

  if [ "$USE_SANDBOX" = true ]; then
    docker sandbox run claude \
      -v "$HOME/.claude:/home/user/.claude" \
      -v "$(pwd):/workspace" \
      -w /workspace \
      -- --dangerously-skip-permissions -p "$context @progress.txt @prds/prompt.md" | tee "$OUTPUT_FILE"
  else
    $CLAUDE_BIN --dangerously-skip-permissions -p "$context @progress.txt @prds/prompt.md" | tee "$OUTPUT_FILE"
  fi

  # Check for completion
  if grep -q "<promise>COMPLETE</promise>" "$OUTPUT_FILE" 2>/dev/null; then
    echo "========================================"
    echo "ALL ISSUES COMPLETE after $i iterations"
    echo "========================================"
    exit 0
  fi

  sleep 2
done

echo "========================================"
echo "Completed $ITERATIONS iterations"
echo "========================================"
