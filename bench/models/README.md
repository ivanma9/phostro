# Model Downloads

The harness expects two ONNX model files in this directory:

```
bench/models/
  det_10g.onnx          # face detection (RetinaFace / InsightFace)
  face_recognition_sface_2021dec.onnx   # face recognition (SFace)
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

```
# Option B — direct download (check current URL at time of use)
# <add download URL here — visit https://github.com/deepinsight/insightface for the latest release URL>
```

**Expected file size:** ~16 MB

---

## Face Recognition — `face_recognition_sface_2021dec.onnx`

**Model:** OpenCV Zoo SFace

**Download:**

Visit https://github.com/opencv/opencv_zoo and navigate to `models/face_recognition_sface/`.

Direct download command (verify URL is current before running):

```
# <add download URL here — visit https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface>
```

**Expected filename:** `face_recognition_sface_2021dec.onnx`  
**Expected file size:** ~37 MB

---

## GPU / CoreML (future work)

The harness uses `onnxruntime` CPU provider only. When ready to accelerate:
- macOS: use `onnxruntime-silicon` or CoreML execution provider
- Linux/CUDA: install `onnxruntime-gpu` and pass `providers=['CUDAExecutionProvider']`

Edit `bench/src/detect.py` and `bench/src/embed.py` — the provider list is a single constant at the top of each file.

---

## Swapping models

Both wrappers (`detect.py`, `embed.py`) are thin — the model path and input preprocessing are the only things that change. Comments in each file mark the spots to edit.
