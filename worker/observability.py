"""
Observability setup for the Python worker.

Decision: the existing _emit_structured shim in main.py / api/ is NOT removed.
It already emits JSON to stderr and the structured shape is grep-friendly for
the canonical-event audit. This module adds a real structlog + Sentry stack
that new code can use and existing code can migrate to in a follow-up PR.

Usage:
    from worker.observability import get_logger
    log = get_logger(__name__)
    log.info("worker.runner.started", worker_id="w1")

Sentry is initialised ONLY in production (WORKER_ENV=production AND SENTRY_DSN
is set). Service tag is always "worker".
"""

import logging
import os
import sys
from typing import Any

import structlog


def _configure_structlog() -> None:
    """Configure structlog for JSON output in prod, pretty console in dev."""
    is_prod = os.environ.get("WORKER_ENV") == "production"

    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if is_prod:
        renderer: Any = structlog.processors.JSONRenderer()
        # Route to stderr (same as existing _emit_structured shim)
        stream = sys.stderr
    else:
        renderer = structlog.dev.ConsoleRenderer()
        stream = sys.stderr

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=stream),
        cache_logger_on_first_use=True,
    )


def _init_sentry() -> None:
    """Initialise Sentry SDK in production only."""
    dsn = os.environ.get("SENTRY_DSN")
    if os.environ.get("WORKER_ENV") != "production" or not dsn:
        return
    try:
        import sentry_sdk  # type: ignore[import]

        sentry_sdk.init(
            dsn=dsn,
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
        )
        with sentry_sdk.configure_scope() as scope:  # type: ignore[attr-defined]
            scope.set_tag("service", "worker")
    except Exception:  # noqa: BLE001
        # Sentry init failure must never crash the worker.
        pass


_configured = False


def _ensure_configured() -> None:
    global _configured  # noqa: PLW0603
    if not _configured:
        _configure_structlog()
        _init_sentry()
        _configured = True


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a structlog bound logger for the given module name."""
    _ensure_configured()
    return structlog.get_logger(name)
