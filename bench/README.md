# Photo Courier — Milestone 0 Benchmark Harness

Two benchmark lanes for RetinaFace (detection) + SFace (embedding):

1. **Qualitative** event-photo benchmark on representative event photos.
2. **Quantitative** labeled benchmark on identity-tagged face samples.

Together they answer three questions before committing to the recognition stack:

1. Does face detection work well enough on group shots, dim light, side profiles, varied skin tones, and low-res candids?
2. What cosine-distance thresholds separate "same person" from "maybe" from "no match"?
3. What precision/recall tradeoff do those thresholds actually produce on labeled pairs?

The qualitative lane is diagnostic. The labeled lane gives you measurable precision/recall.

---

## Setup

### 1. Install Python 3.11

```bash
# With pyenv:
pyenv install 3.11
pyenv local 3.11   # or set bench/.python-version is already there
```

### 2. Create a virtual environment and install deps

```bash
cd /path/to/phostro

# With uv (recommended):
uv venv bench/.venv --python 3.11
source bench/.venv/bin/activate
uv pip install -e bench/

# Or with plain pip:
python3.11 -m venv bench/.venv
source bench/.venv/bin/activate
pip install -e bench/
```

### 3. Download models

See `bench/models/README.md` for model download instructions.

After downloading, your `bench/models/` directory should contain:
```
bench/models/
  det_10g.onnx
  face_recognition_sface_2021dec.onnx
```

### 4. Add fixture photos or labeled samples

See `bench/fixtures/README.md` for how to organize photos.

Example:
```
bench/fixtures/
  group_shot/
    party1.jpg
    party2.jpg
  dim_light/
    indoor1.jpg
  side_profile/
    candid1.jpg
```

---

## Running the qualitative benchmark

```bash
python -m bench.src.bench run \
    --fixtures bench/fixtures \
    --out bench/reports \
    --models bench/models
```

Or with the installed script (after `pip install -e bench/`):
```bash
phostro-bench run --fixtures bench/fixtures --out bench/reports --models bench/models
```

Output lands in `bench/reports/<timestamp>/`:
- `report.json` — machine-readable: per-photo detection counts, confidence scores, embedding hashes, processing times, category aggregates, suggested distance thresholds
- `report.md` — human-readable: summary tables per category, threshold bands, list of zero-detection photos

---

## Running the quantitative labeled benchmark

### 1. Folder-per-identity fast path

Create a local pack of face crops:

```text
bench/fixtures/wedding-face-crops/
  alex/
    alex_01.jpg
    alex_02.jpg
  jamie/
    jamie_01.jpg
  priya/
    priya_01.jpg
```

Generate the manifest:

```bash
python -m bench.src.bench init-labeled-manifest \
    --dataset-dir bench/fixtures/wedding-face-crops
```

### 2. Run the labeled eval

```bash
python -m bench.src.bench eval-labeled \
    --manifest bench/fixtures/wedding-face-crops/manifest.json \
    --out bench/reports \
    --models bench/models
```

Installed-script version:

```bash
phostro-bench init-labeled-manifest --dataset-dir bench/fixtures/wedding-face-crops
phostro-bench eval-labeled --manifest bench/fixtures/wedding-face-crops/manifest.json --out bench/reports --models bench/models
```

Output lands in `bench/reports/<timestamp>-<dataset>/`:
- `labeled_report.json` — threshold sweep, pair distances, confusion metrics, hard cases
- `labeled_report.md` — dataset summary, best-F1 threshold, conservative high-precision threshold, hardest positives and negatives

### 3. Manual manifest mode

If your sample is a face inside a larger photo, point at the photo and add a bbox in `manifest.json`.

See `bench/fixtures/labeled-template/manifest.template.json` for the exact schema.

---

## Reading the output

### Detection hit rate
Fraction of images where at least one face was found. Target: >0.90 on frontal photos, understand failures elsewhere.

### Zero-detection photos
Listed prominently in `report.md`. Inspect these manually — they reveal the hardest cases.

### Suggested thresholds
Derived from pairwise cosine distances between faces in the **same** image. Since group-shot faces are almost always different people, this distribution approximates the lower tail of "different person" distances. The harness suggests:
- **match** < p5 of this distribution
- **maybe** < p15

These are starting-point heuristics. After you have labeled same-person pairs, run a proper ROC curve to find the operating point.

### Precision / recall
`eval-labeled` sweeps over observed cosine-distance thresholds and reports:
- precision
- recall
- F1
- TP / FP / TN / FN

It highlights:
- the threshold with best F1
- the best recall threshold that still clears a configurable precision floor (`--target-precision`, default `0.95`)

### Interpreting cosine distance
- 0.0 = identical embedding
- ~0.2-0.4 = likely same person (tuned per model)
- ~0.5+ = different people (typical for SFace)

---

## GPU / acceleration (future work)

The harness uses `onnxruntime` CPU provider only. To accelerate:

```python
# In bench/src/detect.py and bench/src/embed.py:
PROVIDERS = ["CoreMLExecutionProvider", "CPUExecutionProvider"]  # macOS Apple Silicon
# or
PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]    # Linux/NVIDIA
```

Install the matching runtime: `onnxruntime-silicon` (macOS) or `onnxruntime-gpu` (CUDA).

---

## Directory layout

```
bench/
  fixtures/          # Drop event photos here, organized by category subdir
  models/            # ONNX model files (download separately — see models/README.md)
  src/
    detect.py        # RetinaFace detector wrapper
    embed.py         # SFace embedder wrapper
    align.py         # 5-point landmark face alignment
    bench.py         # CLI entry point
    labeled.py       # manifest loading + labeled dataset helpers
  reports/           # Output lives here (timestamped subdirs)
  pyproject.toml
  .python-version
```
