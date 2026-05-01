"""
HMAC-SHA256 request authentication.

Header: X-Worker-Signature: sha256=<hex_digest>
Digest: hmac_sha256(WORKER_SECRET, raw_body_bytes)

Body must be read once by the endpoint and passed here for hashing — this avoids
consuming the request stream twice while still supporting Pydantic model parsing.
"""
from __future__ import annotations

import hashlib
import hmac
import os

from fastapi import HTTPException, Request


def _get_secret() -> bytes:
    secret = os.environ.get("WORKER_SECRET", "")
    if not secret:
        raise RuntimeError("WORKER_SECRET env var is not set")
    return secret.encode()


def verify_signature(request: Request, body: bytes) -> None:
    """
    Verify X-Worker-Signature header against the raw body.

    Raises HTTPException(401) on mismatch or missing header.
    Returns None on success.
    """
    header = request.headers.get("X-Worker-Signature", "")
    if not header.startswith("sha256="):
        raise HTTPException(
            status_code=401,
            detail={"error": "worker.auth.invalid_signature"},
        )

    provided_hex = header[len("sha256="):]

    expected_hex = hmac.new(_get_secret(), body, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_hex, provided_hex):
        raise HTTPException(
            status_code=401,
            detail={"error": "worker.auth.invalid_signature"},
        )
