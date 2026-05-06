# Pocket v1 — Implementation Plan (outline)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:writing-plans` to expand this into a full plan when v0 self-use is signed off. REQUIRED SUB-SKILL: Use `superpowers:executing-plans` once expanded.

**Date:** 2026-05-06
**Status:** OUTLINE — gated on Pocket v0 Task 12 (self-use postmortem). Do not execute until founder commits.
**Predecessor:** Pocket v0 (`2026-05-02-pocket-v0-implementation.md`).
**Successor:** Pocket Platform v2 (deferred — original Phases 4–6 plans cover the host-broadcast direction).

---

## Why v1 exists (read first)

Pocket v0 is a personal hard-floor experiment: the founder uses Pocket themselves and either retrieves ≥5 grad photos they didn't have, or doesn't. The v0 decision rule (line 384 of the v0 plan) gates v1: "Founder would use Pocket again → ship Pocket v1 (rough edges, in-app browser handling, multi-photo dl, attribution UI)." If v0 fails its hard floor, v1 doesn't exist — re-open `/office-hours` and reconsider.

v1 is **the hardening pass between self-use and a wider beta**. It does the things v0 explicitly punted on once friction is real, and the things Phase 6 says are non-negotiable for *any* product touching biometric data — BIPA geofence, consent record, self-serve deletion, error reporting, cleanup verification. It also pays down the Pocket-edition migration audit debt (legacy `/events/*` routes still mounted alongside `/pockets/*`).

v1 is **not** a feature expansion. No host-broadcast. No multi-pocket sharing. No platform features. Anything that points at Pocket Platform v2 stays out — those are the original Phase 4–6 plans, preserved for after v1 proves a non-founder beta user can complete a pocket without bouncing.

---

## End state of Pocket v1

A non-founder beta user can:

1. Tap a share link from inside Instagram or Facebook DMs and get to a working contributor page (in-app browser handled).
2. Upload from an iPhone with HEIC photos > 50MB without the upload silently failing.
3. See a "Saved" indicator per photo and bulk-save all unsaved matches in one action.
4. Delete their own face profile or full account via a settings page; an audit row survives.
5. Be blocked at signup/enrollment if they're in Illinois (BIPA), with a documented rollback if it misfires.
6. Not crash silently — uncaught errors land in Sentry within 60s; expired pockets are verifiably cleaned up.
7. Receive a Resend-sent first-match notification (single kind only — full kind matrix is v2).
8. Add their name to a contribution if they choose (`contributor_display_name` finally surfaced in UI).

The pocket page (owner side) stops being a single "You" feed and gains a minimal contribution metadata strip plus a per-photo save state. No three-tab gallery — that's v2.

---

## Exit criteria

v1 is done when **all** of the following hold and are verifiable by automated test, recorded device test, or runbook walkthrough:

1. **Migration debt cleared.** Items 2–5 of the migration audit (`2026-05-04-pocket-edition-migration-audit.md`) are deleted; CI green; no broken imports.
2. **In-app browser handled.** Opening a share link inside Instagram/Facebook in-app browsers either renders the contributor flow successfully or shows an "Open in Safari/Chrome" prompt with a working deep-link. Verified on at least one iOS device and one Android device, recorded in a device-test note.
3. **Bulk save works on iOS Safari, iOS PWA, and Android Chrome.** A pocket with ≥10 owner-matched photos can save all matches via anchor-loop (≤ threshold) or ZIP (> threshold). Threshold value locked into `docs/plans/decisions.md`.
4. **Per-photo save state persists.** A `photo_saves` row exists per (owner, photo) save; reopening the pocket shows checkmarks on previously saved photos.
5. **Self-serve deletion works end-to-end.** "Delete face profile" and "Delete account" both work from a settings page; a `deletion_requests` row is written; cascade is provably complete.
6. **Sentry receives a synthetic error from prod within 60s.** Both Next.js app and Python worker are wired.
7. **Cleanup verification is green.** Expired pockets have zero rows across `photos`, `photo_jobs`, `face_detections`, `face_clusters`, `share_links`, and zero R2 objects under the event prefix; failure injection produces an alert.
8. **BIPA geofence blocks Illinois at signup and enrollment**, behind `GEOFENCE_IL_ENABLED` flag with a <5-minute rollback documented.

