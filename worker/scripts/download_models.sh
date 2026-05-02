#!/usr/bin/env bash
# download_models.sh — download ONNX models for the phostro worker
#
# Usage:
#   ./worker/scripts/download_models.sh [--out DIR]
#
# Options:
#   --out DIR   Directory to write models into.
#               Default: <repo-root>/worker/models/
#               Relative paths are resolved from the current working directory.
#
# Downloads:
#   det_10g.onnx                          ~16 MB  InsightFace RetinaFace detection
#   face_recognition_sface_2021dec.onnx   ~37 MB  OpenCV Zoo SFace recognition
#
# Behaviour:
#   - Skips a file if it already exists AND its SHA-256 matches the expected hash.
#   - Re-downloads (with a warning) if the file exists but the hash is wrong.
#   - Exits non-zero on any hash mismatch after download or on curl failure.
#
# macOS compatibility: uses `shasum -a 256` (ships with macOS); works on bash 3.2+.
#
# Note: downloading det_10g.onnx requires pip-installing the `insightface` package
# into the active Python environment (no stable standalone download URL exists).
# This modifies whatever Python environment is currently active. Run inside a venv
# or a throwaway environment if you need isolation.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/worker/models"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --out=*)
      OUT_DIR="${1#--out=}"
      shift
      ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/p; }' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--out DIR]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "${OUT_DIR}"

# ── Expected hashes ───────────────────────────────────────────────────────────
DET_FILE="det_10g.onnx"
DET_SHA256="5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
# Source: extracted from the InsightFace buffalo_l pack via pip install insightface;
# see bench/models/README.md Option A.  Direct release URL is not published by
# InsightFace as a stable permalink, so we use the pip-extract route via Python
# (see download_det below).

SFACE_FILE="face_recognition_sface_2021dec.onnx"
SFACE_SHA256="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
SFACE_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"

# ── Helper: compute sha256 (macOS + Linux) ────────────────────────────────────
sha256_of() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  else
    echo "ERROR: neither shasum nor sha256sum found" >&2
    exit 1
  fi
}

# ── Helper: verify hash, exit on mismatch ─────────────────────────────────────
verify_hash() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(sha256_of "${file}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ERROR: SHA-256 mismatch for $(basename "${file}")" >&2
    echo "  expected: ${expected}" >&2
    echo "  got:      ${actual}" >&2
    exit 1
  fi
  echo "  sha256 OK: ${actual}"
}

# ── Helper: check if file is already present and valid ───────────────────────
already_valid() {
  local file="$1"
  local expected="$2"
  if [[ -f "${file}" ]]; then
    local actual
    actual="$(sha256_of "${file}")"
    if [[ "${actual}" == "${expected}" ]]; then
      return 0  # present + valid
    else
      echo "WARNING: $(basename "${file}") exists but hash mismatch — re-downloading" >&2
      echo "  expected: ${expected}" >&2
      echo "  got:      ${actual}" >&2
      return 1
    fi
  fi
  return 1  # not present
}

# ── Download det_10g.onnx via insightface pip extraction ──────────────────────
download_det() {
  local dest="${OUT_DIR}/${DET_FILE}"

  echo "==> ${DET_FILE}"
  if already_valid "${dest}" "${DET_SHA256}"; then
    echo "  skipped: hash matches"
    return
  fi

  echo "  downloading via insightface pip extraction..."
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found; required to extract det_10g.onnx from insightface" >&2
    exit 1
  fi

  # Install insightface quietly into the current environment (or a temp one).
  # We pipe to head to avoid flooding the terminal but still surface errors.
  python3 -m pip install --quiet insightface 2>&1 | head -10

  python3 - "${dest}" <<'PYEOF'
import sys, os, shutil

dest = sys.argv[1]

# Trigger model download by initialising FaceAnalysis (downloads to ~/.insightface/models/buffalo_l/)
import insightface
app = insightface.app.FaceAnalysis(providers=['CPUExecutionProvider'])
app.prepare(ctx_id=-1, det_size=(640, 640))

src = os.path.expanduser('~/.insightface/models/buffalo_l/det_10g.onnx')
if not os.path.exists(src):
    print(f"ERROR: expected model not found at {src}", file=sys.stderr)
    sys.exit(1)

shutil.copy(src, dest)
print(f"  copied {src} -> {dest}")
PYEOF

  echo "  verifying hash..."
  verify_hash "${dest}" "${DET_SHA256}"
  echo "  done: ${dest}"
}

# ── Download face_recognition_sface_2021dec.onnx via curl ─────────────────────
download_sface() {
  local dest="${OUT_DIR}/${SFACE_FILE}"

  echo "==> ${SFACE_FILE}"
  if already_valid "${dest}" "${SFACE_SHA256}"; then
    echo "  skipped: hash matches"
    return
  fi

  echo "  downloading from ${SFACE_URL} ..."
  curl --retry 3 --retry-delay 2 -fL -o "${dest}" "${SFACE_URL}"

  echo "  verifying hash..."
  verify_hash "${dest}" "${SFACE_SHA256}"
  echo "  done: ${dest}"
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo "Output directory: ${OUT_DIR}"
echo ""

download_sface
echo ""
download_det

echo ""
echo "All models present and verified."
