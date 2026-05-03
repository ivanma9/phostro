"""
worker.recognition — face detection, alignment, and embedding for Photo Courier worker.

Mirrors bench/src/ interfaces exactly so worker output is byte-identical to bench output.
The single configuration seam is WORKER_MODELS_DIR (default: /models), read in each
load_* function via the caller layer below.

Phase-4 GPU/CoreML swap: change PROVIDERS in providers.py only.
"""
from __future__ import annotations

import os
from pathlib import Path

from . import detect, embed, align, providers  # re-export for convenience

__all__ = ["detect", "embed", "align", "providers", "get_models_dir"]


def get_models_dir() -> Path:
    """Return the models directory from WORKER_MODELS_DIR env var (default: /models)."""
    return Path(os.environ.get("WORKER_MODELS_DIR", "/models"))