Not on the list (intentional): notifications beyond first-match; "maybe you" tier; cross-pocket linking; multi-owner; host-broadcast.

---

## Explicitly deferred — not in v1

- **Three-tab gallery (You / By Me / Other).** → Pocket Platform v2 (Phase 5 plan).
- **Multiple owners per pocket / shared "You" feed.** → v2.
- **"Maybe you" tier in You feed.** → v2 (binary match in v1; same as v0).
- **Push notifications, daily-digest emails, host-event-summary, expiry T-2d/T-2h emails.** → v2 (Phase 6 Task 4 full kind matrix). v1 ships **only first-match** as a smoke test of the Resend pipeline.
- **Multi-angle enrollment.** → v2 unless v0 self-use postmortem shows < 60% recall.
- **Host-broadcast event mode + `event_members` non-owner roles.** → v2.
- **`face_clusters.claimed_by_user_id` workflow.** → v2.
- **`open_pool` / `host_only` visibility modes.** → v2.
- **Cross-pocket / cross-event face linking.** → never (privacy invariant).
- **B2B photographer features, marketing site, status page (full BetterStack/Statuspage), GDPR portability export, cookie banners.** → post-v2.
- **Heuristic dedupe of duplicate uploaded photos.** → v2.
- **Service-worker offline gallery, native share-sheet integration.** → v2+.

---

## Open questions

1. **Does the v0 postmortem demand attribution UI now or never?** *Default: yes — surface `contributor_display_name` capture as an optional contributor-page input. If postmortem says contributors didn't care, drop the task.* `[depends on v0 self-use postmortem]`
2. **Does first-match email belong in v1 or v2?** *Default: v1, scoped to first-match-only as a Resend pipeline smoke test. Postmortem may show the founder doesn't even check email for this — if so, defer the whole notifications path to v2 and keep v1 strictly to the privacy/legal floor.* `[depends on v0 self-use postmortem]`
3. ~~**Pocket auto-expiry policy.**~~ **Resolved 2026-05-06: 7-day default**, matching the existing `events.lifespan_days` default and the original design doc. v1 wires the cron against this; manual extension button stays out of scope. The schema column is already `notNull().default(7)`, so no migration needed — Task 6 just has to enable the cron and confirm the default isn't being overridden anywhere.
4. ~~**ZIP generation location.**~~ **Resolved 2026-05-06: Next.js streaming route via `archiver`, ZIPs `r2_key_preview` only (all JPEG), `zlib: { level: 0 }` store-only, 500-photo hard cap returning 413 above it, parallel R2 GETs (concurrency ~8), no recompression.** Worker path rejected — would compete with detection inference for CPU on a CPU-only worker, requires a new job kind, async UX with polling, and adds R2 upload + presigned URL round-trip. Vercel's 4.5MB response-body cap does not apply to streaming responses (confirmed in Vercel's KB). For 500 photos at ≤600KB previews, wall time is ~60-120s and memory is bounded by archiver's one-entry-at-a-time pipeline — well inside the 300s hobby duration. Originals/HEIC handling deferred to v2 if v1 postmortem surfaces it.
5. **Resend sending domain.** New subdomain, or reuse whatever Phase 1 used for magic-link auth? *Default: reuse Phase 1's `lib/email.ts` Resend setup; don't re-provision DNS for v1.*

---

## Cross-phase contracts assumed

**v1 inherits from Phase 1, 2, 3, and Pocket v0:**

