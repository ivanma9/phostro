# Worker Cold-Start & Saturation Measurements — 2026-04

Baseline measurements for phostro-worker on Apple Silicon, Phase 3 Task 1.
Cloud deploy measurements (Step 4) are deferred — see "Deferred: Cloud deploys" below.

---

## Host Info

| Field | Value |
|---|---|
| Date | 2026-05-01 |
| Machine | Apple M3 Pro, 11-core, 18 GB RAM |
| OS | macOS 14.6.0 (Darwin 23.6.0 arm64) |
| Docker | 29.2.1, context `desktop-linux` (aarch64) |
| Arch | linux/arm64 (native — no cross-compile needed) |

---

## Cold-Start Results

Images tested:
- **`phostro-worker:stub`** — bare FastAPI + uvicorn, `/health` endpoint only (no models).
- **`phostro-worker:loaded`** — same base + onnxruntime 1.25.1; `@app.on_event("startup")` loads both ONNX models from a mounted `/models` volume (no inference, load-only).

Models loaded at startup:
- `det_10g.onnx` (~16 MB, InsightFace RetinaFace detection)
- `face_recognition_sface_2021dec.onnx` (~37 MB, OpenCV Zoo SFace recognition)

Measurement method: bash loop, 5 runs per image. Each run: `docker run --rm`, poll `GET /health` every 100ms until first 200. Wall time = `docker run` invocation → first 200 response (millisecond precision via `gdate +%s%3N`). Container killed after measurement. Port 8000 cleared between runs via `lsof -ti:8000 | xargs kill -9`.

### Summary

| Image | Runs | p50 | p95 | Raw times (s) |
|---|---|---|---|---|
| stub (no models) | 5/5 | **0.792s** | **0.973s** | 0.973, 0.789, 0.788, 0.792, 0.807 |
| loaded (models loaded at startup) | 5/5 | **1.031s** | **1.316s** | 1.316, 0.948, 0.802, 1.031, 1.218 |

**Overhead of ONNX model loading:** +0.239s (p50), +0.343s (p95) vs stub.

Both images start well within 2s on Apple M3 Pro. The loaded image overhead is driven mainly by onnxruntime initialization (~0.2–0.5s for two models totaling 53 MB).

### Notes on failures

Zero failed runs. All 10 runs (5 stub + 5 loaded) returned 200 within the 30s timeout.

Log files for each run: see `/tmp/worker-coldstart/20260501T012025/` (stub) and `/tmp/worker-coldstart/20260501T012126/` (loaded).

---

## Saturation Test

Endpoint: `GET /detect` — returns `{"faces": [], "stub": true}` after `asyncio.sleep(0.2)` (200ms non-blocking sleep, simulating a latency budget for inference without actual CPU load).

Image: `phostro-worker:loaded` (warm, single pod). Concurrency levels: 1, 2, 4, 8. Requests per level: `concurrency * 20`. Each request measured independently (wall time from `curl` invocation to response). P50/P95 in milliseconds.

### Results

| Concurrency | p50 (ms) | p95 (ms) | RPS (approx) | Notes |
|---|---|---|---|---|
| 1 | 228 | 243 | 82 | ~200ms per request, no queuing |
| 2 | 230 | 248 | 161 | linear scaling — async I/O |
| 4 | 234 | 261 | 300 | still linear |
| 8 | 239 | 261 | 584 | still linear |

### Interpretation

**No knee observed up to concurrency 8.** P95 latency rises only ~18ms from c=1 to c=8 (243ms → 261ms), and throughput scales linearly. This is expected: `asyncio.sleep(0.2)` is non-blocking — uvicorn/asyncio dispatches all concurrent requests without queuing.

**This test does not reflect real CPU saturation.** The 200ms sleep is a placeholder for inference time. Actual CPU-bound ONNX inference (Task 7) will create true saturation; the knee concurrency should be measured again after Task 7 is implemented with real `ort.InferenceSession.run()` calls.

**Provisional `WORKER_CONCURRENCY` decision:** defer setting a default until Task 7 saturation re-run. For now, leave uvicorn at its default (1 worker process; async concurrency unlimited by code). The async handler means memory, not CPU, will be the first constraint for the stub.

---

## Deferred: Cloud Deploys (Step 4)

**Step 4 (Fly.io trial + Railway trial) is DEFERRED — needs user account setup; planned follow-up.**

The "Scale-from-zero wake" and "Host" columns are left blank until cloud measurements are taken. The "Decision" column (which cloud host to use) is also TBD pending those results.

---

## Full Results Table (with deferred columns)

| Host | Cold start (no models) | Cold start (models loaded) | Scale-from-zero wake | Knee concurrency | Decision |
|---|---|---|---|---|---|
| Local (Apple M3 Pro) | p50=0.79s / p95=0.97s | p50=1.03s / p95=1.32s | N/A | No knee ≤ c=8 (async sleep only; re-test with real inference in Task 7) | N/A (local baseline) |
| Fly.io | — | — | DEFERRED | DEFERRED | TBD |
| Railway | — | — | DEFERRED | DEFERRED | TBD |

---

## Image Sizes

| Image | Size |
|---|---|
| `phostro-worker:stub` | ~200 MB compressed (python:3.11-slim + fastapi + uvicorn) |
| `phostro-worker:loaded` | ~450 MB compressed (adds onnxruntime 1.25.1 + numpy) |

Build times (Apple M3 Pro, from cache-warm base layer):
- stub: ~14s
- loaded: ~24s (extra pip install for onnxruntime)

---

## Script

Measurements produced by: `scripts/bench-worker-coldstart.sh`

Usage:
```
./scripts/bench-worker-coldstart.sh --mode stub|loaded|saturation|all
```

Environment variables: `RUNS` (default 5), `MODELS_DIR` (default `./bench/models`), `PORT` (default 8000).

Requires `gdate` (GNU coreutils) or `python3` for millisecond timestamps on macOS. Uses `lsof` to clear port between runs.
