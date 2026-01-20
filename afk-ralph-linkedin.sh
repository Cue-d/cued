#!/bin/bash
# afk-ralph-linkedin.sh - Parallel subagent execution for LinkedIn PRD
#
# Usage: ./afk-ralph-linkedin.sh [--parallel N] [--max-iterations M]
#
# Options:
#   --parallel N       Max parallel agents (default: 3)
#   --max-iterations M Total iterations before stopping (default: 20)
#
# Features:
#   - Dependency-aware task scheduling
#   - Parallel execution of independent tasks
#   - Lock files to prevent duplicate work
#   - Shared progress tracking

set -e

# Ensure PATH includes common locations for claude CLI
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Configuration
PRD_FILE="prds/linkedin-prd.json"
PROGRESS_FILE="prds/linkedin-progress.txt"
LOCK_DIR="/tmp/ralph-linkedin-locks"
LOG_DIR="/tmp/ralph-linkedin-logs"
MAX_PARALLEL=3
MAX_ITERATIONS=20

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --parallel)
      MAX_PARALLEL="$2"
      shift 2
      ;;
    --max-iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Find claude command
CLAUDE_BIN=""
for loc in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "/opt/homebrew/bin/claude" "$(which claude 2>/dev/null)"; do
  if [ -x "$loc" ] 2>/dev/null; then
    CLAUDE_BIN="$loc"
    break
  fi
done

if [ -z "$CLAUDE_BIN" ]; then
  echo "Error: Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

echo "Using Claude CLI: $CLAUDE_BIN"

# Create directories
mkdir -p "$LOCK_DIR" "$LOG_DIR"