- All v0 contracts (per the v0 plan's "Cross-phase contracts" section) carry forward unchanged: `share_links`, `users.face_embedding`, the filter API at `app/api/events/[id]/you/route.ts`, the `photos_authorship_check` XOR.
- v0 must have shipped Task 0 of v0 (schema delta) cleanly — confirmed by `db/schema.ts` already containing `share_links`, nullable `uploader_user_id`, `uploader_token`, and `contributor_display_name`.
- v0 self-use postmortem at `docs/postmortems/pocket-v0-self-use.md` must exist with a yes/maybe verdict before v1 starts.

**v1 produces (Pocket Platform v2 may consume):**

- `photo_saves` table — v2's Phase 5 three-tab gallery reads this directly. v1 adopts the Phase 5 schema verbatim (`(user_id, photo_id)` PK, `saved_at` timestamp). No `photo_views` in v1; v2 adds it.
- `cleanup_runs` + `cleanup_verification_failures` tables — directly from Phase 6 Task 6.
- `deletion_requests`, `consent_acceptances` — from Phase 6 Tasks 10 and 7. v1 only uses `enrollment_biometric` document type; v2 extends to `privacy_policy` / `terms_of_service`.
- `notification_deliveries` — schema from Phase 6 Task 2 but only `kind='first_match'` written in v1.
- A working `/api/health` endpoint (Phase 6 Task 9) and Sentry integration the v2 plan can build against.

**Prerequisite:** the migration cleanup audit (`2026-05-04-pocket-edition-migration-audit.md`) gets paid down in Task 0. v1 must not start with both `/events/*` and `/pockets/*` route trees mounted.

---

## Tasks (outline level — file list + 1-paragraph scope per task)

### Task 0 — Migration cleanup (prerequisite)

**Files (delete):** `app/(app)/events/new/page.tsx`, `app/(app)/events/[id]/join/page.tsx`, `app/api/events/route.ts`, `app/api/events/[id]/route.ts`, `app/api/events/[id]/photos/init/route.ts`, `app/api/events/[id]/photos/[photoId]/finalize/route.ts`, `components/EventCreateForm.tsx`, `components/UploadDropzone.tsx`, `components/ShareLink.tsx`, `lib/events/join.ts`, `tests/api/events-create.test.ts`, `tests/api/events-get.test.ts`, `tests/api/photos-init.test.ts`, `tests/api/photos-finalize.test.ts`, `tests/events/join.test.ts`, `tests/photos/gallery.test.ts`. **Files (modify):** `app/(app)/page.tsx` (rebrand to "Your pockets"), `lib/photos/upload-client.ts` (drop `'event'` branch). Audit-doc PR B in one commit. `app/api/events/[id]/you/route.ts` is the one ambiguous case — verify it's still the live filter endpoint before deleting (the v0 plan declares it as Pocket's filter API). Verification: `pnpm test`, `pnpm build`, and a fresh `pnpm dev` smoke walk of pocket creation → contribution → You feed.

### Task 1 — In-app browser detection and "Open in Safari" prompt

**Files:** `app/p/[token]/page.tsx`, `lib/browser/detect-inapp.ts`, `tests/browser/detect-inapp.test.ts`, plus a Playwright spec at `e2e/inapp-browser.spec.ts`. Detect Instagram (`Instagram` UA token), Facebook (`FBAN`/`FBAV`), TikTok (`musical_ly`/`Bytedance`), and the generic iOS WebView quirk where `<input type="file">` works inconsistently. On match, render a "Open in Safari" / "Open in Chrome" CTA above the contributor flow with `intent://` deep-link for Android and a `safari-https://` fallback hint for iOS. Verification: Playwright spec spoofs the three UA strings and asserts the prompt renders; falls back to native flow on Safari/Chrome UAs.

### Task 2 — iOS HEIC + large-file resize

**Files:** `lib/photos/client-resize.ts` (new), `app/p/[token]/page.tsx` (wire resize before signed PUT), `tests/photos/client-resize.test.ts`. Use `browser-image-compression` or `heic2any` to convert HEIC → JPEG and downscale to `max-edge=4096` before signing. Don't strip EXIF (the worker uses `taken_at`). Cap at ~10MB post-resize; reject larger with a friendly error. Verification: a real iPhone HEIC fixture round-trips through the contributor finalize endpoint and yields a `face_detections` row.

