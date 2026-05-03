#!/usr/bin/env bash
# bench-worker-coldstart.sh — measure uvicorn cold-start and saturation for phostro-worker
#
# Usage:
#   ./scripts/bench-worker-coldstart.sh --mode stub         # cold-start only, stub image
#   ./scripts/bench-worker-coldstart.sh --mode loaded       # cold-start only, loaded image
#   ./scripts/bench-worker-coldstart.sh --mode saturation   # saturation test (loaded image, warm)
#   ./scripts/bench-worker-coldstart.sh --mode all          # run everything in sequence
#
# Environment:
#   RUNS          number of cold-start iterations  (default: 5)
#   MODELS_DIR    host path to mount as /models     (default: ./bench/models)
#   PORT          host port to bind                 (default: 8000)
#
set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────

usage() {
  # Print the header comment block (lines 2–14, stop at first non-comment line)
  awk 'NR>1 && /^#/ { sub(/^# ?/,""); print; next } NR>1 { exit }' "$0"
  exit 1
}

log() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

die() { echo "ERROR: $*" >&2; exit 1; }

# Milliseconds since epoch — macOS date lacks %3N; use gdate (GNU coreutils) if available
ms_now() {
  if command -v gdate &>/dev/null; then
    gdate +%s%3N
  else
    python3 -c "import time; print(int(time.time()*1000))"
  fi
}

# Compute percentile of a newline-separated list of floats.
# percentile <pct> <values>
percentile() {
  local pct="$1"; shift
  printf '%s\n' "$@" \
    | sort -n \
    | awk -v p="$pct" 'BEGIN{n=0} {a[n++]=$1} END{
        idx=int(n*p/100);
        if(idx>=n) idx=n-1;
        printf "%.3f\n", a[idx]
      }'
}

# ── config ────────────────────────────────────────────────────────────────────

MODE=""
RUNS="${RUNS:-5}"
PORT="${PORT:-8000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$REPO_ROOT/bench/models}"
LOG_BASE="/tmp/worker-coldstart/$(date +%Y%m%dT%H%M%S)"

# Parse --mode flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -z "$MODE" ]] && usage

case "$MODE" in
  stub|loaded|saturation|all) ;;
  *) die "Unknown mode: $MODE. Choose stub|loaded|saturation|all" ;;
esac

mkdir -p "$LOG_BASE"
log "Logging to $LOG_BASE"

# ── host info ─────────────────────────────────────────────────────────────────

capture_host_info() {
  local out="$LOG_BASE/host-info.txt"
  {
    echo "=== Host Info ==="
    echo "Date:          $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "uname:         $(uname -a)"
    echo "CPU:           $(sysctl -n machdep.cpu.brand_string 2>/dev/null || grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 || echo 'unknown')"
    echo "CPU cores:     $(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 'unknown')"
    echo "RAM:           $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 )) GB"
    echo "Docker:        $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
    echo "Docker arch:   $(docker info --format '{{.Architecture}}' 2>/dev/null)"
    echo "Shell:         $BASH_VERSION"
  } | tee "$out"
}

# ── cold-start measurement ────────────────────────────────────────────────────

