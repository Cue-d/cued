#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_CLI_PATH="$ROOT_DIR/dist/cli.js"
DEFAULT_BASELINE_PATH="$ROOT_DIR/src/runtime/perf/daemon-memory-baseline.json"

DEFAULT_RUN_COUNT="${CUED_BENCH_RUN_COUNT:-3}"
DEFAULT_WARMUP_SECONDS="${CUED_BENCH_WARMUP_SECONDS:-5}"
DEFAULT_SAMPLE_COUNT="${CUED_BENCH_SAMPLE_COUNT:-20}"
DEFAULT_SAMPLE_INTERVAL_SECONDS="${CUED_BENCH_SAMPLE_INTERVAL_SECONDS:-1}"
DEFAULT_STARTUP_ATTEMPTS="${CUED_BENCH_STARTUP_ATTEMPTS:-300}"
DEFAULT_STARTUP_SLEEP_SECONDS="${CUED_BENCH_STARTUP_SLEEP_SECONDS:-0.1}"
DEFAULT_IDLE_CPU_POWER_RUN_COUNT="${CUED_BENCH_IDLE_CPU_POWER_RUN_COUNT:-1}"
DEFAULT_IDLE_CPU_POWER_WARMUP_SECONDS="${CUED_BENCH_IDLE_CPU_POWER_WARMUP_SECONDS:-10}"
DEFAULT_IDLE_CPU_POWER_SAMPLE_COUNT="${CUED_BENCH_IDLE_CPU_POWER_SAMPLE_COUNT:-60}"
DEFAULT_IDLE_CPU_POWER_SAMPLE_INTERVAL_SECONDS="${CUED_BENCH_IDLE_CPU_POWER_SAMPLE_INTERVAL_SECONDS:-10}"
DEFAULT_ACTIVE_SYNC_RUN_COUNT="${CUED_BENCH_ACTIVE_SYNC_RUN_COUNT:-3}"
DEFAULT_ACTIVE_SYNC_SAMPLE_INTERVAL_SECONDS="${CUED_BENCH_ACTIVE_SYNC_SAMPLE_INTERVAL_SECONDS:-0.25}"
DEFAULT_ACTIVE_SYNC_TIMEOUT_SECONDS="${CUED_BENCH_ACTIVE_SYNC_TIMEOUT_SECONDS:-60}"

SCENARIO="clean_idle"
BASELINE_PATH=""
WRITE_BASELINE_PATH=""
ARTIFACT_ROOT=""
ACTIVE_ROOT_PID=""
CLONED_PROFILE_SEED_DB_PATH=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [--scenario=clean|cloned|idle_cpu_power|active_sync_projection] [--baseline=PATH] [--write-baseline=PATH]

Options:
  --scenario=...         Benchmark scenario to run. Default: clean_idle
  --baseline=PATH        Compare the selected scenario against a baseline file and fail on regression.
  --write-baseline=PATH  Write the selected scenario's summary metrics into a baseline file.
  --help                 Show this help text.

Scenarios:
  clean_idle             Idle daemon residency with low-noise clean profile.
  cloned_profile_idle    Idle daemon residency against a cloned ~/.cued profile (informational).
  idle_cpu_power         10-minute idle CPU/process churn sample after daemon is ready.
  active_sync_projection    Replay-driven daemon sync/projection run with CPU + memory sampling.

Notes:
  - This script runs only on macOS.
  - The daemon must already be built at dist/cli.js.
  - The cloned profile scenario currently tolerates startup failure.
EOF
}

normalize_scenario() {
  case "$1" in
    clean|clean_idle)
      printf '%s\n' "clean_idle"
      ;;
    cloned|cloned_profile|cloned_profile_idle)
      printf '%s\n' "cloned_profile_idle"
      ;;
    idle_cpu_power)
      printf '%s\n' "idle_cpu_power"
      ;;
    active_sync_projection)
      printf '%s\n' "active_sync_projection"
      ;;
    *)
      printf '%s\n' "Unsupported scenario: $1" >&2
      exit 1
      ;;
  esac
}

scenario_run_count() {
  case "$SCENARIO" in
    clean_idle|cloned_profile_idle)
      printf '%s\n' "$DEFAULT_RUN_COUNT"
      ;;
    idle_cpu_power)
      printf '%s\n' "$DEFAULT_IDLE_CPU_POWER_RUN_COUNT"
      ;;
    active_sync_projection)
      printf '%s\n' "$DEFAULT_ACTIVE_SYNC_RUN_COUNT"
      ;;
  esac
}

scenario_warmup_seconds() {
  case "$SCENARIO" in
    clean_idle|cloned_profile_idle)
      printf '%s\n' "$DEFAULT_WARMUP_SECONDS"
      ;;
    idle_cpu_power)
      printf '%s\n' "$DEFAULT_IDLE_CPU_POWER_WARMUP_SECONDS"
      ;;
    active_sync_projection)
      printf '%s\n' "0"
      ;;
  esac
}

scenario_sample_count() {
  case "$SCENARIO" in
    clean_idle|cloned_profile_idle)
      printf '%s\n' "$DEFAULT_SAMPLE_COUNT"
      ;;
    idle_cpu_power)
      printf '%s\n' "$DEFAULT_IDLE_CPU_POWER_SAMPLE_COUNT"
      ;;
    active_sync_projection)
      printf '%s\n' "0"
      ;;
  esac
}

