.PHONY: up down stop logs migrate smoke smoke-e2e

# Start the full dev stack (rebuilds images on changes).
up:
	docker compose up --build

# Tear down all containers AND named volumes (wipes DB state).
# Use `make stop` to preserve DB data between sessions.
down:
	docker compose down -v

# Stop containers without removing volumes — preserves DB state.
stop:
	docker compose stop

# Stream logs from worker and dispatcher (the two background services).
logs:
	docker compose logs -f worker dispatcher

# Run pending DB migrations against the in-compose Postgres.
migrate:
	docker compose exec web pnpm db:migrate

# Lightweight smoke check: verify /health endpoints + assert no failed jobs.
# Does NOT do a real upload (needs R2 credentials). Use `make smoke-e2e` for the
# full pipeline.
smoke:
	./scripts/smoke-compose.sh

# Phase 3 Task 18 — full end-to-end smoke. Spins up a local fixture HTTP
# server, inserts real DB rows, exercises real ONNX inference in the worker,
# verifies face_detections + face_clusters appear, then verifies the failure
# path (retry → dead-letter).
#
# Prerequisites:
#   - Postgres reachable at DATABASE_URL (default: postgres://postgres:postgres@localhost:54329/postgres)
#   - Worker running at WORKER_URL (default: http://localhost:8000) with WORKER_SECRET=ci-test-secret
#
# Easiest worker startup:
#   WORKER_SECRET=ci-test-secret WORKER_MODELS_DIR=$(PWD)/bench/models \
#     worker/.venv/bin/uvicorn worker.main:app --host 127.0.0.1 --port 8000
smoke-e2e:
	pnpm tsx scripts/smoke-e2e.ts
