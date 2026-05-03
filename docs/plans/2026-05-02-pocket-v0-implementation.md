# Pocket v0 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Date:** 2026-05-02
**Phase:** Pocket v0 (supersedes Phases 4–6 of `2026-04-27-photo-courier-implementation.md` for the v0 scope)
**Status:** Ready for implementation. Demand validated by manual Google Photos test (7 contributors / 50-person chat = 14% contribution rate). Recognition pipeline (Phase 3) carries forward unchanged.
**Predecessor:** Phase 3 (Recognition Pipeline). Successor: Pocket v1 (post-launch hardening) → Pocket Platform (the original host-broadcast plan, deferred).

---

## Why this plan exists (read first)

The original implementation plan (`2026-04-27-photo-courier-implementation.md`) builds **host-broadcast Photo Courier**: a host uploads photos for an event, attendees enroll faces, and a recognition worker matches photos to attendees. Six phases, ~6 months, mostly pre-revenue.

Office-hours session on 2026-05-01 surfaced a different product the founder *actually has a current personal need for*: **receiver-pooled gathering** — the receiver creates a bucket, takes one selfie, sends a share link, contributors drop photos with no account, recognition filters the contributions to the receiver's face. Validated by the founder running a no-code Drive/Google-Photos analog of the contributor flow and getting 7 contributors out of a 50-person grad chat.

Pocket v0 is the receiver-pooled product. It reuses Phase 1 (auth/foundation), Phase 2 (R2 upload + preview pipeline), and Phase 3 (recognition worker — current branch). It replaces the planned Phase 4 (multi-angle attendee enrollment + matching) with a simpler owner-only enrollment + single-bucket filter. Phases 5 and 6 (gallery tabs, notifications, cleanup) are mostly deferred or simplified.

**Design doc this plan implements:**
`/Users/ivanma/.gstack/projects/ivanma9-phostro/ivanma-phase-3-recognition-design-20260501-officehours.md`

> **Note:** the design doc lives outside the repo (founder-local). This plan is the authoritative spec for implementers. If anyone other than the founder picks up this work, copy the relevant decision rationale from the design doc into `docs/design/pocket-v0-rationale.md` first.

---

## End state of Pocket v0

The founder can:

1. Sign in to phostro and tap **+ New Pocket** on the home screen.
2. Name the pocket (e.g. "ivan grad"), take a selfie or pick from camera roll, get a face-quality score, confirm.
3. Tap **Copy share link** → paste into iMessage/WhatsApp → send to friends.
4. Open the pocket later and see a **You** feed of contributed photos that match their face, ordered by recency.

Anyone with the share link can:

1. Tap link → land on `/p/{token}`.
2. Native photo picker opens immediately.
3. Multi-select photos → tap **Done** → photos upload via signed R2 PUT URL.
4. See "Added X photos to ivan grad" → close tab. No account, no enrollment, no PWA install.

Behind the scenes:

- Each contributed photo enqueues a `photo_jobs` row → Phase 3 worker detects faces and computes 128-d embeddings.
- A **filter** step (new in this plan) compares each detected face's embedding against the pocket owner's stored `users.face_embedding` using pgvector cosine distance. Matches above the threshold are surfaced in the owner's **You** feed.

---

## Exit criteria

Pocket v0 is complete when **all** hold:

1. **End-to-end personal use** — founder uses Pocket v0 to gather grad photos from their own group chat. Hard floor: ≥ 5 photos of themselves retrieved that they did not previously have. Verified by the founder; documented in a `docs/postmortems/pocket-v0-self-use.md`.
2. **Owner flow** — `pnpm test:e2e` includes a Playwright test covering: create pocket → enroll selfie → copy link → see "You" feed populate after a contribution.
3. **Contributor flow** — Playwright test covers: open `/p/{token}` → upload 3 photos → confirm `photos` rows exist with `uploader_token` set and `uploader_user_id NULL`.
4. **Token security** — invalid token → 404. Revoked token → 410. Expired token → 410. Token over `max_uploads` → 429. Each verified by integration test in `tests/integration/share-links.test.ts`.
5. **Filter correctness** — given the labeled bench fixtures from `bench/fixtures/group_shot/`, the filter API returns exactly the photos containing the enrolled face at the production threshold. No false positives in the test set.
6. **R2 contributor uploads work without auth** — signed PUT URL flow tested end-to-end without a user session.
7. **CI green** — pnpm tests, pytest worker tests, and Playwright e2e all pass on GitHub Actions.

