# Worker ONNX Models — Operations Reference

Models used by the phostro recognition worker for face detection and embedding.

---

## Model Inventory

### `det_10g.onnx` — Face Detection

| Field | Value |
|---|---|
| Name | InsightFace RetinaFace — det_10g (10G-flop MobileNet-V1 backbone) |
| Version | buffalo_l pack (no standalone version tag; hash is canonical) |
| Source | Bundled with the `insightface` Python package; extracted from `~/.insightface/models/buffalo_l/det_10g.onnx` |
| Upstream | https://github.com/deepinsight/insightface |
| SHA-256 | `5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91` |
| File size | ~16 MB |
| License | MIT (InsightFace project — see [LICENSE](https://github.com/deepinsight/insightface/blob/master/LICENSE)) |
| Role | Detects face bounding boxes + 5-point landmarks in an input image |
| Why this model | Handles smaller faces and mild profile angles better than YuNet on group photos; profile angles are the primary problem domain |

### `face_recognition_sface_2021dec.onnx` — Face Recognition (Embedding)

| Field | Value |
|---|---|
| Name | OpenCV Zoo SFace — 2021 December release |
| Version | `face_recognition_sface_2021dec` |
| Source | https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx |
| Upstream | https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface |
| SHA-256 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |
| File size | ~37 MB |
| License | Apache-2.0 (OpenCV Zoo — see [LICENSE](https://github.com/opencv/opencv_zoo/blob/main/LICENSE)) |
| Role | Produces a 128-dim L2-normalised face embedding from an aligned 112×112 crop |

**Combined size on disk:** ~53 MB

**License compatibility:** Both models are MIT-safe (MIT + Apache-2.0). The project's design doc requires MIT-safe builds; Apache-2.0 is compatible with MIT distribution.

---

## Download

Run the download script from the repo root:

```bash
worker/scripts/download_models.sh
# outputs to worker/models/ by default

worker/scripts/download_models.sh --out /some/other/dir
```

The script:
- Downloads `face_recognition_sface_2021dec.onnx` via `curl` from the OpenCV Zoo GitHub.
- Extracts `det_10g.onnx` from the `insightface` Python package (requires `python3` + `pip`; insightface is installed temporarily).
- Verifies SHA-256 of each file after download; exits non-zero on any mismatch.
- Is idempotent: skips download if the file already exists and the hash matches.

---

## Image Strategy: Bake Models into the Docker Image

**Decision: bake models into the image** (`COPY worker/models /models` in the runtime stage of `worker/Dockerfile`).

### Rationale

Cold-start measurements from Task 1 (`docs/ops/worker-coldstart-2026-04.md`):

| Image | p50 | p95 | Compressed size |
|---|---|---|---|
| Stub (no models) | 0.79s | 0.97s | ~200 MB |
| Loaded (models mounted at startup) | 1.03s | 1.32s | ~450 MB |

With models baked in, the image lands around ~450–500 MB compressed (stub ~200 MB + onnxruntime + ~53 MB models). That is **at or under the 500 MB ceiling** the spec calls out as the threshold for reconsidering.

Key factors:
1. Models are a fixed cold-start cost regardless of where they live — baking them avoids an additional runtime download step.
2. A runtime-download path would fail silently in environments with restricted egress, making deploys fragile.
3. The image stays self-contained: any environment that can pull the image can run it without extra network access.

### Dev override

`docker-compose.yml` mounts `./bench/models:/models:ro`. This bind-mount **overrides** the baked `/models` directory, which is intentional — it lets you swap model files during development without rebuilding the image.

In production (no volume mount), the baked copy is used automatically.

### Fallback option

If image size grows past ~500 MB compressed (e.g., after adding a larger model variant), switch to a startup-time download from S3/R2:

1. Remove `COPY worker/models /models` from the Dockerfile.
2. Add a startup hook in `worker/main.py` that downloads from a known R2 URL and verifies SHA-256 before serving.
3. Surface failures as structured logs tagged `worker.startup.model_download_failed` and fail the health check so the container does not receive traffic with stale/missing models.

This fallback is not implemented; it is the recommended migration path if the image size constraint is hit.

---

## Updating Model Versions

Changing models invalidates the recognition thresholds (Task 11). Follow all of these steps:

1. Download the new model file and note its SHA-256.
2. Update the hashes in `worker/scripts/download_models.sh` (two hardcoded constants near the top of the script).
3. Update this document (SHA-256, file size, version, source URL if changed).
4. Re-run the threshold calibration (Task 11 / `worker/config/thresholds.json`) — embedding distances shift with every model change.
5. Re-run the bench parity test (`worker/tests/test_bench_worker_parity.py`) to confirm results match the bench harness with the new model.
6. Rebuild the Docker image: `docker build -f worker/Dockerfile -t phostro-worker:new-model .`
7. Commit: update the Dockerfile COPY layer (no code change needed if `COPY worker/models /models` is already there).

---

## Attribution

**InsightFace (det_10g.onnx)**

```
InsightFace: An Open Source 2D & 3D Deep Face Analysis Toolbox
https://github.com/deepinsight/insightface
Licensed under the MIT License
```

**OpenCV Zoo SFace (face_recognition_sface_2021dec.onnx)**

```
SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition
Yaoyao Zhong, Weihong Deng, Jiani Hu, Dongyue Zhao, Xian Li, Dongchao Wen
OpenCV Zoo — https://github.com/opencv/opencv_zoo
Licensed under the Apache License 2.0
```
