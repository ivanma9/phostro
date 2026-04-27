"""
Milestone 0 benchmark harness — main entry point.

Commands:
  - run: qualitative category-based benchmark over event photos
  - init-labeled-manifest: scaffold a manifest from folder-per-identity crops
  - eval-labeled: quantitative identity benchmark with precision/recall
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path
from typing import Any

import click
import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from rich.console import Console
from rich.progress import BarColumn, MofNCompleteColumn, Progress, SpinnerColumn, TextColumn
from rich.table import Table

from .align import ALIGN_SIZE, align_face
from .detect import load_detector
from .embed import cosine_distance, embedding_hash, load_embedder
from .labeled import (
    LabeledDataset,
    LabeledSample,
    build_manifest_from_identity_dirs,
    load_labeled_dataset,
)

console = Console()

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def _load_image_bgr(path: Path) -> np.ndarray | None:
    """
    Load an image as a BGR ndarray with EXIF orientation applied.

    cv2.imread does not apply EXIF rotation, which would silently rotate
    phone-camera portrait photos 90° and tank detection rates. We use Pillow
    to honor orientation, then convert to BGR so the rest of the pipeline
    (which expects OpenCV-style arrays) is unchanged.

    Returns None on unreadable / corrupt files.
    """
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode != "RGB":
                im = im.convert("RGB")
            arr_rgb = np.asarray(im)
    except (FileNotFoundError, UnidentifiedImageError, OSError):
        return None
    if arr_rgb.size == 0:
        return None
    return cv2.cvtColor(arr_rgb, cv2.COLOR_RGB2BGR)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli() -> None:
    """Photo Courier — Milestone 0 benchmark harness."""


@cli.command()
@click.option(
    "--fixtures",
    default="bench/fixtures",
    show_default=True,
    type=click.Path(exists=True, file_okay=False),
    help="Root directory containing category subdirs.",
)
@click.option(
    "--out",
    default="bench/reports",
    show_default=True,
    type=click.Path(file_okay=False),
    help="Output root directory; a timestamped subdir is created.",
)
@click.option(
    "--models",
    default="bench/models",
    show_default=True,
    type=click.Path(exists=True, file_okay=False),
    help="Directory containing ONNX model files.",
)
def run(fixtures: str, out: str, models: str) -> None:
    """Run face detection + embedding benchmark over category-based fixtures."""
    fixtures_path = Path(fixtures)
    out_path = Path(out)
    models_path = Path(models)

    console.rule("[bold blue]Loading models")
    with console.status("Loading detector..."):
        detector = load_detector(models_path)
    console.print("[green]Detector loaded[/green]")

    with console.status("Loading embedder..."):
        embedder = load_embedder(models_path)
    console.print("[green]Embedder loaded[/green]\n")

    categories = _discover_categories(fixtures_path)
    total_images = sum(len(v) for v in categories.values())

    if total_images == 0:
        console.print(
            "[bold yellow]No images found.[/bold yellow] "
            "Drop photos into subdirectories under "
            f"[cyan]{fixtures_path}[/cyan] and re-run.\n"
            "See bench/fixtures/README.md for layout instructions."
        )
        return

    console.print(
        f"Found [bold]{total_images}[/bold] images across "
        f"[bold]{len(categories)}[/bold] categories.\n"
    )

    console.rule("[bold blue]Running benchmark")

    per_photo: list[dict[str, Any]] = []
    zero_detection_photos: list[str] = []

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Processing images...", total=total_images)

        for category, image_paths in sorted(categories.items()):
            for img_path in sorted(image_paths):
                result = _process_image(img_path, category, detector, embedder)
                per_photo.append(result)

                if result["face_count"] == 0:
                    zero_detection_photos.append(str(img_path))

                progress.advance(task)

    aggregates = _compute_aggregates(per_photo)

    report_dir = _timestamped_report_dir(out_path)
    _write_json(report_dir / "report.json", per_photo, aggregates, zero_detection_photos)
    _write_markdown(
        report_dir / "report.md",
        per_photo,
        aggregates,
        zero_detection_photos,
    )

    console.rule("[bold blue]Summary")
    _print_summary_table(aggregates, zero_detection_photos)
    console.print(f"\nReports written to [cyan]{report_dir}[/cyan]")


@cli.command("init-labeled-manifest")
@click.option(
    "--dataset-dir",
    required=True,
    type=click.Path(exists=True, file_okay=False),
    help="Directory containing one subdirectory per identity.",
)
@click.option(
    "--output",
    type=click.Path(dir_okay=False),
    help="Output manifest path. Defaults to <dataset-dir>/manifest.json.",
)
@click.option(
    "--force",
    is_flag=True,
    help="Overwrite an existing manifest.json.",
)
def init_labeled_manifest(dataset_dir: str, output: str | None, force: bool) -> None:
    """
    Generate a labeled manifest from a folder-per-identity dataset.

    Example:
      bench/fixtures/my-pack/
        alex/
          alex_01.jpg
          alex_02.jpg
        jamie/
          jamie_01.jpg
    """
    dataset_path = Path(dataset_dir)
    output_path = Path(output) if output else dataset_path / "manifest.json"

    if output_path.exists() and not force:
        raise click.ClickException(
            f"{output_path} already exists. Re-run with --force to overwrite it."
        )

    payload = build_manifest_from_identity_dirs(dataset_path)
    samples = payload["samples"]
    if not samples:
        raise click.ClickException(
            "No images found under dataset_dir/<identity>/*.jpg|jpeg|png."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    identities = {sample["identity_id"] for sample in samples}
    console.print(f"[green]Wrote[/green] [cyan]{output_path}[/cyan]")
    console.print(
        f"- samples: [bold]{len(samples)}[/bold]\n"
        f"- identities: [bold]{len(identities)}[/bold]\n"
        "- pairs: derived automatically during eval-labeled unless you add a 'pairs' array"
    )


@cli.command("eval-labeled")
@click.option(
    "--manifest",
    required=True,
    type=click.Path(exists=True, dir_okay=False),
    help="Path to a labeled manifest.json file.",
)
@click.option(
    "--out",
    default="bench/reports",
    show_default=True,
    type=click.Path(file_okay=False),
    help="Output root directory; a timestamped subdir is created.",
)
@click.option(
    "--models",
    default="bench/models",
    show_default=True,
    type=click.Path(exists=True, file_okay=False),
    help="Directory containing ONNX model files.",
)
@click.option(
    "--target-precision",
    default=0.95,
    show_default=True,
    type=float,
    help="Precision floor used when suggesting a conservative operating point.",
)
def eval_labeled(
    manifest: str,
    out: str,
    models: str,
    target_precision: float,
) -> None:
    """Run a quantitative identity benchmark and compute precision/recall."""
    manifest_path = Path(manifest)
    out_path = Path(out)
    models_path = Path(models)

    if not 0.0 < target_precision <= 1.0:
        raise click.ClickException("--target-precision must be in the range (0, 1].")

    console.rule("[bold blue]Loading labeled dataset")
    dataset = load_labeled_dataset(manifest_path)
    console.print(
        f"Dataset: [bold]{dataset.dataset_id}[/bold]\n"
        f"Manifest: [cyan]{dataset.manifest_path}[/cyan]\n"
        f"Samples: [bold]{len(dataset.samples)}[/bold]\n"
        f"Pairs: [bold]{len(dataset.pairs)}[/bold]\n"
    )

    _validate_dataset_for_eval(dataset)

    console.rule("[bold blue]Loading models")
    with console.status("Loading detector..."):
        detector = load_detector(models_path)
    console.print("[green]Detector loaded[/green]")

    with console.status("Loading embedder..."):
        embedder = load_embedder(models_path)
    console.print("[green]Embedder loaded[/green]\n")

    console.rule("[bold blue]Embedding labeled samples")

    sample_results: list[dict[str, Any]] = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Processing samples...", total=len(dataset.samples))
        for sample in sorted(dataset.samples, key=lambda item: item.sample_id):
            sample_results.append(
                _process_labeled_sample(sample, dataset.root_dir, detector, embedder)
            )
            progress.advance(task)

    pair_records, skipped_pairs = _build_pair_records(dataset, sample_results)
    aggregates = _compute_labeled_aggregates(
        dataset,
        sample_results,
        pair_records,
        skipped_pairs,
        target_precision,
    )

    report_dir = _timestamped_report_dir(out_path, dataset.dataset_id)
    _write_labeled_json(
        report_dir / "labeled_report.json",
        dataset,
        sample_results,
        pair_records,
        skipped_pairs,
        aggregates,
    )
    _write_labeled_markdown(
        report_dir / "labeled_report.md",
        dataset,
        sample_results,
        pair_records,
        skipped_pairs,
        aggregates,
        target_precision,
    )

    console.rule("[bold blue]Summary")
    _print_labeled_summary(aggregates, target_precision)
    console.print(f"\nReports written to [cyan]{report_dir}[/cyan]")


# ---------------------------------------------------------------------------
# Image processing: qualitative benchmark
# ---------------------------------------------------------------------------

def _discover_categories(fixtures_path: Path) -> dict[str, list[Path]]:
    """Return {category_name: [image_path, ...]} for all immediate subdirs."""
    categories: dict[str, list[Path]] = {}
    for subdir in sorted(fixtures_path.iterdir()):
        if not subdir.is_dir():
            continue
        images = [
            p for p in subdir.iterdir()
            if p.suffix.lower() in IMAGE_EXTENSIONS and p.is_file()
        ]
        if images:
            categories[subdir.name] = images
    return categories


def _process_image(
    img_path: Path,
    category: str,
    detector: Any,
    embedder: Any,
) -> dict[str, Any]:
    """Detect + align + embed all faces in one image. Returns a result dict."""
    image_bgr = _load_image_bgr(img_path)
    if image_bgr is None:
        return {
            "path": str(img_path),
            "category": category,
            "error": "image loader returned None — unreadable or corrupt file",
            "face_count": 0,
            "detection_time_s": 0.0,
            "total_time_s": 0.0,
            "faces": [],
        }

    t0 = time.perf_counter()
    faces, detect_time = detector.detect(image_bgr)

    face_records = []
    for face in faces:
        aligned = align_face(image_bgr, face.landmarks)
        embedding = embedder.embed(aligned)
        face_records.append(
            {
                "confidence": round(float(face.confidence), 4),
                "bbox": [round(v, 1) for v in face.bbox],
                "embedding_hash": embedding_hash(embedding),
                "_embedding": embedding,
            }
        )

    total_time = time.perf_counter() - t0

    return {
        "path": str(img_path),
        "category": category,
        "face_count": len(faces),
        "detection_time_s": round(detect_time, 4),
        "total_time_s": round(total_time, 4),
        "image_shape": list(image_bgr.shape[:2]),
        "faces": face_records,
    }


# ---------------------------------------------------------------------------
# Image processing: labeled benchmark
# ---------------------------------------------------------------------------

def _validate_dataset_for_eval(dataset: LabeledDataset) -> None:
    """
    Pre-flight check: refuse to run eval-labeled if the dataset cannot
    produce both positive and negative pairs, since the precision/recall
    numbers would be trivially perfect/undefined and silently misleading.

    Requires:
      - at least 2 samples
      - at least 2 distinct identities (so a different-person pair can exist)
      - at least 1 identity with 2+ samples (so a same-person pair can exist)

    Raises click.ClickException with a clear remediation hint on failure.
    """
    samples = dataset.samples
    if len(samples) < 2:
        raise click.ClickException(
            f"Dataset has only {len(samples)} sample(s). Need at least 2 to form any pairs."
        )

    by_identity: dict[str, int] = defaultdict(int)
    for sample in samples:
        by_identity[sample.identity_id] += 1

    distinct_identities = len(by_identity)
    multi_sample_identities = sum(1 for count in by_identity.values() if count >= 2)

    if distinct_identities < 2:
        raise click.ClickException(
            "Dataset has only 1 identity — no different-person pairs are possible, "
            "so precision will be trivially 1.0 at every threshold. "
            "Add samples for a second identity (folder-per-identity layout: another subdir)."
        )
    if multi_sample_identities < 1:
        raise click.ClickException(
            "No identity has 2+ samples — no same-person pairs are possible, "
            "so recall will be 0 at every threshold. "
            "Add a second photo for at least one identity."
        )


def _process_labeled_sample(
    sample: LabeledSample,
    dataset_root: Path,
    detector: Any,
    embedder: Any,
) -> dict[str, Any]:
    """Crop, re-align, and embed one labeled sample."""
    rel_path = sample.file.relative_to(dataset_root).as_posix()
    t0 = time.perf_counter()
    image_bgr = _load_image_bgr(sample.file)

    if image_bgr is None:
        return {
            "sample_id": sample.sample_id,
            "identity_id": sample.identity_id,
            "cluster_id": sample.cluster_id,
            "path": rel_path,
            "crop_mode": sample.crop_mode,
            "bbox": list(sample.bbox) if sample.bbox else None,
            "tags": list(sample.tags),
            "error": "image loader returned None — unreadable or corrupt file",
            "alignment_detection_time_s": 0.0,
            "total_time_s": 0.0,
        }

    try:
        crop_bgr = _extract_sample_crop(image_bgr, sample)
    except ValueError as exc:
        return {
            "sample_id": sample.sample_id,
            "identity_id": sample.identity_id,
            "cluster_id": sample.cluster_id,
            "path": rel_path,
            "crop_mode": sample.crop_mode,
            "bbox": list(sample.bbox) if sample.bbox else None,
            "tags": list(sample.tags),
            "error": str(exc),
            "alignment_detection_time_s": 0.0,
            "total_time_s": 0.0,
        }

    aligned_face, detect_time, crop_face_count, selected_confidence, alignment_strategy = (
        _prepare_labeled_face(crop_bgr, detector)
    )
    embedding = embedder.embed(aligned_face)
    total_time = time.perf_counter() - t0

    return {
        "sample_id": sample.sample_id,
        "identity_id": sample.identity_id,
        "cluster_id": sample.cluster_id,
        "path": rel_path,
        "crop_mode": sample.crop_mode,
        "bbox": list(sample.bbox) if sample.bbox else None,
        "tags": list(sample.tags),
        "alignment_strategy": alignment_strategy,
        "alignment_detection_time_s": round(detect_time, 4),
        "crop_detector_face_count": crop_face_count,
        "selected_face_confidence": (
            round(float(selected_confidence), 4)
            if selected_confidence is not None
            else None
        ),
        "embedding_hash": embedding_hash(embedding),
        "total_time_s": round(total_time, 4),
        "_embedding": embedding,
    }


def _extract_sample_crop(image_bgr: np.ndarray, sample: LabeledSample) -> np.ndarray:
    if sample.crop_mode == "full_image":
        return image_bgr

    if sample.bbox is None:
        raise ValueError(f"Sample {sample.sample_id} requires a bbox crop but has no bbox.")

    x1, y1, x2, y2 = sample.bbox
    height, width = image_bgr.shape[:2]
    x1 = max(0, min(width, x1))
    y1 = max(0, min(height, y1))
    x2 = max(0, min(width, x2))
    y2 = max(0, min(height, y2))

    if x2 <= x1 or y2 <= y1:
        raise ValueError(
            f"Sample {sample.sample_id} has a bbox outside image bounds: {sample.bbox}"
        )

    crop = image_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        raise ValueError(f"Sample {sample.sample_id} produced an empty crop.")
    return crop


def _prepare_labeled_face(
    crop_bgr: np.ndarray,
    detector: Any,
) -> tuple[np.ndarray, float, int, float | None, str]:
    """
    Try to re-detect and align a single face within the crop.

    If crop detection fails, fall back to resizing the crop directly. This makes
    face-crop packs and bbox-based packs both usable without requiring landmarks
    in the manifest.
    """
    faces, detect_time = detector.detect(crop_bgr)
    if faces:
        best_face = max(faces, key=lambda face: _bbox_area(face.bbox))
        aligned_face = align_face(crop_bgr, best_face.landmarks)
        return (
            aligned_face,
            detect_time,
            len(faces),
            float(best_face.confidence),
            "crop_redetect_align",
        )

    resized = cv2.resize(crop_bgr, ALIGN_SIZE, interpolation=cv2.INTER_LINEAR)
    return resized, detect_time, 0, None, "resize_fallback"


def _bbox_area(bbox: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = bbox
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


# ---------------------------------------------------------------------------
# Aggregates: qualitative benchmark
# ---------------------------------------------------------------------------

def _compute_aggregates(per_photo: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute per-category and global stats including pairwise embedding distances."""
    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for result in per_photo:
        by_category[result["category"]].append(result)

    category_stats: dict[str, Any] = {}
    all_intra_distances: list[float] = []

    for category, results in by_category.items():
        total = len(results)
        detected = sum(1 for result in results if result["face_count"] > 0)
        total_faces = sum(result["face_count"] for result in results)
        detect_times = [result["detection_time_s"] for result in results]
        total_times = [result["total_time_s"] for result in results]

        intra_distances: list[float] = []
        for result in results:
            embeddings = [face["_embedding"] for face in result["faces"] if "_embedding" in face]
            for a, b in combinations(embeddings, 2):
                intra_distances.append(cosine_distance(a, b))

        all_intra_distances.extend(intra_distances)

        category_stats[category] = {
            "total_images": total,
            "images_with_detection": detected,
            "detection_hit_rate": round(detected / total, 3) if total > 0 else 0.0,
            "total_faces_detected": total_faces,
            "mean_faces_per_image": round(total_faces / total, 2) if total > 0 else 0.0,
            "mean_detection_time_s": round(float(np.mean(detect_times)), 4) if detect_times else 0.0,
            "mean_total_time_s": round(float(np.mean(total_times)), 4) if total_times else 0.0,
            "intra_photo_distances": _distance_stats(intra_distances),
        }

    global_stats = {
        "total_images": len(per_photo),
        "total_faces": sum(result["face_count"] for result in per_photo),
        "global_detection_hit_rate": round(
            sum(1 for result in per_photo if result["face_count"] > 0) / len(per_photo), 3
        ) if per_photo else 0.0,
        "mean_detection_time_s": round(
            float(np.mean([result["detection_time_s"] for result in per_photo])), 4
        ) if per_photo else 0.0,
        "all_intra_photo_distances": _distance_stats(all_intra_distances),
        "suggested_thresholds": _suggest_thresholds(all_intra_distances),
    }

    return {"global": global_stats, "by_category": category_stats}


