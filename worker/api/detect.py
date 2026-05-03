"""
POST /detect  — detect faces in an image fetched from a presigned R2 URL.

Body-read-once pattern:
  1. `await request.body()` reads and caches the raw bytes in Starlette's
     internal buffer. Subsequent calls to `request.body()` return the same
     cached bytes (Starlette caches on first read).
  2. We pass those bytes to `verify_signature` for HMAC checking.
  3. We parse the JSON payload manually from the same bytes to avoid a
     second stream read.

Detector/Embedder are CPU-bound ONNX. Wrapped in run_in_executor so the
asyncio event loop is not blocked during inference.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid
from typing import AsyncGenerator, Optional

import cv2
import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from .auth import verify_signature
from .r2 import fetch_image

router = APIRouter()

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class DetectRequest(BaseModel):
    photo_id: uuid.UUID
    preview_get_url: str
    preview_sha256: Optional[str] = None


class FaceOut(BaseModel):
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float
    confidence: float
    landmarks: list[list[float]]  # [[x, y], ...] × 5
    embedding: list[float] = Field(min_length=128, max_length=128)

    @field_validator("landmarks")
    @classmethod
    def validate_landmarks_shape(cls, v: list[list[float]]) -> list[list[float]]:
        if len(v) != 5 or not all(len(p) == 2 for p in v):
            raise ValueError(
                f"landmarks must be shape (5, 2); got {len(v)} points"
                + (f" with shapes {[len(p) for p in v]}" if v else "")
            )
        return v


class DetectResponse(BaseModel):
    photo_id: uuid.UUID
    faces: list[FaceOut]
    elapsed_ms: float


# ---------------------------------------------------------------------------
# Dependency: shared httpx client (overridable in tests)
# ---------------------------------------------------------------------------


async def get_http_client() -> AsyncGenerator[httpx.AsyncClient, None]:
    """
    Yields a 15s-timeout AsyncClient and closes it after the request.

    Implemented as an async generator so FastAPI manages the lifecycle (open
    on entry, aclose on exit). Tests override this with `dependency_overrides`
    to inject an httpx.MockTransport-backed client; in that case the test owns
    the client lifecycle.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        yield client


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.post("/detect", response_model=DetectResponse)
async def detect(
    request: Request,
    http_client: httpx.AsyncClient = Depends(get_http_client),
):
    # 1. Read raw body once — Starlette caches after first read
    body = await request.body()

    # 2. HMAC auth
    verify_signature(request, body)

    # 3. Parse JSON
    try:
        payload = json.loads(body)
        req = DetectRequest(**payload)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "worker.detect.invalid_request"},
        ) from exc

    t0 = time.perf_counter()

    # 4. Fetch image from R2 (lifecycle owned by Depends())
    image_bytes = await fetch_image(req.preview_get_url, http_client)

    # 5. Decode image
    img_array = np.frombuffer(image_bytes, np.uint8)
    image_bgr = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if image_bgr is None:
        _emit_structured("worker.detect.decode_failed", photo_id=str(req.photo_id))
        raise HTTPException(
            status_code=400,
            detail={"error": "worker.detect.decode_failed"},
        )

    # 6. Detect + embed (CPU-bound → executor so we don't block the event loop)
    detector = request.app.state.detector
    embedder = request.app.state.embedder

    loop = asyncio.get_running_loop()
    # TODO: executor pool saturation — defer to Phase 3 follow-up after Task 1
    # saturation re-run with real inference. Consider a bounded ThreadPoolExecutor.
    try:
        faces_raw, _detect_elapsed = await loop.run_in_executor(
            None, detector.detect, image_bgr
        )

        from worker.recognition.align import align_face

        face_outs: list[FaceOut] = []
        for face in faces_raw:
            aligned = await loop.run_in_executor(
                None, align_face, image_bgr, face.landmarks
            )
            embedding = await loop.run_in_executor(None, embedder.embed, aligned)

            x1, y1, x2, y2 = face.bbox
            face_outs.append(
                FaceOut(
                    bbox_x1=x1,
                    bbox_y1=y1,
                    bbox_x2=x2,
                    bbox_y2=y2,
                    confidence=face.confidence,
                    landmarks=face.landmarks.tolist(),
                    embedding=embedding.tolist(),
                )
            )
    except Exception as exc:
        _emit_structured(
            "worker.detect.inference_failed",
            photo_id=str(req.photo_id),
            error=str(exc),
        )
        # Sentry capture is wired up in Task 16; for now structured log only.
        raise HTTPException(
            status_code=500,
            detail={"error": "worker.detect.inference_failed"},
        ) from exc

    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    return DetectResponse(
        photo_id=req.photo_id,
        faces=face_outs,
        elapsed_ms=elapsed_ms,
    )


def _emit_structured(event: str, **kwargs) -> None:
    print(json.dumps({"event": event, **kwargs}), file=sys.stderr)
