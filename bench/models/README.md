# Model Downloads

The harness expects two ONNX model files in this directory:

```
bench/models/
  det_10g.onnx     # face detection (RetinaFace / InsightFace)
  w600k_r50.onnx   # face recognition (ArcFace R50, 512-d, InsightFace buffalo_l)
```

---

## Face Detection — `det_10g.onnx`

**Chosen model:** InsightFace `det_10g.onnx` (RetinaFace backbone, MobileNet-V1, 10G flops)

**Why this over YuNet:**
- `det_10g.onnx` handles smaller faces and mild profile angles better than YuNet in informal benchmarks on group photos.
- YuNet is faster on tight crops but more brittle on tilted faces — exactly our problem domain.
- You can swap to YuNet later by editing `bench/src/detect.py`; both return the same logical interface.

**Download:**

The model ships with the `insightface` Python package but can also be downloaded standalone:

```
# Option A — extract from the insightface package (no account needed)
pip install insightface
python -c "
import insightface, os, shutil
app = insightface.app.FaceAnalysis(providers=['CPUExecutionProvider'])
app.prepare(ctx_id=-1)
# The model is cached in ~/.insightface/models/buffalo_l/det_10g.onnx
src = os.path.expanduser('~/.insightface/models/buffalo_l/det_10g.onnx')
shutil.copy(src, 'bench/models/det_10g.onnx')
print('copied')
"
```

**Option B — no stable standalone URL exists.** InsightFace does not publish a versioned permalink for `det_10g.onnx` outside the package. Use Option A, or run `worker/scripts/download_models.sh` which automates the pip-extraction with SHA-256 verification.

**Expected file size:** ~16 MB

---

## Face Recognition — `w600k_r50.onnx`

**Model:** InsightFace ArcFace R50 (Glint360K, 512-d L2-normalized embeddings)

**Why this over SFace:** SFace (128-d, 2021) underperforms on accessories like glasses (founder dogfood 2026-05-07: self-with-glasses cosine distance 0.903 vs not-self at 0.981 — only 0.078 of margin). ArcFace R50 trained on Glint360K with substantial augmentation handles accessories and pose variance much better.

**Download:**

`w600k_r50.onnx` ships in the same `buffalo_l` insightface pack as `det_10g.onnx`, so a single Option A run populates both models. `worker/scripts/download_models.sh` automates the pip-extraction with SHA-256 verification for both.

**Expected filename:** `w600k_r50.onnx`
**Expected file size:** ~166 MB
**SHA-256:** `4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43`
**Embedding dim:** 512 (L2-normalized; cosine distance metric)

---

## GPU / CoreML (future work)

The harness uses `onnxruntime` CPU provider only. When ready to accelerate:
- macOS: use `onnxruntime-silicon` or CoreML execution provider
- Linux/CUDA: install `onnxruntime-gpu` and pass `providers=['CUDAExecutionProvider']`

Edit `bench/src/detect.py` and `bench/src/embed.py` — the provider list is a single constant at the top of each file.

---

## Swapping models

Both wrappers (`detect.py`, `embed.py`) are thin — the model path and input preprocessing are the only things that change. Comments in each file mark the spots to edit.