scenario_sample_interval_seconds() {
  case "$SCENARIO" in
    clean_idle|cloned_profile_idle)
      printf '%s\n' "$DEFAULT_SAMPLE_INTERVAL_SECONDS"
      ;;
    idle_cpu_power)
      printf '%s\n' "$DEFAULT_IDLE_CPU_POWER_SAMPLE_INTERVAL_SECONDS"
      ;;
    active_sync_projection)
      printf '%s\n' "$DEFAULT_ACTIVE_SYNC_SAMPLE_INTERVAL_SECONDS"
      ;;
  esac
}

collect_tree_pids() {
  local queue out pid child
  queue="$1"
  out=""
  while [ -n "$queue" ]; do
    pid="${queue%% *}"
    if [ "$queue" = "$pid" ]; then
      queue=""
    else
      queue="${queue#* }"
    fi
    if kill -0 "$pid" 2>/dev/null; then
      out="$out $pid"
      for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        queue="$queue $child"
      done
    fi
  done
  printf '%s\n' $out | awk 'NF && !seen[$0]++'
}

sample_tree_rss_kb() {
  local pids
  pids="$(collect_tree_pids "$1" | paste -sd, -)"
  if [ -z "$pids" ]; then
    printf '0\n'
    return
  fi
  ps -o rss= -p "$pids" | awk '{ sum += $1 } END { print sum + 0 }'
}

sample_tree_cpu_pct() {
  local pids
  pids="$(collect_tree_pids "$1" | paste -sd, -)"
  if [ -z "$pids" ]; then
    printf '0\n'
    return
  fi
  ps -o %cpu= -p "$pids" | awk '{ sum += $1 } END { printf "%.2f\n", sum + 0 }'
}

median_of_file() {
  local file="$1"
  sort -n "$file" | awk '
    { values[NR] = $1 }
    END {
      if (NR == 0) {
        print 0
        exit
      }
      if (NR % 2 == 1) {
        print values[(NR + 1) / 2]
      } else {
        print (values[NR / 2] + values[(NR / 2) + 1]) / 2
      }
    }
  '
}

percentile_of_file() {
  local file="$1"
  local percentile="$2"
  sort -n "$file" | awk -v percentile="$percentile" '
    { values[NR] = $1 }
    END {
      if (NR == 0) {
        print 0
        exit
      }
      rank = int(((percentile / 100) * NR) + 0.999999)
      if (rank < 1) {
        rank = 1
      }
      if (rank > NR) {
        rank = NR
      }
      print values[rank]
    }
  '
}

avg_of_file() {
  awk '{ sum += $1; count += 1 } END { if (count == 0) { print 0 } else { print sum / count } }' "$1"
}

max_of_file() {
  awk 'NR == 1 || $1 > max { max = $1 } END { print max + 0 }' "$1"
}

format_kb_as_mb() {
  awk -v value="$1" 'BEGIN { printf "%.1f", value / 1024 }'
}

format_number() {
  awk -v value="$1" 'BEGIN { printf "%.1f", value }'
}

format_pct() {
  awk -v value="$1" 'BEGIN { printf "%.2f", value }'
}

current_time_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

run_cli_to_file() {
  local home_dir="$1"
  local output_path="$2"
  shift 2
  local disabled_slack_app_path="$home_dir/disabled/Slack.app/Contents/MacOS/Slack"
  local disabled_slack_user_data_dir="$home_dir/disabled/SlackData"
  CUED_HOME="$home_dir" \
  CUED_DB_PATH="$home_dir/local.db" \
  CUED_SLACK_APP_BINARY="$disabled_slack_app_path" \
  CUED_SLACK_USER_DATA_DIR="$disabled_slack_user_data_dir" \
  node "$DIST_CLI_PATH" "$@" >"$output_path"
}

run_cli_quiet() {
  local home_dir="$1"
  shift
  local output_path rc
  output_path="$(mktemp "/tmp/cued-bench-cli.XXXXXX")"
  rc=0
  run_cli_to_file "$home_dir" "$output_path" "$@" || rc=$?
  rm -f "$output_path"
  return "$rc"
}

parse_json_field_from_file() {
  local file_path="$1"
  local expression="$2"
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expression = process.argv[2];
    const value = new Function("data", `return (${expression});`)(data);
    if (value == null) {
      process.exit(0);
    }
    process.stdout.write(String(value));
  ' "$file_path" "$expression"
}

sqlite_value() {
  local db_path="$1"
  local query="$2"
  sqlite3 "$db_path" "$query" | tr -d '\r'
}

pending_run_count() {
  local db_path="$1"
  sqlite_value "$db_path" "SELECT COUNT(*) FROM sync_runs WHERE status IN ('queued', 'ingesting', 'projecting');"
}

capture_power_proxy() {
  local root_pid="$1"
  local output_path="$2"
  if command -v top >/dev/null 2>&1; then
    if top -l 1 -pid "$root_pid" -stats pid,command,cpu,power >"$output_path" 2>/dev/null; then
      if awk 'NR > 1 && $1 ~ /^[0-9]+$/ { found = 1 } END { exit(found ? 0 : 1) }' "$output_path"; then
        return 0
      fi
    fi
  fi
  : >"$output_path"
  return 1
}

cleanup_active_tree() {
  local pids pid root_pid
  if [ -z "${ACTIVE_ROOT_PID:-}" ]; then
    return
  fi
  root_pid="$ACTIVE_ROOT_PID"
  pids="$(collect_tree_pids "$root_pid" || true)"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
  wait "$root_pid" 2>/dev/null || true
  ACTIVE_ROOT_PID=""
}

