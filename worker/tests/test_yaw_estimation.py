"""
Unit tests for estimate_yaw — the coarse pose proxy used by the multi-angle
enrollment flow's server-side pose check.

Sign convention (derived from align.py's ARCFACE_TEMPLATE which places the
first landmark at x=38.29 of a 112×112 canonical crop, i.e. image-left of
center):

  landmarks[0]  = image-left eye  = subject's right eye (subject faces camera)
  landmarks[1]  = image-right eye = subject's left eye
  landmarks[2]  = nose

When subject turns head to THEIR LEFT, their nose physically moves toward the
camera's RIGHT (image-right), so nose.x > eye_mid_x  →  yaw > 0.
When subject turns head to THEIR RIGHT, nose moves toward image-left  →  yaw < 0.

Magnitudes here are illustrative; production thresholds (YAW_FRONTAL_MAX = 0.10,
YAW_TURN_MIN = 0.18 in lib/auth/face-enrollment.ts) are tuned empirically against
the founder's first scan. These tests pin only the SIGN — that's the load-bearing
property for the gate not to invert "left" and "right" prompts.
"""
from __future__ import annotations

import numpy as np
import pytest

from worker.recognition.detect import estimate_yaw


def _landmarks(eye_l_x: float, eye_r_x: float, nose_x: float) -> np.ndarray:
    """Helper: build a (5, 2) landmark array with given eye + nose x-coords.
    y-coords and the two mouth points don't affect estimate_yaw."""
    return np.array(
        [
            [eye_l_x, 50.0],   # landmarks[0] — image-left eye
            [eye_r_x, 50.0],   # landmarks[1] — image-right eye
            [nose_x, 70.0],    # landmarks[2] — nose
            [eye_l_x + 5, 90.0],
            [eye_r_x - 5, 90.0],
        ],
        dtype=np.float32,
    )


def test_frontal_centered_nose_yaw_near_zero():
    # Eyes at x=10 and x=50; nose centered at x=30.
    lm = _landmarks(10.0, 50.0, 30.0)
    assert abs(estimate_yaw(lm)) < 1e-6


def test_user_turned_left_yaw_positive():
    # User turns head to THEIR LEFT → nose moves toward image-RIGHT.
    # Eyes anchored at 10 and 50; nose at 42 (closer to landmarks[1]).
    lm = _landmarks(10.0, 50.0, 42.0)
    yaw = estimate_yaw(lm)
    assert yaw > 0
    assert yaw == pytest.approx(0.30, abs=1e-3)


def test_user_turned_right_yaw_negative():
    # User turns head to THEIR RIGHT → nose moves toward image-LEFT.
    # Eyes anchored at 10 and 50; nose at 18 (closer to landmarks[0]).
    lm = _landmarks(10.0, 50.0, 18.0)
    yaw = estimate_yaw(lm)
    assert yaw < 0
    assert yaw == pytest.approx(-0.30, abs=1e-3)


def test_eye_order_robust_to_landmark_swap():
    """estimate_yaw uses min/max over eye x-coords, so swapping landmarks[0] and
    landmarks[1] must produce the same yaw."""
    lm_a = _landmarks(10.0, 50.0, 42.0)
    lm_b = _landmarks(50.0, 10.0, 42.0)
    assert estimate_yaw(lm_a) == pytest.approx(estimate_yaw(lm_b), abs=1e-6)


def test_degenerate_zero_eye_distance_returns_zero():
    # Two eyes at the same x (vertical / detection error) → safe fallback.
    lm = _landmarks(30.0, 30.0, 30.0)
    assert estimate_yaw(lm) == 0.0


def test_yaw_magnitude_scales_with_nose_offset():
    """Yaw is a linear ratio: doubling the nose offset doubles |yaw|."""
    eye_dx = 40.0
    eye_l, eye_r = 10.0, 50.0
    eye_mid = 30.0
    yaw_a = estimate_yaw(_landmarks(eye_l, eye_r, eye_mid + 0.10 * eye_dx))
    yaw_b = estimate_yaw(_landmarks(eye_l, eye_r, eye_mid + 0.20 * eye_dx))
    assert yaw_b == pytest.approx(2 * yaw_a, abs=1e-3)
