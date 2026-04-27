# Photo Courier — Implementation Plan (Codex Version)

**Date:** 2026-04-27
**Status:** Draft
**Source:** Derived from `2026-04-26-photo-courier-design.md`

## Build goal

Ship the smallest version of Photo Courier that proves the product promise from the design doc:

- A host can create an event and share a link in under 2 minutes
- An attendee can sign in, upload photos, or enroll their face in under 30 seconds
- New uploads can show up in the attendee's matched gallery within about 2 minutes
- Attendees can bulk-save originals to their camera roll
- The event expires and cleans itself up without turning into a permanent vault

## Planning principles

1. **Prove the magic before polishing the shell.** The differentiator is reliable "photos of you," not project setup.
2. **Keep biometric scope narrow.** Matching stays event-scoped; personal identity data gets the strongest guardrails early.
3. **Start with the privacy-default product.** Personal mode is the real MVP. Other visibility modes can exist in schema before they exist in UI.
4. **Prefer one simple app plus one simple worker.** Avoid introducing separate queueing or orchestration infrastructure until throughput demands it.
5. **Instrument quality before growth.** We need to know when matching fails before we optimize virality or notification volume.

## Launch scope

### In scope for MVP beta

- Host creates an event, picks lifespan, and shares a join link
- Attendee joins via magic link
- Attendee uploads photos directly to storage
- Worker generates previews, detects faces, stores embeddings, and clusters by event
- Attendee consents to face enrollment and gets a "You" gallery
- Personal mode gallery works end-to-end: `You`, `By Me`, and `Other`
- Bulk save of matched photos
- Expiry reminders, one host extension, and final cleanup

### Explicitly deferred

- Native mobile apps
- Push notifications
- Global face discovery across events
- Video support
- "Invite this person from an unrecognized face" flow
- Shareable closing highlight image
- Per-photo "share with event" override

### Beta simplification

Implement **Personal** mode fully first. Keep `open_pool` and `host_only` in the data model and authorization design, but do not make them launch-blocking for beta. That keeps the team focused on the product wedge and the privacy posture the design doc is centered on.

## Proposed architecture

- **Web app:** Next.js App Router PWA for host, attendee, upload, gallery, and event lifecycle UI
- **App API:** Next.js route handlers for auth, event membership, uploads, gallery reads, and notification triggers
- **Recognition worker:** Python FastAPI service using RetinaFace + SFace through ONNX Runtime
- **Database:** Postgres + pgvector
- **Blob storage:** Cloudflare R2 for originals, previews, enrollment frames, archives
- **Queueing:** Postgres-backed jobs table for launch; move to SQS only if throughput or retry behavior becomes painful
- **Auth:** Magic-link email via Resend
- **Deployment:** Web app on Vercel; worker on Fly.io or Railway; choose after worker cold-start testing

Why this shape:

- It respects the design doc's chosen stack without adding extra moving parts too early
- It keeps app logic and ML logic separated behind a service interface
- It gives us a clean path to swap recognition models later without rewriting the product

## Milestone plan

## Milestone 0 — Feasibility spike and launch constraints

**Goal:** De-risk the two things most likely to sink the MVP: recognition quality and browser behavior.

### Work

- Build a small internal benchmark pack of representative event photos:
  - group shots
  - dim light
  - side profiles
  - varied skin tones
  - low-res candids
- Run RetinaFace + SFace on the pack and record:
  - face detection hit rate
  - false-positive rate
  - rough matching threshold candidates
  - average processing time per photo
- Validate two browser-dependent UX paths:
  - iOS Safari/PWA multi-angle capture
  - bulk-save behavior for multiple photos on iOS and Android
- Draft the enrollment consent language and profile deletion flow before coding the capture UI
- Decide whether worker hosting should be Fly.io or Railway based on cold start and CPU availability

### Exit criteria

- We have a documented threshold strategy for "match," "maybe you," and "no match"
- We know the launch browser caveats up front
- We have a clear go/no-go on the launch recognition stack

### Why it comes first

The design doc's wedge is not event creation; it is trustworthy face retrieval. If that fails, perfect scaffolding does not matter.

## Milestone 1 — Event spine: auth, events, membership, share loop

**Goal:** A host can create an event and an attendee can join it through a real link.

### Work

- Initialize the repo and deployment skeleton
- Add environment validation, logging, and error reporting hooks
- Implement magic-link auth
- Create core tables:
  - `users`
  - `magic_link_tokens` or equivalent session challenge table
  - `events`
  - `event_members`
- Build host event creation flow:
  - event name
  - default 7-day lifespan
  - optional extension eligibility flag
  - shareable link and QR code
- Build attendee join flow:
  - entering from share link
  - authentication checkpoint
  - implicit membership on first upload or first retrieval attempt
- Add a basic event dashboard for the host with zero-state counters

### Exit criteria

- Host can create an event and see a working share link
- Attendee can join the event and appear in membership records
- Event state is durable and deployable

## Milestone 2 — Upload and ingestion spine

**Goal:** Photos reach storage, metadata is registered, and every upload produces a processable job.

### Work

- Add `photos` table with:
  - event ownership
  - uploader ownership
  - original key
  - preview key
  - dimensions
  - capture time when available
  - processing state
- Issue presigned upload URLs for direct-to-R2 uploads
- Register uploaded photos in Postgres
- Extract metadata server-side after upload completes
- Generate preview assets
- Add a Postgres-backed `photo_jobs` table and worker polling contract
- Show uploader-facing progress and host-facing event counters
- Preserve originals; serve previews by default