# ---------------------------------------------------------------------------
# Aggregates: labeled benchmark
# ---------------------------------------------------------------------------

def _build_pair_records(
    dataset: LabeledDataset,
    sample_results: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sample_by_id = {sample["sample_id"]: sample for sample in sample_results}

    pair_records: list[dict[str, Any]] = []
    skipped_pairs: list[dict[str, Any]] = []

    for pair in dataset.pairs:
        left = sample_by_id[pair.a]
        right = sample_by_id[pair.b]

        if "_embedding" not in left or "_embedding" not in right:
            skipped_pairs.append(
                {
                    "a": pair.a,
                    "b": pair.b,
                    "same_identity": pair.same_identity,
                    "source": pair.source,
                    "reason": "missing_embedding",
                }
            )
            continue

        pair_records.append(
            {
                "a": pair.a,
                "b": pair.b,
                "a_identity": left["identity_id"],
                "b_identity": right["identity_id"],
                "same_identity": pair.same_identity,
                "source": pair.source,
                "distance": round(
                    cosine_distance(left["_embedding"], right["_embedding"]),
                    6,
                ),
            }
        )

    return pair_records, skipped_pairs


def _compute_labeled_aggregates(
    dataset: LabeledDataset,
    sample_results: list[dict[str, Any]],
    pair_records: list[dict[str, Any]],
    skipped_pairs: list[dict[str, Any]],
    target_precision: float,
) -> dict[str, Any]:
    valid_samples = [sample for sample in sample_results if "_embedding" in sample]
    failed_samples = [sample for sample in sample_results if "_embedding" not in sample]
    identity_ids = sorted({sample["identity_id"] for sample in sample_results})

    positive_distances = [
        pair["distance"] for pair in pair_records if pair["same_identity"]
    ]
    negative_distances = [
        pair["distance"] for pair in pair_records if not pair["same_identity"]
    ]
    threshold_rows = _evaluate_thresholds(pair_records)

    best_f1 = _select_best_f1_row(threshold_rows)
    high_precision = _select_high_precision_row(threshold_rows, target_precision)

    crop_redetect_count = sum(
        1 for sample in valid_samples if sample["alignment_strategy"] == "crop_redetect_align"
    )

    return {
        "dataset": {
            "dataset_id": dataset.dataset_id,
            "description": dataset.description,
            "manifest_path": str(dataset.manifest_path),
        },
        "samples": {
            "total": len(sample_results),
            "embedded": len(valid_samples),
            "failed": len(failed_samples),
            "identity_count": len(identity_ids),
            "mean_total_time_s": round(
                float(np.mean([sample["total_time_s"] for sample in valid_samples])),
                4,
            ) if valid_samples else 0.0,
            "crop_redetect_align_rate": round(
                crop_redetect_count / len(valid_samples),
                3,
            ) if valid_samples else 0.0,
        },
        "pairs": {
            "evaluated": len(pair_records),
            "skipped": len(skipped_pairs),
            "positive_count": sum(1 for pair in pair_records if pair["same_identity"]),
            "negative_count": sum(1 for pair in pair_records if not pair["same_identity"]),
            "positive_distance_stats": _distance_stats(positive_distances),
            "negative_distance_stats": _distance_stats(negative_distances),
        },
        "best_f1_operating_point": best_f1,
        "high_precision_operating_point": high_precision
        if high_precision is not None
        else {
            "note": f"No threshold achieved precision >= {target_precision:.2f}."
        },
        "hard_cases": {
            "hardest_true_pairs": sorted(
                [pair for pair in pair_records if pair["same_identity"]],
                key=lambda pair: pair["distance"],
                reverse=True,
            )[:5],
            "hardest_false_pairs": sorted(
                [pair for pair in pair_records if not pair["same_identity"]],
                key=lambda pair: pair["distance"],
            )[:5],
        },
        "threshold_sweep": threshold_rows,
    }


def _evaluate_thresholds(pair_records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not pair_records:
        return []

    distances = np.array([pair["distance"] for pair in pair_records], dtype=np.float64)
    labels = np.array([pair["same_identity"] for pair in pair_records], dtype=bool)

    unique_thresholds = sorted(set(float(distance) for distance in distances.tolist()))
    min_threshold = max(0.0, unique_thresholds[0] - 1e-6)
    max_threshold = min(2.0, unique_thresholds[-1] + 1e-6)
    candidate_thresholds = sorted(set([min_threshold, *unique_thresholds, max_threshold]))

    rows: list[dict[str, Any]] = []
    for threshold in candidate_thresholds:
        predicted_same = distances <= threshold
        tp = int(np.sum(predicted_same & labels))
        fp = int(np.sum(predicted_same & ~labels))
        tn = int(np.sum(~predicted_same & ~labels))
        fn = int(np.sum(~predicted_same & labels))

        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        accuracy = (tp + tn) / len(pair_records) if pair_records else 0.0

        rows.append(
            {
                "threshold": round(float(threshold), 6),
                "tp": tp,
                "fp": fp,
                "tn": tn,
                "fn": fn,
                "precision": round(float(precision), 4),
                "recall": round(float(recall), 4),
                "f1": round(float(f1), 4),
                "accuracy": round(float(accuracy), 4),
            }
        )

    return rows


def _select_best_f1_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"note": "No labeled pairs were available for scoring."}
    return max(
        rows,
        key=lambda row: (
            row["f1"],
            row["precision"],
            row["recall"],
            -row["threshold"],
        ),
    )


def _select_high_precision_row(
    rows: list[dict[str, Any]],
    target_precision: float,
) -> dict[str, Any] | None:
    eligible = [
        row
        for row in rows
        if row["precision"] >= target_precision and row["tp"] > 0
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda row: (
            row["recall"],
            row["precision"],
            -row["threshold"],
        ),
    )


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _distance_stats(distances: list[float]) -> dict[str, Any]:
    if not distances:
        return {"count": 0}
    arr = np.array(distances)
    return {
        "count": len(distances),
        "min": round(float(arr.min()), 4),
        "max": round(float(arr.max()), 4),
        "mean": round(float(arr.mean()), 4),
        "p5": round(float(np.percentile(arr, 5)), 4),
        "p25": round(float(np.percentile(arr, 25)), 4),
        "p50": round(float(np.percentile(arr, 50)), 4),
        "p75": round(float(np.percentile(arr, 75)), 4),
        "p95": round(float(np.percentile(arr, 95)), 4),
    }


def _suggest_thresholds(distances: list[float]) -> dict[str, Any]:
    """
    Derive rough threshold bands from intra-photo pairwise distances.

    Intra-photo pairs are almost always different people, so their distance
    distribution approximates the "different person" population. A reasonable
    "match" threshold sits below the 5th percentile of this distribution.
    """
    if not distances:
        return {"note": "No intra-photo pairs found — drop more photos with multiple faces."}

    arr = np.array(distances)
    p5 = float(np.percentile(arr, 5))
    p15 = float(np.percentile(arr, 15))

    return {
        "match_threshold": round(p5, 4),
        "maybe_threshold": round(p15, 4),
        "rationale": (
            f"'match' < {p5:.4f} (p5 of intra-photo different-person distances); "
            f"'maybe' < {p15:.4f} (p15). "
            "These are proxies — validate with labeled same-person pairs."
        ),
    }


def _timestamped_report_dir(out_path: Path, suffix: str | None = None) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if suffix:
        report_dir = out_path / f"{timestamp}-{_slugify_for_path(suffix)}"
    else:
        report_dir = out_path / timestamp
    report_dir.mkdir(parents=True, exist_ok=True)
    return report_dir


def _slugify_for_path(value: str) -> str:
    chars = [
        ch.lower() if ch.isalnum() else "-"
        for ch in value
    ]
    slug = "".join(chars).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "report"


# ---------------------------------------------------------------------------
# Report writers: qualitative benchmark
# ---------------------------------------------------------------------------

def _write_json(
    path: Path,
    per_photo: list[dict[str, Any]],
    aggregates: dict[str, Any],
    zero_detection_photos: list[str],
) -> None:
    clean_photos = []
    for result in per_photo:
        record = {key: value for key, value in result.items() if key != "faces"}
        record["faces"] = [
            {key: value for key, value in face.items() if not key.startswith("_")}
            for face in result.get("faces", [])
        ]
        clean_photos.append(record)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "zero_detection_photos": zero_detection_photos,
        "aggregates": aggregates,
        "per_photo": clean_photos,
    }

    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_markdown(
    path: Path,
    per_photo: list[dict[str, Any]],
    aggregates: dict[str, Any],
    zero_detection_photos: list[str],
) -> None:
    lines: list[str] = []
    global_stats = aggregates["global"]
    category_stats = aggregates["by_category"]

    lines += [
        "# Benchmark Report — Milestone 0",
        f"\nGenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "## Global Summary",
        "",
        f"- **Total images processed:** {global_stats['total_images']}",
        f"- **Total faces detected:** {global_stats['total_faces']}",
        f"- **Global detection hit rate:** {global_stats['global_detection_hit_rate']:.1%}",
        f"- **Mean detection time:** {global_stats['mean_detection_time_s'] * 1000:.1f} ms/image",
        "",
    ]

    suggested = global_stats.get("suggested_thresholds", {})
    lines += [
        "## Suggested Matching Thresholds",
        "",
        "> These are derived from pairwise cosine distances between faces in the **same**",
        "> photo (almost always different people). They approximate the lower bound of",
        "> the different-person distance distribution. Tune with labeled same-person pairs.",
        "",
    ]
    if "note" in suggested:
        lines.append(f"_{suggested['note']}_")
    else:
        lines += [
            "| Band | Cosine distance threshold |",
            "|---|---|",
            f"| **Match** (same person) | < {suggested.get('match_threshold', 'N/A')} |",
            f"| **Maybe** (review) | < {suggested.get('maybe_threshold', 'N/A')} |",
            f"| **No match** | >= {suggested.get('maybe_threshold', 'N/A')} |",
            "",
            f"_Rationale: {suggested.get('rationale', '')}_",
        ]
    lines.append("")

    lines += [
        "## Results by Category",
        "",
    ]

    for category in sorted(category_stats.keys()):
        stats = category_stats[category]
        dist = stats["intra_photo_distances"]
        lines += [
            f"### `{category}`",
            "",
            "| Metric | Value |",
            "|---|---|",
            f"| Images | {stats['total_images']} |",
            f"| Images with ≥1 detection | {stats['images_with_detection']} |",
            f"| Detection hit rate | {stats['detection_hit_rate']:.1%} |",
            f"| Total faces detected | {stats['total_faces_detected']} |",
            f"| Mean faces/image | {stats['mean_faces_per_image']} |",
            f"| Mean detection time | {stats['mean_detection_time_s'] * 1000:.1f} ms |",
            f"| Mean total time (incl. embed) | {stats['mean_total_time_s'] * 1000:.1f} ms |",
            "",
        ]

        if dist.get("count", 0) > 0:
            lines += [
                "**Intra-photo embedding distances** (different-person proxy):",
                "",
                "| p5 | p25 | p50 | p75 | p95 |",
                "|---|---|---|---|---|",
                f"| {dist['p5']} | {dist['p25']} | {dist['p50']} | {dist['p75']} | {dist['p95']} |",
                "",
            ]
        else:
            lines.append("_No multi-face images in this category — no intra-photo distances._\n")

    lines += [
        "## Photos with Zero Detections",
        "",
    ]
    if zero_detection_photos:
        lines.append(
            "> **Action required:** Inspect these photos manually. They may indicate "
            "detector failure on low-light, extreme angles, or very small faces."
        )
        lines.append("")
        for path_value in zero_detection_photos:
            lines.append(f"- `{path_value}`")
    else:
        lines.append("_None — every image produced at least one detection._")
    lines.append("")

    lines += [
        "## Per-Photo Detail",
        "",
        "| Category | File | Faces | Top Confidence | Detect ms | Total ms |",
        "|---|---|---|---|---|---|",
    ]
    for result in per_photo:
        filename = Path(result["path"]).name
        category = result["category"]
        faces = result.get("faces", [])
        top_conf = max((face["confidence"] for face in faces), default=0.0)
        top_conf_str = f"{top_conf:.3f}" if faces else "—"
        detect_ms = f"{result['detection_time_s'] * 1000:.1f}"
        total_ms = f"{result['total_time_s'] * 1000:.1f}"
        error = result.get("error", "")
        face_count = result["face_count"]
        face_count_str = f"**{face_count}** ⚠" if face_count == 0 else str(face_count)
        lines.append(
            f"| `{category}` | `{filename}` | {face_count_str} | {top_conf_str} | {detect_ms} | {total_ms} |"
        )
        if error:
            lines.append(f"| | _Error: {error}_ | | | | |")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Report writers: labeled benchmark