### Task 3 — `photo_saves` schema + per-photo save state

**Files:** `db/schema.ts` (add `photoSaves` per Phase 5 Task 1 shape), new Drizzle migration, `lib/photos/saves.ts`, `tests/photos/saves.test.ts`. Single `(user_id, photo_id)` PK row per save. Upsert on re-save. **Skip `photo_views`** — the diff label and view tracking are v2 features. Verification: integration test inserts and reads back; index plan reviewed.

### Task 4 — Bulk-save flow (anchor loop + ZIP)

**Files:** `lib/gallery/bulk-save-client.ts`, `app/api/events/[id]/zip/route.ts`, `app/api/events/[id]/save-manifest/route.ts`, `app/api/photos/saves/route.ts`, `components/BulkSaveButton.tsx`, `tests/api/zip.test.ts`. Lift Phase 5 Task 5 + Task 6 logic verbatim, scoped to one feed (the owner's "You" feed). Anchor-loop default; ZIP route streams via `archiver` past `BULK_SAVE_ZIP_THRESHOLD`. Run device tests on iOS Safari, iOS PWA, Android Chrome; lock the threshold in `docs/plans/decisions.md`. Verification: device tests recorded; integration test for ZIP auth + 413 cap; e2e at 5 photos (anchor) and 30 photos (ZIP).

**ZIP route implementation contract (locked from Open Question 4):**

- **Source:** `r2_key_preview` only. Every file in the ZIP is a `.jpg` at ≤2048px ≤600KB regardless of what the contributor uploaded — Phase 2's `finalize` route already transcoded HEIC/PNG/WebP to JPEG during preview generation. One file extension, opens on every platform.
- **Compression:** `new ZipArchive({ zlib: { level: 0 } })` — store-only. JPEGs are already compressed; running deflate over them costs CPU and saves ~0% size.
- **Streaming:** pipe `archive.pipe(response.body)` (or equivalent Web Streams adapter for Next.js App Router) — do NOT `await` the full archive before responding. Vercel's 4.5MB response-body cap is bypassed when the function streams.
- **R2 fan-out:** parallel GETs at concurrency 8. For each photo: `getObjectStream(r2_key_preview)` → `archive.append(stream, { name: \`{photoId}.jpg\` })`. 500 sequential GETs at ~100ms each is 50s of wasted round-trip; 8-wide cuts that to ~6s.
- **Filename inside ZIP:** `{photoId}.jpg` is the safe default. If contributor attribution (Task 5) ships, prefix with display name slug: `{slugify(contributor_display_name)}-{shortId}.jpg`.
- **Hard 500-photo cap.** Above 500, return 413 with a body explaining "split into multiple downloads" — Pocket scale shouldn't exceed this in v1.
- **Function config:** `export const maxDuration = 300; export const runtime = 'nodejs'` at the top of the route. Edge runtime not viable (archiver needs Node.js streams).
- **Originals path is deferred to v2.** If the v1 postmortem surfaces "I wanted full-res," v2 adds either a separate "/zip-originals" route with HEIC→JPEG transcode via Sharp, or an owner toggle. Don't ship that branching here.

### Task 5 — Contributor attribution UI

**Files:** `app/p/[token]/page.tsx`, `app/api/p/[token]/finalize/[photoId]/route.ts`, `app/pockets/[id]/page.tsx`. Optional one-line "Your name (optional)" input on contributor page; persists to `photos.contributor_display_name`. Owner pocket page renders attribution under each tile. Verification: Playwright spec uploads one named and one anonymous contribution; both render correctly. `[depends on v0 self-use postmortem — drop the task if attribution wasn't missed]`

### Task 6 — Pocket auto-expiry + cleanup cron

**Files:** `app/api/cron/expire/route.ts`, `lib/cleanup/expire-pocket.ts`, `lib/r2/delete-prefix.ts`, `db/schema.ts` (add `cleanup_runs`), `vercel.json`, `tests/cleanup/expire-pocket.test.ts`. Lift Phase 6 Task 5. Pocket-scoped: deletes `photo_saves`, `face_detections`, `face_clusters`, `photo_jobs`, `share_links`, `photos`, then the `events` row, plus R2 prefix purge. **Auto-expiry is 7 days** per the schema's existing `lifespan_days` default and the original design doc — no migration, just confirm no code path overrides the default and the cron filter is `expires_at < now()`. Verification: integration test against MinIO; staging dry run on a synthetic expired pocket; check that `pocket creation → 7 days later → cron sweep → fully cleaned` round-trips cleanly with a clock fixture.

### Task 7 — Cleanup verification cron

**Files:** `app/api/cron/verify-cleanup/route.ts`, `lib/cleanup/verify-pocket.ts`, `db/schema.ts` (add `cleanup_verification_failures`), `vercel.json`. Lift Phase 6 Task 6. Inline pass after each delete + hourly delayed pass for R2 eventual consistency. Failure-injection test asserts Sentry `captureException` fires when R2 delete is stubbed. Verification: failure-injection test green; staging chaos test (comment out the R2 delete, see alert).

### Task 8 — BIPA geofence (Illinois)

**Files:** `lib/geofence/illinois.ts`, `app/(legal)/coming-soon/page.tsx`, `app/api/auth/request/route.ts` (modify), enrollment endpoint (modify), `docs/ops/geofence-rollback.md`, `tests/geofence/illinois.test.ts`, `.env.example`. Lift Phase 6 Task 8 verbatim. Behind `GEOFENCE_IL_ENABLED` (default `true` in prod). Soft re-check at enrollment for VPN/travel cases. Document <5-minute rollback. Verification: synthetic `CF-IPCountry: US, CF-Region-Code: IL` → 451 + no token row; rollback dry-run completes in <5 minutes.

### Task 9 — Consent record (enrollment_biometric only)

**Files:** `db/schema.ts` (add `consent_acceptances` per Phase 6 Task 7 shape, `enrollment_biometric` document type only), `lib/legal/versions.ts`, `components/enroll/ConsentModal.tsx`, `app/api/me/face/route.ts` (gate). Block enrollment with 403 + `{ error: 'consent_required', latestVersion }` if no active acceptance. Privacy policy / ToS document types are v2 (Open Question 5 above is about email domain, not legal scope — keep this scoped tight). Verification: integration test asserts blocked → modal → accept → succeed.

### Task 10 — Self-serve deletion (face profile + full account)

**Files:** `app/(app)/settings/page.tsx`, `app/api/me/face/route.ts` (DELETE), `app/api/account/delete/route.ts`, `lib/account/cascade-delete.ts`, `db/schema.ts` (add `deletion_requests`), `scripts/delete-user.ts`, `tests/account/delete.test.ts`. Lift Phase 6 Task 10. `face_profile_only` nulls face fields; `full_account` cascades through pockets the user hosts (drops the entire pocket including share links and contributions), `share_links`, `consent_acceptances`, `magic_link_tokens`, `notification_deliveries`. Audit row survives. Verification: cascade test on a multi-pocket seed; Playwright e2e click-through.

### Task 11 — Sentry + uptime + on-call basics

**Files:** `instrumentation.ts`, `sentry.client.config.ts`, `sentry.server.config.ts`, `worker/sentry.py`, `worker/main.py` (init), `app/api/health/route.ts`, `docs/ops/on-call.md`, `docs/launch/beta-checklist.md`. Lift Phase 6 Task 9, scoped down: skip status page (Notion incident doc is fine for v1 beta), skip log-drain provisioning (Vercel default + Sentry is enough), keep BetterStack uptime monitor on `/api/health`. On-call doc covers: Sentry alert response, geofence rollback, cleanup verification failure, Resend bouncing. Verification: synthetic error in prod → Sentry within 60s; BetterStack monitor green for 24h staging soak.

### Task 12 — First-match notification (one kind only)

**Files:** `db/schema.ts` (add `notification_deliveries` + `user_notification_preferences` per Phase 6 Task 2 shape), `lib/notifications/dispatch.ts`, `lib/notifications/kinds/first-match.ts`, `lib/email/templates/FirstMatch.tsx`, `app/api/me/face/route.ts` (call `dispatch` after enrollment writes match rows from existing pocket photos). Single kind only: `first_match`. Subject: "You appear in N photos in {pocket}". Dedupe key: `first_match:user:event`. Quiet-hours scheduler is **not** required if this is the only kind (first match isn't recurring). Verification: trigger first-match by enrolling against a seeded pocket with prior contributions; email arrives within 60s; second enrollment doesn't re-fire (dedupe). `[depends on v0 self-use postmortem — drop entirely if Open Question 2 resolves to "defer"]`

### Task 13 — v1 self-use + non-founder beta postmortem

**Files:** `docs/postmortems/pocket-v1-self-use.md`, `docs/postmortems/pocket-v1-beta.md`. Founder uses v1 themselves first (smoke). Then invites 1–3 non-founder beta users — at least one on iOS in-app browser flow, at least one with HEIC photos > 50MB, at least one outside the founder's Mac/Chrome dev environment. Postmortem captures: contributor count, photos retrieved, friction list, did they bounce. Verdict: ready for wider beta? defer to v2? give up?

---

## Estimated effort

Task 0 (cleanup): 0.5d, mechanical. Tasks 1–2 (in-app browser, HEIC): 1.5d combined — both touch the contributor page and need real device testing. Tasks 3–4 (saves + bulk save): 2d — bulk save is the heaviest UX task, plus device-test cycle. Tasks 6–7 (expiry + verification): 1.5d, mostly lifting from Phase 6. Task 8 (geofence): 1d, plus a counsel-review wait that's wall-clock, not work-time. Task 9 (consent): 0.5d. Task 10 (deletion): 1d. Task 11 (Sentry/uptime/on-call): 1d. Task 12 (first-match): 0.5d if it ships, 0d if dropped. Task 13 (postmortem): 0.5d focused over 1–2 weeks of beta. **Total focused work: ~10 dev-days. Realistic calendar: 3–4 weeks for solo founder.** Counsel review on the privacy policy + Illinois geofence approach is the long pole if it isn't already in flight.

---

## Decision rule at end of v1

After Task 13 postmortem, decide:

- **Non-founder beta users completed pockets without bouncing, retrieved photos, didn't trip BIPA/Sentry/cleanup alarms** → start scoping Pocket Platform v2 from the original Phase 4–6 plans (host-broadcast direction, `user_event_matches`, three-tab gallery, full notification kind matrix). Cold-share with non-friend networks during the v2 build.
- **Beta users bounced** (in-app browser still broken, HEIC still failing, friction in attribution / save / consent flow) → fix the single biggest friction and re-run beta. Don't open v2.
- **Founder is no longer using Pocket themselves by week 4** → recognition isn't solving a real-enough problem at receiver scale even after hardening. Re-open `/office-hours`.

---

## Anti-scope (things to not do during this plan)

- Do not reopen the host-broadcast direction. Phase 4–6 plans stay deferred.
- Do not build the three-tab gallery (You / By Me / Other). One feed in v1.
- Do not wire `open_pool` / `host_only` visibility modes.
- Do not implement multi-owner pockets, shared "You" feeds, or `event_members` writes for non-owner roles.
- Do not implement the full Phase 6 notification kind matrix (new-photos, expiry T-2d/T-2h, host summary). First-match only, and only if Open Question 2 resolves yes.
- Do not implement `face_clusters.claimed_by_user_id` workflow — that's Phase 4 / v2.
- Do not run the multi-angle enrollment workstream unless v0 self-use recall < 60%.
- Do not migrate ML stack, add B2B photographer features, or build a marketing site.
- Do not add cookie banners, GDPR portability export, or full status page — v2+ scope.
- Do not skip Task 0. v1 must not start with the legacy `/events/*` tree still mounted.
