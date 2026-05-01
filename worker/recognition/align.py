"""
Face alignment using the 5-point landmark template.

Applies a similarity transform to warp a detected face into a canonical
112x112 crop suitable for SFace embedding. The template is the standard
ArcFace / InsightFace target positions, and the fit uses the closed-form
Umeyama least-squares estimator (skimage.SimilarityTransform) — the same
estimator the InsightFace reference uses, so embeddings stay comparable
to published thresholds and are deterministic across runs.

Copied verbatim from bench/src/align.py — no changes needed; alignment
is hardware-agnostic (pure CPU numpy/skimage/opencv).
"""

# WARNING: Kept in sync with bench/src/. Worker output must be byte-identical
# to bench eval. test_bench_worker_parity.py guards drift.
# When fixing a bug here: also update bench/src/align.py and rerun the
# parity test.

from __future__ import annotations

import cv2
import numpy as np
from skimage.transform import SimilarityTransform

# Standard ArcFace 112x112 reference landmark positions
# Order: right_eye, left_eye, nose_tip, right_mouth, left_mouth
ARCFACE_TEMPLATE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)

ALIGN_SIZE = (112, 112)


def align_face(image_bgr: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    """
    Warp a face region into a 112x112 canonical crop.

    Args:
        image_bgr: Full original image in BGR format.
        landmarks: Shape (5, 2) array of landmark coordinates in image space.

    Returns:
        Aligned face crop, shape (112, 112, 3), BGR.
    """
    src = landmarks.astype(np.float32)
    dst = ARCFACE_TEMPLATE

    tform = SimilarityTransform()
    if not tform.estimate(src, dst):
        # Degenerate landmarks (collinear, duplicate, very small face).
        return _bbox_fallback(image_bgr, landmarks)

    matrix = tform.params[:2, :].astype(np.float32)
    aligned = cv2.warpAffine(image_bgr, matrix, ALIGN_SIZE, flags=cv2.INTER_LINEAR)
    return aligned


def _bbox_fallback(image_bgr: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    """Rough crop around landmark centroid when affine estimation fails."""
    cx, cy = landmarks[:, 0].mean(), landmarks[:, 1].mean()
    h, w = image_bgr.shape[:2]
    half = 56  # ~half of 112
    x1 = max(0, int(cx - half))
    y1 = max(0, int(cy - half))
    x2 = min(w, x1 + 112)
    y2 = min(h, y1 + 112)
    crop = image_bgr[y1:y2, x1:x2]
    return cv2.resize(crop, ALIGN_SIZE, interpolation=cv2.INTER_LINEAR)
