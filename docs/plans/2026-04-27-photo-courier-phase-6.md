# Photo Courier — Phase 6 Implementation Plan

> **⚠ Deferred — host-broadcast product line.** Active development is on **Pocket v0 / v1** (receiver-pooled product). See `docs/plans/2026-05-02-pocket-v0-implementation.md`. This phase plan is preserved for **Pocket Platform v2** — the original host-broadcast model — which is on hold pending Pocket v0 self-use results. Do not execute tasks here without re-confirming the product direction. Salvageable subsets for Pocket v1 are noted at the end of this document.

**Date:** 2026-04-27
**Status:** Draft, expanded from outline in `2026-04-27-photo-courier-implementation.md`

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

---

## End state of Phase 6

A real event can be created, populated, retrieved from, and reach end-of-life entirely without manual operator intervention. Specifically:

- Email notifications for first-match, new-photo deltas, T-2d, and T-2h are dispatched via Resend, debounced, deduped, respect per-user preferences, and respect quiet hours.
- A daily expiry cron deletes expired event photos in R2, embeddings + clusters in pgvector, photo rows, jobs, views, saves, and notification ledger entries — and a follow-up verification cron re-checks every recently-expired event and pages on-call if any artifact survives.
- Host can extend an active event once (+7 days) before expiry and download a single zip archive of the event before expiry (host archive lives in Phase 5; this phase wires the email reminder for it).
- A privacy policy, terms of service, and explicit enrollment consent modal exist, are versioned, and are recorded against each user's consent acceptance.
- Illinois is geofenced at signup with a "coming soon" page; bypass attempts via VPN are mitigated with a soft re-check at enrollment.
- Beta launch checklist is satisfied: error reporting (Sentry), uptime monitor (BetterStack or equivalent), log retention policy, status/incident doc, on-call runbook, and a self-serve data-deletion handler for users.
- Five real beta events have run end-to-end through cleanup with cleanup verification green and Sentry signal triaged daily.

---

## Exit criteria (numbered, testable)

1. **Notifications dispatch reliably.** A test event with one enrolled attendee triggers a first-match email within 5 minutes of the matching upload, recorded in `notification_deliveries` with `status='sent'` and a Resend message ID; integration test asserts no duplicate sends within the dedupe window.
2. **Notifications respect preferences.** A user who toggles off "new photos" in their preferences receives no `new_photos` email but still receives `expiry_reminder` (transactional, non-opt-out). Verified by Vitest integration test against `user_notification_preferences` and the dispatcher's pre-send filter.
3. **Quiet hours hold.** A T+5min match notification scheduled inside a user's quiet hours is rescheduled to the next allowed window (or, for the T-2h expiry case, bypasses quiet hours per the urgent-override rule) — verified by unit tests on the scheduler's `nextDispatchAt` computation.
4. **Expiry cron deletes everything.** For an event whose `expires_at < now()`, after the cron runs there are zero rows in `photos`, `photo_jobs`, `face_detections`, `face_clusters`, `photo_views`, `photo_saves`, and zero R2 objects under the event prefix. Verified by integration test with a seeded event and a moto/MinIO R2 mock, and by the verification cron in production.
5. **Cleanup verification fails loudly.** A simulated partial cleanup (delete DB rows but skip R2) causes the verification cron to record a `cleanup_verification_failures` row and emit a Sentry alert at `error` severity within one cron interval. Tested by deliberately injecting a leak and asserting the alert fires.
6. **Geofence blocks Illinois at signup.** A request originating from an Illinois IP (mocked via `CF-IPCountry` + `CF-IPCity` or test fixture) hitting `/auth/request` returns the "coming soon" page and creates no `magic_link_tokens` row. Verified by integration test with a fixture IP map.
7. **Geofence has a documented rollback.** A feature flag `GEOFENCE_IL_ENABLED` can be flipped via env var to disable enforcement within 5 minutes (no redeploy). Verified by manual flip + smoke test in staging.
8. **Privacy + consent gates enrollment.** The enrollment endpoint refuses any frame upload from a user without an active `consent_acceptances` row for the current `consent_version`. Integration test asserts 403 + audit log entry.
9. **Self-serve deletion works end-to-end.** A signed-in user clicks "Delete my account": their `face_embedding`, `consent_acceptances`, `event_members` rows, photos they uploaded (per host policy), and `notification_deliveries` are purged within the documented SLA, the event is recalculated, and an immutable `deletion_requests` audit row is written. Verified by Playwright e2e + Vitest cascade test.
10. **Beta launch checklist closed.** Sentry receives a synthetic error from prod within 60s; uptime monitor pings `/api/health` every 60s and pages on three consecutive failures; log retention is set to ≥30 days in the chosen platform; on-call runbook exists at `docs/ops/on-call.md`; status page (or incident doc) URL is shared with beta hosts. All boxes checked in the launch checklist task.
11. **Tear-down works.** A `pnpm tsx scripts/teardown-beta-event.ts <eventId>` command takes a beta event from active to fully purged, with a confirmation prompt and a dry-run flag, used at least once during beta.

