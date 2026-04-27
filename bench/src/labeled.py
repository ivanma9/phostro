"""
Helpers for labeled benchmark datasets.

This supports a quantitative evaluation lane alongside the existing
category-based qualitative benchmark:

- each sample points to either a cropped face image or a bbox inside a photo
- each sample has an identity_id
- pairs can be supplied explicitly, or derived automatically from identity_id
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


@dataclass(frozen=True)
class LabeledSample:
    sample_id: str
    file: Path
    identity_id: str
    crop_mode: str
    bbox: tuple[int, int, int, int] | None
    cluster_id: str | None
    tags: tuple[str, ...]
    notes: str | None


@dataclass(frozen=True)
class LabeledPair:
    a: str
    b: str
    same_identity: bool
    source: str


@dataclass(frozen=True)
class LabeledDataset:
    dataset_id: str
    description: str
    manifest_path: Path
    samples: tuple[LabeledSample, ...]
    pairs: tuple[LabeledPair, ...]

    @property
    def root_dir(self) -> Path:
        return self.manifest_path.parent


def build_manifest_from_identity_dirs(dataset_dir: Path) -> dict[str, Any]:
    """
    Build a manifest payload from:

      dataset_dir/
        <identity_id>/
          image1.jpg
          image2.jpg
        <identity_id>/
          ...

    Each image becomes one labeled sample with crop_mode=full_image.
    """
    samples: list[dict[str, Any]] = []

    for identity_dir in sorted(p for p in dataset_dir.iterdir() if p.is_dir()):
        identity_id = identity_dir.name
        for image_path in sorted(identity_dir.rglob("*")):
            if not image_path.is_file() or image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue

            rel_path = image_path.relative_to(dataset_dir).as_posix()
            sample_id = _slugify_path(rel_path)
            samples.append(
                {
                    "sample_id": sample_id,
                    "file": rel_path,
                    "identity_id": identity_id,
                    "cluster_id": identity_id,
                    "crop_mode": "full_image",
                    "tags": [],
                }
            )

    return {
        "dataset_id": dataset_dir.name,
        "description": (
            "Generated from folder-per-identity layout. "
            "Each file is treated as one labeled face sample."
        ),
        "samples": samples,
    }


def load_labeled_dataset(manifest_path: Path) -> LabeledDataset:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    dataset_id = str(payload.get("dataset_id") or manifest_path.parent.name)
    description = str(payload.get("description") or "")
    default_crop_mode = str(payload.get("default_crop_mode") or "full_image")

    raw_samples = payload.get("samples")
    if not isinstance(raw_samples, list) or not raw_samples:
        raise ValueError("Manifest must include a non-empty 'samples' array.")

    samples: list[LabeledSample] = []
    sample_by_id: dict[str, LabeledSample] = {}

    for index, raw in enumerate(raw_samples):
        if not isinstance(raw, dict):
            raise ValueError(f"samples[{index}] must be an object.")

        sample_id = str(raw.get("sample_id") or "").strip()
        identity_id = str(raw.get("identity_id") or "").strip()
        file_value = str(raw.get("file") or "").strip()
        crop_mode = str(raw.get("crop_mode") or default_crop_mode).strip()

        if not sample_id:
            raise ValueError(f"samples[{index}] is missing sample_id.")
        if sample_id in sample_by_id:
            raise ValueError(f"Duplicate sample_id: {sample_id}")
        if not identity_id:
            raise ValueError(f"samples[{index}] is missing identity_id.")
        if not file_value:
            raise ValueError(f"samples[{index}] is missing file.")
        if crop_mode not in {"full_image", "bbox"}:
            raise ValueError(
                f"samples[{index}] has unsupported crop_mode={crop_mode!r}. "
                "Use 'full_image' or 'bbox'."
            )

        file_path = (manifest_path.parent / file_value).resolve()
        if not file_path.exists():
            raise ValueError(f"samples[{index}] points to a missing file: {file_value}")

        bbox = _parse_bbox(raw.get("bbox"), sample_id, crop_mode)
        tags = tuple(str(tag) for tag in raw.get("tags", []) if str(tag).strip())
        notes = str(raw["notes"]).strip() if raw.get("notes") is not None else None
        cluster_id = (
            str(raw["cluster_id"]).strip()
            if raw.get("cluster_id") is not None
            else None
        )

        sample = LabeledSample(
            sample_id=sample_id,
            file=file_path,
            identity_id=identity_id,
            crop_mode=crop_mode,
            bbox=bbox,
            cluster_id=cluster_id,
            tags=tags,
            notes=notes,
        )
        samples.append(sample)
        sample_by_id[sample_id] = sample

    pairs = _load_pairs(payload.get("pairs"), sample_by_id)

    return LabeledDataset(
        dataset_id=dataset_id,
        description=description,
        manifest_path=manifest_path.resolve(),
        samples=tuple(samples),
        pairs=tuple(pairs),
    )


def _load_pairs(
    raw_pairs: Any,
    sample_by_id: dict[str, LabeledSample],
) -> list[LabeledPair]:
    if raw_pairs is None:
        return [
            LabeledPair(
                a=a.sample_id,
                b=b.sample_id,
                same_identity=(a.identity_id == b.identity_id),
                source="derived_from_identity_id",
            )
            for a, b in combinations(sorted(sample_by_id.values(), key=lambda sample: sample.sample_id), 2)
        ]

    if not isinstance(raw_pairs, list):
        raise ValueError("Manifest 'pairs' must be an array when present.")

    pairs: list[LabeledPair] = []
    seen: set[tuple[str, str]] = set()
    for index, raw in enumerate(raw_pairs):
        if not isinstance(raw, dict):
            raise ValueError(f"pairs[{index}] must be an object.")

        a = str(raw.get("a") or "").strip()
        b = str(raw.get("b") or "").strip()
        if not a or not b:
            raise ValueError(f"pairs[{index}] must include both 'a' and 'b'.")
        if a == b:
            raise ValueError(f"pairs[{index}] cannot compare a sample with itself: {a}")
        if a not in sample_by_id or b not in sample_by_id:
            raise ValueError(f"pairs[{index}] references an unknown sample_id.")

        key = tuple(sorted((a, b)))
        if key in seen:
            raise ValueError(f"Duplicate pair: {a}, {b}")
        seen.add(key)

        if "same_identity" in raw:
            same_identity = bool(raw["same_identity"])
            source = "explicit_pair_label"
        else:
            same_identity = sample_by_id[a].identity_id == sample_by_id[b].identity_id
            source = "derived_from_identity_id"

        pairs.append(
            LabeledPair(
                a=a,
                b=b,
                same_identity=same_identity,
                source=source,
            )
        )

    return pairs


def _parse_bbox(
    raw_bbox: Any,
    sample_id: str,
    crop_mode: str,
) -> tuple[int, int, int, int] | None:
    if raw_bbox is None:
        if crop_mode == "bbox":
            raise ValueError(f"Sample {sample_id} uses crop_mode='bbox' but has no bbox.")
        return None

    if not isinstance(raw_bbox, list) or len(raw_bbox) != 4:
        raise ValueError(f"Sample {sample_id} bbox must be a four-item array.")

    x1, y1, x2, y2 = (int(v) for v in raw_bbox)
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"Sample {sample_id} has an invalid bbox: {raw_bbox}")
    return (x1, y1, x2, y2)


def _slugify_path(path_value: str) -> str:
    stem = Path(path_value).with_suffix("").as_posix()
    return re.sub(r"[^a-zA-Z0-9]+", "_", stem).strip("_").lower()
