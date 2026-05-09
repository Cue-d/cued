#!/usr/bin/env bash
set -euo pipefail

CLI="${CUED_CLI:-cued}"
DURATION_SECONDS="${CUED_BENCH_DURATION_SECONDS:-60}"
INTERVAL_SECONDS="${CUED_BENCH_INTERVAL_SECONDS:-1}"
TRIGGER_SYNC="${CUED_BENCH_TRIGGER_SYNC:-0}"
OUT="${CUED_BENCH_OUT:-/tmp/cued-gui-responsiveness-$(date +%Y%m%d-%H%M%S).jsonl}"

if [[ "$TRIGGER_SYNC" == "1" ]]; then
  ("$CLI" sync resume >/tmp/cued-bench-sync-resume.out 2>/tmp/cued-bench-sync-resume.err || true) &
fi

CUED_CLI="$CLI" \
CUED_BENCH_DURATION_SECONDS="$DURATION_SECONDS" \
CUED_BENCH_INTERVAL_SECONDS="$INTERVAL_SECONDS" \
CUED_BENCH_OUT="$OUT" \
python3 - <<'PY'
import json
import os
import statistics
import subprocess
import time

cli = os.environ["CUED_CLI"]
duration_seconds = float(os.environ["CUED_BENCH_DURATION_SECONDS"])
interval_seconds = float(os.environ["CUED_BENCH_INTERVAL_SECONDS"])
out = os.environ["CUED_BENCH_OUT"]

end = time.time() + duration_seconds
samples = []

while time.time() < end:
    sample_started_at = time.time()
    proc = subprocess.run([cli, "status", "--json"], text=True, capture_output=True)
    sample_finished_at = time.time()
    record = {
        "ts": sample_finished_at,
        "latency_ms": round((sample_finished_at - sample_started_at) * 1000, 1),
        "ok": proc.returncode == 0,
    }
    if proc.returncode == 0:
        data = json.loads(proc.stdout)
        overview = data.get("overview") or {}
        data_status = data.get("dataStatus") or {}
        projection = data.get("projection") or {}
        record.update(
            {
                "messages": overview.get("messages"),
                "rawEvents": overview.get("rawEvents"),
                "pendingProjectionEvents": data_status.get("pendingProjectionEvents"),
                "pendingSearchIndexMessages": data_status.get("pendingSearchIndexMessages"),
                "watermark": projection.get("projection_watermark"),
                "maxRaw": projection.get("max_raw_event_rowid"),
            }
        )
    else:
        record["stderr"] = proc.stderr[-300:]

    samples.append(record)
    with open(out, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")

    elapsed = time.time() - sample_finished_at
    time.sleep(max(0, interval_seconds - elapsed))

latencies = [sample["latency_ms"] for sample in samples if sample.get("ok")]
first = samples[0] if samples else {}
last = samples[-1] if samples else {}


def value_delta(key: str) -> int:
    return (last.get(key) or 0) - (first.get(key) or 0)


max_pending_samples = 0
current_pending_samples = 0
for sample in samples:
    if (sample.get("pendingProjectionEvents") or 0) > 0:
        current_pending_samples += 1
        max_pending_samples = max(max_pending_samples, current_pending_samples)
    else:
        current_pending_samples = 0

projected_events = value_delta("watermark")
elapsed_seconds = max(0.001, (last.get("ts") or time.time()) - (first.get("ts") or time.time()))
projected_per_minute = round(projected_events / elapsed_seconds * 60)

print("out", out)
print("samples", len(samples), "ok", sum(1 for sample in samples if sample.get("ok")))
if latencies:
    p95 = (
        statistics.quantiles(latencies, n=20)[18]
        if len(latencies) >= 20
        else max(latencies)
    )
    print(
        "status_latency_ms",
        "p50",
        round(statistics.median(latencies), 1),
        "p95",
        round(p95, 1),
        "max",
        round(max(latencies), 1),
    )
print(
    "start",
    {
        key: first.get(key)
        for key in [
            "messages",
            "rawEvents",
            "pendingProjectionEvents",
            "pendingSearchIndexMessages",
            "watermark",
            "maxRaw",
        ]
    },
)
print(
    "end",
    {
        key: last.get(key)
        for key in [
            "messages",
            "rawEvents",
            "pendingProjectionEvents",
            "pendingSearchIndexMessages",
            "watermark",
            "maxRaw",
        ]
    },
)
print(
    "delta",
    {
        key: value_delta(key)
        for key in [
            "messages",
            "rawEvents",
            "pendingProjectionEvents",
            "pendingSearchIndexMessages",
            "watermark",
            "maxRaw",
        ]
    },
)
print("projected_events_per_minute", projected_per_minute)
print("max_contiguous_pending_projection_samples", max_pending_samples)
PY

if [[ "$TRIGGER_SYNC" == "1" ]]; then
  cat /tmp/cued-bench-sync-resume.out 2>/dev/null || true
  cat /tmp/cued-bench-sync-resume.err 2>/dev/null || true
fi