---

## Explicitly deferred

Out of scope for Phase 6 — surface here so they don't slip in:

- Push notifications (PWA push is fragile on iOS Safari; revisit post-beta)
- SMS notifications and SMS-based magic links
- Multi-region data residency (single-region us-east at beta)
- SOC 2, HIPAA, or formal compliance audits
- Bug bounty program (post-launch, >1K users)
- PhotoDNA / Safer ingest moderation (manual moderation acceptable at beta scale per design doc)
- Batched digest emails (e.g., "your weekly recap") — beta uses immediate + debounced only
- Localization of email copy beyond English
- Granular per-event notification opt-outs (beta is per-user only)
- Self-serve "export all my data" (GDPR portability) — manual handler at beta, automate post-beta
- Cookie banners — not required for transactional auth-only flows; revisit if marketing pages added

---

## Open questions

These should be answered before or during the relevant task. Answers go in the design doc, not this plan.

1. **Quiet-hours timezone source.** Capture user IANA timezone at signup or infer from browser? Default window? Does the T-2h expiry email override quiet hours, or get bumped (and risk missing the deadline)? Working assumption in this plan: capture timezone at signup, default 22:00–08:00, urgent expiry reminders override.
2. **Geofence provider.** Cloudflare `CF-IPCountry` + `CF-IPCity` is free and on-path; MaxMind GeoIP2 is more accurate but adds dependency. Working assumption: Cloudflare headers in front of Vercel; falls back to MaxMind only if Vercel-direct.
3. **Cleanup verification cadence and remediation.** Run verification inline after each delete pass, or as a separate cron 1 hour later (eventual consistency safety)? Working assumption: both — inline assertion + delayed re-verify cron.
4. **Resend sending domain.** Verified subdomain (`mail.phostro.com` with SPF/DKIM/DMARC) provisioned in this phase or pre-existing? Working assumption: provisioned in Task 1 of this phase.
5. **Status page vs incident doc at beta.** ~5 events, ~50 users — full status page (BetterStack/Statuspage) overkill? Working assumption: shared Notion incident doc + BetterStack uptime monitor that emails on failure; upgrade to status page post-beta.

---

## Cross-phase contracts assumed

This phase touches data and code produced by every prior phase. Naming the contracts here so a Phase 6 task that breaks them is caught immediately.

- **Phase 1 (auth + events):** `users.id`, `users.contact`, `events.id`, `events.expires_at`, `events.host_user_id`, `event_members(event_id, user_id, role)`. Phase 6 adds `users.timezone`, `users.geofence_state` and consent/preferences tables — none mutate Phase 1 columns.
- **Phase 2 (upload + R2):** `photos.id`, `photos.event_id`, `photos.uploader_user_id`, `photos.r2_key_original`, `photos.r2_key_preview`. The R2 bucket layout (assumed `events/<eventId>/...`) is the contract the cleanup task relies on for prefix-based deletion. If Phase 2 used a different layout, cleanup must adapt — call this out before starting Task 5.
- **Phase 3 (recognition pipeline):** `photo_jobs`, `face_detections.photo_id`, `face_clusters.event_id`. Cleanup deletes these in foreign-key-safe order. The first-match notification is triggered by Phase 4's matching pipeline inserting a `user_event_matches` row with `band='match'` — see Task 4 (`first-match.ts`) for the dispatch contract.
- **Phase 4 (enrollment + matching):** `users.face_embedding`, `users.face_enrolled_at`, `consent_acceptances` (created in Phase 4 Task 1 with the full `document`/`version` column shape; Phase 6 Task 7 only adds the `privacy_policy` and `terms_of_service` document types and the consent-modal flow for them). The enrollment endpoint is augmented in Task 6 to read the consent gate; Phase 4 must not have hardcoded a bypass.
- **Phase 5 (gallery + downloads):** `photo_views`, `photo_saves`, host archive zip endpoint. The "new photos since last save" delta query Phase 5 built powers the daily new-photos email — Phase 6 reuses it as a function, doesn't reimplement.

If any contract above is missing or differently shaped when Phase 6 starts, **stop and reconcile** before adding tasks on top.

---

## Tasks

### Task 1: Resend domain verification + email infrastructure baseline

**Files:**
- Create: `lib/email/client.ts` (extracted from Phase 1 `lib/email.ts`), `lib/email/templates/index.ts`, `lib/email/templates/_layout.tsx`
- Modify: `lib/email.ts` (delegate to new client), `.env.example`, `docs/ops/email-domain.md` (operator notes)

**Step 1:** Provision the Resend sending domain. In Resend dashboard add `mail.phostro.com` (or chosen subdomain). Add the SPF, DKIM (3 CNAMEs), and DMARC records to the DNS provider. Wait for verification.

**Step 2:** Update `RESEND_FROM_ADDRESS` env var to `Photo Courier <noreply@mail.phostro.com>` in `.env.example` and Vercel preview/prod. Document the rotation procedure in `docs/ops/email-domain.md`.

