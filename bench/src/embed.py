"""
SFace face recognition via face_recognition_sface_2021dec.onnx (OpenCV Zoo / ONNX Runtime).

Returns a 128-dimensional L2-normalized embedding for an aligned 112x112 face crop.
Cosine similarity between two embeddings is the primary matching metric.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import onnxruntime as ort

# -- Model config -------------------------------------------------------------
# To swap the recognizer: change MODEL_FILENAME and update _preprocess to
# match the new model's expected input range and layout.
MODEL_FILENAME = "face_recognition_sface_2021dec.onnx"

PROVIDERS = ["CPUExecutionProvider"]

# SFace input: (1, 3, 112, 112), float32, BGR, [0, 255]
INPUT_SIZE = (112, 112)
EMBEDDING_DIM = 128


def load_embedder(models_dir: Path) -> "Embedder":
    model_path = models_dir / MODEL_FILENAME
    if not model_path.exists():
        raise FileNotFoundError(
            f"Recognition model not found: {model_path}\n"
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
            aligned_face_bgr: Shape (112, 112, 3), BGR, uint8 or float32.

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
    """Convert aligned face crop to SFace input blob."""
    if face_bgr.shape[:2] != INPUT_SIZE:
        import cv2
        face_bgr = cv2.resize(face_bgr, INPUT_SIZE, interpolation=cv2.INTER_LINEAR)

    blob = face_bgr.astype(np.float32)
    blob = blob.transpose(2, 0, 1)[np.newaxis]  # (1, 3, 112, 112)
    return blob
