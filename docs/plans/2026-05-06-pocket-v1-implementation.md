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
9. **Contributor attribution renders.** Optional `contributor_display_name` input on `/p/[token]`, displayed under each tile on the owner pocket page. Verified by Playwright spec uploading one named + one anonymous contribution.
10. **First-match notification fires once and only once per (user, pocket).** Triggered after enrollment writes match rows from existing pocket photos; integration test confirms second enrollment doesn't re-fire (dedupe).
11. **Resend custom domain verified.** `mail.phostro.com` SPF / DKIM / DMARC pass; test send to a real Gmail / iCloud / Outlook inbox lands in the inbox (not spam) with valid DKIM signature.
12. **Contributor init is rate-limited.** `/api/p/[token]/init` returns 429 with `Retry-After` after 30 calls per 15 minutes per `(share_link_id, IP)`. Integration test floods 31 calls and asserts the 31st is 429.
13. **Security headers present on every response.** CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Mozilla Observatory grade ≥ B.
14. **Owner can revoke a leaked share link.** `DELETE /api/pockets/:id/share-links/:linkId` sets `revoked_at`; subsequent contributor `init` with that token returns 410. UI exposes this in `app/(app)/pockets/[id]/share-links/page.tsx`.

Not on the list (intentional): notifications beyond first-match; "maybe you" tier; cross-pocket linking; multi-owner; host-broadcast; full preferences/quiet-hours UI.

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