**Step 3:** Refactor `lib/email.ts` (Phase 1 magic-link wrapper) into `lib/email/client.ts` exposing a single `sendEmail({ to, subject, react, text, tag, idempotencyKey })` API. Tags are required and used for Resend analytics + downstream filtering.

**Step 4:** Add a base React Email layout `_layout.tsx` (header, footer, unsubscribe link placeholder, "this is a transactional/operational email" footer where required by CAN-SPAM).

**Step 5:** Update `lib/email.ts` to delegate to the new client; keep the magic-link export so Phase 1 keeps compiling.

**Expected output:** All existing email tests still pass; one new unit test asserts `sendEmail` enforces non-empty `tag` and propagates `idempotencyKey` to Resend.

**Verification:** `pnpm test lib/email`; manually send a test from a Vercel preview to a real inbox; check Resend dashboard shows tag and idempotency key.

---

### Task 2: Schema — `user_notification_preferences` + `notification_deliveries`

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/00XX_user_notification_preferences.sql`, `db/migrations/00XX_notification_deliveries.sql`

**Step 1:** Add `userNotificationPreferences` table:
```
user_notification_preferences
  user_id (uuid, pk, fk users.id on delete cascade)
  first_match_enabled (bool, default true)
  new_photos_enabled (bool, default true)
  expiry_reminders_enabled (bool, default true)  -- transactional; UI warns toggling off
  host_event_summary_enabled (bool, default true)
  quiet_hours_start (time, default '22:00')
  quiet_hours_end (time, default '08:00')
  timezone (text, default 'UTC')                  -- IANA
  updated_at (timestamp, default now())
```

**Step 2:** Add `notificationDeliveries` table:
```
notification_deliveries
  id (uuid, pk)
  user_id (uuid, fk users.id on delete cascade)
  event_id (uuid, nullable, fk events.id on delete set null)
  kind (text enum: first_match | new_photos | expiry_t_minus_2d | expiry_t_minus_2h | host_event_summary | host_extension_offer | post_event_replan)
  dedupe_key (text not null)                       -- e.g., "first_match:user:event"
  scheduled_for (timestamp not null)
  sent_at (timestamp)
  status (text enum: pending | sent | failed | suppressed_quiet_hours | suppressed_preference | suppressed_dedupe)
  resend_message_id (text)
  error (text)
  created_at (timestamp, default now())
  unique (user_id, dedupe_key)                     -- hard dedupe
