# Preview deploy runbook (founder dogfood)

**Date:** 2026-05-06
**Goal:** Get Pocket v0 (`pocket-v0` branch) end-to-end on free tiers so the founder can run the actual dogfood and replace the stub at `docs/postmortems/pocket-v0-self-use.md` with real numbers.

**Not goals:** Public beta. Production hardening. Custom domain. v1 work. None of that lives here — this is the smallest path to a clickable URL with working recognition.

**Estimated wall time:** ~4 hours, mostly waiting on DNS-ish things (Supabase project provision, Fly machine boot, Vercel build).

**Cost:** $0. Every service used has a free tier that fits one founder + one group chat.

---

## What you need before starting

- A GitHub account (you have one — `ivanma9/phostro` is up)
- Cloudflare account (R2 free tier: 10 GB storage, no egress fees)
- Supabase account (free tier: 500 MB Postgres + pgvector built in)
- Fly.io account (free trial: 3 shared-cpu-1x machines, fine for the worker)
- Vercel account (free tier: hobby plan)
- Resend account (free tier: 100 emails/day, sandbox sender works for self-testing)
- Local CLIs: `vercel`, `flyctl` (`brew install flyctl`), `supabase` (optional — `psql` is enough)

You're solo and these are all the founder's accounts. No team setup needed.

---

## Step 1 — Supabase prod-isolated DB (~15 min)

The dev DB cannot be reused. The README explicitly says "**never** the production project DB."

1. https://supabase.com/dashboard → New project. Name `phostro-preview`. Region: same as your Vercel region (default: `iad1` / us-east).
2. Wait for provisioning (~2 min).
3. Project Settings → Database → **Connection pooling** → copy the "Transaction" pooler URL. It looks like `postgresql://postgres.xxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres`. **This** is your `DATABASE_URL`. Do not use the direct connection URL — Vercel needs the pooler.
4. SQL Editor → run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
   Verify: `\dx vector` returns one row.
5. Apply migrations from your local checkout:
   ```bash
   cd /Users/ivanma/Desktop/asumare/phostro
   git checkout pocket-v0
   DATABASE_URL='<paste pooler URL>' pnpm db:migrate
   ```
   Verify: `psql "$DATABASE_URL" -c "\dt"` lists `users`, `events`, `event_members`, `magic_link_tokens`, `photos`, `photo_jobs`, `face_clusters`, `face_detections`, `share_links`.

**Stop here if migrations fail.** Don't proceed without a clean migration.

---

## Step 2 — Cloudflare R2 preview bucket (~10 min)

Separate from your dev bucket. Free tier covers up to 10 GB; one grad-photo dogfood will fit easily.

1. Cloudflare dashboard → R2 → **Create bucket**. Name `phostro-photos-preview`. Location hint: `ENAM` (matches Supabase us-east).
2. **Do not** enable the public dev URL. Photos must stay behind presigned URLs.
3. R2 → **Manage R2 API tokens** → Create token. Permissions: **Object Read & Write**, scoped to `phostro-photos-preview`. TTL: 90 days. Copy `Access Key ID`, `Secret Access Key`, `Account ID`.
4. Bucket → Settings → CORS Policy. Vercel preview URLs are stable per branch (`https://phostro-git-pocket-v0-<username>.vercel.app`), so add both that pattern and the production URL you'll get later:
   ```json
   [{
     "AllowedOrigins": [
       "http://localhost:3000",
       "https://phostro-git-pocket-v0-ivanma9.vercel.app",
       "https://phostro.vercel.app"
     ],
     "AllowedMethods": ["GET", "PUT", "HEAD"],
     "AllowedHeaders": ["*"],
     "ExposeHeaders": ["ETag"],
     "MaxAgeSeconds": 3600
   }]
   ```
   You'll learn the exact Vercel preview URL after Step 4 — come back and update if it doesn't match.
5. Bucket → Settings → **Object Lifecycle Rules** → "Delete after 1 day" for the whole bucket. The README has this for dev; preview is the same posture.

Verify with a `curl` round-trip later (Step 5 smoke).

---

## Step 3 — Fly.io worker (~45 min, longest step)

The worker is CPU-only Python+ONNX. Fly.io free tier gives you 3 shared-cpu-1x machines; one is plenty.

1. Download the ONNX models locally (the worker bakes these into the image):
   ```bash
   cd worker
   bash scripts/download_models.sh
   ls -la models/
   ```
   Should show `det_10g.onnx` (~16 MB) and `face_recognition_sface_2021dec.onnx` (~37 MB).

2. Install the Fly CLI if you haven't: `brew install flyctl`. Then:
   ```bash
   flyctl auth login
   ```

