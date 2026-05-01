"""
Smoke tests for worker.recognition package.

Fixture strategy (option 1): bench/fixtures/group_shot/ does not exist on this
branch. The face-count + embedding-shape assertion is skipped until a public-domain
group photo is committed under worker/tests/fixtures/ (see inline comment).

What DOES run:
  - test_modules_importable — verifies all four modules import without error, which
    means onnxruntime, cv2, numpy, and skimage must all be installed and the package
    structure must be correct.  An import error breaks CI immediately.
  - test_providers_list — verifies providers.py exports a non-empty PROVIDERS list.
  - test_face_dataclass — sanity-checks the Face dataclass is importable and
    constructable with expected fields.
"""
from __future__ import annotations

import os
import pytest


def test_modules_importable() -> None:
    """All recognition sub-modules must import without error."""
    from worker.recognition import detect, embed, align, providers  # noqa: F401


def test_providers_list() -> None:
    """providers.PROVIDERS must be a non-empty list of strings."""
    from worker.recognition.providers import PROVIDERS

    assert isinstance(PROVIDERS, list), "PROVIDERS must be a list"
    assert len(PROVIDERS) >= 1, "PROVIDERS must have at least one entry"
    assert all(isinstance(p, str) for p in PROVIDERS), "Each provider must be a string"


def test_face_dataclass() -> None:
    """Face dataclass is importable and constructable with expected fields."""
    import numpy as np
    from worker.recognition.detect import Face

    lm = np.zeros((5, 2), dtype=np.float32)
    face = Face(bbox=(0.0, 0.0, 100.0, 100.0), confidence=0.99, landmarks=lm)
    assert face.confidence == pytest.approx(0.99)
    assert face.bbox == (0.0, 0.0, 100.0, 100.0)
    assert face.landmarks.shape == (5, 2)


@pytest.mark.skip(
    reason=(
        "bench/fixtures/group_shot/ not present in this branch. "
        "To enable: commit a public-domain group photo (≥2 faces, ≤500 KB) "
        "to worker/tests/fixtures/group_03.jpg, then remove this skip. "
        "Models are expected at $WORKER_MODELS_DIR (default: /models)."
    )
)
def test_detect_and_embed_group_shot() -> None:
    """
    Integration smoke: group photo produces ≥2 detections and a (128,) embedding.

    Prerequisites:
      - worker/tests/fixtures/group_03.jpg  (public-domain group photo, ≥2 faces)
      - $WORKER_MODELS_DIR pointing at a directory containing:
          det_10g.onnx
          face_recognition_sface_2021dec.onnx
    """
    import cv2
    import numpy as np
    from pathlib import Path

    from worker.recognition.detect import load_detector
    from worker.recognition.embed import load_embedder
    from worker.recognition.align import align_face

    models_dir = Path(os.environ.get("WORKER_MODELS_DIR", "/models"))
    fixture = Path(__file__).parent / "fixtures" / "group_03.jpg"

    image = cv2.imread(str(fixture))
    assert image is not None, f"Could not load fixture: {fixture}"

    detector = load_detector(models_dir)
    faces, _ = detector.detect(image)
    assert len(faces) >= 2, f"Expected ≥2 faces, got {len(faces)}"

    embedder = load_embedder(models_dir)
    aligned = align_face(image, faces[0].landmarks)
    embedding = embedder.embed(aligned)
    assert embedding.shape == (128,), f"Expected (128,), got {embedding.shape}"
    # L2-normalized: norm should be ~1.0
    assert abs(float(np.linalg.norm(embedding)) - 1.0) < 1e-5