```

**Step 3:** Add IANA timezone column to users if not already present:
```
alter table users add column if not exists timezone text not null default 'UTC';
```

**Step 4:** Generate + apply migrations: `pnpm db:generate && pnpm db:migrate`. Verify in Drizzle Studio.

**Step 5:** Seed default preferences row for every existing user via a one-time script `scripts/seed-default-prefs.ts` (idempotent, safe to re-run).

**Expected output:** Two new tables visible; existing users have a preferences row; CI migration job green.

**Verification:** `select count(*) from user_notification_preferences` equals `select count(*) from users`; new user signup also creates a default row (handled in Task 4's user-creation hook).

---

### Task 3: Notification scheduler — quiet hours + dedupe (TDD)

**Files:**
- Create: `lib/notifications/schedule.ts`, `tests/notifications/schedule.test.ts`

**Step 1:** Write failing tests covering the rules:
- `nextDispatchAt(now, prefs, kind, naturalTime)` returns `naturalTime` if outside quiet hours.
- Returns next quiet-hours-end if inside.
- Returns `naturalTime` regardless of quiet hours when `kind === 'expiry_t_minus_2h'` (urgent override).
- Returns `null` (suppressed) when the relevant `*_enabled` flag is false.
- Handles quiet-hours window crossing midnight (22:00–08:00).
- Handles non-UTC timezones (test against `America/Chicago` and `Asia/Tokyo`).

**Step 2:** Implement `lib/notifications/schedule.ts` using `date-fns-tz` (`pnpm add date-fns date-fns-tz`).

**Step 3:** Add `dedupeKeyFor({ kind, userId, eventId, windowDay? })` helper with deterministic outputs documented in the test file.

**Expected output:** All scheduling rules covered by tests; pure function, no I/O.

**Verification:** `pnpm test lib/notifications/schedule`; coverage report shows ≥95% on this file.

---

### Task 4: Notification dispatcher + per-kind senders

**Files:**
- Create: `lib/notifications/dispatch.ts`, `lib/notifications/kinds/first-match.ts`, `lib/notifications/kinds/new-photos.ts`, `lib/notifications/kinds/expiry.ts`, `lib/notifications/kinds/host.ts`, `lib/email/templates/FirstMatch.tsx`, `lib/email/templates/NewPhotos.tsx`, `lib/email/templates/ExpiryReminder.tsx`, `tests/notifications/dispatch.test.ts`

**Step 1:** Implement `dispatch({ kind, userId, eventId, payload })` which:
1. Loads user + preferences + event in one query.
2. Computes `dedupeKey`; attempts `insert ... on conflict (user_id, dedupe_key) do nothing returning id`. If no row returned → `suppressed_dedupe`, return.
3. Computes `scheduled_for` via `nextDispatchAt`; if null → mark `suppressed_preference`, return.
4. If `scheduled_for > now()` → leave `status='pending'`; cron job picks it up.
5. If `scheduled_for <= now()` → render template, call `sendEmail`, write `sent_at` + `resend_message_id` or `failed`.

**Step 2:** Implement per-kind modules:
- `first-match.ts`: triggered by Phase 4's matching pipeline immediately after a new `user_event_matches` row with `band='match'` is inserted. Phase 4's `/api/me/enroll` and `/api/events/:id/my-matches` are the two insertion points; both call `dispatch({ kind: 'first_match', ... })` after upsert if any new match-band row was created. The dedupe key (`first_match:user:event`) already prevents re-sends even though Phase 4 may upsert the same row multiple times, so the once-only semantic still holds. Subject: "You appear in N photos from {event}".
- `new-photos.ts`: scheduled daily at 09:00 user-local during Active phase; computes delta via Phase 5's `photo_saves` query; suppressed if delta < 3.
- `expiry.ts`: handles T-2d and T-2h. T-2h is the urgent kind that bypasses quiet hours.
- `host.ts`: post-event "plan another?" + extension offer at T-3d.

**Step 3:** Create React Email templates with branding and a "manage preferences" link.

**Step 4:** Test the dispatcher with mocked `sendEmail` and a frozen clock (`vi.useFakeTimers()`); assert dedupe, suppression, and pending states each generate the correct row.

**Expected output:** A real send round-trip works in staging against a verified inbox; preferences and quiet hours observed.

**Verification:** Vitest passes; staging smoke: trigger first-match by claiming a cluster, see the email arrive within 60s.

---

### Task 5: Expiry cron — deletion pass

**Files:**
- Create: `app/api/cron/expire/route.ts`, `lib/cleanup/expire-event.ts`, `lib/r2/delete-prefix.ts`, `tests/cleanup/expire-event.test.ts`
- Modify: `vercel.json` (add cron schedule)

**Step 1:** Implement `expireEvent(eventId)` which executes inside a single transaction (DB) plus an R2 delete pass:
1. `select photos where event_id = $1` — capture `r2_key_original` and `r2_key_preview` keys.
2. R2: list all objects under `events/<eventId>/` and delete in batches of 1000 (R2 batch limit). Capture deleted count.
3. DB delete in this order (respecting FKs): `photo_saves` → `photo_views` → `face_detections` → `face_clusters` → `photo_jobs` → `photos` → `event_members` → `notification_deliveries where event_id = $1` → `events where id = $1`.
4. Insert a `cleanup_runs` row recording counts deleted per table and R2 object count.

**Step 2:** Implement `app/api/cron/expire/route.ts` which authenticates via `CRON_SECRET` header (Vercel cron), selects all `events where expires_at < now() and not exists (cleanup_runs.event_id = events.id)`, and calls `expireEvent` per event with a per-event try/catch so one failure doesn't block others.

**Step 3:** Add cron to `vercel.json`:
```json
{ "crons": [{ "path": "/api/cron/expire", "schedule": "0 * * * *" }] }
```

**Step 4:** Test against MinIO/moto S3 mock and a seeded event with photos, detections, clusters, views, saves, jobs. Assert all tables have zero rows for the event afterwards and the R2 prefix is empty.

**Expected output:** A deliberately expired event is fully cleaned in <30s.

**Verification:** Vitest integration test green; staging dry run with one expired event shows clean DB + clean R2 prefix.

---

### Task 6: Cleanup verification cron — the launch-blocker guard

**Files:**
- Create: `app/api/cron/verify-cleanup/route.ts`, `lib/cleanup/verify-event.ts`, `db/schema.ts` (add `cleanup_runs`, `cleanup_verification_failures`), `tests/cleanup/verify-event.test.ts`
- Modify: `vercel.json` (second cron)

**Step 1:** Add tables:
```
cleanup_runs
  event_id (uuid, pk)
  ran_at (timestamp, default now())
  photos_deleted (int) detections_deleted (int) clusters_deleted (int)
  views_deleted (int) saves_deleted (int) jobs_deleted (int) members_deleted (int)
  r2_objects_deleted (int)

cleanup_verification_failures
  id (uuid, pk)
  event_id (uuid not null)
  verified_at (timestamp, default now())
  r2_orphans (int)
  photos_remaining (int)
  detections_remaining (int)
  clusters_remaining (int)
  views_remaining (int)
  saves_remaining (int)
  jobs_remaining (int)
  members_remaining (int)
  notes (text)
  resolved_at (timestamp)
