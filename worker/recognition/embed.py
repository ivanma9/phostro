"""
SFace face recognition via face_recognition_sface_2021dec.onnx (OpenCV Zoo / ONNX Runtime).

Returns a 128-dimensional L2-normalized embedding for an aligned 112x112 face crop.
Cosine similarity between two embeddings is the primary matching metric.

Copied verbatim from bench/src/embed.py — only PROVIDERS is imported from
.providers instead of being hardcoded, so Phase-4 GPU swap touches one file.
"""

# WARNING: Kept in sync with bench/src/. Worker output must be byte-identical
# to bench eval. test_bench_worker_parity.py guards drift.
# When fixing a bug here: also update bench/src/embed.py and rerun the
# parity test.

from __future__ import annotations

import hashlib
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from .providers import PROVIDERS

# -- Model config -------------------------------------------------------------
MODEL_FILENAME = "face_recognition_sface_2021dec.onnx"

# SFace input: (1, 3, 112, 112), float32, RGB, [0, 255].
INPUT_SIZE = (112, 112)
EMBEDDING_DIM = 128


def load_embedder(models_dir: Path) -> "Embedder":
    model_path = models_dir / MODEL_FILENAME
    if not model_path.exists():
        raise FileNotFoundError(
            f"Recognition model not found: {model_path}\n"
            f"Set WORKER_MODELS_DIR to the directory containing {MODEL_FILENAME} "
            f"(locally: WORKER_MODELS_DIR=$(pwd)/bench/models).\n"
            f"See bench/models/README.md for download instructions."
        )
    return Embedder(model_path)


class Embedder:
    def __init__(self, model_path: Path) -> None:
        self._session = ort.InferenceSession(str(model_path), providers=PROVIDERS)
        self._input_name = self._session.get_inputs()[0].name

    def embed(self, aligned_face_bgr: np.ndarray) -> np.ndarray:
        """
        Compute a 128-d L2-normalized embedding for an aligned 112x112 BGR face.

        Args:
            aligned_face_bgr: Shape (112, 112, 3), BGR (as produced by cv2.imread
                and align_face), uint8 or float32. Internally swapped to RGB
                before being fed to SFace.

        Returns:
            Embedding vector, shape (128,), float32, L2-normalized.
        """
        blob = _preprocess(aligned_face_bgr)
        outputs = self._session.run(None, {self._input_name: blob})
        embedding = outputs[0].flatten().astype(np.float32)
        norm = np.linalg.norm(embedding)
        if norm > 1e-6:
            embedding /= norm
        return embedding


def embedding_hash(embedding: np.ndarray) -> str:
    """Short SHA256 fingerprint of an embedding — for report JSON (not stored in full)."""
    return hashlib.sha256(embedding.tobytes()).hexdigest()[:16]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two L2-normalized embeddings. Range [-1, 1]."""
    return float(np.dot(a, b))


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine distance (1 - similarity). Range [0, 2]. Lower = more similar."""
    return 1.0 - cosine_similarity(a, b)


# -- Preprocessing ------------------------------------------------------------

def _preprocess(face_bgr: np.ndarray) -> np.ndarray:
    """Convert an aligned BGR face crop to an SFace input blob (RGB, NCHW)."""
    if face_bgr.shape[:2] != INPUT_SIZE:
        face_bgr = cv2.resize(face_bgr, INPUT_SIZE, interpolation=cv2.INTER_LINEAR)

    face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
    blob = face_rgb.astype(np.float32)
    blob = blob.transpose(2, 0, 1)[np.newaxis]  # (1, 3, 112, 112)
    return blob
