#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_CLI_PATH="$ROOT_DIR/dist/cli.js"
DEFAULT_BASELINE_PATH="$ROOT_DIR/src/runtime/perf/daemon-memory-baseline.json"

RUN_COUNT=3
WARMUP_SECONDS=5
SAMPLE_COUNT=20
SAMPLE_INTERVAL_SECONDS=1
STARTUP_ATTEMPTS=300
STARTUP_SLEEP_SECONDS=0.1

SCENARIO="clean_idle"
BASELINE_PATH=""
WRITE_BASELINE_PATH=""
ARTIFACT_ROOT=""
ACTIVE_ROOT_PID=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [--scenario=clean|clean_idle|cloned|cloned_profile_idle] [--baseline=PATH] [--write-baseline=PATH]

Options:
  --scenario=...         Benchmark scenario to run. Default: clean_idle
  --baseline=PATH        Compare the selected scenario against a baseline file and fail on regression.
  --write-baseline=PATH  Write the selected scenario's summary metrics into a baseline file.
  --help                 Show this help text.

Notes:
  - This script runs only on macOS.
  - The daemon must already be built at dist/cli.js.
  - The cloned profile scenario is informational and currently tolerates startup failure.
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
    *)
      printf '%s\n' "Unsupported scenario: $1" >&2
      exit 1
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

current_time_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
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
    clean_idle)
      return
      ;;
    cloned_profile_idle)
      if [ ! -f "$HOME/.cued/local.db" ]; then
        printf '%s\n' "Missing source database at $HOME/.cued/local.db" >&2
        exit 1
      fi
      sqlite3 "$HOME/.cued/local.db" ".backup '$home_dir/local.db'"
      ;;
  esac
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

if [ "$SCENARIO" = "cloned_profile_idle" ] && ! command -v sqlite3 >/dev/null 2>&1; then
  printf '%s\n' "Missing required tool for cloned profile scenario: sqlite3" >&2
  exit 1
fi

if [ -n "$BASELINE_PATH" ] && [ ! -f "$BASELINE_PATH" ]; then
  printf '%s\n' "Baseline file not found: $BASELINE_PATH" >&2
  exit 1
fi

ARTIFACT_ROOT="$(mktemp -d "/tmp/cued-daemon-memory.${SCENARIO}.XXXXXX")"
trap cleanup_artifacts_on_failure EXIT

RUN_SUMMARY_TSV="$ARTIFACT_ROOT/run-summary.tsv"
printf 'run\tstatus\tstartup_ready_ms\tmain_rss_median_kb\tmain_rss_avg_kb\tmain_rss_max_kb\ttree_rss_median_kb\ttree_rss_avg_kb\ttree_rss_max_kb\tphysical_footprint_mb\tphysical_footprint_peak_mb\tproc_count_median\n' >"$RUN_SUMMARY_TSV"

SCENARIO_STATUS="ok"
SCENARIO_NOTE=""