### Exit criteria

- An attendee can upload a batch of photos from a phone
- Host and uploader can see those uploads land in the event
- Each uploaded photo results in a queued processing job

## Milestone 3 — Recognition pipeline and operator visibility

**Goal:** Every uploaded photo can be processed into faces and event-scoped clusters with enough observability to debug failures.

### Work

- Stand up `worker/` with FastAPI, ONNX Runtime, and model-loading lifecycle hooks
- Implement worker endpoints for:
  - `detect(photo)`
  - `enroll(frames)`
  - optional `health` and `version`
- Add recognition tables:
  - `face_detections`
  - `face_clusters`
- Process each `photo_job` through:
  - preview validation
  - face detection
  - alignment and embedding
  - event-scoped clustering
  - retry / failure classification
- Add internal debug views or admin queries for:
  - unprocessed photos
  - failed jobs
  - cluster counts per event
  - sample matched faces
- Store enough traces to answer "why didn't this photo show up for this person?"

### Exit criteria

- Newly uploaded photos are processed asynchronously without manual intervention
- We can inspect failed detections and poor clusters without direct DB spelunking
- Matching thresholds are backed by the benchmark pack from Milestone 0

## Milestone 4 — Enrollment, consent, and matched retrieval

**Goal:** A user can explicitly consent, enroll, and see a credible first version of "photos of you."

### Work

- Implement consent modal and deletion language from the design doc
- Build multi-angle capture with device guidance
- Upload enrollment frames to an ephemeral path
- Run enrollment through worker:
  - detect face in each frame
  - compute centroid
  - compute variance / quality score
  - reject low-confidence captures
- Store `face_profile` on the user record
- Add retrieval query path:
  - nearest candidate clusters in the current event
  - confidence thresholding
  - optional `maybe_you` bucket for borderline matches
- Enforce event scope strictly: no matching unless user is a member of the event
- Add profile deletion endpoint for stored face embeddings

### Exit criteria

- New attendee can enroll from a phone and see matched results in the same session
- Borderline matches are surfaced safely instead of silently dropped
- Raw enrollment frames are deleted immediately after embedding extraction

## Milestone 5 — Courier gallery, save state, and attendee value loop

**Goal:** Turn raw matches into the experience the design doc actually sells.

### Work

- Implement Personal mode gallery tabs:
  - `You`
  - `By Me`
  - `Other`
- Add `photo_views` and `photo_saves`
- Add "new since last save/view" diff logic
- Build one-tap bulk save with a fallback path for browser limitations
- Mark already-saved items in the UI
- Add empty states and "all caught up" states
- Add event activity cues that matter to attendees:
  - upload counts
  - new-photo delta
  - closing countdown
- Add host archive generation for full-event export before expiry

### Exit criteria

- An enrolled attendee can find, review, and save their matched photos quickly
- A returning attendee can tell whether anything new has arrived
- Host can export the event before cleanup

## Milestone 6 — Expiry, notifications, legal hardening, and beta launch

**Goal:** The product completes the courier promise: active event, retrieval window, reminders, and cleanup.

### Work

- Add event lifecycle jobs:
  - T+5min first-match email
  - daily "new photos of you" email when delta is meaningful
  - 48-hour expiry reminder
  - final reminder
- Add one-time host extension flow
- Build cleanup job that deletes:
  - expired R2 objects
  - photo rows
  - detections
  - clusters
  - temporary enrollment artifacts
- Add privacy policy and consent records
- Geofence Illinois at signup for beta
- Add launch metrics:
  - enrollment rate
  - upload-to-match latency
  - save rate
  - false-match / support-event count
- Run a small beta with real events before exposing non-default visibility modes

### Exit criteria

- A real event can run from creation through expiry with no manual ops cleanup
- We can measure whether the core value loop is working
- Legal and deletion behaviors are testable, not aspirational

## Data model rollout

Build tables in the order they become operationally necessary:

1. **Auth and event core**
   - `users`
   - `magic_link_tokens`
   - `events`
   - `event_members`
2. **Upload and processing**
   - `photos`
   - `photo_jobs`
3. **Recognition**
   - `face_detections`
   - `face_clusters`
4. **Retrieval and notifications**
   - `photo_views`
   - `photo_saves`
   - `notification_deliveries` or equivalent send ledger

That ordering keeps migrations aligned with working software rather than anticipating every phase on day one.

## Testing strategy

### Product and API

- Unit tests for token, authorization, filtering, and diff logic
- Integration tests for auth, event membership, upload registration, and gallery queries
- End-to-end tests for three full journeys:
  - host creates event
  - attendee joins and uploads
  - attendee enrolls and retrieves matched photos

### Recognition

- Fixture-based tests for detection, embedding, clustering, and enrollment quality checks
- Contract tests between Next.js and worker payloads
- Benchmark snapshots stored alongside threshold decisions so threshold changes are intentional

### Operational

- Staging smoke test for expiry cleanup
- Failure-path tests for dead jobs, bad uploads, and no-face photos
- Manual device testing on iPhone Safari and Chrome on Android before beta

## Key product decisions to lock before coding too far

- Whether beta exposes only email magic links or includes phone login
- Whether host-only and open-pool are schema-only or partially live in beta
- What confidence band becomes `maybe_you`
- Whether host archive is built in MVP or immediately after beta
- Whether event activity notifications are immediate or batched

## Recommendation

Use this plan as the roadmap because it sequences work around product risk and launch viability. Once a milestone is chosen, it can be decomposed into the kind of file-by-file execution checklist that the existing implementation doc is better at producing.
