"""
RetinaFace detection via det_10g.onnx (InsightFace / ONNX Runtime).

Returns bounding boxes and 5-point landmarks for every face found.

Swap the model: change MODEL_PATH and update _preprocess / _postprocess
to match the new model's input spec.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort

# -- Model config -------------------------------------------------------------
# To swap to YuNet: replace with face_detection_yunet_*.onnx and update
# _preprocess/_postprocess to match its input shape and output format.
MODEL_FILENAME = "det_10g.onnx"

PROVIDERS = ["CPUExecutionProvider"]

# det_10g input size (must be divisible by 32; larger = slower but catches small faces)
INPUT_SIZE = (640, 640)

# Confidence threshold — faces below this are discarded
CONF_THRESHOLD = 0.5

# NMS overlap threshold
NMS_THRESHOLD = 0.4

# RetinaFace anchor strides and sizes for det_10g
_STRIDES = [8, 16, 32]
_NUM_ANCHORS = 2


@dataclass
class Face:
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 (image coords)
    confidence: float
    landmarks: np.ndarray  # shape (5, 2) — right_eye, left_eye, nose, right_mouth, left_mouth


def load_detector(models_dir: Path) -> "Detector":
    model_path = models_dir / MODEL_FILENAME
    if not model_path.exists():
        raise FileNotFoundError(
            f"Detection model not found: {model_path}\n"
            f"See bench/models/README.md for download instructions."
        )
    return Detector(model_path)


class Detector:
    def __init__(self, model_path: Path) -> None:
        self._session = ort.InferenceSession(str(model_path), providers=PROVIDERS)
        self._input_name = self._session.get_inputs()[0].name

    def detect(self, image_bgr: np.ndarray) -> tuple[list[Face], float]:
        """
        Detect faces in a BGR image (as returned by cv2.imread).

        Returns (faces, elapsed_seconds).
        """
        t0 = time.perf_counter()

        img, scale, (pad_h, pad_w) = _preprocess(image_bgr)
        outputs = self._session.run(None, {self._input_name: img})
        faces = _postprocess(outputs, image_bgr.shape[:2], scale, pad_h, pad_w)

        elapsed = time.perf_counter() - t0
        return faces, elapsed


# -- Preprocessing ------------------------------------------------------------

def _preprocess(
    image_bgr: np.ndarray,
) -> tuple[np.ndarray, float, tuple[int, int]]:
    """
    Resize + pad image to INPUT_SIZE, keeping aspect ratio.
    Returns (blob, scale, (pad_h, pad_w)).
    scale is the ratio original -> resized (same for x and y after letterbox).
    """
    h, w = image_bgr.shape[:2]
    target_h, target_w = INPUT_SIZE

    scale = min(target_h / h, target_w / w)
    new_h, new_w = int(h * scale), int(w * scale)

    resized = cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    pad_h = target_h - new_h
    pad_w = target_w - new_w
    padded = cv2.copyMakeBorder(resized, 0, pad_h, 0, pad_w, cv2.BORDER_CONSTANT, value=0)

    # det_10g was trained on RGB. cv2.imread returns BGR. Swap to match
    # the InsightFace reference (cv2.dnn.blobFromImage(..., swapRB=True)).
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
    blob = (rgb.astype(np.float32) - 127.5) / 128.0
    blob = blob.transpose(2, 0, 1)[np.newaxis]  # (1, 3, H, W)

    return blob, scale, (pad_h, pad_w)


# -- Postprocessing -----------------------------------------------------------

def _postprocess(
    outputs: list[np.ndarray],
    orig_shape: tuple[int, int],
    scale: float,
    pad_h: int,  # noqa: ARG001 — kept for API symmetry with _preprocess; padding is bottom/right so coordinates are unaffected
    pad_w: int,  # noqa: ARG001
) -> list[Face]:
    """
    Decode det_10g outputs into Face objects in original image coordinates.

    det_10g output order is grouped by tensor type, then stride (matches
    InsightFace SCRFD reference):
      [scores_s8, scores_s16, scores_s32,
       bbox_s8,   bbox_s16,   bbox_s32,
       kps_s8,    kps_s16,    kps_s32]
    Total outputs: 3 strides * 3 = 9 tensors. With FMC=3, level i reads
    outputs[i] (scores), outputs[i + 3] (bbox), outputs[i + 6] (landmarks).

    Padding is bottom/right only (_preprocess), so predicted box coordinates
    in padded-image space are identical to non-padded space for all real faces.
    Dividing by `scale` maps directly back to original image coordinates.
    """
    faces: list[Face] = []
    input_h, input_w = INPUT_SIZE
    orig_h, orig_w = orig_shape

    fmc = len(_STRIDES)
    for idx, stride in enumerate(_STRIDES):
        feat_h = input_h // stride
        feat_w = input_w // stride

        scores = outputs[idx].reshape(-1)                # (N,)
        bbox_preds = outputs[idx + fmc].reshape(-1, 4)   # (N, 4)
        lm_preds = outputs[idx + 2 * fmc].reshape(-1, 10)  # (N, 10)

        # Build anchor centers
        anchors = _make_anchors(feat_h, feat_w, stride)  # (N, 2)

        # Decode boxes: center-form predictions * stride
        x1 = (anchors[:, 0] - bbox_preds[:, 0] * stride)
        y1 = (anchors[:, 1] - bbox_preds[:, 1] * stride)
        x2 = (anchors[:, 0] + bbox_preds[:, 2] * stride)
        y2 = (anchors[:, 1] + bbox_preds[:, 3] * stride)

        # Decode landmarks
        lm = lm_preds * stride
        lm[:, 0::2] += anchors[:, 0:1]  # x coords
        lm[:, 1::2] += anchors[:, 1:2]  # y coords

        keep = scores >= CONF_THRESHOLD
        if not np.any(keep):
            continue

        x1, y1, x2, y2 = x1[keep], y1[keep], x2[keep], y2[keep]
        lm = lm[keep]
        sc = scores[keep]

        for i in range(len(sc)):
            bx1 = max(0.0, float(x1[i]) / scale)
            by1 = max(0.0, float(y1[i]) / scale)
            bx2 = min(float(orig_w), float(x2[i]) / scale)
            by2 = min(float(orig_h), float(y2[i]) / scale)
            faces.append(
                Face(
                    bbox=(bx1, by1, bx2, by2),
                    confidence=float(sc[i]),
                    landmarks=lm[i].reshape(5, 2) / scale,
                )
            )

    if not faces:
        return faces

    # NMS
    boxes_arr = np.array([f.bbox for f in faces], dtype=np.float32)
    scores_arr = np.array([f.confidence for f in faces], dtype=np.float32)
    indices = _nms(boxes_arr, scores_arr, NMS_THRESHOLD)
    return [faces[i] for i in indices]


def _make_anchors(feat_h: int, feat_w: int, stride: int) -> np.ndarray:
    """Generate anchor center points for a feature map level."""
    cy, cx = np.mgrid[0:feat_h, 0:feat_w]
    cx = (cx * stride + stride / 2).flatten()
    cy = (cy * stride + stride / 2).flatten()
    centers = np.stack([cx, cy], axis=1)
    # Repeat for _NUM_ANCHORS anchors per location
    return np.repeat(centers, _NUM_ANCHORS, axis=0)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-7)
        order = order[1:][iou <= iou_threshold]
    return keep