for run_number in $(seq 1 "$RUN_COUNT"); do
  RUN_DIR="$ARTIFACT_ROOT/run-$run_number"
  HOME_DIR="$RUN_DIR/home"
  DISABLED_SLACK_APP_PATH="$HOME_DIR/disabled/Slack.app/Contents/MacOS/Slack"
  DISABLED_SLACK_USER_DATA_DIR="$HOME_DIR/disabled/SlackData"
  mkdir -p "$RUN_DIR"
  prepare_home_for_run "$HOME_DIR"

  CUED_HOME="$HOME_DIR" \
  CUED_DB_PATH="$HOME_DIR/local.db" \
  CUED_AUTOSYNC_PLATFORMS="fixture" \
  CUED_SLACK_APP_BINARY="$DISABLED_SLACK_APP_PATH" \
  CUED_SLACK_USER_DATA_DIR="$DISABLED_SLACK_USER_DATA_DIR" \
  node "$DIST_CLI_PATH" daemon >"$RUN_DIR/daemon.out" 2>&1 &
  ACTIVE_ROOT_PID="$!"

  READY_MS=0
  STARTUP_STARTED_MS="$(current_time_ms)"
  for startup_attempt in $(seq 1 "$STARTUP_ATTEMPTS"); do
    if \
      CUED_HOME="$HOME_DIR" \
      CUED_DB_PATH="$HOME_DIR/local.db" \
      CUED_SLACK_APP_BINARY="$DISABLED_SLACK_APP_PATH" \
      CUED_SLACK_USER_DATA_DIR="$DISABLED_SLACK_USER_DATA_DIR" \
      node "$DIST_CLI_PATH" status >/dev/null 2>&1; then
      READY_MS=$(( $(current_time_ms) - STARTUP_STARTED_MS ))
      break
    fi
    sleep "$STARTUP_SLEEP_SECONDS"
  done

  if [ "$READY_MS" -eq 0 ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$run_number" "startup_failed" 0 0 0 0 0 0 0 0 0 0 >>"$RUN_SUMMARY_TSV"

    if [ "$SCENARIO" = "clean_idle" ]; then
      printf '%s\n' "Daemon failed to start during clean_idle scenario. See $RUN_DIR/daemon.out." >&2
      exit 1
    fi

    SCENARIO_STATUS="startup_failed"
    SCENARIO_NOTE="cloned profile startup failed; informational scenario only"
    cleanup_active_tree
    break
  fi

  sleep "$WARMUP_SECONDS"

  SAMPLE_CSV="$RUN_DIR/samples.csv"
  printf 'sample,main_rss_kb,tree_rss_kb,proc_count\n' >"$SAMPLE_CSV"

  for sample_number in $(seq 1 "$SAMPLE_COUNT"); do
    MAIN_RSS_KB="$(ps -o rss= -p "$ACTIVE_ROOT_PID" | awk '{ print $1 + 0 }')"
    TREE_RSS_KB="$(sample_tree_rss_kb "$ACTIVE_ROOT_PID")"
    PROC_COUNT="$(collect_tree_pids "$ACTIVE_ROOT_PID" | awk 'END { print NR + 0 }')"
    printf '%s,%s,%s,%s\n' "$sample_number" "$MAIN_RSS_KB" "$TREE_RSS_KB" "$PROC_COUNT" >>"$SAMPLE_CSV"
    sleep "$SAMPLE_INTERVAL_SECONDS"
  done

  cut -d, -f2 "$SAMPLE_CSV" | tail -n +2 >"$RUN_DIR/main-rss-kb.txt"
  cut -d, -f3 "$SAMPLE_CSV" | tail -n +2 >"$RUN_DIR/tree-rss-kb.txt"
  cut -d, -f4 "$SAMPLE_CSV" | tail -n +2 >"$RUN_DIR/proc-count.txt"

  MAIN_RSS_MEDIAN_KB="$(median_of_file "$RUN_DIR/main-rss-kb.txt")"
  MAIN_RSS_AVG_KB="$(avg_of_file "$RUN_DIR/main-rss-kb.txt")"
  MAIN_RSS_MAX_KB="$(max_of_file "$RUN_DIR/main-rss-kb.txt")"
  TREE_RSS_MEDIAN_KB="$(median_of_file "$RUN_DIR/tree-rss-kb.txt")"
  TREE_RSS_AVG_KB="$(avg_of_file "$RUN_DIR/tree-rss-kb.txt")"
  TREE_RSS_MAX_KB="$(max_of_file "$RUN_DIR/tree-rss-kb.txt")"
  PROC_COUNT_MEDIAN="$(median_of_file "$RUN_DIR/proc-count.txt")"

  FINAL_PIDS="$(collect_tree_pids "$ACTIVE_ROOT_PID" | paste -sd, -)"
  if [ -n "$FINAL_PIDS" ]; then
    ps -o pid=,ppid=,rss=,comm= -p "$FINAL_PIDS" >"$RUN_DIR/final-ps.txt"
  else
    : >"$RUN_DIR/final-ps.txt"
  fi

  vmmap -summary "$ACTIVE_ROOT_PID" >"$RUN_DIR/vmmap-summary.txt" 2>/dev/null || true
  PHYSICAL_FOOTPRINT_MB="$(awk '/^Physical footprint:/ { value = $NF; sub(/M$/, "", value); print value; exit }' "$RUN_DIR/vmmap-summary.txt")"
  PHYSICAL_FOOTPRINT_PEAK_MB="$(awk '/^Physical footprint \(peak\):/ { value = $NF; sub(/M$/, "", value); print value; exit }' "$RUN_DIR/vmmap-summary.txt")"
  PHYSICAL_FOOTPRINT_MB="${PHYSICAL_FOOTPRINT_MB:-0}"
  PHYSICAL_FOOTPRINT_PEAK_MB="${PHYSICAL_FOOTPRINT_PEAK_MB:-0}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run_number" "ok" "$READY_MS" "$MAIN_RSS_MEDIAN_KB" "$MAIN_RSS_AVG_KB" "$MAIN_RSS_MAX_KB" \
    "$TREE_RSS_MEDIAN_KB" "$TREE_RSS_AVG_KB" "$TREE_RSS_MAX_KB" \
    "$PHYSICAL_FOOTPRINT_MB" "$PHYSICAL_FOOTPRINT_PEAK_MB" "$PROC_COUNT_MEDIAN" >>"$RUN_SUMMARY_TSV"

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
  cut -f10 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/physical-footprint-mb.txt"
  cut -f11 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/physical-footprint-peak-mb.txt"
  cut -f12 "$RUN_SUMMARY_TSV" | tail -n +2 | awk '$1 > 0' >"$ARTIFACT_ROOT/proc-count-median.txt"

  STARTUP_READY_MS="$(median_of_file "$ARTIFACT_ROOT/startup-ready-ms.txt")"
  MAIN_RSS_MEDIAN_MB="$(format_kb_as_mb "$(median_of_file "$ARTIFACT_ROOT/main-rss-median-kb.txt")")"
  MAIN_RSS_AVG_MB="$(format_kb_as_mb "$(avg_of_file "$ARTIFACT_ROOT/main-rss-avg-kb.txt")")"
  MAIN_RSS_MAX_MB="$(format_kb_as_mb "$(max_of_file "$ARTIFACT_ROOT/main-rss-max-kb.txt")")"
  TREE_RSS_MEDIAN_MB="$(format_kb_as_mb "$(median_of_file "$ARTIFACT_ROOT/tree-rss-median-kb.txt")")"
  TREE_RSS_AVG_MB="$(format_kb_as_mb "$(avg_of_file "$ARTIFACT_ROOT/tree-rss-avg-kb.txt")")"
  TREE_RSS_MAX_MB="$(format_kb_as_mb "$(max_of_file "$ARTIFACT_ROOT/tree-rss-max-kb.txt")")"
  PHYSICAL_FOOTPRINT_MB="$(format_number "$(median_of_file "$ARTIFACT_ROOT/physical-footprint-mb.txt")")"
  PHYSICAL_FOOTPRINT_PEAK_MB="$(format_number "$(max_of_file "$ARTIFACT_ROOT/physical-footprint-peak-mb.txt")")"
  PROC_COUNT_MEDIAN="$(median_of_file "$ARTIFACT_ROOT/proc-count-median.txt")"
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
  PHYSICAL_FOOTPRINT_MB="0.0"
  PHYSICAL_FOOTPRINT_PEAK_MB="0.0"
  PROC_COUNT_MEDIAN="0"
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
PHYSICAL_FOOTPRINT_MB="$PHYSICAL_FOOTPRINT_MB" \
PHYSICAL_FOOTPRINT_PEAK_MB="$PHYSICAL_FOOTPRINT_PEAK_MB" \
PROC_COUNT_MEDIAN="$PROC_COUNT_MEDIAN" \
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
      physicalFootprintMb,
      physicalFootprintPeakMb,
      procCountMedian,
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
      physicalFootprintMb: Number.parseFloat(physicalFootprintMb),
      physicalFootprintPeakMb: Number.parseFloat(physicalFootprintPeakMb),
      procCountMedian: Number.parseFloat(procCountMedian),
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
    procCountMedian: toNumber(process.env.PROC_COUNT_MEDIAN),
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
  treeRssMaxMb: summary.metrics.treeRssMaxMb,
};

let baseline = {};
if (fs.existsSync(path)) {
  baseline = JSON.parse(fs.readFileSync(path, "utf8"));
}
baseline[process.env.SCENARIO] = nextEntry;
fs.writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
EOF
fi

printf '%s\n' "Daemon memory benchmark"
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
printf '%-24s %s\n' "procCountMedian" "$PROC_COUNT_MEDIAN"

if [ -f "$COMPARE_REPORT_PATH" ]; then
  printf '%-24s %s\n' "baseline" "$BASELINE_PATH"
fi

printf '\n'
cat "$SUMMARY_JSON_PATH"

trap - EXIT

exit "$COMPARE_EXIT_CODE"