3. Init the app from `worker/`:
   ```bash
   cd worker
   flyctl launch --no-deploy --copy-config --name phostro-worker-preview
   ```
   It'll generate `worker/fly.toml`. When it asks: no Postgres (you have Supabase), no Redis, no deploy yet. Keep `auto_stop_machines = true` and `auto_start_machines = true` — the worker will scale-to-zero between sessions, which is the correct posture for preview.

4. Edit `worker/fly.toml` to bake models and set primary region. Add:
   ```toml
   primary_region = "iad"

   [build]
     dockerfile = "../Dockerfile"   # or wherever build context lands; flyctl launch usually points correctly

   [[services]]
     internal_port = 8000
     protocol = "tcp"
     auto_stop_machines = true
     auto_start_machines = true
     min_machines_running = 0

     [[services.ports]]
       port = 80
       handlers = ["http"]

     [[services.ports]]
       port = 443
       handlers = ["tls", "http"]
   ```
   The actual `flyctl launch` output may already have most of this — just verify region and scale-to-zero.

5. Set worker secrets:
   ```bash
   # WORKER_SECRET — same value you'll set in Vercel later
   openssl rand -hex 32 | tee /tmp/worker-secret
   flyctl secrets set WORKER_SECRET="$(cat /tmp/worker-secret)"
   flyctl secrets set WORKER_ENV=production
   # Skip Sentry for preview unless you already have a DSN
   ```

6. Deploy:
   ```bash
   flyctl deploy
   ```
   First build takes ~5 minutes (downloading deps, copying models). Subsequent deploys are faster.

7. Get the worker URL:
   ```bash
   flyctl status | grep -i hostname
   # or
   echo "https://phostro-worker-preview.fly.dev"
   ```
   Verify health:
   ```bash
   curl https://phostro-worker-preview.fly.dev/health
   # → {"status":"ok"}
   ```

8. Verify cold-start latency (the worker scales to zero):
   ```bash
   sleep 60  # wait for it to scale down
   time curl https://phostro-worker-preview.fly.dev/health
   ```
   Expect ~5-15s on first hit after sleep. Acceptable for preview; document if it's worse.

**Save the WORKER_SECRET value** — you'll paste it into Vercel in Step 4.

---

## Step 4 — Vercel preview deploy (~30 min)

1. Link the repo:
   ```bash
   cd /Users/ivanma/Desktop/asumare/phostro
   vercel login   # if not already
   vercel link    # accept defaults; pick "ivanma9" scope
   ```
   This creates `.vercel/project.json` (don't commit it; it's gitignored by default).

