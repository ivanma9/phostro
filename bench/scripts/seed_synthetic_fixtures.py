#!/usr/bin/env python3
"""
Seed bench/fixtures/ with AI-generated faces from thispersondoesnotexist.com.

These are GAN-synthesized — no real person depicted. They exist only to
validate that the benchmark pipeline runs end-to-end. Replace with real
event photos before drawing any threshold conclusions.

Run:  python3 bench/scripts/seed_synthetic_fixtures.py
"""

from __future__ import annotations

import io
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageEnhance

SOURCE_URL = "https://thispersondoesnotexist.com/"
USER_AGENT = "Mozilla/5.0 (compatible; phostro-bench-seed/1.0)"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FETCH_COUNT = 16
DELAY_SECONDS = 1.5


def fetch_face() -> Image.Image:
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=20) as response:
        return Image.open(io.BytesIO(response.read())).convert("RGB")


def fetch_pool(count: int) -> list[Image.Image]:
    pool: list[Image.Image] = []
    for index in range(count):
        print(f"  face {index + 1}/{count}", flush=True)
        pool.append(fetch_face())
        if index < count - 1:
            time.sleep(DELAY_SECONDS)
    return pool


def save_jpeg(image: Image.Image, path: Path, quality: int = 92) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="JPEG", quality=quality)


def make_group_shot(faces: list[Image.Image], target_height: int = 768) -> Image.Image:
    resized: list[Image.Image] = []
    for face in faces:
        ratio = target_height / face.height
        new_width = int(face.width * ratio)
        resized.append(face.resize((new_width, target_height), Image.LANCZOS))
    total_width = sum(image.width for image in resized)
    canvas = Image.new("RGB", (total_width, target_height), (32, 32, 32))
    cursor = 0
    for image in resized:
        canvas.paste(image, (cursor, 0))
        cursor += image.width
    return canvas


def main() -> int:
    print(f"Seeding {FIXTURES}")
    print("Source: thispersondoesnotexist.com (GAN-generated, no real person)\n")

    print(f"Fetching {FETCH_COUNT} unique faces (~{FETCH_COUNT * DELAY_SECONDS:.0f}s)...")
    faces = fetch_pool(FETCH_COUNT)
    print()

    print("Writing single_frontal/ ...")
    for index, face in enumerate(faces[0:5], 1):
        save_jpeg(face, FIXTURES / "single_frontal" / f"face_{index:02d}.jpg")

    print("Writing low_res/ ...")
    for index, face in enumerate(faces[5:10], 1):
        small = face.resize((256, 256), Image.LANCZOS)
        save_jpeg(small, FIXTURES / "low_res" / f"face_{index:02d}.jpg", quality=80)

    print("Writing dim_light/ ...")
    for index, face in enumerate(faces[10:15], 1):
        dim = ImageEnhance.Brightness(face).enhance(0.35)
        save_jpeg(dim, FIXTURES / "dim_light" / f"face_{index:02d}.jpg")

    print("Writing group_shot/ ...")
    groups = [
        [faces[15], faces[0]],
        [faces[1], faces[6]],
        [faces[2], faces[11], faces[15]],
        [faces[3], faces[7], faces[12]],
        [faces[4], faces[8], faces[13], faces[14]],
    ]
    for index, members in enumerate(groups, 1):
        composite = make_group_shot(members)
        save_jpeg(composite, FIXTURES / "group_shot" / f"group_{index:02d}.jpg")

    notice = FIXTURES / "SYNTHETIC_NOTICE.md"
    notice.write_text(
        "# Synthetic seed fixtures\n\n"
        "These photos are AI-generated faces from thispersondoesnotexist.com.\n"
        "No real person is depicted. They exist only to validate that the\n"
        "benchmark pipeline runs end-to-end.\n\n"
        "Category labels (single_frontal, dim_light, low_res, group_shot)\n"
        "describe how this seed script processed the images, not real-world\n"
        "photo characteristics. Replace with real event photos before drawing\n"
        "any threshold conclusions.\n\n"
        "Re-run with: `python3 bench/scripts/seed_synthetic_fixtures.py`\n",
        encoding="utf-8",
    )

    total = sum(1 for _ in FIXTURES.rglob("*.jpg"))
    print(f"\nDone. {total} photos under {FIXTURES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
