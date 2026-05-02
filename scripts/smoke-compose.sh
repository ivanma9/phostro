#!/usr/bin/env bash
# Lightweight compose smoke check.
# Verifies /health endpoints and asserts no rows in failed_photo_jobs_recent.
# Does NOT perform a real photo upload (R2 credentials not guaranteed in dev).
# Task 18 owns the full end-to-end upload smoke test.

set -euo pipefail

WEB_URL="${WEB_URL:-http://localhost:3000}"
WORKER_URL="${WORKER_URL:-http://localhost:8000}"
DB_URL="${DATABASE_URL:-postgresql://postgres:pw@localhost:54330/postgres}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"   # "ok" or "fail: <reason>"
  if [[ "$result" == "ok" ]]; then
    echo "  PASS  $label"
    ((PASS++)) || true
  else
    echo "  FAIL  $label — $result"
    ((FAIL++)) || true
  fi
}

echo ""
echo "=== phostro compose smoke ==="
echo ""

# 1. Worker /health
if curl -sf --max-time 5 "$WORKER_URL/health" > /dev/null 2>&1; then
  check "worker /health" "ok"
else
  check "worker /health" "fail: HTTP error or connection refused at $WORKER_URL"
fi

# 2. Web /api/health (Next.js)
if curl -sf --max-time 10 "$WEB_URL/api/health" > /dev/null 2>&1; then
  check "web /api/health" "ok"
else
  check "web /api/health" "fail: HTTP error or connection refused at $WEB_URL"
fi

# 3. No failed jobs in failed_photo_jobs_recent view
if command -v psql &> /dev/null; then
  FAILED_ROWS=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM failed_photo_jobs_recent;" 2>/dev/null || echo "ERROR")
  if [[ "$FAILED_ROWS" == "ERROR" ]]; then
    check "failed_photo_jobs_recent empty" "fail: could not query DB (is the view created? run make migrate)"
  elif [[ "$FAILED_ROWS" -gt 0 ]]; then
    echo ""
    echo "--- failed_photo_jobs_recent (first 20 rows) ---"
    psql "$DB_URL" -c "SELECT * FROM failed_photo_jobs_recent LIMIT 20;" 2>/dev/null || true
    echo "---"
    check "failed_photo_jobs_recent empty" "fail: $FAILED_ROWS failed job(s) found"
  else
    check "failed_photo_jobs_recent empty" "ok"
  fi
else
  echo "  SKIP  failed_photo_jobs_recent empty — psql not found, skipping DB check"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