cleanup_artifacts_on_failure() {
  cleanup_active_tree
}

prepare_home_for_run() {
  local home_dir="$1"
  mkdir -p "$home_dir"

  case "$SCENARIO" in
    clean_idle|idle_cpu_power)
      return
      ;;
    active_sync_projection)
      cat >"$home_dir/contacts-benchmark.json" <<'EOF'
{"contacts":[
  {"displayName":"Perf Alpha","company":"Cued","phoneNumbers":["+14155550101"],"emails":["alpha@example.com"]},
  {"displayName":"Perf Beta","company":"Cued","phoneNumbers":["+14155550102"],"emails":["beta@example.com"]},
  {"displayName":"Perf Gamma","company":"Cued","phoneNumbers":["+14155550103"],"emails":["gamma@example.com"]}
]}
EOF
      return
      ;;
    cloned_profile_idle)
      if [ -n "$CLONED_PROFILE_SEED_DB_PATH" ]; then
        sqlite3 "$CLONED_PROFILE_SEED_DB_PATH" ".backup '$home_dir/local.db'"
        return
      fi

      if [ ! -f "$HOME/.cued/local.db" ]; then
        printf '%s\n' "Missing source database at $HOME/.cued/local.db" >&2
        exit 1
      fi
      sqlite3 "$HOME/.cued/local.db" ".backup '$home_dir/local.db'"
      ;;
  esac
}

