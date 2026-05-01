"""
Phostro worker — FastAPI application entry point.

Routes:
  GET  /health   — liveness probe
  GET  /version  — commit sha, model hashes, concurrency
  POST /detect   — face detection + embedding (HMAC-authenticated)
  POST /enroll   — stub, returns 501 (Phase 4)

Startup:
  Loads det_10g.onnx and face_recognition_sface_2021dec.onnx from
  WORKER_MODELS_DIR (default /models).  Fails fast if models are missing —
  emits worker.startup.model_load_failed and re-raises so uvicorn exits non-zero.
  Model SHA-256 hashes and the resolved concurrency setting are computed once
  and cached on app.state.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _emit_structured(event: str, **kwargs) -> None:
    print(json.dumps({"event": event, **kwargs}), file=sys.stderr)


# ---------------------------------------------------------------------------
# Lifespan — model load at startup
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    models_dir = Path(os.environ.get("WORKER_MODELS_DIR", "/models"))

    from worker.recognition.detect import load_detector, MODEL_FILENAME as DET_FILE
    from worker.recognition.embed import load_embedder, MODEL_FILENAME as EMB_FILE

    try:
        app.state.detector = load_detector(models_dir)
        app.state.embedder = load_embedder(models_dir)
    except Exception as exc:
        _emit_structured(
            "worker.startup.model_load_failed",
            models_dir=str(models_dir),
            error=str(exc),
        )
        raise

    # Compute model hashes once at startup
    app.state.model_hashes = {
        DET_FILE: _sha256_file(models_dir / DET_FILE),
        EMB_FILE: _sha256_file(models_dir / EMB_FILE),
    }

    app.state.worker_concurrency = os.environ.get("WORKER_CONCURRENCY", "auto")
    app.state.commit_sha = os.environ.get("GIT_COMMIT_SHA", "unknown")

    yield
    # Teardown (none needed — ONNX sessions are closed by GC)


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(lifespan=lifespan)

from worker.api.detect import router as detect_router  # noqa: E402
app.include_router(detect_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/version")
def version():
    return {
        "commit_sha": app.state.commit_sha,
        "model_hashes": app.state.model_hashes,
        "worker_concurrency": app.state.worker_concurrency,
    }


@app.post("/enroll")
@app.get("/enroll")
def enroll():
    return JSONResponse(
        status_code=501,
        content={"error": "not_implemented", "phase": "4"},
    )
