"""pytest configuration — makes the worktree root importable as `worker`."""
import sys
from pathlib import Path

# Used when running pytest without `pip install -e .` for fast iteration.
# With `pip install -e .`, setuptools handles the path and this is a no-op.
# The pyproject.toml [project] table enables `pip install -e .` as the other path.
_repo_root = Path(__file__).parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))