# run_coldstart <image> <extra_docker_args...>
# Returns nothing; sets global array COLDSTART_TIMES
run_coldstart() {
  local image="$1"; shift
  local extra_args=("$@")
  COLDSTART_TIMES=()

  log "Cold-start measurement: image=$image  runs=$RUNS"

  for i in $(seq 1 "$RUNS"); do
    local run_log="$LOG_BASE/coldstart-run-${i}.log"
    log "  Run $i/$RUNS ..."

    # Kill anything on the port first
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

    local t_start elapsed
    t_start=$(ms_now)   # milliseconds

    # Start container in background, capture its output
    # Use ${extra_args[@]+"${extra_args[@]}"} to handle empty array under set -u
    docker run --rm \
      -p "${PORT}:8000" \
      ${extra_args[@]+"${extra_args[@]}"} \
      "$image" \
      > "$run_log" 2>&1 &
    local docker_pid=$!

    # Poll /health until 200 or timeout
    local ready=0
    local t_ready
    for _poll in $(seq 1 300); do
      sleep 0.1
      if curl -sf --max-time 2 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
        t_ready=$(ms_now)
        ready=1
        break
      fi
    done

    # Stop the container
    kill "$docker_pid" 2>/dev/null || true
    wait "$docker_pid" 2>/dev/null || true
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

    if [[ $ready -eq 0 ]]; then
      log "  Run $i FAILED (no 200 within 30s) — see $run_log"
      echo "FAILED" >> "$LOG_BASE/coldstart-results.txt"
      continue
    fi

    elapsed=$(( t_ready - t_start ))
    local elapsed_s
    elapsed_s=$(echo "$elapsed" | awk '{printf "%.3f", $1/1000}')
    log "  Run $i: ${elapsed_s}s"
    echo "$elapsed_s" >> "$LOG_BASE/coldstart-results.txt"
    COLDSTART_TIMES+=("$elapsed_s")
  done

  # Compute p50/p95
  if [[ ${#COLDSTART_TIMES[@]} -eq 0 ]]; then
    log "  All runs failed!"
    COLDSTART_P50="N/A"
    COLDSTART_P95="N/A"
    return
  fi

  COLDSTART_P50=$(percentile 50 "${COLDSTART_TIMES[@]}")
  COLDSTART_P95=$(percentile 95 "${COLDSTART_TIMES[@]}")
  log "  p50=${COLDSTART_P50}s  p95=${COLDSTART_P95}s  (from ${#COLDSTART_TIMES[@]}/${RUNS} successful runs)"
}

# ── saturation test ───────────────────────────────────────────────────────────

SATURATION_IMAGE="phostro-worker:loaded"

run_saturation() {
  log "Saturation test: image=$SATURATION_IMAGE"

  # Start container (keep warm)
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  local sat_log="$LOG_BASE/saturation-container.log"

  docker run --rm \
    -p "${PORT}:8000" \
    -v "${MODELS_DIR}:/models:ro" \
    "$SATURATION_IMAGE" \
    > "$sat_log" 2>&1 &
  local docker_pid=$!

  # Wait until healthy
  log "  Waiting for container to be ready..."
  local ready=0
  for _poll in $(seq 1 300); do
    sleep 0.1
    if curl -sf --max-time 2 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
  done

  if [[ $ready -eq 0 ]]; then
    log "  Container never became healthy; aborting saturation test."
    kill "$docker_pid" 2>/dev/null || true
    return
  fi
  log "  Container ready."

  local results_file="$LOG_BASE/saturation-results.txt"
  echo "concurrency,p50_ms,p95_ms,rps" > "$results_file"

  for CONC in 1 2 4 8; do
    local REQUESTS=$(( CONC * 20 ))  # enough to observe knee without very long runtime
    log "  Concurrency $CONC: sending $REQUESTS requests to /detect ..."

    # Fire requests in parallel waves; measure per-request wall time
    local times=()
    local pids=()
    local tmpdir
    tmpdir=$(mktemp -d)

    for j in $(seq 1 "$REQUESTS"); do
      (
        local t0 t1
        t0=$(ms_now)
        curl -sf --max-time 30 "http://localhost:${PORT}/detect" -o /dev/null 2>/dev/null
        t1=$(ms_now)
        echo $(( t1 - t0 )) > "$tmpdir/$j"
      ) &
      pids+=($!)
      # Release in batches of CONC
      if (( j % CONC == 0 )); then
        for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" 2>/dev/null || true; done
        pids=()
      fi
    done
    # Wait for any remaining
    for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" 2>/dev/null || true; done

    # Collect times (use while-read to avoid mapfile which needs bash 4.4)
    local times=()
    while IFS= read -r line; do
      times+=("$line")
    done < <(cat "$tmpdir"/* 2>/dev/null | sort -n)
    rm -rf "$tmpdir"

    if [[ ${#times[@]} -eq 0 ]]; then
      log "  Concurrency $CONC: all requests failed (is /detect endpoint available?)"
      echo "${CONC},FAILED,FAILED,FAILED" >> "$results_file"
      continue
    fi

    local p50 p95 rps
    p50=$(percentile 50 "${times[@]}")
    p95=$(percentile 95 "${times[@]}")
    # RPS: total_requests / (max_time_ms / 1000) — rough throughput
    # Use awk to get last element (avoids bash4-only negative index)
    local max_t
    max_t=$(printf '%s\n' "${times[@]}" | tail -1)
    if [[ "$max_t" -gt 0 ]]; then
      rps=$(echo "$REQUESTS $max_t" | awk '{printf "%.1f", $1 / ($2/1000)}')
    else
      rps="inf"
    fi

    echo "${CONC},${p50},${p95},${rps}" >> "$results_file"
    log "  Concurrency $CONC: p50=${p50}ms  p95=${p95}ms  rps=${rps}"
  done

  log "  Saturation results saved to $results_file"

  # Stop container
  kill "$docker_pid" 2>/dev/null || true
  wait "$docker_pid" 2>/dev/null || true
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
}

# ── main ──────────────────────────────────────────────────────────────────────

capture_host_info

summary_file="$LOG_BASE/summary.txt"
{
echo "=== Cold-Start Bench Summary ==="
echo "Mode: $MODE"
echo "Runs per image: $RUNS"
echo ""
} | tee "$summary_file"

if [[ "$MODE" == "stub" || "$MODE" == "all" ]]; then
  log "=== STUB image cold-start ==="
  run_coldstart "phostro-worker:stub"
  {
    echo "STUB image (no models):"
    echo "  p50 = ${COLDSTART_P50}s"
    echo "  p95 = ${COLDSTART_P95}s"
    echo "  raw = ${COLDSTART_TIMES[*]:-}"
    echo ""
  } | tee -a "$summary_file"
fi

if [[ "$MODE" == "loaded" || "$MODE" == "all" ]]; then
  log "=== LOADED image cold-start ==="
  [[ -d "$MODELS_DIR" ]] || die "MODELS_DIR not found: $MODELS_DIR"
  run_coldstart "phostro-worker:loaded" -v "${MODELS_DIR}:/models:ro"
  {
    echo "LOADED image (models loaded at startup):"
    echo "  p50 = ${COLDSTART_P50}s"
    echo "  p95 = ${COLDSTART_P95}s"
    echo "  raw = ${COLDSTART_TIMES[*]:-}"
    echo ""
  } | tee -a "$summary_file"
fi

if [[ "$MODE" == "saturation" || "$MODE" == "all" ]]; then
  log "=== Saturation test ==="
  run_saturation
fi

log "Done. Full logs: $LOG_BASE"
log "Summary:"
cat "$summary_file"
