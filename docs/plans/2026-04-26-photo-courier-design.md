# Photo Courier — Design Document

**Date:** 2026-04-26
**Status:** Draft, ready for implementation planning

## One-line pitch

A face-aware photo courier for events. The host shares a link, attendees dump photos in for a few days, and everyone walks away with the photos *of them* — then it cleans itself up.

## Mental model

WeTransfer for events × Face ID. Not a destination, not a vault — a transfer mechanism with a built-in sorter. Photos live in your camera roll after the handoff. We just move them.

## Foundational decisions

| Question | Decision | Reasoning |
|---|---|---|
| Primary user | Event attendee | Wider audience than organizers; both growth surface and value surface |
| Wedge | Face-rec retrieval ("see only photos of you") | Differentiates from Google Photos / shared albums |
| Initiation model | Host creates event, shares link | Most tractable, matches existing mental models |
| Identity model | One unified account, magic-link auth, face enrollment as optional upgrade | Most uploaders are also retrievers; collapses two flows into one |
| Enrollment style | Face ID-style multi-angle capture (5-7 frames) | Better accuracy, sets clear consent tone |
| Cross-event scope | Per-event matching only — no global discovery | Avoids BIPA/GDPR landmines and consent ambiguity |
| Platform | PWA-first | Friction kills attendee adoption; native deferred to power-user phase |
| Photo fidelity | Originals stored, compressed served by default | Trust contract; people want their actual photos |
| Visibility model | **Personal** (default): attendees see only photos of them, photos they uploaded, and no-people photos. **Open Pool** and **Host-only** as opt-in modes. | Stronger privacy posture; aligns with courier framing; sharper differentiation vs. Google Photos / shared albums |
| Storage retention | Default 7 days, max 30 days | Courier framing — we are not a vault |
| Storage backend | Cloudflare R2 | Zero egress cost, S3-compatible API, no lock-in |
| Face matching | SFace via ONNX, MIT-licensed | Best free model with permissive license; ~99.6% LFW |
| Detection | RetinaFace (MIT-safe build) | Best detector for group photos with small/angled faces |
| Vector storage | Postgres + pgvector | Single DB, no separate vector store needed at this scale |

## Three primary flows

### Flow 1 — Host creates event (paid surface, deferred monetization)
1. Sign up (magic-link auth)
2. Name event, pick lifespan (default 7d)
3. Get shareable link, QR code, "Invite contacts" button
4. Live counters on event page: uploads, attendees, photos

### Flow 2 — Attendee joins (unified, lightweight)
1. Tap link → "Add photos" or "See photos of you"
2. Sign up: name + phone/email magic link (~15 sec)
3. Either upload from camera roll, or proceed to face enrollment

### Flow 3 — Face enrollment (optional upgrade — unlocks "photos of me")
1. Multi-angle capture prompt (front, left, right, up, down + 1-2 mid-angles)
2. Quality check on capture variance; retry if too inconsistent
3. Embedding centroid stored as user's `face_profile`
4. Returns to gallery: "23 photos of you" → bulk save to camera roll

## Lifecycle phases (UI mirrors these)

- **Day 0-2 — Active:** uploads pouring in, real-time counters, "Sarah just added 12 photos"
- **Day 3-5 — Retrieval:** "Your gallery is ready — 23 photos of you"
- **Day 6-7 — Closing:** "Photos expire in 48 hours" notifications; host can extend once for free (+7d); host can download a single zip archive of the event before expiry

## Data model

```
User
  id, name, phone_or_email (verified), created_at
  face_profile: {embedding (vector(128)), quality_score, enrolled_at} | null

Event
  id, host_user_id, name, created_at,
  lifespan_days (default 7, max 30), expires_at,
  extension_used (bool),
  visibility_mode (personal | open_pool | host_only, default personal),
  settings

EventMember
  (event_id, user_id), role (host|attendee), joined_at
  // Joining is implicit on first upload OR first "see my photos" tap

Photo
  id, event_id, uploader_user_id, taken_at, uploaded_at,
  r2_key_original, r2_key_preview, width, height,
  has_detected_faces (bool, set by worker after detection),
  deleted_at | null

FaceDetection
  id, photo_id, bbox, embedding (vector(128)), cluster_id | null

FaceCluster
  id, event_id, representative_thumb, representative_embedding (vector(128)),
  claimed_by_user_id | null
  // Per-event scoped; never global

PhotoView
  (user_id, photo_id), viewed_at
  // Tracks first time a user opened/viewed a photo

PhotoSave
  (user_id, photo_id), saved_at
  // Tracks when a user initiated a save-to-camera-roll
  // Powers diff-download UX and "X new photos of you" notifications
```

