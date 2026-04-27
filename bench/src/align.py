"""
Face alignment using the 5-point landmark template.

Applies an affine transform to warp a detected face into a canonical
112x112 crop suitable for SFace embedding. The template is the standard
ArcFace / InsightFace target positions.
"""

from __future__ import annotations

import cv2
import numpy as np

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

    transform = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)[0]
    if transform is None:
        # Fallback: return a rough bbox crop resized to 112x112
        # This can happen when landmarks are degenerate (very small face, etc.)
        return _bbox_fallback(image_bgr, landmarks)

    aligned = cv2.warpAffine(image_bgr, transform, ALIGN_SIZE, flags=cv2.INTER_LINEAR)
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
