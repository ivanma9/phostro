# Pocket edition — code migration audit

**Date:** 2026-05-04
**Status:** Audit only. No code changes. Pick up later when scoping Pocket v0 cleanup or Pocket v1.
**Scope:** Catalog the legacy "events" surface that still co-exists with the new "pockets" surface on branch `pocket-v0`, so a future PR can prune cleanly.

---

## DB migrations: clean

- 8 SQL migrations in `db/migrations/`, journal `_journal.json` in sync.
- `db/schema.ts` last touched in `96dbd12` alongside `0007_nosy_leper_queen.sql` (Pocket v0 schema delta: `share_links` table, nullable `photos.uploader_user_id`, new `uploader_token` + `contributor_display_name`, `photos_authorship_check` XOR constraint).
- No drizzle drift detected.

**Action:** none.

---

## Code migrations still pending

The Pocket v0 plan (`2026-05-02-pocket-v0-implementation.md`) defers host-broadcast (the Phase 4 `EventCreateForm` flow) to Pocket Platform v2, but the legacy `/events/*` routes, components, and tests are still mounted alongside the new `/pockets/*` and `/p/[token]/*` surfaces. Underlying DB term `events` is intentional and stays — a pocket is just an `events` row with `visibility_mode='personal'`. Only the user-facing surface needs renaming, and the broadcast-model paths need to be deleted or kept as dead code.

### 1. Home page rebrand

`app/(app)/page.tsx:21-23`
- Heading "Your events"
- Link "+ New event" → `/events/new`
- Item links → `/events/${id}`

Should become: "Your pockets" / "+ New pocket" / `/pockets/new` / `/pockets/${id}`. The underlying query of the `events` table is fine.

### 2. Legacy `/events/*` route tree (dead in v0, still mounted)

| File | Status |
|---|---|
| `app/(app)/events/[id]/page.tsx` | already redirects to `/pockets/${id}` (uncommitted) |
| `app/(app)/events/new/page.tsx` | dead — uses `EventCreateForm` |
| `app/(app)/events/[id]/join/page.tsx` | dead — Phase-4 attendee join |
| `app/api/events/route.ts` POST | dead — host_only/open_pool creation |
| `app/api/events/[id]/route.ts` GET | dead — member-gated fetch |
| `app/api/events/[id]/photos/init/route.ts` | dead — owner upload, superseded by `/api/p/[token]/init` |
| `app/api/events/[id]/photos/[photoId]/finalize/route.ts` | dead — superseded by `/api/p/[token]/finalize/[photoId]` |
| `app/api/events/[id]/you/route.ts` | check usage; possibly fed by pocket page server-side instead |

**Decision required:** delete vs. keep as dead code.
- Delete reduces surface area and removes confused entry points.
- Keep is only justified if Phase-4 broadcast re-emerges before v2 starts (the v2 plan can also reintroduce these from history).

### 3. Components dead if (2) is deleted

- `components/EventCreateForm.tsx` — only consumer is `app/(app)/events/new/page.tsx`
- `components/UploadDropzone.tsx` — only consumer was `app/(app)/events/[id]/page.tsx`, which is now a redirect
- `components/ShareLink.tsx` — same. `components/MintShareLink.tsx` is the v0 replacement.

### 4. Lib code dead if (2) is deleted

- `lib/events/join.ts` — only `tests/events/join.test.ts` and the join page reference it
- `lib/photos/gallery.ts` `listMyPhotos` — replaced by `lib/photos/you-feed.ts` `listYouFeed`
- `lib/photos/upload-client.ts` — dual-mode `UploadTarget = { kind: 'event' } | { kind: 'token' }`. Keep the file and trim the `'event'` branch; `ContributorUpload.tsx` still uses the `'token'` branch.

### 5. Tests targeting the legacy surface

- `tests/api/events-create.test.ts`
- `tests/api/events-get.test.ts`
- `tests/api/photos-init.test.ts`
- `tests/api/photos-finalize.test.ts`
- `tests/events/join.test.ts`
- `tests/photos/gallery.test.ts`
- `tests/photos/upload-client.test.ts` — partial, the `'event'` mode cases only

---

## Uncommitted work-in-progress at audit time

`git status` on `pocket-v0`:

| File | Change | Notes |
|---|---|---|
| `.env.example` | adds iron-session length comment | safe to commit |
| `lib/auth/session.ts` | 32-char min check for `SESSION_SECRET` | good defensive fix; introduces `getSession (` (space before paren) — verify Biome lint before commit |
| `app/(app)/events/[id]/page.tsx` | redirect events → pockets | safe to commit |
| `docs/plans/2026-04-27-photo-courier-phase-4.md` | 382+/245- rewrite of the deferred phase | doc-only, no code impact |

---

## Suggested follow-up PRs

**PR A (small, low-risk) — rebrand + commit WIP**
- Update `app/(app)/page.tsx` for the pocket nomenclature.
- Commit the four uncommitted files above (after Biome-fixing `session.ts`).

**PR B (delete-only) — prune legacy surface**
- Remove items 2–5 in one drop.
- Hold until the team commits to deferring Phase-4-style broadcast to Pocket Platform v2.
- Skip if you want a v2 escape hatch in current source (history is always a fine escape hatch).