```

**Step 2:** Implement `verifyEvent(eventId)`:
1. Count rows in every table where `event_id = $1` (or photo_id joined to a photo with that event_id, for detections/saves/views).
2. R2: list objects under `events/<eventId>/` — must be 0.
3. If **any** count > 0 → insert into `cleanup_verification_failures` and emit a Sentry `error` with full context (event id, counts, R2 keys sampled).
4. If clean → no-op (don't write a row; cleanup_runs already records success).

**Step 3:** Implement the cron route at `/api/cron/verify-cleanup` which:
- Inline pass: re-verifies events whose `cleanup_runs.ran_at` was in the last 60 minutes.
- Hourly pass: verifies all events from the last 7 days that have a `cleanup_runs` row but no resolved verification failure.
- Schedule: `15 * * * *` (offset 15 min from delete cron to allow R2 eventual consistency).

**Step 4:** **Failure-injection test** — write a Vitest test that calls `expireEvent` with a stub R2 client that silently no-ops the delete, then runs `verifyEvent` and asserts:
- A `cleanup_verification_failures` row exists with `r2_orphans > 0`.
- A Sentry capture was invoked (mock `@sentry/nextjs` and assert `captureException` called with the expected fingerprint).

**Step 5:** Add an on-call runbook entry (in Task 9) for "cleanup verification failed" with retry + escalation steps.

**Expected output:** Silent partial cleanup is impossible — every leak surfaces as a Sentry alert and a queryable row.

**Verification:** Test passes; staging chaos test: comment out the R2 delete line, run cleanup, confirm verification fires within 1 hour. Revert.

---

### Task 7: Privacy policy, terms of service, consent records

**Files:**
- Create: `app/(legal)/privacy/page.tsx`, `app/(legal)/terms/page.tsx`, `lib/legal/versions.ts`, `tests/legal/consent.test.ts`
- Modify: `components/enroll/ConsentModal.tsx` (built in Phase 4 Task 2) — extend it to cover the privacy and terms documents in addition to enrollment biometric. Do **not** create a second `EnrollmentConsentModal` component.
- Modify: Phase 4 enrollment endpoint to gate on consent
- Note: `db/schema.ts` — **Phase 4 Task 1 has already created `consent_acceptances` with this shape.** Phase 6 Task 7 only adds the `privacy_policy` and `terms_of_service` document types and the consent-modal flow for them. No new migration is needed for the table itself; a migration may be needed if the `document` enum is stored as a Postgres enum type rather than a `text` check.

**Step 1:** Author privacy policy and ToS markdown content covering: what's stored (face embeddings, not raw photos of face), retention (event lifespan + 24h grace), per-event matching scope, third parties (Resend for email, R2 for storage, no others), right to delete, embedding model, encryption at rest, ephemeral enrollment frames. **Send to counsel before launch** — placeholder content acceptable for development.

**Step 2:** Confirm the `consent_acceptances` table exists with this shape (created in Phase 4 Task 1):
```
consent_acceptances
  id (uuid, pk)
  user_id (uuid, fk users.id on delete cascade)
  document (text enum: privacy_policy | terms_of_service | enrollment_biometric)
  version (text not null)             -- e.g., '2026-04-27'
  accepted_at (timestamp, default now())
  ip_address (text)
  user_agent (text)
  unique (user_id, document, version)
