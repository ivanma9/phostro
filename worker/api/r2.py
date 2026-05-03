"""
R2 (or any presigned URL) image fetcher.

Returns raw bytes on success.
Raises HTTPException(502) on connection errors or non-2xx responses.
"""
from __future__ import annotations

import httpx
from fastapi import HTTPException


async def fetch_image(url: str, client: httpx.AsyncClient) -> bytes:
    """
    Fetch image bytes from a presigned GET URL.

    Uses the provided AsyncClient so tests can inject a mock transport.
    Timeout is 15s (set on the client at construction time).
    """
    try:
        resp = await client.get(url)
    except httpx.RequestError as exc:
        _emit_structured("worker.detect.r2_fetch_failed", url=url, error=str(exc))
        raise HTTPException(
            status_code=502,
            detail={"error": "worker.detect.r2_fetch_failed", "upstream_status": None},
        ) from exc

    if resp.status_code < 200 or resp.status_code >= 300:
        _emit_structured(
            "worker.detect.r2_fetch_failed", url=url, status=resp.status_code
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": "worker.detect.r2_fetch_failed",
                "upstream_status": resp.status_code,
            },
        )

    return resp.content


def _emit_structured(event: str, **kwargs) -> None:
    import json, sys
    print(json.dumps({"event": event, **kwargs}), file=sys.stderr)