1. ~~**Does the v0 postmortem demand attribution UI?**~~ **Resolved 2026-05-06: ship in v1.** Schema already has `contributor_display_name` (nullable), the contributor input is one optional text field, the owner-side render is a small caption under each tile. Cost ≈ 0.5 dev day; signal-to-noise is too good to defer. Task 5 is mandatory, not conditional on the v0 postmortem.
2. ~~**Does first-match email belong in v1 or v2?**~~ **Resolved 2026-05-06: ship in v1, scoped tight.** Without it, a contributor uploads → recognition matches → owner has no idea unless they reopen the app. Production-ready means users get notified when something happens to them. Single kind only (`first_match`), one dedupe row, no preferences table, no quiet-hours scheduler — those are v2. Task 12 is mandatory. Depends on Question 5's domain provisioning.
3. ~~**Pocket auto-expiry policy.**~~ **Resolved 2026-05-06: 7-day default**, matching the existing `events.lifespan_days` default and the original design doc. v1 wires the cron against this; manual extension button stays out of scope. The schema column is already `notNull().default(7)`, so no migration needed — Task 6 just has to enable the cron and confirm the default isn't being overridden anywhere.
4. ~~**ZIP generation location.**~~ **Resolved 2026-05-06: Next.js streaming route via `archiver`, ZIPs `r2_key_preview` only (all JPEG), `zlib: { level: 0 }` store-only, 500-photo hard cap returning 413 above it, parallel R2 GETs (concurrency ~8), no recompression.** Worker path rejected — would compete with detection inference for CPU on a CPU-only worker, requires a new job kind, async UX with polling, and adds R2 upload + presigned URL round-trip. Vercel's 4.5MB response-body cap does not apply to streaming responses (confirmed in Vercel's KB). For 500 photos at ≤600KB previews, wall time is ~60-120s and memory is bounded by archiver's one-entry-at-a-time pipeline — well inside the 300s hobby duration. Originals/HEIC handling deferred to v2 if v1 postmortem surfaces it.
5. ~~**Resend sending domain.**~~ **Resolved 2026-05-06: provision a verified custom subdomain (`mail.phostro.com`) before opening v1 to non-founder beta.** Phase 1 currently hardcodes `Photo Courier <onboarding@resend.dev>` (Resend's sandbox sender) — see `lib/email.ts:14`. That sender works for dev, but on a non-founder beta inbox it (a) looks unverified, (b) is more likely to land in spam, (c) shares reputation with every other Resend free-tier project. Add SPF, DKIM, DMARC records to `mail.phostro.com`, verify in Resend dashboard, update `lib/email.ts` to read `RESEND_FROM_ADDRESS=Photo Courier <noreply@mail.phostro.com>` from env. This is now part of Task 14 (production-readiness). Reuse the existing Resend API key — no new account.

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

### Task 5b — Optional "alternate look" enrollment angle

**Why this exists:** The 2026-05-08 self-use dogfood (`docs/postmortems/pocket-v0-self-use.md`) exposed that multi-angle ArcFace + 3 angles (frontal/left/right) does NOT close the glasses gap. A self-photo with glasses landed at cosine distance 0.858 — indistinguishable from a non-self photo at 0.859. Multi-angle enrollment trains the embedding on yaw variation, not appearance variation. For users who wear glasses, hats, makeup, or have noticeably different hair/style across their social photos, recall caps at ~67% on their own photos.

**Files:**
- Modify: `lib/auth/face-enrollment.ts` — extend the `FaceScanAngle` enum to include `'alt'` (or a more descriptive name; bikeshed at implementation). Update the `(user_id, angle)` PK story to allow this fourth row. Migration: extend the `user_face_embeddings_angle_check` CHECK constraint to include the new value.
- Modify: `app/(app)/me/face/enroll/page.tsx` — after the 3 mandatory angles complete, surface a fourth optional step: "If you wear glasses (or have a different look you'd like recognized), add a photo of that too." A single button, skippable.
- Modify: `lib/photos/you-feed.ts` — already iterates over all rows in `user_face_embeddings` and takes MIN distance; no change needed if the schema accepts the new value.
- Modify: `app/api/me/face/finalize/route.ts` — bypass the pose-vs-claimed-angle yaw gate for the `'alt'` angle (the user is intentionally enrolling a "different look" frontally; pose validation doesn't apply). Keep the `detectTooSimilar` check.
- Modify: `worker/recognition/detect.py` (Python) — no change needed. Yaw is returned but only used by the Next.js validator.

**UX scope:**
- Opt-in only. The default 3 angles stay mandatory; the 4th is a soft nudge after success ("This catches you wearing glasses or a hat. Skip if you don't need it.")
- One alternate look only in v1 (not multiple variants). Multiple variants is v2 if the dogfood data shows a need.
- The alternate-look enrollment shows the same uploaded preview during validation so the user can confirm "yes that's the look I want recognized."

**Verification:**
- Bench: re-test the glasses photo from the 2026-05-08 dogfood. Ground truth says it's the user; with `'alt'` enrollment, distance should drop below threshold. (If it doesn't, the embedding-level gap is real and we need a different model — flag for v2.)
- Playwright e2e: enroll 3 angles, then enroll the 4th, then upload a photo of the user-with-alternate-look and assert it lands in the You feed.
- Unit test: `detectTooSimilar` doesn't fire on the 4th angle vs the 3 base angles even though appearance differs (because it should — different appearance = different embedding = far enough).

**Don't do in v1:**
- Multi-variant looks (wearing-mask, with-beard, etc.). Ship one alt slot; if usage data shows multi-variant demand, that's v2.
- "Auto-detect glasses and prompt" — the prompt is unconditional. Users who don't wear glasses will skip; users who do will tap through. Don't try to be clever about who needs it.

`[ranked highest in postmortem — ship before any non-founder beta]`

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

### Task 14 — Production-readiness gaps (added 2026-05-06)

A pre-Task-13 production hardening pass for items the audit flagged that weren't already covered by Tasks 0–12. Each sub-item has a concrete file list and verification.

**14a. Rate limit `/api/p/[token]/init` (resolves the existing `// TODO: per-IP rate limit (Pocket v1)` at line 18).**
Files: `lib/rate-limit/token-init.ts` (new), modify `app/api/p/[token]/init/route.ts`, `tests/api/p-init-rate-limit.test.ts`. Use a lightweight Postgres-backed token bucket keyed on `(share_link_id, request_ip)`: 30 inits per 15 minutes per IP per link. Above limit: 429 with `Retry-After`. Verification: integration test floods 31 calls, asserts the 31st is 429; Sentry breadcrumb fires.

**14b. Resend custom domain provisioning.**
Files: modify `lib/email.ts` (read `RESEND_FROM_ADDRESS` env), `.env.example`, `docs/ops/email-domain.md` (new). Provision `mail.phostro.com` in Resend, add SPF / DKIM / DMARC DNS records, wait for verification, set `RESEND_FROM_ADDRESS=Photo Courier <noreply@mail.phostro.com>` in Vercel prod env. Operational doc records rotation cadence and how to nuke a leaked key. **Blocks Task 12** (first-match notification needs a verified sender). Verification: end-to-end send to a real Gmail / iCloud / Outlook inbox shows verified DKIM and lands in inbox, not spam.

**14c. Security headers via Next.js middleware.**
Files: `middleware.ts` (new), `tests/security-headers.test.ts`. Default deny: `Content-Security-Policy` (allow only self + R2 image origin + Resend tracking), `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. CSP must NOT block the contributor `/p/[token]` flow's R2 PUT (allow R2 endpoint in `connect-src`). Verification: `mozilla.observatory` scan grade ≥ B; Playwright spec asserts headers on `/`, `/p/[token]`, `/api/me`.

**14d. Share-link revocation UI.**
Files: `app/(app)/pockets/[id]/share-links/page.tsx` (new — server component listing the owner's active links), modify `app/api/pockets/[id]/share-links/route.ts` (add `DELETE /:linkId`), `components/RevokeShareLinkButton.tsx`, `tests/api/share-links-revoke.test.ts`. Owner sees a list of active links with usage count, expiry, and a revoke button. Revoke sets `share_links.revoked_at = now()`. The contributor page already returns 410 for revoked tokens (Pocket v0 ships this); revocation makes it actionable. Verification: integration test revokes, then asserts contributor `init` returns 410.

**14e. Worker dispatcher Sentry breadcrumbs (resolves Phase 3 `// TODO: add Sentry breadcrumbs (Task 16)` at `lib/worker/dispatcher.ts:8`).**
Subsumed by Task 11 (Sentry wiring) — verify the dispatcher emits `worker.dispatch.success` / `.retry` / `.dead_letter` breadcrumbs end-to-end before closing Task 11.

**14f. R2 lifecycle policy for orphan upload pendingKeys.**
Files: `docs/ops/r2-lifecycle.md` (new), Cloudflare dashboard config. Init creates a `pendingKey` with a 15-minute TTL in DB but the R2 object can persist if finalize never runs. Set bucket lifecycle rule: delete objects under `pending/` prefix older than 24h. Verification: run a one-off `aws s3 ls` post-rollout to confirm `pending/` doesn't accumulate.

Verification of Task 14 as a whole: a `docs/launch/production-readiness-checklist.md` checks off all six sub-items before Task 13's beta invites go out.

---

## Estimated effort

Task 0 (cleanup): 0.5d, mechanical. Tasks 1–2 (in-app browser, HEIC): 1.5d combined — both touch the contributor page and need real device testing. Tasks 3–4 (saves + bulk save): 2d — bulk save is the heaviest UX task, plus device-test cycle. Task 5 (attribution): 0.5d. Tasks 6–7 (expiry + verification): 1.5d, mostly lifting from Phase 6. Task 8 (geofence): 1d, plus a counsel-review wait that's wall-clock, not work-time. Task 9 (consent): 0.5d. Task 10 (deletion): 1d. Task 11 (Sentry/uptime/on-call): 1d. Task 12 (first-match): 0.5d. Task 13 (postmortem): 0.5d focused over 1–2 weeks of beta. **Task 14 (production gaps): 1.5d** — rate limit (0.5), Resend domain (0.5 + DNS wall-clock), CSP middleware (0.25), revocation UI (0.25), R2 lifecycle (0.05). **Total focused work: ~12 dev-days. Realistic calendar: 4–5 weeks for solo founder.** Counsel review on the privacy policy + Illinois geofence approach is the long pole if it isn't already in flight; DNS verification on `mail.phostro.com` is the second-longest pole.

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
