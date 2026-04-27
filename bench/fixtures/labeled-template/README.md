# Labeled Fixture Template

This folder shows the quantitative benchmark shape without checking in real face images.

## Recommended path

If you already have cropped face samples, skip manual editing and use folder-per-identity plus:

```bash
phostro-bench init-labeled-manifest --dataset-dir bench/fixtures/<your-pack>
```

## Manual manifest mode

Copy `manifest.template.json` to your local pack and replace the sample entries with real local files.

Use `crop_mode: "full_image"` when the file itself is already a tight face crop.

Use `crop_mode: "bbox"` when the file is a larger photo and you want to evaluate one specific face inside it.

The evaluator will try to re-detect a face inside each crop so it can align before embedding. If that fails, it falls back to resizing the crop directly.