```
If the `document` column does not yet include `privacy_policy` and `terms_of_service` (Phase 4 only needed `enrollment_biometric`), add a migration to extend the check constraint.

**Step 3:** `lib/legal/versions.ts` exports the current version constants. Bumping a version requires re-acceptance — document this in the file's header comment.

**Step 4:** Extend Phase 4's existing `components/enroll/ConsentModal.tsx` to accept a `document` prop (`'enrollment_biometric' | 'privacy_policy' | 'terms_of_service'`) so the same component drives all three flows. Phase 4 already wired the `enrollment_biometric` path; Phase 6 adds the privacy and terms variants and surfaces them where appropriate (e.g., signup, settings). Posts to `/api/consent/accept` with the right `document` value.

**Step 5:** Modify the Phase 4 enrollment endpoint to refuse with 403 + `{ error: 'consent_required', latestVersion }` if no `consent_acceptances` row exists for the current `enrollment_biometric` version.

**Step 6:** Test: a user without consent gets 403 from `/api/enroll`; after accepting, they get through.

**Expected output:** No biometric data is captured without an audit trail.

**Verification:** Vitest integration test; manual e2e: clear consent row in DB, attempt enrollment, see modal, accept, succeed.

---

### Task 8: Illinois geofence at signup + enrollment soft re-check

**Files:**
- Create: `lib/geofence/illinois.ts`, `app/(legal)/coming-soon/page.tsx`, `tests/geofence/illinois.test.ts`
- Modify: `app/api/auth/request/route.ts`, Phase 4 enrollment endpoint, `.env.example`

**Step 1:** **Legal trigger.** Document at the top of `lib/geofence/illinois.ts`: "Illinois BIPA (740 ILCS 14) imposes statutory damages of $1,000–$5,000 per violation for collection of biometric identifiers without written consent meeting specific requirements. Until counsel reviews our consent flow and we obtain insurance, Illinois users are blocked at signup." Cite the design doc's privacy section.

**Step 2:** Implement `isIllinoisRequest(request)`:
- Primary signal: `request.headers.get('cf-ipcountry') === 'US'` AND `request.headers.get('cf-region-code') === 'IL'`.
- Fallback (if no Cloudflare): MaxMind GeoIP2 lookup via `@maxmind/geoip2-node` against a mounted `GeoLite2-City.mmdb`. (If we don't deploy the .mmdb, log a warning and fail-open with a Sentry breadcrumb — but only if `GEOFENCE_FAIL_OPEN=true`; default fail-closed in prod.)
- Behind `GEOFENCE_IL_ENABLED` env flag (default `true` in prod, `false` in dev/staging).

**Step 3:** **Signup-side enforcement.** In `/api/auth/request`, before creating a magic link token, call `isIllinoisRequest(request)`. If true:
- Return `{ error: 'geofenced', supportedRegions: 'US-non-IL,...' }` with status 451 (Unavailable For Legal Reasons).
- Frontend redirects to `/coming-soon`.
- No `magic_link_tokens` row created. Log to a `geofence_blocks` audit table (event-style; not a hard table here — append-only log).

**Step 4:** **Enrollment soft re-check.** A user who signed up outside Illinois but later enrolls from an Illinois IP (VPN, travel) gets the same 451 response from `/api/enroll`. They can still upload, retrieve via face matching of others' uploads they're tagged in won't work for them but no biometric is captured.

**Step 5:** Build `/coming-soon` page with copy: "Photo Courier isn't available in your region yet. Join the waitlist." (Form to capture email goes to a separate `waitlist` table — out of Phase 6 scope; placeholder acceptable.)

**Step 6:** **Rollback plan.** Document in `docs/ops/geofence-rollback.md`:
1. Set `GEOFENCE_IL_ENABLED=false` in Vercel prod env.
2. Trigger a redeploy via Vercel UI (or use `vercel env pull && vercel --prod`).
3. Verify by hitting `/api/auth/request` with `CF-IPCountry: US, CF-Region-Code: IL` test header — should now succeed.
4. **Total time: <5 minutes.**
5. If geofence misses a known case (e.g., we discover Cloudflare doesn't set `cf-region-code` reliably) and we're already serving Illinois users without consent — immediately flip to maintenance mode (separate `MAINTENANCE_MODE=true` env), purge any biometric records collected during the window, and notify counsel. Runbook step list this explicitly.

**Step 7:** Tests:
- IL IP → 451 + no token row.
- TX IP → 200 + token row.
- Flag off → 200 regardless of IP.
- VPN re-check on enrollment endpoint.

**Expected output:** Documented, testable, reversible geofence.

**Verification:** Vitest passes; staging smoke with synthetic `CF-IPCountry`/`CF-Region-Code` headers confirms blocks; rollback dry-run completes in <5 minutes.

---

### Task 9: Beta launch checklist — error reporting, uptime, logs, on-call, status

**Files:**
- Create: `docs/ops/on-call.md`, `docs/ops/incidents.md`, `docs/ops/data-deletion-runbook.md`, `instrumentation.ts` (Next.js Sentry init), `worker/sentry.py`, `app/api/health/route.ts`
- Modify: `package.json`, `worker/requirements.txt`, `.env.example`

**Step 1: Error reporting (Sentry).**
- `pnpm add @sentry/nextjs` — run wizard or manually configure `instrumentation.ts`, `sentry.client.config.ts`, `sentry.server.config.ts`. Tracesample rate 0.1 in prod.
- Worker: `pip install sentry-sdk`, init in `worker/main.py`.
- Verify: throw a test error from a `/api/_test/error` route (gated to non-prod) and confirm in Sentry dashboard.

**Step 2: Uptime monitor.**
- Implement `/api/health` returning `{ db: 'ok', r2: 'ok', worker: 'ok'|'unknown', version: <git-sha> }`. DB ping via `select 1`; R2 ping via head-object on a known sentinel; worker ping via `WORKER_URL/health` with 2s timeout.
- Provision BetterStack (or equivalent) monitor at `https://app.phostro.com/api/health`, 60s interval, page on 3 consecutive failures, alert via email + SMS to on-call.

**Step 3: Log retention.**
- Vercel logs: enable Log Drains to a destination with ≥30-day retention (Axiom, Datadog, or S3). Document chosen destination in `docs/ops/logs.md`.
- Worker (Fly.io / Railway): configure log forwarding to same destination.
- Sentry retention: confirm Free tier 30-day retention is acceptable; upgrade if not.

