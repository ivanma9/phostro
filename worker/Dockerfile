# Stage 1: build — install Python deps into a prefix we can copy
FROM python:3.11-slim AS builder

WORKDIR /install

COPY worker/requirements.txt .

# Install to an isolated prefix so we can COPY only site-packages into the final image
RUN pip install --no-cache-dir --prefix=/install/deps -r requirements.txt


# Stage 2: runtime — lean image, non-root user, no build tools
FROM python:3.11-slim AS runtime

# Copy installed packages from the builder stage
COPY --from=builder /install/deps /usr/local

WORKDIR /app

# Copy application code (recognition package, config, entrypoint)
COPY worker/__init__.py ./worker/__init__.py
COPY worker/main.py ./worker/main.py
COPY worker/api/ ./worker/api/
COPY worker/recognition/ ./worker/recognition/
COPY worker/config/ ./worker/config/

# Models baked into the image (Task 14 decision: ~53 MB total, image stays under 500 MB).
# Run worker/scripts/download_models.sh first to populate worker/models/ locally.
# In dev, docker-compose mounts ./bench/models:/models:ro — that mount takes
# precedence and lets you swap models without rebuilding.
ENV WORKER_MODELS_DIR=/models

# Non-root user for least-privilege runtime
RUN useradd -m -u 1000 worker

# Bake models — owned by root, readable by worker (defensive: no write access)
COPY worker/models /models

USER worker

EXPOSE 8000

CMD ["uvicorn", "worker.main:app", "--host", "0.0.0.0", "--port", "8000"]
