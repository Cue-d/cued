#!/bin/bash
# ralph-once.sh - Human-in-the-loop Ralph iteration
#
# Usage: ./ralph-once.sh [--issue <number>] [--port <number>] [--sandbox]
#
# GitHub issues are the work items. No PRD files needed.
# Worktrees are managed by Conductor via conductor.json.

set -e

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

ISSUE_NUMBER=""
PORT=""
USE_SANDBOX=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --issue) ISSUE_NUMBER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --sandbox) USE_SANDBOX=true; shift ;;
    *) shift ;;
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

# Find claude
CLAUDE_CMD=""
for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude" "$(which claude 2>/dev/null)"; do
  if [ -x "$loc" ] 2>/dev/null; then
    CLAUDE_CMD="$loc"
    break
  fi
done

if [ -z "$CLAUDE_CMD" ]; then
  echo "Error: Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
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

# Fetch GitHub issues
if [ -n "$ISSUE_NUMBER" ]; then
  echo "Targeting issue #$ISSUE_NUMBER"
  issues=$(gh issue view "$ISSUE_NUMBER" --json number,title,body,comments | jq '[.]')
else
  issues=$(gh issue list --state open --json number,title,body,comments)
fi

echo "========================================"
echo "Ralph - HITL Mode (port $PORT)"
echo "========================================"

# Build context with environment info
context="Dev server: http://localhost:$PORT

$issues"

if [ "$USE_SANDBOX" = true ]; then
  echo "Running in Docker sandbox with OAuth credentials..."
  docker sandbox run claude \
    -v "$HOME/.claude:/home/user/.claude" \
    -v "$(pwd):/workspace" \
    -w /workspace \
    -- --dangerously-skip-permissions -p "$context @progress.txt @prds/prompt.md"
else
  $CLAUDE_CMD -p --dangerously-skip-permissions "$context @progress.txt @prds/prompt.md"
fi

echo ""
echo "Done. Review: git log -1 --stat"