**Step 4: On-call doc.** `docs/ops/on-call.md` includes:
- Who is on call (rotation table).
- How alerts arrive (Sentry → email; BetterStack → SMS).
- Escalation: ack within 15min for SEV1 (cleanup verification failure, prod down), 1hr for SEV2 (single-user failure pattern).
- Common alerts and first-step responses, including: cleanup verification failure (Task 6 cross-link), Resend bouncing, worker OOM, geofence false-positive (Task 8 rollback).
- Postmortem template stub.

**Step 5: Status / incidents doc.** `docs/ops/incidents.md` is a markdown file (or Notion page link) the team appends to during incidents, shared with beta hosts at launch.

**Step 6: Data deletion request handler.** `docs/ops/data-deletion-runbook.md` documents:
- The self-serve UI button (built in Task 10) is the primary path.
- Email-driven manual fallback at `privacy@phostro.com` with 30-day SLA (GDPR floor).
- The exact SQL/script `scripts/delete-user.ts` to run for manual requests; this script is **not** auto-executed — operator confirms each one.
- Audit log: every deletion request is logged to a `deletion_requests` table (created in Task 10), regardless of self-serve or manual.

**Step 7:** Add a "go / no-go" checklist file `docs/launch/beta-checklist.md` enumerating each of the above items as boxes; require all checked before beta invites go out.

**Expected output:** All ops infra in place; an on-call human can respond to the most likely failure modes from documentation alone.

**Verification:** Synthetic Sentry error fires in prod within 60s. BetterStack monitor history shows 100% uptime over 24h staging soak. On-call doc reviewed by at least one other engineer.

---

### Task 10: Self-serve account + face-profile deletion

**Files:**
- Create: `app/(app)/settings/page.tsx`, `app/api/account/delete/route.ts`, `lib/account/cascade-delete.ts`, `db/schema.ts` (add `deletion_requests`), `scripts/delete-user.ts`, `tests/account/delete.test.ts`
- Refactor: `app/api/me/face-profile/route.ts` (Phase 4's existing DELETE route — URL stays the same; implementation is extracted into `cascadeDelete`)
- Modify: Phase 4 enrollment endpoint (already done in Task 7)

**Step 1:** Add `deletion_requests` audit table:
```
deletion_requests
  id (uuid, pk)
  user_id (uuid)                           -- not FK; row outlives the user
  user_contact_at_request (text)           -- snapshot
  request_kind (text enum: face_profile_only | full_account)
  requested_at (timestamp, default now())
  completed_at (timestamp)
  ip (inet)
  user_agent (text)
  initiated_by (text enum: self_serve | operator_manual)
  notes (text)
```

**Step 2:** Implement `cascadeDelete({ userId, kind })`:
- `face_profile_only`: null out `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`; do not touch other rows. Insert `deletion_requests` row.
- `full_account`: per-event policy — by default, photos uploaded by this user remain in events they don't host (host's content), but face matches against this user are gone. Specifically: null face fields; delete `face_detections` rows that link to this user via cluster ownership; delete `event_members` rows; delete `notification_deliveries`; delete `consent_acceptances`; delete `magic_link_tokens`; delete events they host (cascades to all their content); finally delete the `users` row. **Wrap in a transaction.** Insert `deletion_requests` row with `completed_at`.

**Step 3:** Refactor Phase 4's existing `DELETE /api/me/face-profile` route to call `cascadeDelete({ userId, kind: 'face_profile_only' })` rather than duplicating the cascade logic inline. The endpoint URL stays the same; only the implementation is extracted.

**Step 4:** Build the settings page with two destructive actions: "Delete face profile" and "Delete account." Confirmation modal requires typing the user's email to confirm. Both call the corresponding API.

**Step 5:** Implement the full-account API route (`DELETE /api/account`); both routes require an authenticated session and re-validate by re-checking session userId against the request body's claimed userId.

**Step 6:** `scripts/delete-user.ts` is the operator-manual variant for email-driven requests; takes `--user-id` and `--kind`, prompts for confirmation, calls the same `cascadeDelete` with `initiated_by='operator_manual'`.

**Step 7:** Test cascade thoroughly with a multi-event seed: user is host of A, attendee of B; deleting them must remove A entirely, leave B's other photos intact, and leave their `deletion_requests` audit row.

**Expected output:** Privacy promise is real; deletions complete within a single user-perceivable interaction; audit trail survives.

**Verification:** Vitest cascade test; Playwright e2e walks through delete flow; verify in DB that exactly the expected rows are gone.

---

### Task 11: Tear-down beta task — wind down a beta event cleanly

**Files:**
- Create: `scripts/teardown-beta-event.ts`, `docs/ops/teardown-beta.md`

**Step 1:** Implement `scripts/teardown-beta-event.ts <eventId>` with flags `--dry-run`, `--reason "<text>"`, and `--notify-attendees`:
1. Confirm event exists and `host_user_id` matches an env-allowlisted beta host (safety check).
2. If `--notify-attendees`: send a one-off email (kind: `beta_teardown`, transactional, bypasses preferences) explaining the event is being archived early and giving a final 24h save window.
3. After the 24h window (or immediately if `--immediate`): force `events.expires_at = now()`.
4. Run `expireEvent(eventId)` (Task 5) inline.
5. Run `verifyEvent(eventId)` (Task 6) inline; abort and Sentry-alert if verification fails.
6. Print summary: photos deleted, R2 objects deleted, members affected.