---

## Explicitly deferred — not in Pocket v0

Do **not** unblock these. They belong to Pocket v1 (hardening) or Platform (v2).

**Deferred to Pocket v1 (post-self-use, pre-public):**

- Multiple owners per pocket / shared "You" feeds.
- Per-photo "saved" state and bulk download.
- "Maybe you" tier (only `match` / `no_match` in v0; threshold is binary).
- Contributor attribution UI (the schema supports it via `contributor_display_name`, but the v0 contributor page does not ask for it).
- Notifications when new matches arrive.
- Cleanup / expiry job (pockets do not auto-expire in v0; manual delete only).
- In-app browser detection ("Open in Safari" prompt for Instagram/Facebook in-app browsers — punt to v1 unless Playwright catches a real failure).

**Deferred to Pocket Platform (v2, the original plan):**

- Host-broadcast event mode (host uploads → attendees enroll → matching to many users).
- `event_members` writes for non-owner roles.
- Gallery tabs (`You` / `By Me` / `Other`).
- `visibility_mode` enums beyond `personal`.
- Multi-angle enrollment.
- `face_clusters.claimed_by_user_id` workflow.
- Email notification triggers, T+5min first-match emails.

**Never:**

- Cross-pocket / cross-event face linking (privacy invariant).
- Storing contributor face embeddings without their consent (v0 only stores embeddings of detected faces in contributed photos; nothing maps a face back to an identity unless the pocket owner enrolls).

---

## Kickoff decisions

1. **Pocket is the v0 product.** The original Phase 4–6 work is paused. Phase 1–3 work carries forward unchanged.
2. **Single-owner buckets only in v0.** Each pocket has exactly one `owner_user_id` (= `events.host_user_id`). Multi-owner is v1.
3. **Stateless tokens, with a `share_links` table for revocation.** Token format: HMAC-signed `{eventId, expiresAt}` (reuses worker `/detect` HMAC machinery). Server lookups verify against `share_links.token_hash` for revocation, expiry, and `max_uploads`. Token is shown to user once; only the hash is stored.
4. **Anonymous contributions: nullable `photos.uploader_user_id` + new `photos.uploader_token` text.** CHECK constraint enforces XOR. Existing photos are unaffected.
5. **Filter, not match.** v0 does not run cluster-to-user assignment. The filter is a single SQL query: for each `face_detection` row in this pocket's photos, compute cosine distance to the owner's `users.face_embedding`; surface photos where any detection beats the threshold.
6. **Reuse Phase 3 thresholds verbatim.** Whatever `worker/config/thresholds.json` lands at end of Phase 3 is what Pocket v0 uses. The Task 9 bench run is a *verification* step (gate: zero false positives on the labeled set); recall is recorded but not a blocker. No tuning of the threshold inside this plan — if recall is too low in self-use, that lives in the v1 postmortem follow-up.
7. **One enrollment selfie in v0.** Multi-angle deferred to v1 unless single-angle recall in self-test is below 60%.
8. **Existing event-shape kept.** A pocket *is* an `events` row with `visibility_mode='personal'`. No `pockets` table — semantic-only rename in the UI.

---

## Open questions (resolve during build)