# Clean up old locks on start
rm -f "$LOCK_DIR"/*.lock 2>/dev/null || true

echo "========================================"
echo "Ralph LinkedIn - Parallel AFK Mode"
echo "========================================"
echo "PRD: $PRD_FILE"
echo "Max parallel agents: $MAX_PARALLEL"
echo "Max iterations: $MAX_ITERATIONS"
echo "Start time: $(date)"
echo "========================================"
echo ""

# Function to check if a task's dependencies are complete
check_dependencies() {
  local task_id="$1"
  local deps=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .depends_on[]?" "$PRD_FILE")

  for dep in $deps; do
    local dep_passes=$(jq -r ".tasks[] | select(.id == \"$dep\") | .passes" "$PRD_FILE")
    if [ "$dep_passes" != "true" ]; then
      return 1
    fi
  done
  return 0
}

# Function to get next executable tasks
get_executable_tasks() {
  local executable=()
  local task_ids=$(jq -r '.tasks[] | select(.passes == false) | .id' "$PRD_FILE")

  for task_id in $task_ids; do
    # Skip if locked
    if [ -f "$LOCK_DIR/$task_id.lock" ]; then
      continue
    fi

    # Check dependencies
    if check_dependencies "$task_id"; then
      executable+=("$task_id")
    fi
  done

  echo "${executable[@]}"
}

# Function to get tasks in a parallel group
get_parallel_group_tasks() {
  local task_id="$1"
  local group=$(jq -r ".tasks[] | select(.id == \"$task_id\") | .parallel_group // empty" "$PRD_FILE")

  if [ -n "$group" ] && [ "$group" != "null" ]; then
    jq -r ".parallel_groups[\"$group\"][]" "$PRD_FILE"
  else
    echo "$task_id"
  fi
}

# Function to run a single task
run_task() {
  local task_id="$1"
  local log_file="$LOG_DIR/task-$task_id-$(date +%s).log"

  # Create lock
  echo "$$" > "$LOCK_DIR/$task_id.lock"

  echo "[$(date +%H:%M:%S)] Starting task $task_id (log: $log_file)"

  $CLAUDE_BIN --dangerously-skip-permissions -p "@$PRD_FILE @$PROGRESS_FILE

## CONTEXT
You are working on task $task_id from the LinkedIn Messaging Integration PRD.
Other agents may be working on parallel tasks - DO NOT modify files owned by other tasks.

## YOUR TASK
1. Read the task with id=$task_id from the PRD JSON
2. If the task has a 'reference' URL, fetch it to understand the Go source code
3. Implement ONLY this task following the steps exactly
4. Run the verification command (pnpm typecheck or pnpm test)
5. If verification passes:
   - Update the PRD: set passes=true for task $task_id
   - Append a log entry to $PROGRESS_FILE with:
     - Date/time and task ID
     - Files changed
     - Brief summary of what was done
6. Commit your changes with message: 'Task $task_id: <description>'

## FILE OWNERSHIP
Only modify files listed in the task's 'files' array.
Do NOT touch files owned by other tasks to avoid git conflicts.

## IMPORTANT
- Work on task $task_id ONLY
- Do NOT proceed to dependent tasks
- If blocked, explain why and exit" > "$log_file" 2>&1

  local exit_code=$?

  # Remove lock
  rm -f "$LOCK_DIR/$task_id.lock"

  if [ $exit_code -eq 0 ]; then
    echo "[$(date +%H:%M:%S)] Task $task_id completed"
  else
    echo "[$(date +%H:%M:%S)] Task $task_id failed (exit code: $exit_code)"
  fi

  return $exit_code
}

# Main loop
iteration=0
while [ $iteration -lt $MAX_ITERATIONS ]; do
  iteration=$((iteration + 1))
  echo ""
  echo "-----------------------------------"
  echo "Iteration $iteration of $MAX_ITERATIONS"
  echo "Time: $(date)"
  echo "-----------------------------------"

  # Get executable tasks
  executable_tasks=($(get_executable_tasks))

  if [ ${#executable_tasks[@]} -eq 0 ]; then
    # Check if all tasks are complete
    incomplete=$(jq '[.tasks[] | select(.passes == false)] | length' "$PRD_FILE")
    if [ "$incomplete" -eq 0 ]; then
      echo ""
      echo "========================================"
      echo "ALL TASKS COMPLETE!"
      echo "========================================"
      echo "Total iterations: $iteration"
      echo "End time: $(date)"
      echo ""
      echo "Review: git log --oneline"
      echo "========================================"
      exit 0
    fi

    echo "No executable tasks (waiting for dependencies or locked)"
    sleep 5
    continue
  fi

  echo "Executable tasks: ${executable_tasks[*]}"

  # Determine tasks to run in parallel
  tasks_to_run=()
  for task_id in "${executable_tasks[@]}"; do
    if [ ${#tasks_to_run[@]} -ge $MAX_PARALLEL ]; then
      break
    fi

    # Get all tasks in same parallel group
    group_tasks=$(get_parallel_group_tasks "$task_id")

    for gt in $group_tasks; do
      # Check if this task is executable and not already in list
      if [[ " ${executable_tasks[*]} " =~ " $gt " ]] && [[ ! " ${tasks_to_run[*]} " =~ " $gt " ]]; then
        if [ ${#tasks_to_run[@]} -lt $MAX_PARALLEL ]; then
          tasks_to_run+=("$gt")
        fi
      fi
    done
  done

  echo "Running tasks in parallel: ${tasks_to_run[*]}"

  # Run tasks in parallel
  pids=()
  for task_id in "${tasks_to_run[@]}"; do
    run_task "$task_id" &
    pids+=($!)
  done

  # Wait for all parallel tasks
  for pid in "${pids[@]}"; do
    wait $pid || true
  done

  # Brief pause between iterations
  sleep 2
done

echo ""
echo "========================================"
echo "Reached max iterations ($MAX_ITERATIONS)"
echo "========================================"
echo "Check progress: cat $PROGRESS_FILE"
echo "Check PRD: jq '.tasks[] | select(.passes == false) | .id' $PRD_FILE"
echo "========================================"