prepare_cloned_profile_seed() {
  local seed_home_dir
  if [ "$SCENARIO" != "cloned_profile_idle" ]; then
    return
  fi

  seed_home_dir="$ARTIFACT_ROOT/seed-home"
  prepare_home_for_run "$seed_home_dir"
  CLONED_PROFILE_SEED_DB_PATH="$seed_home_dir/local.db"

  (
    cd "$ROOT_DIR"
    CUED_HOME="$seed_home_dir" \
    CUED_DB_PATH="$CLONED_PROFILE_SEED_DB_PATH" \
    node <<'EOF'
(async () => {
  const { openCuedDatabase } = await import("./dist/db/database.js");
  const db = openCuedDatabase(process.env.CUED_DB_PATH);
  db.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF
  )
}

wait_for_daemon_ready() {
  local home_dir="$1"
  local startup_started_ms ready_ms startup_attempt
  ready_ms=0
  startup_started_ms="$(current_time_ms)"
  for startup_attempt in $(seq 1 "$DEFAULT_STARTUP_ATTEMPTS"); do
    if run_cli_quiet "$home_dir" status >/dev/null 2>&1; then
      ready_ms=$(( $(current_time_ms) - startup_started_ms ))
      break
    fi
    sleep "$DEFAULT_STARTUP_SLEEP_SECONDS"
  done
  printf '%s\n' "$ready_ms"
}

record_sample() {
  local sample_csv="$1"
  local sample_number="$2"
  local tree_pids main_rss_kb tree_rss_kb tree_cpu_pct proc_count
  tree_pids="$(collect_tree_pids "$ACTIVE_ROOT_PID" | paste -sd';' -)"
  main_rss_kb="$(ps -o rss= -p "$ACTIVE_ROOT_PID" | awk '{ print $1 + 0 }')"
  tree_rss_kb="$(sample_tree_rss_kb "$ACTIVE_ROOT_PID")"
  tree_cpu_pct="$(sample_tree_cpu_pct "$ACTIVE_ROOT_PID")"
  if [ -n "$tree_pids" ]; then
    proc_count="$(printf '%s\n' "$tree_pids" | tr ';' '\n' | awk 'NF { count += 1 } END { print count + 0 }')"
  else
    proc_count=0
  fi
  printf '%s,%s,%s,%s,%s,%s\n' \
    "$sample_number" "$main_rss_kb" "$tree_rss_kb" "$tree_cpu_pct" "$proc_count" "$tree_pids" >>"$sample_csv"
}

collect_fixed_interval_samples() {
  local run_dir="$1"
  local warmup_seconds="$2"
  local sample_count="$3"
  local sample_interval_seconds="$4"
  local sample_csv="$run_dir/samples.csv"

  printf 'sample,main_rss_kb,tree_rss_kb,tree_cpu_pct,proc_count,tree_pids\n' >"$sample_csv"
  sleep "$warmup_seconds"
  for sample_number in $(seq 1 "$sample_count"); do
    record_sample "$sample_csv" "$sample_number"
    sleep "$sample_interval_seconds"
  done
}

collect_active_sync_projection_samples() {
  local run_dir="$1"
  local home_dir="$2"
  local sample_csv="$run_dir/samples.csv"
  local sync_output="$run_dir/replay-sync.json"
  local rebuild_output="$run_dir/replay-rebuild.json"
  local sync_run_id rebuild_run_id sync_status rebuild_status
  local sample_number=0
  local active_started_ms

  printf 'sample,main_rss_kb,tree_rss_kb,tree_cpu_pct,proc_count,tree_pids\n' >"$sample_csv"

  run_cli_to_file "$home_dir" "$sync_output" sync run contacts
  run_cli_to_file "$home_dir" "$rebuild_output" rebuild
  sync_run_id="$(parse_json_field_from_file "$sync_output" 'data.runId ?? data.result?.runId ?? null')"
  rebuild_run_id="$(parse_json_field_from_file "$rebuild_output" 'data.runId ?? data.result?.runId ?? null')"

  active_started_ms="$(current_time_ms)"
  while true; do
    sample_number=$((sample_number + 1))
    record_sample "$sample_csv" "$sample_number"
    sync_status="$(sqlite_value "$home_dir/local.db" "SELECT status FROM sync_runs WHERE id = '$sync_run_id';")"
    rebuild_status="$(sqlite_value "$home_dir/local.db" "SELECT status FROM sync_runs WHERE id = '$rebuild_run_id';")"
    if \
      [ "$sample_number" -ge 2 ] && \
      { [ "$sync_status" = "completed" ] || [ "$sync_status" = "failed" ]; } && \
      { [ "$rebuild_status" = "completed" ] || [ "$rebuild_status" = "failed" ]; }; then
      break
    fi
    if [ $(( $(current_time_ms) - active_started_ms )) -ge $(( DEFAULT_ACTIVE_SYNC_TIMEOUT_SECONDS * 1000 )) ]; then
      printf '%s\n' "active_sync_projection timed out after ${DEFAULT_ACTIVE_SYNC_TIMEOUT_SECONDS}s" >&2
      return 1
    fi
    sleep "$DEFAULT_ACTIVE_SYNC_SAMPLE_INTERVAL_SECONDS"
  done
}

materialize_run_metrics() {
  local run_dir="$1"
  local sample_csv="$run_dir/samples.csv"
  local final_pids power_proxy_raw power_proxy_status

  cut -d, -f2 "$sample_csv" | tail -n +2 >"$run_dir/main-rss-kb.txt"
  cut -d, -f3 "$sample_csv" | tail -n +2 >"$run_dir/tree-rss-kb.txt"
  cut -d, -f4 "$sample_csv" | tail -n +2 >"$run_dir/tree-cpu-pct.txt"
  cut -d, -f5 "$sample_csv" | tail -n +2 >"$run_dir/proc-count.txt"
  cut -d, -f6 "$sample_csv" | tail -n +2 | tr ';' '\n' | awk 'NF' >"$run_dir/pids-seen.txt"

  MAIN_RSS_MEDIAN_KB="$(median_of_file "$run_dir/main-rss-kb.txt")"
  MAIN_RSS_AVG_KB="$(avg_of_file "$run_dir/main-rss-kb.txt")"
  MAIN_RSS_MAX_KB="$(max_of_file "$run_dir/main-rss-kb.txt")"
  TREE_RSS_MEDIAN_KB="$(median_of_file "$run_dir/tree-rss-kb.txt")"
  TREE_RSS_AVG_KB="$(avg_of_file "$run_dir/tree-rss-kb.txt")"
  TREE_RSS_MAX_KB="$(max_of_file "$run_dir/tree-rss-kb.txt")"
  CPU_MEDIAN_PCT="$(median_of_file "$run_dir/tree-cpu-pct.txt")"
  CPU_P95_PCT="$(percentile_of_file "$run_dir/tree-cpu-pct.txt" 95)"
  CPU_MAX_PCT="$(max_of_file "$run_dir/tree-cpu-pct.txt")"
  PROC_COUNT_MEDIAN="$(median_of_file "$run_dir/proc-count.txt")"

  final_pids="$(collect_tree_pids "$ACTIVE_ROOT_PID" | paste -sd, -)"
  if [ -n "$final_pids" ]; then
    ps -o pid=,ppid=,rss=,%cpu=,comm= -p "$final_pids" >"$run_dir/final-ps.txt"
  else
    : >"$run_dir/final-ps.txt"
  fi

  PROC_CHURN_COUNT="$(awk '!seen[$0]++ { count += 1 } END { print count + 0 }' "$run_dir/pids-seen.txt")"
  PROC_CHURN_COUNT="$(awk -v seen="$PROC_CHURN_COUNT" -v final="$PROC_COUNT_MEDIAN" 'BEGIN {
    churn = seen - final;
    if (churn < 0) {
      churn = 0;
    }
    print churn;
  }')"

  vmmap -summary "$ACTIVE_ROOT_PID" >"$run_dir/vmmap-summary.txt" 2>/dev/null || true
  PHYSICAL_FOOTPRINT_MB="$(awk '/^Physical footprint:/ { value = $NF; sub(/M$/, "", value); print value; exit }' "$run_dir/vmmap-summary.txt")"
  PHYSICAL_FOOTPRINT_PEAK_MB="$(awk '/^Physical footprint \(peak\):/ { value = $NF; sub(/M$/, "", value); print value; exit }' "$run_dir/vmmap-summary.txt")"
  PHYSICAL_FOOTPRINT_MB="${PHYSICAL_FOOTPRINT_MB:-0}"
  PHYSICAL_FOOTPRINT_PEAK_MB="${PHYSICAL_FOOTPRINT_PEAK_MB:-0}"

  power_proxy_status="unavailable"
  if capture_power_proxy "$ACTIVE_ROOT_PID" "$run_dir/power-proxy.txt"; then
    power_proxy_status="captured"
  fi
  power_proxy_raw="$(tr '\n' ' ' <"$run_dir/power-proxy.txt" | awk '{$1=$1; print}')"
  POWER_PROXY_STATUS="$power_proxy_status"
  POWER_PROXY_RAW="$power_proxy_raw"
}

for arg in "$@"; do
  case "$arg" in
    --)
      ;;
    --scenario=*)
      SCENARIO="$(normalize_scenario "${arg#*=}")"
      ;;
    --baseline=*)
      BASELINE_PATH="${arg#*=}"
      ;;
    --write-baseline=*)
      WRITE_BASELINE_PATH="${arg#*=}"
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' "bench-daemon-memory-macos.sh runs only on macOS." >&2
  exit 1