**Step 2:** Document the procedure in `docs/ops/teardown-beta.md`:
- When to use it: beta event went sideways (PII leak, NSFW, host requested early shutdown, end of beta period).
- Pre-flight: take a DB snapshot via Neon branch in case we need forensics.
- Run with `--dry-run` first; review output.
- Run for real; archive the script output in the incident doc.
- Post-flight: confirm `cleanup_verification_failures` has no row for this event; close the loop.

**Step 3:** Test with a seeded event in dev/staging; run dry-run first, then real run; assert cleanup_runs and verification both green.

**Expected output:** Beta exit ramp exists and has been exercised at least once before launch.

**Verification:** Staging dry run + real run on a synthetic event; output matches the documented format; nothing leaks.

---

### Task 12: Beta soak + success-criteria instrumentation

**Files:**
- Create: `lib/analytics/events.ts`, `app/api/analytics/track/route.ts`, `db/schema.ts` (add `analytics_events`), `docs/launch/success-metrics.md`
- Modify: Phases 4–5 to emit events

**Step 1:** Add `analytics_events` table (lightweight; no third-party analytics yet):
```
analytics_events
  id, user_id (nullable), event_id (nullable), kind (text), payload (jsonb), occurred_at
```

**Step 2:** Emit events at: signup, consent_accepted, enrollment_started, enrollment_completed, photo_uploaded, first_match_email_sent, first_save, last_save_in_session, event_extended, event_expired.

**Step 3:** Build a simple admin SQL view (or Metabase if available) computing the design doc's success criteria:
- ≥40% enrollment rate among joined attendees
- ≥70% save-rate among enrolled attendees
- ≥30% repeat-host rate within 60 days

**Step 4:** Run the beta with ~5 events. Each evening for the beta period, the on-call reviews Sentry, BetterStack, `cleanup_verification_failures`, and the success metrics view. Notes go in the incidents doc.

**Step 5:** At end of beta, write a beta retrospective doc summarizing metrics vs targets; this informs whether to scale or rethink (per design doc's "does the wedge work?" section).

**Expected output:** We have data, not vibes, on whether the product works.

**Verification:** Metrics view runs; events emit; retro doc written.

---

## Phase 6 review checkpoint

Before declaring Phase 6 complete and inviting public users beyond beta:

1. **Run `superpowers:requesting-code-review`** on the entire phase, with explicit reviewer focus on: (a) cleanup verification correctness, (b) geofence rollback safety, (c) cascade-delete completeness, (d) consent gating on every biometric path.
2. **Counsel sign-off** on privacy policy, ToS, consent wording, and the Illinois geofence approach. **Do not invite any user outside the dev team until this is signed.**
3. **Beta retrospective** (Task 12) must show the design doc's success thresholds are within striking distance — if enrollment <20% or save <40%, the wedge isn't landing and we stop to rethink before scaling.
4. **Cleanup verification has been clean for 14 consecutive days** in staging or beta. A single unresolved `cleanup_verification_failures` row blocks broader launch.
5. **On-call rotation has actually been exercised** at least once (real or simulated incident) and the runbook held up.
6. **Tear-down has been used at least once** (Task 11) on a real beta event without surprises.
7. **Manual smoke** of all five email kinds against real inboxes (Gmail, iCloud, Outlook, Yahoo, ProtonMail) — verify deliverability, not just send success.
8. **Self-serve deletion** has been performed by at least one non-engineer beta tester and verified to complete with no orphans.

If any of the above is red, do not move to general availability — fix and re-verify.

---

## Salvageable for Pocket v1

Most of Phase 6 transfers cleanly to Pocket v1 — these concerns are product-shape-independent:

- **Resend notifications** — owner pinged when a new match lands in their pocket. Quiet hours, dedupe, and preferences scheduler all apply.
- **Expiry cron + cleanup verification** — Pocket retention policy still TBD, but the delete-then-verify pattern is the right shape. Cleanup verification is non-negotiable for the privacy promise.
- **Illinois BIPA geofence + rollback plan** — biometric collection happens in both products; the legal posture is identical.
- **Self-serve deletion** (`/api/me/face-profile`, `/api/account/delete`) and `deletion_requests` audit table — Pocket v0 has no deletion path; v1 needs this.
- **Beta launch checklist** — Sentry, uptime, log retention, on-call doc, status/incidents — all still required.

Adjust before lifting:
- `notification_deliveries.kind` enum drops `host_event_summary` and `post_event_replan`; replace with `pocket_match_arrived`, `pocket_expiring`.
- The `first_match` trigger reads Pocket v0's filter result rather than `user_event_matches.band='match'`.
- `consent_acceptances.document` enum can drop event-specific values once the host-broadcast paths are deleted.
