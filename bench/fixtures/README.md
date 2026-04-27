# Benchmark Fixtures

There are now two fixture lanes:

1. **Qualitative event-photo benchmark** for detection quality on real event images.
2. **Quantitative labeled benchmark** for precision/recall on identity-labeled face samples.

Both are local-first. Do not commit real people's photos to the repo.

## 1. Qualitative event-photo layout

Use this with:

```bash
phostro-bench run --fixtures bench/fixtures --out bench/reports --models bench/models
```

Directory shape:

```text
fixtures/
  group_shot/
    photo1.jpg
    photo2.jpg
  dim_light/
    photo1.jpg
  side_profile/
    photo1.jpg
  varied_skin_tone/
    photo1.jpg
  low_res_candid/
    photo1.jpg
  <any_name_you_want>/
    ...
```

The harness does not hardcode category names. Every immediate subdirectory with image files is treated as one category.

### What makes a good qualitative set

Cover the failure modes most likely to hurt a real event product:

| Category | What to include |
|---|---|
| `group_shot` | 5-20 people, mixed distances, partially occluded faces |
| `dim_light` | Indoor candids with low ISO or under-exposed |
| `side_profile` | Faces at 45-90 degrees from camera |
| `varied_skin_tone` | Full range — auto-exposure and detection both have known biases here |
| `low_res_candid` | Cropped or zoomed-in shots, small face bounding boxes |
| `motion_blur` | Action shots, dancing |

## 2. Quantitative labeled layout

Use this when you want actual precision/recall numbers.

The easiest path is **one folder per person**, with each image already being a tight face crop:

```text
fixtures/
  wedding-face-crops/
    alex/
      alex_01.jpg
      alex_02.jpg
    jamie/
      jamie_01.jpg
      jamie_02.jpg
    priya/
      priya_01.jpg
```

Then generate a manifest:

```bash
phostro-bench init-labeled-manifest --dataset-dir bench/fixtures/wedding-face-crops
```

That writes:

```text
bench/fixtures/wedding-face-crops/manifest.json
```

Then run the quantitative benchmark:

```bash
phostro-bench eval-labeled \
  --manifest bench/fixtures/wedding-face-crops/manifest.json \
  --out bench/reports \
  --models bench/models
```

### When to use manual manifests

If a sample is not already a face crop, the manifest can point at a full photo and provide a bbox:

```json
{
  "sample_id": "photo_003_face_01",
  "file": "group/photo_003.jpg",
  "identity_id": "alex",
  "cluster_id": "alex",
  "crop_mode": "bbox",
  "bbox": [422, 128, 588, 322],
  "tags": ["group_shot", "side_profile"]
}
```

See `bench/fixtures/labeled-template/` for a starter template.

## Accepted formats

`.jpg`, `.jpeg`, `.png` (case-insensitive).

## Privacy note

These fixtures are for local benchmarking only. Avoid committing real biometric data. The checked-in files here should be manifests, templates, and docs only.