fi

if [ ! -f "$DIST_CLI_PATH" ]; then
  printf '%s\n' "Missing $DIST_CLI_PATH. Run pnpm build first." >&2
  exit 1
fi

for tool in node ps pgrep awk vmmap; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s\n' "Missing required tool: $tool" >&2
    exit 1
  fi
done

if [ "$SCENARIO" = "cloned_profile_idle" ] || [ "$SCENARIO" = "active_sync_projection" ]; then
  if ! command -v sqlite3 >/dev/null 2>&1; then
    printf '%s\n' "Missing required tool for $SCENARIO: sqlite3" >&2
    exit 1
  fi
fi

if [ -n "$BASELINE_PATH" ] && [ ! -f "$BASELINE_PATH" ]; then
  printf '%s\n' "Baseline file not found: $BASELINE_PATH" >&2
  exit 1
fi

ARTIFACT_ROOT="$(mktemp -d "/tmp/cued-daemon-bench.${SCENARIO}.XXXXXX")"
trap cleanup_artifacts_on_failure EXIT

RUN_COUNT="$(scenario_run_count)"
WARMUP_SECONDS="$(scenario_warmup_seconds)"
SAMPLE_COUNT="$(scenario_sample_count)"
SAMPLE_INTERVAL_SECONDS="$(scenario_sample_interval_seconds)"

prepare_cloned_profile_seed

RUN_SUMMARY_TSV="$ARTIFACT_ROOT/run-summary.tsv"
printf 'run\tstatus\tstartup_ready_ms\tmain_rss_median_kb\tmain_rss_avg_kb\tmain_rss_max_kb\ttree_rss_median_kb\ttree_rss_avg_kb\ttree_rss_max_kb\tcpu_median_pct\tcpu_p95_pct\tcpu_max_pct\tphysical_footprint_mb\tphysical_footprint_peak_mb\tproc_count_median\tproc_churn_count\tpower_proxy_status\tpower_proxy_raw\n' >"$RUN_SUMMARY_TSV"

SCENARIO_STATUS="ok"
SCENARIO_NOTE=""

for run_number in $(seq 1 "$RUN_COUNT"); do
  RUN_DIR="$ARTIFACT_ROOT/run-$run_number"
  HOME_DIR="$RUN_DIR/home"
  DISABLED_SLACK_APP_PATH="$HOME_DIR/disabled/Slack.app/Contents/MacOS/Slack"
  DISABLED_SLACK_USER_DATA_DIR="$HOME_DIR/disabled/SlackData"
  mkdir -p "$RUN_DIR"
  prepare_home_for_run "$HOME_DIR"

  DAEMON_ENV=(
    "CUED_HOME=$HOME_DIR"
    "CUED_DB_PATH=$HOME_DIR/local.db"
    "CUED_SLACK_APP_BINARY=$DISABLED_SLACK_APP_PATH"
    "CUED_SLACK_USER_DATA_DIR=$DISABLED_SLACK_USER_DATA_DIR"
  )
  if [ "$SCENARIO" = "active_sync_projection" ]; then
    DAEMON_ENV+=(
      "CUED_AUTOSYNC_PLATFORMS=contacts"
      "CUED_CONTACTS_JSON_PATH=$HOME_DIR/contacts-benchmark.json"
    )
  fi

  env "${DAEMON_ENV[@]}" node "$DIST_CLI_PATH" daemon >"$RUN_DIR/daemon.out" 2>&1 &
  ACTIVE_ROOT_PID="$!"

  READY_MS="$(wait_for_daemon_ready "$HOME_DIR")"
  if [ "$READY_MS" -eq 0 ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$run_number" "startup_failed" 0 0 0 0 0 0 0 0 0 0 0 0 0 0 "unavailable" "" >>"$RUN_SUMMARY_TSV"

    if [ "$SCENARIO" = "clean_idle" ] || [ "$SCENARIO" = "idle_cpu_power" ] || [ "$SCENARIO" = "active_sync_projection" ]; then
      printf '%s\n' "Daemon failed to start during $SCENARIO. See $RUN_DIR/daemon.out." >&2
      exit 1
    fi

    SCENARIO_STATUS="startup_failed"
    SCENARIO_NOTE="cloned profile startup failed; informational scenario only"
    cleanup_active_tree
    break
  fi

  case "$SCENARIO" in
    clean_idle|cloned_profile_idle|idle_cpu_power)
      collect_fixed_interval_samples "$RUN_DIR" "$WARMUP_SECONDS" "$SAMPLE_COUNT" "$SAMPLE_INTERVAL_SECONDS"
      ;;
    active_sync_projection)
      collect_active_sync_projection_samples "$RUN_DIR" "$HOME_DIR"
      ;;
  esac

  materialize_run_metrics "$RUN_DIR"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run_number" "ok" "$READY_MS" "$MAIN_RSS_MEDIAN_KB" "$MAIN_RSS_AVG_KB" "$MAIN_RSS_MAX_KB" \
    "$TREE_RSS_MEDIAN_KB" "$TREE_RSS_AVG_KB" "$TREE_RSS_MAX_KB" \
    "$CPU_MEDIAN_PCT" "$CPU_P95_PCT" "$CPU_MAX_PCT" \
    "$PHYSICAL_FOOTPRINT_MB" "$PHYSICAL_FOOTPRINT_PEAK_MB" "$PROC_COUNT_MEDIAN" "$PROC_CHURN_COUNT" \
    "$POWER_PROXY_STATUS" "$POWER_PROXY_RAW" >>"$RUN_SUMMARY_TSV"

  cleanup_active_tree