1. **Contributor IP rate limit value.** v0 ships with *some* rate limit on contributor uploads to defeat trivial abuse. Number TBD — start with 100 photos / IP / hour, revisit if real users complain.
2. **What happens if the contributor uploads a photo with no detected faces?** Two options: (a) accept and store anyway (it might be a venue shot the owner wants), (b) reject with "no faces found" message. v0 default: accept. Surface only in "All contributions" view (not in "You" feed). The "All" view is itself a v1 feature; v0 just stores them.
3. **Token URL format.** `/p/{token}` or `/p/{eventId}/{token}`? Former is shorter and leaks no event ID; latter is debuggable. Recommend former.
4. **iOS Safari upload size limit.** iOS imposes ~50MB per upload via web. Need to test multi-photo selection of large iPhone HEIC photos. May need client-side resize before PUT.

---

## Cross-phase contracts

**Phase 2 produces (Pocket v0 consumes):**

- `lib/photos/r2.ts:createPresignedPutUrl(key, contentType, ttl)` — Pocket v0 calls this from the contributor upload endpoint to mint signed PUT URLs without a user session.
- `app/api/events/[id]/photos/finalize/route.ts` — the finalize hook that enqueues `photo_jobs`. Pocket v0 wires the contributor upload through this same finalize path; no new finalize logic.
- `photos.processing_state` state machine — Pocket v0 reads `'ready'` state, never writes.

**Phase 3 produces (Pocket v0 consumes):**

- `face_detections` rows with 128-d embeddings, populated by the worker.
- HMAC machinery in `worker/auth.py` and the corresponding Next.js helper — Pocket v0 reuses the same HMAC for share-link token signing (different signing key; same algorithm).
- `worker/config/thresholds.json` — `match` threshold value used by the filter.

**Pocket v0 produces (Pocket v1 / Platform consumes):**

- `share_links` table — Platform extends with multi-owner roles.
- Filter API at `app/api/events/[id]/you/route.ts` — Platform reuses for the "You" gallery tab; just iterates over many enrolled users.

---

## Tasks (in shippable order)

Each task is sized for ~half a day to one day of focused work. Tests-first where the spec is well-defined; manual verification where UX matters more than correctness.

### Task 1 — Schema delta + migration

**Files:** `db/schema.ts`, new Drizzle migration in `drizzle/`
**Why:** Foundation for every other task.

Changes:

- `photos.uploader_user_id` → nullable.
- `photos.uploader_token` → new `text` column, nullable.
- CHECK constraint: `(uploader_user_id IS NOT NULL) <> (uploader_token IS NOT NULL)` (XOR; exactly one set).
- `photos.contributor_display_name` → new `text` column, nullable. (For v1; safe to add now.)
- Index `photos_uploader_event_idx` → make partial: `WHERE uploader_user_id IS NOT NULL`.
- New `share_links` table per the design doc.

**Done when:** `pnpm db:migrate` succeeds against the dev DB; `pnpm test` passes.

### Task 2 — Share-link token helpers

**Files:** `lib/share-links/token.ts`, `lib/share-links/storage.ts`, `tests/unit/share-links.test.ts`

Helpers:

- `mintShareLink(eventId, opts)` — generates token, inserts row, returns full URL token.
- `verifyShareLink(token)` — looks up by hash, checks not revoked / not expired / under `max_uploads`. Returns `{eventId, linkId}` or throws.
- `revokeShareLink(linkId)`.

**`upload_count` accounting (single rule):** the counter is incremented exactly once, in the same DB transaction as the photo's `processing_state` transition to `ready` in finalize (Task 3). No counting at PUT-URL mint time, no counting in `verifyShareLink`. Abandoned PUTs do not burn the budget; double-finalize is idempotent because the state transition guards itself. This means `verifyShareLink` must enforce `upload_count < max_uploads` *at finalize time*, not at mint time — re-check inside the finalize transaction.

**Done when:** unit tests cover happy path + all four failure modes (invalid, revoked, expired, exhausted).

### Task 3 — Contributor upload API

**Files:**
- `lib/photos/finalize-core.ts` (extracted helper, see below)
- `app/api/events/[id]/photos/[photoId]/finalize/route.ts` (refactor to call helper)
- `app/api/p/[token]/init/route.ts` (new)
- `app/api/p/[token]/finalize/[photoId]/route.ts` (new)
- `tests/integration/contributor-upload.test.ts`

