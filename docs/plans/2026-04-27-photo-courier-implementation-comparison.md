# Photo Courier — Implementation Plan Comparison

**Date:** 2026-04-27
**Compared documents:**

- `2026-04-27-photo-courier-implementation-codex.md`
- `2026-04-27-photo-courier-implementation.md`

## Short version

The existing implementation doc is a strong execution checklist for bootstrapping the repo and shipping Phase 1. My version is a stronger roadmap for deciding **what to build first** and **what must be proven before the project is worth scaling**.

## Where they align

- Both plans keep the core product shape from the design doc:
  - PWA-first web product
  - magic-link auth
  - Cloudflare R2 storage
  - Postgres + pgvector
  - Python recognition worker using RetinaFace + SFace
- Both plans assume a host-created event and an attendee-facing retrieval flow
- Both plans preserve event-scoped matching and cleanup-oriented retention
- Both plans treat notifications and expiry as part of the MVP, not a later add-on

## Main differences

## 1. Sequencing philosophy

### Existing implementation doc

- Spends most of its detail budget on Phase 1 repo setup, auth, schema, and event creation
- Leaves Phases 2-6 as outlines until later

### Codex version

- Starts with a feasibility spike for recognition quality, browser behavior, and consent constraints
- Pushes detailed setup behind the question "can the core magic actually work well enough to launch?"

### Why this matters

The design doc's real risk is not scaffolding. It is whether attendees reliably get the right photos on real devices with acceptable latency and acceptable privacy posture.

## 2. Definition of MVP

### Existing implementation doc

- Treats "working app shell plus host event creation" as the fully expanded first milestone
- Carries all visibility modes in schema early, but the attendee value loop arrives later

### Codex version

- Defines MVP around the full courier promise:
  - upload
  - process
  - enroll
  - retrieve
  - save
  - expire
- Recommends shipping beta with **Personal mode only** even if the schema is future-ready

### Why this matters

The design doc is unusually opinionated that privacy-default behavior is part of the product wedge. Personal mode should be first-class, not just one of several modes.

## 3. Granularity

### Existing implementation doc

- Very concrete
- Names files, packages, commands, tests, and commit boundaries
- Easy to execute step by step

### Codex version

- Organized around milestones, exit criteria, and launch gates
- Better for deciding scope and dependencies
- Less useful as a literal implementation checklist without a second pass

### Why this matters

These docs serve different jobs. One is a roadmap; the other is a build script for humans.

## 4. Risk management

### Existing implementation doc

- Includes sensible tech choices and some later-phase open questions
- Defers several meaningful launch risks until phase boundaries

### Codex version

- Pulls risk discovery forward:
  - ML benchmark pack
  - device/browser validation
  - operator debug tooling
  - cleanup verification
  - consent and deletion wording before enrollment UI polish

### Why this matters

Face products fail in the gray areas: borderline matches, ugly lighting, mobile browser constraints, and deletion/compliance gaps. Those deserve first-class planning.

## 5. Queue and operations strategy

### Existing implementation doc

- Leaves SQS vs. Postgres queue as an open question
- Focuses initial detail on app-side implementation

### Codex version

- Explicitly recommends Postgres-backed jobs for launch and a later migration only if needed
- Adds internal debugging and failure visibility as milestone requirements

### Why this matters

For an MVP, failed or silent jobs are more dangerous than imperfect scalability.

## What I would keep from the existing implementation doc

- The concrete package choices are mostly sensible
- The file-by-file Phase 1 breakdown is useful once the team decides to execute that milestone
- The emphasis on tests, CI, and small commits is good discipline for an empty repo

## What I would change before using the existing implementation doc as the primary plan

- Add a pre-implementation feasibility milestone for recognition quality and mobile browser behavior
- Tighten the MVP definition around Personal mode and the complete attendee value loop
- Add explicit exit criteria for matching quality, processing latency, and cleanup correctness
- Add operator/debug tooling earlier so the ML pipeline is diagnosable during beta

## Recommendation

Use the Codex version as the top-level roadmap and decision document.

Use the existing implementation doc as the execution checklist for **Milestone 1 / Phase 1** after folding in two changes:

1. Add the feasibility spike before repo bootstrap becomes the team's main focus.
2. Expand later milestones sooner, especially the recognition and gallery milestones, because that is where the product's moat and launch risk live.