done

if awk -F '\t' 'NR > 1 && $2 == "ok" { found = 1 } END { exit(found ? 0 : 1) }' "$RUN_SUMMARY_TSV"; then
  cut -f3 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/startup-ready-ms.txt"
  cut -f4 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/main-rss-median-kb.txt"
  cut -f5 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/main-rss-avg-kb.txt"
  cut -f6 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/main-rss-max-kb.txt"
  cut -f7 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/tree-rss-median-kb.txt"
  cut -f8 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/tree-rss-avg-kb.txt"
  cut -f9 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/tree-rss-max-kb.txt"
  cut -f10 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/cpu-median-pct.txt"
  cut -f11 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/cpu-p95-pct.txt"
  cut -f12 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/cpu-max-pct.txt"
  cut -f13 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/physical-footprint-mb.txt"
  cut -f14 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/physical-footprint-peak-mb.txt"
  cut -f15 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/proc-count-median.txt"
  cut -f16 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 >= 0' >"$ARTIFACT_ROOT/proc-churn-count.txt"

  STARTUP_READY_MS="$(median_of_file "$ARTIFACT_ROOT/startup-ready-ms.txt")"
  MAIN_RSS_MEDIAN_MB="$(format_kb_as_mb "$(median_of_file "$ARTIFACT_ROOT/main-rss-median-kb.txt")")"
  MAIN_RSS_AVG_MB="$(format_kb_as_mb "$(avg_of_file "$ARTIFACT_ROOT/main-rss-avg-kb.txt")")"
  MAIN_RSS_MAX_MB="$(format_kb_as_mb "$(max_of_file "$ARTIFACT_ROOT/main-rss-max-kb.txt")")"
  TREE_RSS_MEDIAN_MB="$(format_kb_as_mb "$(median_of_file "$ARTIFACT_ROOT/tree-rss-median-kb.txt")")"
  TREE_RSS_AVG_MB="$(format_kb_as_mb "$(avg_of_file "$ARTIFACT_ROOT/tree-rss-avg-kb.txt")")"
  TREE_RSS_MAX_MB="$(format_kb_as_mb "$(max_of_file "$ARTIFACT_ROOT/tree-rss-max-kb.txt")")"
  CPU_MEDIAN_PCT="$(format_pct "$(median_of_file "$ARTIFACT_ROOT/cpu-median-pct.txt")")"
  CPU_P95_PCT="$(format_pct "$(max_of_file "$ARTIFACT_ROOT/cpu-p95-pct.txt")")"
  CPU_MAX_PCT="$(format_pct "$(max_of_file "$ARTIFACT_ROOT/cpu-max-pct.txt")")"
  PHYSICAL_FOOTPRINT_MB="$(format_number "$(median_of_file "$ARTIFACT_ROOT/physical-footprint-mb.txt")")"
  PHYSICAL_FOOTPRINT_PEAK_MB="$(format_number "$(max_of_file "$ARTIFACT_ROOT/physical-footprint-peak-mb.txt")")"
  PROC_COUNT_MEDIAN="$(median_of_file "$ARTIFACT_ROOT/proc-count-median.txt")"
  PROC_CHURN_COUNT="$(max_of_file "$ARTIFACT_ROOT/proc-churn-count.txt")"
else
  if [ "$SCENARIO" != "cloned_profile_idle" ] || [ "$SCENARIO_STATUS" != "startup_failed" ]; then
    printf '%s\n' "No successful benchmark runs completed." >&2
    exit 1
  fi

  STARTUP_READY_MS="0"
  MAIN_RSS_MEDIAN_MB="0.0"
  MAIN_RSS_AVG_MB="0.0"
  MAIN_RSS_MAX_MB="0.0"
  TREE_RSS_MEDIAN_MB="0.0"
  TREE_RSS_AVG_MB="0.0"
  TREE_RSS_MAX_MB="0.0"
  CPU_MEDIAN_PCT="0.00"
  CPU_P95_PCT="0.00"
  CPU_MAX_PCT="0.00"
  PHYSICAL_FOOTPRINT_MB="0.0"
  PHYSICAL_FOOTPRINT_PEAK_MB="0.0"
  PROC_COUNT_MEDIAN="0"
  PROC_CHURN_COUNT="0"
fi

SUMMARY_JSON_PATH="$ARTIFACT_ROOT/summary.json"

