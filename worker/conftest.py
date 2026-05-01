"""pytest configuration — makes the worktree root importable as `worker`."""
import sys
from pathlib import Path

# Add the parent of `worker/` to sys.path so `import worker.recognition` works.
# The worker/ directory itself is the package root.
_repo_root = Path(__file__).parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))