## Recognition pipeline

```
Photo uploaded → R2 (presigned URL, direct from client)
  ↓ R2 event → SQS / queue
Worker (CPU-only, single small VPS at launch)
  1. Generate compressed preview (~2048px, ~500KB) → R2
  2. RetinaFace detection → bounding boxes
  3. For each face: align crop → SFace ONNX → 128-d embedding
  4. Insert FaceDetection rows into pgvector
  ↓
Incremental clusterer (every 2 min during Active phase)
  → Cosine-similarity grouping within event (threshold ~0.55)
  → Update/create FaceCluster rows
```

### Enrollment

1. PWA captures 5-7 frames during head-rotation prompt
2. Frames uploaded to ephemeral endpoint (auto-deleted from R2 after embed)
3. Server detects + embeds each frame → centroid + variance
4. If variance too high → reject with "let's try that again"
5. Store centroid as `User.face_profile.embedding`

### Matching at retrieval

```sql
SELECT cluster_id
FROM face_clusters
WHERE event_id = $1
ORDER BY representative_embedding <=> $user_embedding
LIMIT 5;
```

Top matches above 0.55 cosine similarity → "your" clusters → gallery shows photos containing those clusters' detections.

### Recognition service interface (the swap-out layer)

```python
class RecognitionService:
    def detect(photo_bytes) -> list[FaceDetection]
    def embed(face_crop) -> np.ndarray  # 128-d
    def enroll(frames: list[bytes]) -> FaceProfile
    def match(profile, candidates) -> list[(id, score)]
```

v1 implementation: SFace ONNX. If SFace underperforms on group photos at scale, swap to AdaFace or InsightFace (with commercial license) behind the same interface.

### Courier-tuned cleanup

- Daily cron: events past `expires_at` → delete R2 objects, drop `Photo`/`FaceDetection`/`FaceCluster` rows
- `User.face_profile` persists across events (one-time enrollment); user can delete from profile settings (GDPR)
- Ephemeral enrollment frames deleted from R2 immediately after embedding extraction

## Visibility modes & gallery UX

Different events have radically different privacy norms. Visibility is a host-level setting at event creation.

### Three modes

| Mode | Who sees what | Best for |
|---|---|---|
| **Personal** *(default)* | Attendee sees: photos of themselves, photos they uploaded, no-people photos. **Does not** see photos of other attendees they're not in. Host always sees all. | Weddings, corporate events, parties with strangers, privacy-default |
| **Open Pool** *(opt-in)* | Everyone in the event sees every photo. Classic shared album. | Close friend groups, family vacations, college reunions |
| **Host-only** *(strictest)* | Only host sees the full pool. Attendees see only their face-matched photos. | Photographer client work, sensitive contexts |

### Gallery tab structure

**Personal mode (default):**

| Tab | Contents | Notes |
|---|---|---|
| **You** | Face-matched photos | Default landing tab if enrolled; CTA to enroll otherwise |
| **By Me** | Photos the user uploaded | Always available; uploaders need to see their own contributions |
| **Other** | Photos with `has_detected_faces = false` (food, scenery, decor, the cake) | Everyone sees these |

**Open Pool mode** adds a fourth tab: **All** (every photo, chronological).

**Host-only mode** removes "Other" from attendee view (they only get "You").

### Group photo math under Personal mode

- Photo of 5 people, 3 enrolled → those 3 see it under "You"
- The 2 unenrolled don't see it, but will when they enroll
- The 30 other attendees not in the photo don't see it
- The uploader sees it under "By Me" regardless of who's in it

### Diff-download UX

`PhotoView` and `PhotoSave` tables power smart diff behavior:

- Gallery header: **"23 photos of you · 5 new since Tuesday"**
- Bulk-save default: **"Save 5 new"** (toggle expands to "Save all")
- Per-photo state: subtle checkmark on already-saved
- Empty-state: "All caught up — check back when more photos are added"

Server-side tracking is required (not just localStorage) because:
- Cross-device consistency (download on phone, see "no new" badge on desktop)
- Drives re-engagement notifications ("5 new photos of you" needs server delta)
- Survives clearing browser data

**Honest limitation:** we cannot detect if a user manually deletes from camera roll after saving. "Saved" means "we initiated the save." Re-saving is one tap, so this is acceptable.

### Optional v1.1 escape valve

