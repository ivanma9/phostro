"""
CI audit: every canonical Python event name from the Phase-3 spec must appear
at least once in the worker source (worker/api/, worker/main.py).

If a refactor renames an event string this test fails and CI catches the drift.
"""

import os
from pathlib import Path

import pytest

WORKER_ROOT = Path(__file__).parent.parent

# Source paths to scan
SOURCE_ROOTS = [
    WORKER_ROOT / "api",
    WORKER_ROOT / "main.py",
]


def collect_py_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    files: list[Path] = []
    for entry in root.rglob("*.py"):
        files.append(entry)
    return files


def read_corpus() -> str:
    chunks: list[str] = []
    for root in SOURCE_ROOTS:
        for f in collect_py_files(root):
            try:
                chunks.append(f.read_text(encoding="utf-8"))
            except OSError:
                pass
    return "\n".join(chunks)


# Canonical event names from Phase-3 spec (Task 8 / startup)
CANONICAL_EVENTS = [
    "worker.startup.model_load_failed",
    "worker.startup.missing_secret",
    "worker.detect.r2_fetch_failed",
    "worker.detect.decode_failed",
    "worker.detect.inference_failed",
]

CORPUS = read_corpus()


@pytest.mark.parametrize("event_name", CANONICAL_EVENTS)
def test_canonical_event_present(event_name: str) -> None:
    """Each canonical event name must appear in the worker source."""
    assert event_name in CORPUS, (
        f"Canonical event '{event_name}' not found in worker source. "
        "Check that the emitting code was not accidentally renamed."
    )