2. In the Vercel dashboard for the linked project → Settings → Environment Variables. Add for **Preview** environment (not Production yet):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Supabase pooler URL from Step 1 |
   | `SESSION_SECRET` | `openssl rand -hex 32` (≥32 chars) |
   | `APP_URL` | `https://phostro-git-pocket-v0-ivanma9.vercel.app` (you'll confirm the exact URL after first deploy — come back and fix) |
   | `RESEND_API_KEY` | from Resend dashboard |
   | `R2_ACCOUNT_ID` | from Step 2 |
   | `R2_ACCESS_KEY_ID` | from Step 2 |
   | `R2_SECRET_ACCESS_KEY` | from Step 2 |
   | `R2_BUCKET` | `phostro-photos-preview` |
   | `WORKER_URL` | `https://phostro-worker-preview.fly.dev` |
   | `WORKER_SECRET` | same value as Fly secret in Step 3 |

   Do NOT set these for Production — preview only.

3. Add yourself as a verified Resend recipient. Resend's `onboarding@resend.dev` sandbox sender only delivers to verified emails. https://resend.com/api-keys → switch to "Domains" or "Audiences" → verify `ivanma819@gmail.com` (or whatever you sign in with). Without this, magic-link emails will silently 200 but never arrive.

4. Push the branch — Vercel auto-deploys on push to a non-default branch:
   ```bash
   git push origin pocket-v0
   ```
   Or trigger explicitly:
   ```bash
   vercel --target preview
   ```
   First build takes ~3-5 minutes.

5. Open the URL Vercel prints. Should look like `https://phostro-git-pocket-v0-ivanma9.vercel.app`. **If the URL differs from what you put in `APP_URL` and the R2 CORS origin**, go back to Step 2 and Step 4.2 and fix both, then redeploy.

---

## Step 5 — Smoke test (~30 min)

1. Open the preview URL. Tap "Sign in." Enter your verified Resend recipient email. Check inbox for magic link.
2. After sign-in, tap "+ New Pocket." Name it "smoke test 2026-05-06." Take a selfie or upload a clean front-facing photo. Verify enrollment doesn't 500.
3. Tap "Copy share link." Paste it into a browser private tab. You should land on `/p/<token>` with a photo picker.
4. From the private tab, upload 3-5 photos that include faces (use phone camera roll on your phone if testing across devices).
5. Wait ~30-60 seconds (worker cold start + detection + clustering).
6. Reload your owner pocket page. The **You** feed should populate with photos that match your enrolled face.
7. Check the worker logs:
   ```bash
   flyctl logs -a phostro-worker-preview
   ```
   Look for `worker.dispatch.success` lines. If you see `worker.dispatch.failed` or `worker.detect.r2_fetch_failed`, R2 CORS or `WORKER_URL` is misconfigured.

8. Check the dispatcher inside Vercel — open Vercel dashboard → Logs → filter the `pocket-v0` deployment. Search for `photo_job.enqueued` and `worker.dispatch.success`. Both should appear.

**If the You feed populates with the right faces, you have a working preview deploy.** Move to the actual dogfood.

---

## Step 6 — Run the actual dogfood

1. Make a real pocket. Name it after the actual gathering ("ivan grad 2026").
2. Take a real selfie. Don't fake-test with a stock photo.
3. Send the share link to your grad chat. Add one line of context: "Drop any photos with me in them — they auto-route to my phone."
4. Wait 1-3 days.
5. Open the pocket. Count:
   - Contributors who opened the link (you can see this in `share_links.upload_count` via Supabase SQL editor)
   - Total photos contributed (`SELECT count(*) FROM photos WHERE event_id = '<pocket id>'`)
   - Photos in the **You** feed
   - Real photos of you in there (manual count)
   - Photos you noticed missing — false negatives matter for the postmortem
6. Replace the stub at `docs/postmortems/pocket-v0-self-use.md` with the actual numbers. Be honest in the "What broke / felt wrong" section. List the single biggest friction first.

**That postmortem is the input to v1 prioritization.** With real friction data, the 14 v1 exit criteria sort themselves.

---

## Common failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Magic-link email never arrives | Resend recipient not verified, OR `RESEND_API_KEY` wrong env scope | Verify recipient in Resend dashboard; check Vercel env var was set for Preview, not Production |
| Photo upload 502 from `/p/[token]/init` | R2 CORS doesn't allow the Vercel preview origin | Update R2 CORS allowed origins to match the actual deployed URL exactly |
| Photos uploaded but never appear in You feed | Worker not picking up jobs | Check `flyctl logs -a phostro-worker-preview`; restart with `flyctl machines restart`; verify `WORKER_URL` + `WORKER_SECRET` match between Vercel and Fly |
| `pgvector` errors on signup | Extension not enabled | Re-run `CREATE EXTENSION IF NOT EXISTS vector;` in Supabase SQL editor |
| First request after idle takes 15+ seconds | Fly scale-to-zero cold start | Expected. For dogfood it's fine; if it's intolerable later, set `min_machines_running = 1` in `fly.toml` (~$2/mo) |
| Share link returns 410 immediately | Token already revoked or expired (default 7-day TTL inherited from `events.lifespan_days`) | Mint a new share link from the owner pocket page |
| Owner pocket page shows "you must enroll" after signup | Enrollment didn't write `users.face_embedding` | Check `flyctl logs` for `/enroll` errors — usually a face-quality reject; retake the selfie |

---

## Teardown when you're done

If the dogfood is over and you don't want preview infra running:

```bash
# Worker
flyctl apps destroy phostro-worker-preview

# Supabase project: dashboard → Settings → Pause project (free) or delete
# R2 bucket: dashboard → delete contents → delete bucket
# Vercel: project → Settings → Delete project (or just unlink: rm -rf .vercel)
```

Total ongoing cost while idle: $0 (Fly scale-to-zero, Supabase free, R2 free, Vercel free).

---

## What this runbook intentionally does NOT cover

- Custom domain (`mail.phostro.com` or `phostro.app`) — that's v1 Task 14b territory.
- BIPA Illinois geofence — only one user (you), no exposure.
- Sentry production wiring — Vercel + Fly logs are enough for one user.
- Cleanup verification cron — nothing in prod yet to clean.
- Multi-region, real backups, status page, on-call docs — beta concerns, not dogfood concerns.

If the dogfood postmortem says "yes, this works, ship to non-founder beta," start the v1 plan (`docs/plans/2026-05-06-pocket-v1-implementation.md`) which covers all of the above.

If the dogfood postmortem says "no, recognition isn't solving it," tear down per the section above and re-open `/office-hours`.