# ---------------------------------------------------------------------------

def _write_labeled_json(
    path: Path,
    dataset: LabeledDataset,
    sample_results: list[dict[str, Any]],
    pair_records: list[dict[str, Any]],
    skipped_pairs: list[dict[str, Any]],
    aggregates: dict[str, Any],
) -> None:
    clean_samples = []
    for sample in sample_results:
        clean_samples.append(
            {key: value for key, value in sample.items() if not key.startswith("_")}
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_id": dataset.dataset_id,
        "manifest_path": str(dataset.manifest_path),
        "aggregates": aggregates,
        "samples": clean_samples,
        "pairs": pair_records,
        "skipped_pairs": skipped_pairs,
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_labeled_markdown(
    path: Path,
    dataset: LabeledDataset,
    sample_results: list[dict[str, Any]],
    pair_records: list[dict[str, Any]],
    skipped_pairs: list[dict[str, Any]],
    aggregates: dict[str, Any],
    target_precision: float,
) -> None:
    lines: list[str] = []
    sample_stats = aggregates["samples"]
    pair_stats = aggregates["pairs"]
    best_f1 = aggregates["best_f1_operating_point"]
    high_precision = aggregates["high_precision_operating_point"]
    hard_cases = aggregates["hard_cases"]

    lines += [
        "# Labeled Benchmark Report — Milestone 0",
        f"\nGenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "## Dataset Summary",
        "",
        f"- **Dataset:** `{dataset.dataset_id}`",
        f"- **Manifest:** `{dataset.manifest_path}`",
        f"- **Samples:** {sample_stats['total']} total, {sample_stats['embedded']} embedded, {sample_stats['failed']} failed",
        f"- **Identities:** {sample_stats['identity_count']}",
        f"- **Pairs evaluated:** {pair_stats['evaluated']} ({pair_stats['positive_count']} positive, {pair_stats['negative_count']} negative)",
        f"- **Pairs skipped:** {pair_stats['skipped']}",
        f"- **Crop re-detect + align hit rate:** {sample_stats['crop_redetect_align_rate']:.1%}",
        "",
    ]

    lines += [
        "## Operating Points",
        "",
    ]
    if "note" in best_f1:
        lines.append(f"_{best_f1['note']}_")
    else:
        lines += [
            "### Best F1",
            "",
            "| Threshold | Precision | Recall | F1 | TP | FP | FN | TN |",
            "|---|---|---|---|---|---|---|---|",
            (
                f"| {best_f1['threshold']} | {best_f1['precision']:.4f} | "
                f"{best_f1['recall']:.4f} | {best_f1['f1']:.4f} | "
                f"{best_f1['tp']} | {best_f1['fp']} | {best_f1['fn']} | {best_f1['tn']} |"
            ),
            "",
        ]

    lines += [
        f"### Precision Guardrail (target >= {target_precision:.2f})",
        "",
    ]
    if "note" in high_precision:
        lines.append(f"_{high_precision['note']}_")
    else:
        lines += [
            "| Threshold | Precision | Recall | F1 | TP | FP | FN | TN |",
            "|---|---|---|---|---|---|---|---|",
            (
                f"| {high_precision['threshold']} | {high_precision['precision']:.4f} | "
                f"{high_precision['recall']:.4f} | {high_precision['f1']:.4f} | "
                f"{high_precision['tp']} | {high_precision['fp']} | "
                f"{high_precision['fn']} | {high_precision['tn']} |"
            ),
            "",
        ]

    lines += [
        "## Distance Distributions",
        "",
        "| Pair set | Count | Min | P50 | P95 | Max | Mean |",
        "|---|---|---|---|---|---|---|",
    ]
    positive_stats = pair_stats["positive_distance_stats"]
    negative_stats = pair_stats["negative_distance_stats"]
    lines.append(_distance_row("Same identity", positive_stats))
    lines.append(_distance_row("Different identity", negative_stats))
    lines.append("")

    lines += [
        "## Hard Cases",
        "",
        "### Farthest Same-Identity Pairs",
        "",
    ]
    if hard_cases["hardest_true_pairs"]:
        for pair in hard_cases["hardest_true_pairs"]:
            lines.append(
                f"- `{pair['a']}` vs `{pair['b']}` -> distance `{pair['distance']}`"
            )
    else:
        lines.append("_None._")
    lines.append("")

    lines += [
        "### Closest Different-Identity Pairs",
        "",
    ]
    if hard_cases["hardest_false_pairs"]:
        for pair in hard_cases["hardest_false_pairs"]:
            lines.append(
                f"- `{pair['a']}` vs `{pair['b']}` -> distance `{pair['distance']}`"
            )
    else:
        lines.append("_None._")
    lines.append("")

    failed_samples = [sample for sample in sample_results if "error" in sample]
    lines += [
        "## Sample Failures",
        "",
    ]
    if failed_samples:
        for sample in failed_samples:
            lines.append(
                f"- `{sample['sample_id']}` (`{sample['path']}`): {sample['error']}"
            )
    else:
        lines.append("_None._")
    lines.append("")

    if skipped_pairs:
        lines += [
            "## Skipped Pairs",
            "",
        ]
        for pair in skipped_pairs[:20]:
            lines.append(
                f"- `{pair['a']}` vs `{pair['b']}`: {pair['reason']}"
            )
        if len(skipped_pairs) > 20:
            lines.append(f"- _...and {len(skipped_pairs) - 20} more_")
        lines.append("")

    lines += [
        "## Per-Sample Detail",
        "",
        "| Sample | Identity | File | Align | Crop faces | Total ms |",
        "|---|---|---|---|---|---|",
    ]
    for sample in sorted(sample_results, key=lambda item: item["sample_id"]):
        if "error" in sample:
            lines.append(
                f"| `{sample['sample_id']}` | `{sample['identity_id']}` | `{sample['path']}` | error | — | — |"
            )
            continue
        lines.append(
            f"| `{sample['sample_id']}` | `{sample['identity_id']}` | `{sample['path']}` | "
            f"`{sample['alignment_strategy']}` | {sample['crop_detector_face_count']} | "
            f"{sample['total_time_s'] * 1000:.1f} |"
        )

    lines += [
        "",
        "_Full threshold sweep, pair records, and skipped-pair detail are in `labeled_report.json`._",
    ]

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _distance_row(label: str, stats: dict[str, Any]) -> str:
    if stats.get("count", 0) == 0:
        return f"| {label} | 0 | — | — | — | — | — |"
    return (
        f"| {label} | {stats['count']} | {stats['min']} | {stats['p50']} | "
        f"{stats['p95']} | {stats['max']} | {stats['mean']} |"
    )


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------

def _print_summary_table(aggregates: dict[str, Any], zero_detection_photos: list[str]) -> None:
    global_stats = aggregates["global"]
    category_stats = aggregates["by_category"]

    table = Table(title="Per-Category Results", show_header=True)
    table.add_column("Category", style="cyan")
    table.add_column("Images", justify="right")
    table.add_column("Hit Rate", justify="right")
    table.add_column("Total Faces", justify="right")
    table.add_column("Mean Det ms", justify="right")

    for category in sorted(category_stats.keys()):
        stats = category_stats[category]
        hit_rate = f"{stats['detection_hit_rate']:.1%}"
        det_ms = f"{stats['mean_detection_time_s'] * 1000:.1f}"
        table.add_row(
            category,
            str(stats["total_images"]),
            hit_rate,
            str(stats["total_faces_detected"]),
            det_ms,
        )

    console.print(table)

    if zero_detection_photos:
        console.print(
            f"\n[bold red]{len(zero_detection_photos)} photo(s) had zero detections[/bold red] "
            "— see report.md for the list."
        )

    thresholds = global_stats.get("suggested_thresholds", {})
    if "match_threshold" in thresholds:
        console.print(
            f"\n[bold]Suggested thresholds[/bold] (cosine distance): "
            f"match < [green]{thresholds['match_threshold']}[/green]  "
            f"maybe < [yellow]{thresholds['maybe_threshold']}[/yellow]"
        )


def _print_labeled_summary(aggregates: dict[str, Any], target_precision: float) -> None:
    sample_stats = aggregates["samples"]
    pair_stats = aggregates["pairs"]
    best_f1 = aggregates["best_f1_operating_point"]
    high_precision = aggregates["high_precision_operating_point"]

    table = Table(title="Labeled Benchmark Summary", show_header=True)
    table.add_column("Metric", style="cyan")
    table.add_column("Value", justify="right")
    table.add_row("Embedded samples", f"{sample_stats['embedded']} / {sample_stats['total']}")
    table.add_row("Identities", str(sample_stats["identity_count"]))
    table.add_row(
        "Pairs",
        f"{pair_stats['evaluated']} ({pair_stats['positive_count']} pos / {pair_stats['negative_count']} neg)",
    )
    table.add_row(
        "Crop re-detect align rate",
        f"{sample_stats['crop_redetect_align_rate']:.1%}",
    )
    console.print(table)

    if "threshold" in best_f1:
        console.print(
            f"\n[bold]Best F1[/bold]: threshold <= [green]{best_f1['threshold']}[/green]  "
            f"precision [green]{best_f1['precision']:.3f}[/green]  "
            f"recall [green]{best_f1['recall']:.3f}[/green]  "
            f"f1 [green]{best_f1['f1']:.3f}[/green]"
        )

    if "threshold" in high_precision:
        console.print(
            f"[bold]Precision guardrail[/bold] (>= {target_precision:.2f}): "
            f"threshold <= [yellow]{high_precision['threshold']}[/yellow]  "
            f"precision [yellow]{high_precision['precision']:.3f}[/yellow]  "
            f"recall [yellow]{high_precision['recall']:.3f}[/yellow]"
        )
    else:
        console.print(f"[yellow]{high_precision['note']}[/yellow]")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli()
