# Stage 1: build — install Python deps into a prefix we can copy
FROM python:3.11-slim AS builder

WORKDIR /install

COPY requirements.txt .

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
COPY worker/recognition/ ./worker/recognition/
COPY worker/config/ ./worker/config/

# Models are NOT baked in — mount at runtime via WORKER_MODELS_DIR.
# Task 14 decides between volume-mount vs runtime-download vs bake-into-image.
ENV WORKER_MODELS_DIR=/models

# Non-root user for least-privilege runtime
RUN useradd -m -u 1000 worker
USER worker

EXPOSE 8000

CMD ["uvicorn", "worker.main:app", "--host", "0.0.0.0", "--port", "8000"]