**Step 3a — Extract `finalizePhotoCore`.** The existing owner finalize route at `app/api/events/[id]/photos/[photoId]/finalize/route.ts` does too many things to copy: it claims the row, validates `pendingKey`, runs Sharp, writes R2, transitions state, and enqueues the worker job. Extract its body into:

```ts
finalizePhotoCore(photoId, { actor: { kind: 'user', userId } | { kind: 'token', linkId } })
```

The helper does the state machine + processing; the actor parameter only changes (a) the authorization check at the top (owner: `uploaderUserId === userId`; token: `uploaderToken === <token-from-link>`) and (b) whether `share_links.upload_count` is incremented in the same transaction as the `ready` transition. Both routes become thin wrappers.

**Step 3b — Contributor init endpoint.** `POST /api/p/[token]/init`:

- Verify token via `verifyShareLink`.
- Insert a new `photos` row with `event_id` from the link, `uploader_token = <raw-token>`, `uploader_user_id = NULL`, `processing_state = 'pending'`, `pending_key = <generated>`, `pending_expires_at = now + 15min`. Mirrors whatever the owner init path already does (find that helper and reuse it; if it does not exist as a helper yet, extract it the same way as 3a).
- Mint a signed PUT URL via `createPresignedPutUrl(pending_key, ...)`.
- Return `{uploadUrl, photoId}`.

**Step 3c — Contributor finalize endpoint.** `POST /api/p/[token]/finalize/[photoId]`:

- Verify token, look up the photo, check `photo.uploaderToken` matches the verified link.
- Re-check `upload_count < max_uploads` *inside the finalize transaction* (see Task 2).
- Call `finalizePhotoCore(photoId, { actor: { kind: 'token', linkId } })`.

**Done when:** integration test uploads 3 photos via init → PUT → finalize, asserts photos exist with `uploader_token` set and `uploader_user_id NULL`, asserts `share_links.upload_count` equals the count of finalized photos (not init calls), and a `photo_jobs` row exists per finalized photo. Also asserts the existing owner finalize route still passes its tests after the refactor.

### Task 4 — Contributor page

**Files:** `app/p/[token]/page.tsx`, `app/p/[token]/loading.tsx`, `app/p/[token]/error.tsx`

UX:

- Server-renders with token verification (404/410 if bad).
- One-line context: "Ivan asked for grad photos."
- Big **Add Photos** button → triggers `<input type="file" multiple accept="image/*">`.
- Upload progress per file; on completion: "Added X photos."
- No login. No account creation. No "tell us your name."

**Done when:** Playwright e2e test (Task 11) covers the flow.

### Task 5 — Owner enrollment endpoint

**Files:** `app/api/me/face/route.ts`, `tests/integration/owner-enrollment.test.ts`

POST endpoint accepting one selfie:

- Calls existing worker `/detect` and `/embed` endpoints (HMAC).
- **Reject if not exactly one face with `confidence > 0.9`.** Multiple faces → `400 { error: 'multiple_faces' }`. Zero qualifying faces → `400 { error: 'no_face' }`. UI prompts a retake. Rationale: the founder is the only enrolled user in v0; one bad enrollment poisons every match in the You feed forever. The friction cost of "retake your selfie" is near-zero; the failure cost of silently enrolling a background face from a group selfie is catastrophic.
- On the single-face success case, write its embedding to `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`.
- Returns `{quality}` on success; `{error}` on rejection.

**Done when:** integration test covers three cases — single-face fixture writes an embedding; group-selfie fixture returns `multiple_faces`; landscape fixture returns `no_face`. Re-enrollment overwrites the previous embedding.

### Task 6 — Pocket creation flow

**Files:** `app/pockets/new/page.tsx`, `app/api/pockets/route.ts`

UX (5 taps as designed):

