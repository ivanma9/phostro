"""
ONNX Runtime execution providers for the worker.

This is the single configuration seam for Phase-4+ hardware acceleration.
To enable GPU (CUDA): PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]
To enable Apple Silicon (CoreML): PROVIDERS = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
CPU is always listed last as a fallback.
"""

PROVIDERS: list[str] = ["CPUExecutionProvider"]
