.PHONY: up down stop logs migrate smoke

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
# Does NOT do a real upload (needs R2 credentials). Task 18 owns the full E2E smoke.
smoke:
	./scripts/smoke-compose.sh