- Step 1: name input → Next.
- Step 2: selfie capture (or upload) → POST to `/api/me/face` → confirm.
- Step 3: server creates the `events` row (`visibility_mode='personal'`, `host_user_id = current user`), mints a share link via `mintShareLink`, redirects to pocket page.

**Done when:** owner can create a pocket; share link is shown and copyable.

### Task 7 — Pocket page (You feed)

**Files:** `app/pockets/[id]/page.tsx`, `app/api/events/[id]/you/route.ts`

GET `/api/events/[id]/you`:

- Verifies caller is the owner.
- Loads owner's `face_embedding`.
- Query (one row per photo, even with multiple matching detections):

  ```sql
  SELECT p.id AS photo_id,
         p.r2_key_preview,
         p.taken_at,
         MIN(fd.embedding <=> $owner_embedding) AS distance
  FROM photos p
  JOIN face_detections fd ON fd.photo_id = p.id
  WHERE p.event_id = $event_id
    AND p.processing_state = 'ready'
  GROUP BY p.id, p.r2_key_preview, p.taken_at
  HAVING MIN(fd.embedding <=> $owner_embedding) < $threshold
  ORDER BY p.taken_at DESC NULLS LAST;
  ```

- Returns `[{photoId, r2KeyPreview, distance, takenAt}]`. Distance is the closest detection's distance; never duplicate photo rows.

Page:

- Header: pocket name + "Share link" button.
- Grid of preview thumbs.
- Tap thumb → full-size view with download.

**Done when:** filter returns expected photos for the bench fixture (Task 9 below) and Playwright test passes.

### Task 8 — Worker filter wiring

**Files:** `worker/main.py` (no change expected), or new endpoint if filter needs to run on the worker side.

Decide during build: does the filter run as a SQL query in Next.js (using pgvector `<=>` operator), or as a worker call? **Default: SQL in Next.js.** pgvector cosine distance is fast enough at v0 scale, and avoids a worker round-trip for every page load.

**Done when:** Task 7's page loads in < 500ms with 100 detections in the pocket.

### Task 9 — Filter correctness on bench fixtures

**Files:** `tests/integration/filter-correctness.test.ts`

Setup:

- Seed a test pocket with one of the labeled identities from `bench/fixtures/group_shot/`.
- Enroll that identity's reference selfie as the owner.
- Insert all `group_shot` photos as contributions.
- Run worker → wait for jobs to succeed.
- Hit the filter endpoint.

Assertions:

- **Gate (must pass):** zero false positives — every photo the filter returns is in the labeled set for that identity.
- **Advisory (recorded, does not fail the test):** recall = `|returned ∩ labeled| / |labeled|`. Print the value to test output. If < 0.6, log a warning, but do not fail. Per kickoff #6, threshold tuning is out of scope for v0.

**Done when:** the precision gate passes with current Phase 3 thresholds; recall is logged.

### Task 10 — Token-failure paths

**Files:** `tests/integration/share-links.test.ts` (extend Task 2 unit tests)

Cases:

- Invalid token → 404.
- Revoked → 410.
- Expired → 410.
- Over `max_uploads` → 429.
- Tampered token (HMAC fails) → 404.

**Done when:** all five cases pass.

### Task 11 — End-to-end Playwright tests

**Files:** `e2e/pocket-owner.spec.ts`, `e2e/pocket-contributor.spec.ts`, `e2e/pocket-combined.spec.ts`, `.github/workflows/e2e.yml` (extend existing if present).

Owner spec: sign in → create pocket → enroll selfie → copy share link → see empty "You" feed.
Contributor spec: visit share link in fresh context (no session) → upload 3 photos → see "Added 3 photos."
Combined: contributor upload triggers (after worker runs) the owner's "You" feed to populate.

**CI prerequisites for the combined spec:**

