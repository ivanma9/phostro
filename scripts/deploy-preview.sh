#!/usr/bin/env bash
# deploy-preview.sh — atomic Vercel deploy + alias update for the pocket-v0 preview.
#
# Why this exists: `vercel deploy` from CLI produces a fresh ephemeral URL
# (phostro-<hash>-asu-mare.vercel.app) but does NOT auto-update the branch
# alias (phostro-git-pocket-v0-asu-mare.vercel.app) or the user alias
# (phostro-ivanma9-asu-mare.vercel.app). Both stay pointing at whatever they
# pointed to before — usually a stale deploy.
#
# Real fix would be wiring Vercel's GitHub integration so `git push` auto-deploys.
# Until that's set up, run this script after any local code change you want
# reflected at the share URL.
#
# Usage:
#   bash scripts/deploy-preview.sh
#
# Requirements: vercel CLI, must be in repo root, must be authenticated.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BRANCH_ALIAS="phostro-git-pocket-v0-asu-mare.vercel.app"
USER_ALIAS="phostro-ivanma9-asu-mare.vercel.app"

echo "==> deploying to Vercel preview..."
DEPLOY_OUTPUT="$(vercel deploy --yes 2>&1)"
NEW_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://phostro-[a-z0-9]+-asu-mare\.vercel\.app' | head -1)"

if [ -z "$NEW_URL" ]; then
  echo "ERROR: could not parse new deploy URL. Full output:" >&2
  echo "$DEPLOY_OUTPUT" >&2
  exit 1
fi

NEW_HOST="${NEW_URL#https://}"
echo "==> deployed: $NEW_URL"

echo "==> aliasing $BRANCH_ALIAS → $NEW_HOST..."
vercel alias set "$NEW_HOST" "$BRANCH_ALIAS" >/dev/null

echo "==> aliasing $USER_ALIAS → $NEW_HOST..."
vercel alias set "$NEW_HOST" "$USER_ALIAS" >/dev/null

echo ""
echo "Live at:"
echo "  https://$BRANCH_ALIAS"
echo "  https://$USER_ALIAS"