A per-photo "Share with event" toggle, letting an uploader publish a specific photo to the wider pool even under Personal mode. Useful for the "this turned out so good everyone should see it" case. Defer.

## Stack

- **Frontend:** PWA (Next.js + Tailwind, deployed to Vercel or Cloudflare Pages)
- **Backend:** API (Next.js routes or FastAPI), worker (Python, FastAPI + Celery or RQ)
- **DB:** Postgres + pgvector (Supabase or Neon)
- **Storage:** Cloudflare R2 (zero egress, S3-compatible)
- **Auth:** Magic link via Resend (email)
- **Recognition:** SFace + RetinaFace via ONNX runtime, CPU-only at launch

## Maximizing customer value

**Value = (photos retrieved) ÷ (effort spent).**

1. **Speed of magic.** Photos appear in "your gallery" within ~60 seconds of upload. Worker pipeline tuned for latency.
2. **One-tap bulk save.** Gallery has a single "Save all to camera roll" button.
3. **Originals, not compressed.** People want their actual photos for printing, framing, posting.
4. **Surprise factor.** Notifications lead with "You appear in 12 photos — including some you've probably never seen." Lean into the candid-photo dopamine.
5. **No silent failures.** Uncertain matches show in a "maybe you?" section rather than being excluded. False negatives = lost magic.
6. **Cross-platform parity.** iOS and Android attendees get identical UX. We win by being the neutral ground.

## Maximizing virality

Six native viral surfaces — build all in v1:

1. **The shareable link is the product.** Make the link's preview card gorgeous (OG image with event name, photo count, recognized-attendee thumbnails). Every share is an ad.
2. **The "12 photos of you are waiting" invite.** From the gallery, one tap on an unrecognized face → "Invite this person" → enter phone/email → recipient gets a deep link with face cluster pre-attached. When they enroll, gallery is *already populated*.
3. **Attendee → Host conversion.** After successful retrieval: "Hosting your own thing? Make an event in 30 seconds." Capture the dopamine moment.
4. **Repeat-host loop.** After event closes: "47 photos retrieved by 18 attendees. Plan another?"
5. **Shareable artifacts.** Closing event auto-generates a shareable highlight image. Optional, but every share is distribution.
6. **Group chat dynamics.** Host pastes link in group chat. First upload triggers notification to everyone else: "Sarah just added 12 photos." Activity creates urgency creates participation.

## Notifications

Email-only at MVP. Push notifications deferred (PWA push is fragile on iOS Safari).

- **T+5min after first match:** "You appear in 12 photos from Sarah's birthday — see them"
- **T+1d during Active phase:** "8 new photos of you" (only if delta is meaningful)
- **T-2d before expiry:** "Photos expire in 48 hours — save yours now"
- **T-2h before expiry:** Final reminder
- **Post-event:** "Plan your next event in 30 seconds" (host) / re-engagement nudge (low-engagement attendee)

## Privacy & legal

Biometric data is the legal hotspot. US (BIPA in Illinois, similar laws spreading), EU (GDPR Art. 9 — special category). Real penalties: Google paid $100M for face grouping in Photos (BIPA, 2022). Meta paid $650M (2020).

**Compliance posture:**
- **Explicit informed consent** modal at enrollment — names what's stored, how long, how to delete
- **Privacy policy** that names the embedding model, retention period, third parties (none — SFace self-hosted is the privacy advantage)
- **Per-event consent boundary** — enrollment matches only within events the user has joined
- **Right to delete** — profile settings → "Delete face profile" → embeddings purged immediately, logged
- **Ephemeral enrollment frames** — raw selfie frames deleted from R2 immediately after embedding computed
- **Embeddings encrypted at rest** — Postgres encryption + pgvector (verify combo with DB host)
- **Geofence Illinois at launch** — block at signup with "coming soon" page until counsel reviews ToS and insurance is in place

## Abuse vectors and mitigations

| Vector | Mitigation |
|---|---|
| Anonymous CSAM/NSFW upload | Authenticated uploaders (name + verified contact); PhotoDNA / Safer at ingest (post-MVP, manual moderation acceptable at <1K users); host one-tap delete + block; NCMEC reporting pipeline |
| Stalking ("find photos of X") | Per-event consent boundary; host can require approval for attendee joins; liveness check during enrollment defeats "photo of a photo" attack |
| Fake events to harvest faces | Enrollment is account-level (one-time), not per-event — fake events gain nothing; embeddings never returned to host or other attendees |
| Magic-link / SMS abuse | Aggressive rate limits per IP and per number; hCaptcha on signup; Twilio Verify (built-in fraud protection) over raw SMS when SMS is added |
| Photo theft within event | Intended behavior — event is a shared pool; host can switch to "matched-only" mode where attendees see only their photos |