SCENARIO="$SCENARIO" \
SCENARIO_STATUS="$SCENARIO_STATUS" \
SCENARIO_NOTE="$SCENARIO_NOTE" \
ARTIFACT_ROOT="$ARTIFACT_ROOT" \
BASELINE_PATH="${BASELINE_PATH:-}" \
STARTUP_READY_MS="$STARTUP_READY_MS" \
MAIN_RSS_MEDIAN_MB="$MAIN_RSS_MEDIAN_MB" \
MAIN_RSS_AVG_MB="$MAIN_RSS_AVG_MB" \
MAIN_RSS_MAX_MB="$MAIN_RSS_MAX_MB" \
TREE_RSS_MEDIAN_MB="$TREE_RSS_MEDIAN_MB" \
TREE_RSS_AVG_MB="$TREE_RSS_AVG_MB" \
TREE_RSS_MAX_MB="$TREE_RSS_MAX_MB" \
CPU_MEDIAN_PCT="$CPU_MEDIAN_PCT" \
CPU_P95_PCT="$CPU_P95_PCT" \
CPU_MAX_PCT="$CPU_MAX_PCT" \
PHYSICAL_FOOTPRINT_MB="$PHYSICAL_FOOTPRINT_MB" \
PHYSICAL_FOOTPRINT_PEAK_MB="$PHYSICAL_FOOTPRINT_PEAK_MB" \
PROC_COUNT_MEDIAN="$PROC_COUNT_MEDIAN" \
PROC_CHURN_COUNT="$PROC_CHURN_COUNT" \
RUN_SUMMARY_TSV="$RUN_SUMMARY_TSV" \
SUMMARY_JSON_PATH="$SUMMARY_JSON_PATH" \
node <<'EOF'
const fs = require("node:fs");

function toNumber(value) {
  return Number.parseFloat(value);
}

