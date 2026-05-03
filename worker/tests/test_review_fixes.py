"""
Tests for review-fix items:
  C2 — startup secret validation
  C3 — FaceOut embedding length enforcement
  I1 — FaceOut landmarks shape enforcement
  I2 — top-level error shape (no detail wrapper)
"""
from __future__ import annotations

import json
import os

import pytest
from pydantic import ValidationError


WORKER_SECRET = "test-secret-review-fixes"


# ---------------------------------------------------------------------------
# C2 — WORKER_SECRET startup validation
#
# TestClient runs the lifespan synchronously (raises on error).  Before the
# fix the secret is only checked at request time (RuntimeError from
# _get_secret()), so startup succeeds and the missing-secret error surfaces
# only at request time — not at startup.  After the fix the lifespan itself
# raises, and the structured log "worker.startup.missing_secret" is emitted.
# ---------------------------------------------------------------------------


def _assert_startup_secret_error(capsys_or_none, monkeypatch, secret_value):
    """
    Helper: set WORKER_SECRET to secret_value (or unset if None), then verify
    that TestClient startup fails AND the structured log contains
    'missing_secret'.
    """
    if secret_value is None:
        monkeypatch.delenv("WORKER_SECRET", raising=False)
    else:
        monkeypatch.setenv("WORKER_SECRET", secret_value)
    # Give models dir a valid-looking path so secret check runs first
    monkeypatch.setenv("WORKER_MODELS_DIR", "/nonexistent")

    import importlib
    import worker.main as main_mod
    importlib.reload(main_mod)
    from fastapi.testclient import TestClient

    import io
    from contextlib import redirect_stderr
    err_buf = io.StringIO()
    with pytest.raises(Exception):
        with redirect_stderr(err_buf):
            with TestClient(main_mod.app):
                pass
    assert "missing_secret" in err_buf.getvalue(), (
        f"Expected 'missing_secret' in stderr, got: {err_buf.getvalue()!r}"
    )


def test_startup_fails_when_secret_unset(monkeypatch):
    """WORKER_SECRET unset → lifespan raises + emits missing_secret log."""
    _assert_startup_secret_error(None, monkeypatch, None)


def test_startup_fails_when_secret_empty(monkeypatch):
    """WORKER_SECRET='' → lifespan raises + emits missing_secret log."""
    _assert_startup_secret_error(None, monkeypatch, "")


def test_startup_fails_when_secret_whitespace(monkeypatch):
    """WORKER_SECRET='   ' → lifespan raises + emits missing_secret log."""
    _assert_startup_secret_error(None, monkeypatch, "   ")


def test_startup_succeeds_with_valid_secret(monkeypatch):
    """WORKER_SECRET set → exception is model-load, NOT missing_secret."""
    monkeypatch.setenv("WORKER_SECRET", "real-secret")
    monkeypatch.setenv("WORKER_MODELS_DIR", "/nonexistent-so-model-load-fails")
    import importlib
    import worker.main as main_mod
    importlib.reload(main_mod)
    from fastapi.testclient import TestClient
    import io
    from contextlib import redirect_stderr
    err_buf = io.StringIO()
    with pytest.raises(Exception):
        with redirect_stderr(err_buf):
            with TestClient(main_mod.app):
                pass
    # Secret is valid — missing_secret must NOT appear; model_load_failed will
    assert "missing_secret" not in err_buf.getvalue()
    assert "model_load_failed" in err_buf.getvalue()


# ---------------------------------------------------------------------------
# C3 — FaceOut embedding length enforcement
# ---------------------------------------------------------------------------


def test_face_out_rejects_embedding_length_64():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
            embedding=[0.0] * 64,
        )


def test_face_out_rejects_embedding_length_256():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
            embedding=[0.0] * 256,
        )


def test_face_out_accepts_embedding_length_128():
    from worker.api.detect import FaceOut
    face = FaceOut(
        bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
        confidence=0.9,
        landmarks=[[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
        embedding=[0.0] * 128,
    )
    assert len(face.embedding) == 128


# ---------------------------------------------------------------------------
# I1 — FaceOut landmarks shape (5, 2) enforcement
# ---------------------------------------------------------------------------


def test_face_out_rejects_too_few_landmarks():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[0, 0], [1, 1], [2, 2]],
            embedding=[0.0] * 128,
        )


def test_face_out_rejects_too_many_landmarks():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]],
            embedding=[0.0] * 128,
        )


def test_face_out_rejects_wrong_landmark_dimensions():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[1.0]],
            embedding=[0.0] * 128,
        )


def test_face_out_rejects_landmark_with_3_coords():
    from worker.api.detect import FaceOut
    with pytest.raises(ValidationError):
        FaceOut(
            bbox_x1=0, bbox_y1=0, bbox_x2=10, bbox_y2=10,
            confidence=0.9,
            landmarks=[[0, 0, 0], [1, 1, 0], [2, 2, 0], [3, 3, 0], [4, 4, 0]],
            embedding=[0.0] * 128,
        )


# ---------------------------------------------------------------------------
# I2 — top-level error shape: {"error": "..."}, no "detail" wrapper
# ---------------------------------------------------------------------------


@pytest.fixture
def app_env_i2(monkeypatch):
    monkeypatch.setenv("WORKER_SECRET", WORKER_SECRET)
    import worker.main as main_mod
    main_mod.app.state.model_hashes = {}
    main_mod.app.state.worker_concurrency = "4"
    main_mod.app.state.commit_sha = "deadbeef"
    return main_mod.app


@pytest.mark.asyncio
async def test_auth_401_has_top_level_error(app_env_i2):
    from httpx import ASGITransport, AsyncClient
    body = json.dumps({
        "photo_id": "00000000-0000-0000-0000-000000000001",
        "preview_get_url": "http://example.com/img.jpg",
    }).encode()
    async with AsyncClient(
        transport=ASGITransport(app=app_env_i2), base_url="http://test"
    ) as ac:
        resp = await ac.post(
            "/detect",
            content=body,
            headers={"Content-Type": "application/json",
                     "X-Worker-Signature": "sha256=badbadbadbad"},
        )
    assert resp.status_code == 401
    data = resp.json()
    assert "detail" not in data
    assert data["error"] == "worker.auth.invalid_signature"
