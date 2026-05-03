"""
AST-equivalence test: bench/src/ vs worker/recognition/.

Verifies that the computational logic is byte-identical between bench and worker
by comparing AST dumps after stripping known-allowed structural differences.

Allowed differences per file:
  detect.py / embed.py:
    - Module-level docstrings (bench and worker docstrings differ in the
      "Copied verbatim..." sentence)
    - `from .providers import PROVIDERS` ImportFrom (worker only)
    - `PROVIDERS = [...]` Assign (bench only)
    - load_detector / load_embedder FunctionDef bodies (error message wording
      differs: worker adds WORKER_MODELS_DIR hint per I3; logic is identical)
  align.py:
    - Module-level docstring only (worker has extra "Copied verbatim..." sentence)

Any drift in detect/embed/align *computational* logic will fail this test.
"""
from __future__ import annotations

import ast
import copy
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent  # .../phostro/


def _is_module_docstring(node: ast.AST) -> bool:
    """True if node is a top-level Expr wrapping a string Constant (module docstring)."""
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _is_providers_import(node: ast.AST) -> bool:
    """True if node is `from .providers import PROVIDERS` (or relative variant)."""
    return (
        isinstance(node, ast.ImportFrom)
        and node.names
        and any(alias.name == "PROVIDERS" for alias in node.names)
    )


def _is_providers_assign(node: ast.AST) -> bool:
    """True if node is `PROVIDERS = [...]`."""
    return (
        isinstance(node, ast.Assign)
        and node.targets
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "PROVIDERS"
    )


def _is_loader_funcdef(node: ast.AST, names: set[str]) -> bool:
    """True if node is a FunctionDef whose name is in `names`."""
    return isinstance(node, ast.FunctionDef) and node.name in names


def _strip_detect_embed(tree: ast.Module) -> ast.Module:
    """
    Strip allowed differences from detect.py or embed.py ASTs before comparison.

    Removed:
      - module docstring (first body element if it's a string Expr)
      - PROVIDERS import (worker) or PROVIDERS assign (bench)
      - load_detector / load_embedder FunctionDef (error message wording differs)
    """
    tree = copy.deepcopy(tree)
    loader_names = {"load_detector", "load_embedder"}
    tree.body = [
        node
        for node in tree.body
        if not _is_module_docstring(node)
        and not _is_providers_import(node)
        and not _is_providers_assign(node)
        and not _is_loader_funcdef(node, loader_names)
    ]
    return tree


def _strip_align(tree: ast.Module) -> ast.Module:
    """Strip module docstring from align.py AST before comparison."""
    tree = copy.deepcopy(tree)
    tree.body = [node for node in tree.body if not _is_module_docstring(node)]
    return tree


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text())


def test_detect_parity() -> None:
    """detect.py computational logic must be identical between bench and worker."""
    bench = _parse(REPO_ROOT / "bench" / "src" / "detect.py")
    worker = _parse(REPO_ROOT / "worker" / "recognition" / "detect.py")

    bench_stripped = ast.dump(_strip_detect_embed(bench))
    worker_stripped = ast.dump(_strip_detect_embed(worker))

    assert bench_stripped == worker_stripped, (
        "detect.py has drifted between bench/src and worker/recognition.\n"
        "Fix the drift, then rerun: pytest worker/tests/test_bench_worker_parity.py"
    )


def test_embed_parity() -> None:
    """embed.py computational logic must be identical between bench and worker."""
    bench = _parse(REPO_ROOT / "bench" / "src" / "embed.py")
    worker = _parse(REPO_ROOT / "worker" / "recognition" / "embed.py")

    bench_stripped = ast.dump(_strip_detect_embed(bench))
    worker_stripped = ast.dump(_strip_detect_embed(worker))

    assert bench_stripped == worker_stripped, (
        "embed.py has drifted between bench/src and worker/recognition.\n"
        "Fix the drift, then rerun: pytest worker/tests/test_bench_worker_parity.py"
    )


def test_align_parity() -> None:
    """align.py must be identical between bench and worker (docstring-only difference)."""
    bench = _parse(REPO_ROOT / "bench" / "src" / "align.py")
    worker = _parse(REPO_ROOT / "worker" / "recognition" / "align.py")

    bench_stripped = ast.dump(_strip_align(bench))
    worker_stripped = ast.dump(_strip_align(worker))

    assert bench_stripped == worker_stripped, (
        "align.py has drifted between bench/src and worker/recognition.\n"
        "Fix the drift, then rerun: pytest worker/tests/test_bench_worker_parity.py"
    )
