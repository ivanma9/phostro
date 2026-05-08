"""
Tests E–J: /detect endpoint error paths, /enroll stub, /version, /health.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
from httpx import ASGITransport, AsyncClient


WORKER_SECRET = "test-secret-for-detect-tests"
FIXTURE_PATH = Path(__file__).parent / "data" / "group_03.jpg"


def _sign(body: bytes, secret: str = WORKER_SECRET) -> str:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app_env(monkeypatch):
    """
    auth.py reads WORKER_SECRET at request time, so monkeypatch alone is
    sufficient — no module reload required.
    """
    monkeypatch.setenv("WORKER_SECRET", WORKER_SECRET)
    monkeypatch.setenv("WORKER_CONCURRENCY", "4")
    monkeypatch.setenv("GIT_COMMIT_SHA", "deadbeef")

    import worker.main as main_mod
    return main_mod.app


@pytest.fixture
def app_with_mock_models(app_env):
    """
    Attach mock detector/embedder to app state so the endpoint can run
    without real ONNX models.
    """
    mock_detector = MagicMock()
    mock_embedder = MagicMock()

    # Return one face with a real-looking numpy structure
    import numpy as np
    from worker.recognition.detect import Face

    fake_landmarks = np.array(
        [[40, 50], [70, 50], [55, 70], [42, 90], [68, 90]], dtype=np.float32
    )
    fake_face = Face(
        bbox=(10.0, 10.0, 100.0, 100.0),
        confidence=0.99,
        landmarks=fake_landmarks,
    )
    mock_detector.detect.return_value = ([fake_face], 0.05)
    mock_embedder.embed.return_value = np.zeros(512, dtype=np.float32)

    app_env.state.detector = mock_detector
    app_env.state.embedder = mock_embedder
    app_env.state.model_hashes = {"det_10g.onnx": "aaa", "w600k_r50.onnx": "bbb"}
    app_env.state.worker_concurrency = "4"
    app_env.state.commit_sha = "deadbeef"
    return app_env


@pytest.fixture
async def client(app_with_mock_models):
    async with AsyncClient(
        transport=ASGITransport(app=app_with_mock_models), base_url="http://test"
    ) as ac:
        yield ac


# Minimal client that just talks to the base app without mock models
@pytest.fixture
async def base_client(app_env):
    app_env.state.model_hashes = {}
    app_env.state.worker_concurrency = "4"
    app_env.state.commit_sha = "deadbeef"
    async with AsyncClient(
        transport=ASGITransport(app=app_env), base_url="http://test"
    ) as ac:
        yield ac


def _detect_body(url: str = "http://example.com/img.jpg") -> bytes:
    return json.dumps({
        "photo_id": "00000000-0000-0000-0000-000000000001",
        "preview_get_url": url,
    }).encode()


# ---------------------------------------------------------------------------
# E. R2 fetch failure → 502
# ---------------------------------------------------------------------------


async def test_r2_fetch_failure_502(client, capsys):
    """Port 1 will always refuse connections — should get 502."""
    body = _detect_body("http://127.0.0.1:1/missing")
    sig = _sign(body)
    resp = await client.post(
        "/detect",
        content=body,
        headers={"Content-Type": "application/json", "X-Worker-Signature": sig},
    )
    assert resp.status_code == 502
    data = resp.json()
    assert data["error"] == "worker.detect.r2_fetch_failed"

    # Verify structured log was emitted
    captured = capsys.readouterr()
    assert "worker.detect.r2_fetch_failed" in captured.err


# ---------------------------------------------------------------------------
# F. Image decode failure → 400
# ---------------------------------------------------------------------------


async def test_image_decode_failure_400(app_with_mock_models, capsys):
    """Mock transport returns non-JPEG bytes — cv2.imdecode returns None → 400."""
    from worker.api.detect import get_http_client

    # Inject mock transport that returns garbage bytes
    mock_transport = httpx.MockTransport(
        lambda req: httpx.Response(200, content=b"not a jpeg at all")
    )
    mock_client = httpx.AsyncClient(transport=mock_transport)

    # Override the dependency
    app_with_mock_models.dependency_overrides[get_http_client] = lambda: mock_client

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app_with_mock_models), base_url="http://test"
        ) as ac:
            body = _detect_body("http://fake-r2.example.com/img.jpg")
            sig = _sign(body)
            resp = await ac.post(
                "/detect",
                content=body,
                headers={"Content-Type": "application/json", "X-Worker-Signature": sig},
            )
    finally:
        app_with_mock_models.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 400
    data = resp.json()
    assert data["error"] == "worker.detect.decode_failed"

    captured = capsys.readouterr()
    assert "worker.detect.decode_failed" in captured.err


# ---------------------------------------------------------------------------
# F2. Detector inference failure → 500
# ---------------------------------------------------------------------------


async def test_detector_inference_failure_500(app_with_mock_models, capsys):
    """If detector.detect() raises, return 500 with worker.detect.inference_failed."""
    from worker.api.detect import get_http_client

    # Make a 1x1 PNG so cv2.imdecode succeeds and we reach the detector path.
    import cv2
    import numpy as np
    one_px = np.zeros((4, 4, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", one_px)
    assert ok, "failed to encode test PNG"

    mock_transport = httpx.MockTransport(
        lambda req: httpx.Response(200, content=encoded.tobytes())
    )
    mock_client = httpx.AsyncClient(transport=mock_transport)
    app_with_mock_models.dependency_overrides[get_http_client] = lambda: mock_client

    # Make detector.detect blow up
    app_with_mock_models.state.detector.detect.side_effect = RuntimeError("onnx boom")

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app_with_mock_models), base_url="http://test"
        ) as ac:
            body = _detect_body("http://fake-r2.example.com/img.png")
            sig = _sign(body)
            resp = await ac.post(
                "/detect",
                content=body,
                headers={"Content-Type": "application/json", "X-Worker-Signature": sig},
            )
    finally:
        app_with_mock_models.dependency_overrides.pop(get_http_client, None)
        app_with_mock_models.state.detector.detect.side_effect = None

    assert resp.status_code == 500
    data = resp.json()
    assert data["error"] == "worker.detect.inference_failed"

    captured = capsys.readouterr()
    assert "worker.detect.inference_failed" in captured.err


# ---------------------------------------------------------------------------
# G. Real inference (skipped if fixture missing)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not FIXTURE_PATH.exists(),
    reason=(
        "Fixture not present. Commit worker/tests/data/group_03.jpg "
        "(public-domain group photo, ≥1 face) to enable."
    ),
)
async def test_detect_inference_path(app_env, capsys):
    """Real image → ≥1 face with 128-dim embedding."""
    import cv2
    from pathlib import Path

    # Need real models too
    models_dir = Path(os.environ.get("WORKER_MODELS_DIR", "/models"))
    from worker.recognition.detect import load_detector
    from worker.recognition.embed import load_embedder

    app_env.state.detector = load_detector(models_dir)
    app_env.state.embedder = load_embedder(models_dir)

    image_bytes = FIXTURE_PATH.read_bytes()
    mock_transport = httpx.MockTransport(
        lambda req: httpx.Response(200, content=image_bytes)
    )
    from worker.api.detect import get_http_client
    app_env.dependency_overrides[get_http_client] = lambda: httpx.AsyncClient(
        transport=mock_transport
    )

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app_env), base_url="http://test"
        ) as ac:
            body = _detect_body("http://fake-r2.example.com/group.jpg")
            sig = _sign(body)
            resp = await ac.post(
                "/detect",
                content=body,
                headers={"Content-Type": "application/json", "X-Worker-Signature": sig},
            )
    finally:
        app_env.dependency_overrides.pop(get_http_client, None)

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["faces"]) >= 2  # spec line 427: >=2 faces in group_03.jpg
    assert len(data["faces"][0]["embedding"]) == 512
    assert "yaw" in data["faces"][0]
    assert isinstance(data["faces"][0]["yaw"], float)


# ---------------------------------------------------------------------------
# H. /enroll → 501
# ---------------------------------------------------------------------------


async def test_enroll_returns_501(base_client):
    resp = await base_client.post("/enroll")
    assert resp.status_code == 501
    data = resp.json()
    assert data["error"] == "not_implemented"
    assert data["phase"] == "4"


# ---------------------------------------------------------------------------
# I. /version → 200 with required keys
# ---------------------------------------------------------------------------


async def test_version_endpoint(base_client):
    resp = await base_client.get("/version")
    assert resp.status_code == 200
    data = resp.json()
    assert "commit_sha" in data
    assert "model_hashes" in data
    assert "worker_concurrency" in data
    assert isinstance(data["model_hashes"], dict)
    assert isinstance(data["worker_concurrency"], str)


# ---------------------------------------------------------------------------
# J. /health regression
# ---------------------------------------------------------------------------


async def test_health_still_works(base_client):
    resp = await base_client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