## Moderation tooling (host-facing)

- Tap any photo → Delete / Report / Block uploader
- Tap any attendee → Remove from event / Block from future events
- "Lock event" → no new uploads, retrieval continues
- "Nuke event" → delete everything immediately

## Operational security baseline

- All face embeddings encrypted at rest
- R2 buckets private; access via short-lived presigned URLs only
- Photos served through Cloudflare with hotlink protection + expiring tokens
- Audit log: enrollments, deletions, moderation actions, failed auth attempts
- Bug bounty post-launch (>1K users)

## What we explicitly defer

- SOC 2 / HIPAA — not required for consumer photo apps
- Two-factor auth — magic links are passwordless and second-factor-ish already
- Region-based data residency — single-region (us-east) until meaningful EU usage

## MVP scope (the wedge, ruthlessly minimal)

The wedge to prove: **"someone opens a link, enrolls their face, sees only photos of them, downloads them."**

### Must-haves

| Capability | Notes |
|---|---|
| Magic-link auth (email) | SMS deferred to v1.1 |
| Host creates event (name + 7d default) | Single screen |
| Shareable link + QR code | Basic OG image |
| Authenticated upload from camera roll | Multi-select, direct-to-R2 presigned PUT |
| Face enrollment (5-7 angle capture, MediaPipe Face Mesh for guidance) | No advanced liveness yet |
| Detection pipeline (RetinaFace) | Single CPU worker is fine at this scale |
| Embedding pipeline (SFace ONNX) | 128-d → pgvector |
| Per-event clustering (cosine similarity ≥0.55) | Incremental, every 2 min |
| Three-tab gallery (You / By Me / Other) | Personal mode default |
| Visibility mode setting at event creation | Personal default; Open Pool opt-in; Host-only deferred to v1.1 |
| `has_detected_faces` flag set by worker | Drives "Other" tab |
| `PhotoSave` tracking + diff-download UX | "5 new since Tuesday", smart bulk-save default |
| One-tap bulk save to camera roll | iOS PWA + Android |
| Auto-expire + cleanup cron | Delete R2 + DB rows at expires_at |
| Email notifications (T+5min, T-2d, T-2h) | Skip push for v1 |
| Privacy policy + consent modal | Real legal review before launch |
| Geofence Illinois | Block at signup, "coming soon" page |

### Explicitly deferred to v1.1+

- Viral invite loop ("invite unrecognized faces")
- Push notifications, SMS auth + invites
- Host-only visibility mode
- Per-photo "Share with event" override under Personal mode
- Host moderation panel (full version)
- PhotoDNA / Safer integration
- Pricing / billing
- Custom branding, vanity URLs, host zip download
- Repeat-host loop / re-engagement
- Native apps

## Suggested 6-week MVP timeline

- **Week 1:** Infra (Postgres+pgvector, R2, Vercel), magic-link auth, basic schema
- **Week 2:** Host event creation, upload flow, R2 lifecycle policies
- **Week 3:** Recognition worker (RetinaFace + SFace ONNX), clustering job
- **Week 4:** Face enrollment UX (multi-angle capture), pgvector matching
- **Week 5:** Gallery, bulk download, email notifications, expiry cron
- **Week 6:** Privacy policy, consent flows, geofence, polish, beta to ~5 friend events

## Success criteria — does the wedge work?

After 30-50 events with ~10 attendees each:

- ≥40% of attendees enroll their face (proves enrollment friction is OK)
- ≥70% of enrolled attendees download at least one photo (proves the magic moment lands)
- ≥30% of hosts create a second event within 60 days (proves it's not single-use)
- Qualitative: "would you use this for your next event?" → yes from majority

If these miss, rethink before scaling. If they hit, build viral loops + monetization in v1.1.

## Open questions for implementation phase

1. Worker hosting choice — Fly.io, Railway, or a small AWS instance?
2. Auth provider — Clerk, Supabase Auth, or roll own magic-link via Resend?
3. PWA framework specifics — Next.js App Router vs. Vite + React?
4. Liveness check approach — MediaPipe blink/depth vs. simple movement-prompt confirmation?
5. RetinaFace runtime — `onnxruntime` Python, or compiled binary for tighter latency?
6. Postgres host — Supabase (auth + storage + DB bundled) vs. Neon (cheaper, DB-only)?

These get answered in the implementation plan, not here.