const rows = fs
  .readFileSync(process.env.RUN_SUMMARY_TSV, "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .filter(Boolean)
  .map((line) => {
    const [
      run,
      status,
      startupReadyMs,
      mainRssMedianKb,
      mainRssAvgKb,
      mainRssMaxKb,
      treeRssMedianKb,
      treeRssAvgKb,
      treeRssMaxKb,
      cpuMedianPct,
      cpuP95Pct,
      cpuMaxPct,
      physicalFootprintMb,
      physicalFootprintPeakMb,
      procCountMedian,
      procChurnCount,
      powerProxyStatus,
      powerProxyRaw,
    ] = line.split("\t");

    return {
      run: Number.parseInt(run, 10),
      status,
      startupReadyMs: Number.parseFloat(startupReadyMs),
      mainRssMedianMb: Number.parseFloat(mainRssMedianKb) / 1024,
      mainRssAvgMb: Number.parseFloat(mainRssAvgKb) / 1024,
      mainRssMaxMb: Number.parseFloat(mainRssMaxKb) / 1024,
      treeRssMedianMb: Number.parseFloat(treeRssMedianKb) / 1024,
      treeRssAvgMb: Number.parseFloat(treeRssAvgKb) / 1024,
      treeRssMaxMb: Number.parseFloat(treeRssMaxKb) / 1024,
      cpuMedianPct: Number.parseFloat(cpuMedianPct),
      cpuP95Pct: Number.parseFloat(cpuP95Pct),
      cpuMaxPct: Number.parseFloat(cpuMaxPct),
      physicalFootprintMb: Number.parseFloat(physicalFootprintMb),
      physicalFootprintPeakMb: Number.parseFloat(physicalFootprintPeakMb),
      processCount: Number.parseFloat(procCountMedian),
      processChurnCount: Number.parseFloat(procChurnCount),
      powerProxy:
        powerProxyStatus === "captured" && powerProxyRaw
          ? { tool: "top", sample: powerProxyRaw }
          : null,
    };
  });

const result = {
  scenario: process.env.SCENARIO,
  status: process.env.SCENARIO_STATUS,
  note: process.env.SCENARIO_NOTE || null,
  artifactRoot: process.env.ARTIFACT_ROOT,
  metrics: {
    startupReadyMs: toNumber(process.env.STARTUP_READY_MS),
    mainRssMedianMb: toNumber(process.env.MAIN_RSS_MEDIAN_MB),
    mainRssAvgMb: toNumber(process.env.MAIN_RSS_AVG_MB),
    mainRssMaxMb: toNumber(process.env.MAIN_RSS_MAX_MB),
    treeRssMedianMb: toNumber(process.env.TREE_RSS_MEDIAN_MB),
    treeRssAvgMb: toNumber(process.env.TREE_RSS_AVG_MB),
    treeRssMaxMb: toNumber(process.env.TREE_RSS_MAX_MB),
    physicalFootprintMb: toNumber(process.env.PHYSICAL_FOOTPRINT_MB),
    physicalFootprintPeakMb: toNumber(process.env.PHYSICAL_FOOTPRINT_PEAK_MB),
    cpuMedianPct: toNumber(process.env.CPU_MEDIAN_PCT),
    cpuP95Pct: toNumber(process.env.CPU_P95_PCT),
    cpuMaxPct: toNumber(process.env.CPU_MAX_PCT),
    processCount: toNumber(process.env.PROC_COUNT_MEDIAN),
    processChurnCount: toNumber(process.env.PROC_CHURN_COUNT),
    powerProxy: rows.find((row) => row.powerProxy)?.powerProxy ?? null,
  },
  runs: rows,
};

fs.writeFileSync(process.env.SUMMARY_JSON_PATH, `${JSON.stringify(result, null, 2)}\n`);
EOF

COMPARE_REPORT_PATH="$ARTIFACT_ROOT/compare.json"
COMPARE_EXIT_CODE=0

if [ -n "$BASELINE_PATH" ]; then
  SUMMARY_JSON_PATH="$SUMMARY_JSON_PATH" \
  BASELINE_PATH="$BASELINE_PATH" \
  SCENARIO="$SCENARIO" \
  COMPARE_REPORT_PATH="$COMPARE_REPORT_PATH" \
  node <<'EOF' || COMPARE_EXIT_CODE=$?
const fs = require("node:fs");

const summary = JSON.parse(fs.readFileSync(process.env.SUMMARY_JSON_PATH, "utf8"));
const baselineFile = JSON.parse(fs.readFileSync(process.env.BASELINE_PATH, "utf8"));
const baseline = baselineFile[process.env.SCENARIO];

if (!baseline) {
  throw new Error(`No baseline entry for scenario '${process.env.SCENARIO}'.`);
}

const failures = [];
const comparisons = [];

function compare(metric, limit) {
  if (typeof baseline[metric] !== "number") {
    return;
  }
  const current = summary.metrics[metric];
  const expected = baseline[metric];
  const passed = current <= limit;
  comparisons.push({ metric, baseline: expected, current, limit, passed });
  if (!passed) {
    failures.push(
      `${metric} regressed: baseline=${expected.toFixed(1)} current=${current.toFixed(1)} limit=${limit.toFixed(1)}`,
    );
  }
}

compare("startupReadyMs", baseline.startupReadyMs * 1.1);
compare(
  "mainRssMedianMb",
  baseline.mainRssMedianMb + Math.max(15, baseline.mainRssMedianMb * 0.05),
);
compare("treeRssMedianMb", baseline.treeRssMedianMb + 15);
compare(
  "physicalFootprintMb",
  baseline.physicalFootprintMb + Math.max(15, baseline.physicalFootprintMb * 0.05),
);
compare("treeRssMaxMb", baseline.treeRssMaxMb + 25);
compare(
  "cpuMedianPct",
  baseline.cpuMedianPct + Math.max(0.25, baseline.cpuMedianPct * 0.25),
);
compare("cpuP95Pct", baseline.cpuP95Pct + Math.max(1, baseline.cpuP95Pct * 0.25));

const report = { scenario: process.env.SCENARIO, comparisons, failures };
fs.writeFileSync(process.env.COMPARE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
EOF
fi

if [ -n "$WRITE_BASELINE_PATH" ]; then
  SUMMARY_JSON_PATH="$SUMMARY_JSON_PATH" \
  WRITE_BASELINE_PATH="$WRITE_BASELINE_PATH" \
  SCENARIO="$SCENARIO" \
  node <<'EOF'
const fs = require("node:fs");
const path = process.env.WRITE_BASELINE_PATH;
const summary = JSON.parse(fs.readFileSync(process.env.SUMMARY_JSON_PATH, "utf8"));

const nextEntry = {
  startupReadyMs: summary.metrics.startupReadyMs,
  mainRssMedianMb: summary.metrics.mainRssMedianMb,
  treeRssMedianMb: summary.metrics.treeRssMedianMb,
  physicalFootprintMb: summary.metrics.physicalFootprintMb,
  cpuMedianPct: summary.metrics.cpuMedianPct,
  cpuP95Pct: summary.metrics.cpuP95Pct,
  treeRssMaxMb: summary.metrics.treeRssMaxMb,
  processCount: summary.metrics.processCount,
};

let baseline = {};
if (fs.existsSync(path)) {
  baseline = JSON.parse(fs.readFileSync(path, "utf8"));
}
baseline[process.env.SCENARIO] = nextEntry;
fs.writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
EOF
fi

printf '%s\n' "Daemon performance benchmark"
printf '%-24s %s\n' "scenario" "$SCENARIO"
printf '%-24s %s\n' "status" "$SCENARIO_STATUS"
if [ -n "$SCENARIO_NOTE" ]; then
  printf '%-24s %s\n' "note" "$SCENARIO_NOTE"
fi
printf '%-24s %s\n' "artifacts" "$ARTIFACT_ROOT"
printf '%-24s %s\n' "startupReadyMs" "$STARTUP_READY_MS"
printf '%-24s %s MB\n' "mainRssMedian" "$MAIN_RSS_MEDIAN_MB"
printf '%-24s %s MB\n' "mainRssAvg" "$MAIN_RSS_AVG_MB"
printf '%-24s %s MB\n' "mainRssMax" "$MAIN_RSS_MAX_MB"
printf '%-24s %s MB\n' "treeRssMedian" "$TREE_RSS_MEDIAN_MB"
printf '%-24s %s MB\n' "treeRssAvg" "$TREE_RSS_AVG_MB"
printf '%-24s %s MB\n' "treeRssMax" "$TREE_RSS_MAX_MB"
printf '%-24s %s MB\n' "physicalFootprint" "$PHYSICAL_FOOTPRINT_MB"
printf '%-24s %s MB\n' "physicalFootprintPeak" "$PHYSICAL_FOOTPRINT_PEAK_MB"
printf '%-24s %s%%\n' "cpuMedianPct" "$CPU_MEDIAN_PCT"
printf '%-24s %s%%\n' "cpuP95Pct" "$CPU_P95_PCT"
printf '%-24s %s%%\n' "cpuMaxPct" "$CPU_MAX_PCT"
printf '%-24s %s\n' "processCount" "$PROC_COUNT_MEDIAN"
printf '%-24s %s\n' "processChurnCount" "$PROC_CHURN_COUNT"

if [ -f "$COMPARE_REPORT_PATH" ]; then
  printf '%-24s %s\n' "baseline" "$BASELINE_PATH"
fi

printf '\n'
cat "$SUMMARY_JSON_PATH"

trap - EXIT

exit "$COMPARE_EXIT_CODE"
