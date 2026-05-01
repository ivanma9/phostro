"""
Tests A–D: HMAC signature verification on POST /detect.
"""
from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from httpx import AsyncClient, ASGITransport


WORKER_SECRET = "test-secret-for-auth-tests"


def _sign(body: bytes, secret: str = WORKER_SECRET) -> str:
    """Compute X-Worker-Signature header value."""
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


@pytest.fixture
def app_with_secret(monkeypatch):
    """
    auth.py reads WORKER_SECRET at request time (not import time), so a fresh
    monkeypatch is enough — no module reload required.
    """
    monkeypatch.setenv("WORKER_SECRET", WORKER_SECRET)
    import worker.main as main_mod
    return main_mod.app


@pytest.fixture
async def client(app_with_secret):
    async with AsyncClient(
        transport=ASGITransport(app=app_with_secret), base_url="http://test"
    ) as ac:
        yield ac


# A. Bad signature → 401
async def test_bad_signature_401(client):
    body = json.dumps({"photo_id": "00000000-0000-0000-0000-000000000001",
                       "preview_get_url": "http://example.com/img.jpg"}).encode()
    resp = await client.post(
        "/detect",
        content=body,
        headers={"Content-Type": "application/json",
                 "X-Worker-Signature": "sha256=badbadbadbad"},
    )
    assert resp.status_code == 401


# B. Good signature → 200
async def test_good_signature_200(client):
    body = json.dumps({"photo_id": "00000000-0000-0000-0000-000000000001",
                       "preview_get_url": "http://127.0.0.1:1/missing"}).encode()
    sig = _sign(body)
    resp = await client.post(
        "/detect",
        content=body,
        headers={"Content-Type": "application/json",
                 "X-Worker-Signature": sig},
    )
    # 200 = auth passed (endpoint itself may return 502 due to bad URL,
    # but auth must NOT reject a valid signature)
    assert resp.status_code != 401


# C. Missing signature → 401
async def test_missing_signature_401(client):
    body = json.dumps({"photo_id": "00000000-0000-0000-0000-000000000001",
                       "preview_get_url": "http://example.com/img.jpg"}).encode()
    resp = await client.post(
        "/detect",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 401


# D. Replay with different body → 401
async def test_replay_with_different_body_401(client):
    original_body = json.dumps({"photo_id": "00000000-0000-0000-0000-000000000001",
                                "preview_get_url": "http://example.com/img.jpg"}).encode()
    sig = _sign(original_body)

    tampered_body = json.dumps({"photo_id": "00000000-0000-0000-0000-000000000002",
                                "preview_get_url": "http://attacker.com/evil.jpg"}).encode()
    resp = await client.post(
        "/detect",
        content=tampered_body,
        headers={"Content-Type": "application/json",
                 "X-Worker-Signature": sig},
    )
    assert resp.status_code == 401