- Postgres + pgvector service container (already required by integration tests; reuse).
- R2 mock or real R2 with a CI-scoped bucket (decide during build; mock preferred to keep CI hermetic).
- Worker process started before the spec runs. Concretely: `docker compose -f docker-compose.ci.yml up -d worker` (or equivalent) inside the workflow `before` step. The spec must not start the worker itself; CI owns its lifecycle.

**Deterministic wait strategy in the combined spec:**

- After the contributor uploads, do not `waitForTimeout`. Instead poll `GET /api/events/[id]/you` (or a dedicated `GET /api/events/[id]/photos?status=ready` debug endpoint) on a 500ms interval, with a hard cap of 30s. Test fails if the cap is hit.
- Alternative if a polling endpoint feels heavy: hit `GET /api/debug/photo-jobs?eventId=...` and wait until every job for the event is `done` or `failed`. Pick one and document it in the spec file.

**Done when:** both specs and the combined spec pass in CI three runs in a row (flake check).

### Task 12 — Self-use & postmortem

**Files:** `docs/postmortems/pocket-v0-self-use.md`

Founder uses Pocket v0 for a real ask:

- Either: re-run the grad photo gather with Pocket instead of Google Photos (if some grad pics are still on friends' phones).
- Or: pick a different recent event and gather from scratch.

Postmortem captures:

- How many contributors / photos / matched photos.
- What broke / felt wrong.
- Whether the founder would use Pocket again next time, or default back to Google Photos + manual scrolling.
- Honest verdict on whether v1 work is justified.

**Done when:** postmortem committed; verdict line is a clear yes/no/maybe with one paragraph of reasoning.

---

## Estimated effort


| Task                       | Effort                         | Notes                                                      |
| -------------------------- | ------------------------------ | ---------------------------------------------------------- |
| 1 — Schema                 | 0.5d                           | Mechanical                                                 |
| 2 — Token helpers          | 0.5d                           | Tests-first                                                |
| 3 — Contributor API        | 1d                             | New auth-less path is the tricky bit                       |
| 4 — Contributor page       | 0.5d                           | Plain HTML; no styling beyond Tailwind defaults            |
| 5 — Enrollment endpoint    | 0.5d                           | Reuses worker                                              |
| 6 — Pocket creation        | 1d                             | Three-step flow + selfie capture is the most UX-heavy task |
| 7 — Pocket page + You feed | 1d                             | pgvector query + grid view                                 |
| 8 — Filter wiring          | 0.25d                          | Decide-during-build                                        |
| 9 — Bench correctness      | 0.5d                           | Labeled fixture seed                                       |
| 10 — Token failure paths   | 0.25d                          | Extends Task 2                                             |
| 11 — Playwright e2e        | 0.5d                           | Two specs                                                  |
| 12 — Self-use & postmortem | 0.5d (over a week of real use) | Forcing function                                           |


**Total focused work:** ~7 dev-days. Realistic calendar time: 2 weeks for solo founder also doing other things.

---

## Decision rule at end of Pocket v0

After Task 12 postmortem, decide:

- **Founder would use Pocket again** → ship Pocket v1 (rough edges, in-app browser handling, multi-photo dl, attribution UI). Then start cold-sharing with non-friend networks to test the social-ask premise on weaker ties.
- **Founder would default back to Google Photos + manual scrolling** → recognition is not solving a real-enough problem at receiver scale. Re-open `/office-hours`. Reconsider Approach D (B2B photographer tool) or shelve phostro.
- **Mixed** → identify the single biggest friction point in the postmortem and decide whether Pocket v1 can fix it. If not, see above.

---

## Anti-scope (things to not do during this plan)

- Do not migrate to a different ML stack.
- Do not add B2B photographer features.
- Do not build a marketing site.
- Do not implement consent modals beyond a one-line "by uploading you agree…" link in the contributor page footer.
- Do not implement Illinois geofencing or any biometric-law screening — v0 is closed-friends use only; the founder is the only enrolled user.
- Do not add "Maybe you" tier to the You feed — binary match in v0.
- Do not write any Phase 5 / Phase 6 code from the original plan.

