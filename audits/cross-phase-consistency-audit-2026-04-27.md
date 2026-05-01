# Category Audit Report

## 1. Scope
- Category: Cross-phase planning consistency for Photo Courier Phases 2-6
- Repository: `/Users/ivanma/Desktop/asumare/phostro`
- Boundaries / assumptions:
  - Audited only plan/design/roadmap docs under `docs/plans/`
  - Ignored wording/style drift; focused on contract mismatches, sequencing, ownership, and schema/API expectations
  - Treated `2026-04-26-photo-courier-design.md`, `2026-04-27-photo-courier-implementation.md`, `2026-04-27-photo-courier-implementation-codex.md`, and `2026-04-27-photo-courier-implementation-comparison.md` as shared roadmap docs

## 2. Measurement Method
| Metric | Tool | Command | Methodology | Limitations |
|---|---|---|---|---|
| Plan inventory | `rg` | `rg --files docs/plans` | Enumerated the candidate docs in scope before reviewing | File presence does not prove the docs are authoritative |
| Contract surface extraction | `rg` | `rg -n "Cross-phase contracts|Prerequisites|my-matches|my-photos|api/enroll|api/me/enroll|api/me/consent|api/consent/accept|host archive|claimed_by_user_id|thresholds|preview|photo_jobs" docs/plans/...` | Pulled the explicit handoff points, route names, schema names, and ownership statements | Keyword search can miss implicit dependencies phrased differently |
| Evidence confirmation | `nl`, `sed` | `nl -ba <file>` and targeted `sed -n '<start>,<end>p' <file>` | Verified exact line numbers and nearby context for each finding | This is a document audit only; no implementation code was checked against the plans |

## 3. Baseline Numbers
| Baseline | Value | Unit | Denominator / Context |
|---|---|---|---|
| Docs inspected | 9 | docs | 5 phase docs + 4 shared roadmap/design docs |
| Explicit cross-phase contract sections reviewed | 4 | sections | Present in Phases 3, 4, 5, and 6 |
| High-signal issues retained | 6 | findings | Filtered down from all observed inconsistencies |
| Sequence-blocking issues | 5 | findings | Issues that can cause a later phase to start against the wrong contract or wrong owner |

## 4. Findings (Ranked)
| Rank | Severity | Type | Finding | Evidence | Impact | Scope |
|---|---|---|---|---|---|---|
| 1 | P1 | Weakness | Host archive ownership is contradictory across the later phases and roadmap docs. | Phase 5 explicitly defers host archive ZIP export to Phase 6 in `docs/plans/2026-04-27-photo-courier-phase-5.md:56-60`, while Phase 6 says host archive already lives in Phase 5 in `docs/plans/2026-04-27-photo-courier-phase-6.md:16` and `docs/plans/2026-04-27-photo-courier-phase-6.md:78`. The Codex roadmap assigns host archive generation to Milestone 5 in `docs/plans/2026-04-27-photo-courier-implementation-codex.md:230-249`. The design doc is internally split between “host can download a single zip archive” in `docs/plans/2026-04-26-photo-courier-design.md:54-56` and “host zip download” deferred to v1.1 in `docs/plans/2026-04-26-photo-courier-design.md:318-327`. | Phase 6 cannot safely assume the endpoint/data flow already exists, and implementers will not know whether archive export is beta scope, Phase 5 scope, Phase 6 scope, or deferred entirely. | Phase 5, Phase 6, shared roadmap, design |
| 2 | P1 | Weakness | Matching-threshold ownership changed from a Phase 3 output to a Phase 4 provisional input, so the retrieval contract is not stable at the handoff. | Phase 3 exit criteria require locked production thresholds committed to `worker/config/thresholds.json` in `docs/plans/2026-04-27-photo-courier-phase-3.md:24-26`, and Phase 3’s output contract says Phase 4 consumes that file in `docs/plans/2026-04-27-photo-courier-phase-3.md:71-77`. Phase 4 then reintroduces unsigned defaults via env vars in `docs/plans/2026-04-27-photo-courier-phase-4.md:73-78` and `docs/plans/2026-04-27-photo-courier-phase-4.md:447-452`, then requires those provisional values to be replaced before sign-off in `docs/plans/2026-04-27-photo-courier-phase-4.md:600-606`. The shared implementation roadmap also says threshold values are an approval checkpoint after Milestone 0 in `docs/plans/2026-04-27-photo-courier-implementation.md:72-74`. | Phase 4 can start against thresholds that Phase 3 was supposed to have finalized already, which makes the Phase 3→4 contract non-deterministic and risks different matching behavior between worker benchmarking and gallery retrieval. | Phase 3, Phase 4, shared roadmap |
| 3 | P1 | Weakness | The matched-retrieval API contract drifts between roadmap and phase docs: `my-photos` vs `my-matches`, photo-level vs cluster-level output, and helper ownership is unresolved. | The shared implementation roadmap says Phase 4 ships `GET /api/events/:id/my-photos` returning matched photos in `docs/plans/2026-04-27-photo-courier-implementation.md:1328-1335`. The detailed Phase 4 plan instead ships `GET /api/events/:id/my-matches` returning cluster bands and persisting `user_event_matches` in `docs/plans/2026-04-27-photo-courier-phase-4.md:92-96` and `docs/plans/2026-04-27-photo-courier-phase-4.md:447-476`. Phase 5 assumes `my-matches` plus `user_event_matches` are the stable contract in `docs/plans/2026-04-27-photo-courier-phase-5.md:94-99`, but its own review checkpoint still asks whether Phase 4 actually shipped a helper and allows an inline fallback join in `docs/plans/2026-04-27-photo-courier-phase-5.md:439-444`. | Phase 5 starts without a single agreed contract for “matched photos,” which risks duplicate query logic, mismatched pagination/auth behavior, and rework at the Phase 4→5 boundary. | Phase 4, Phase 5, shared roadmap |
| 4 | P1 | Weakness | Enrollment and consent API surfaces drift between Phase 4 and Phase 6, including path names and error semantics. | Phase 4 defines `POST /api/me/enroll` in `docs/plans/2026-04-27-photo-courier-phase-4.md:411-425` and `POST /api/me/consent` in `docs/plans/2026-04-27-photo-courier-phase-4.md:247-255`; its enrollment gate returns `412` when consent is missing in `docs/plans/2026-04-27-photo-courier-phase-4.md:423-425`. Phase 6 extends the consent modal to post to `/api/consent/accept` in `docs/plans/2026-04-27-photo-courier-phase-6.md:318-318`, tests consent gating against `/api/enroll` in `docs/plans/2026-04-27-photo-courier-phase-6.md:320-322`, and applies Illinois re-check to `/api/enroll` in `docs/plans/2026-04-27-photo-courier-phase-6.md:348-348`. Phase 6’s notification task separately references `/api/me/enroll` as the insertion point in `docs/plans/2026-04-27-photo-courier-phase-6.md:195-196`. | Phase 6 cannot reliably layer legal gates and notification hooks onto Phase 4 because the route names and response contract are not settled. | Phase 4, Phase 6 |
| 5 | P1 | Weakness | Cluster ownership is promised one way upstream and consumed another way downstream; `claimed_by_user_id` never gets a clear owner. | Phase 3 says `face_clusters.claimed_by_user_id` is left NULL for Phase 4 to populate in `docs/plans/2026-04-27-photo-courier-phase-3.md:71-74`. The design doc also includes `claimed_by_user_id` on `FaceCluster` in `docs/plans/2026-04-26-photo-courier-design.md:82-88`. The detailed Phase 4 plan never populates that field and instead introduces `user_event_matches` as the retrieval contract in `docs/plans/2026-04-27-photo-courier-phase-4.md:92-96` and `docs/plans/2026-04-27-photo-courier-phase-4.md:447-476`. Phase 5’s implementation steps use `getMatchedPhotoIds()` over `user_event_matches` in `docs/plans/2026-04-27-photo-courier-phase-5.md:201-204`, but its exit criterion still describes host logic as skipping a `claimed_by_user_id = me` filter in `docs/plans/2026-04-27-photo-courier-phase-5.md:49-49`. | Later phases do not share one retrieval/ownership model for “who a cluster belongs to,” which makes host access rules and future cleanup/audit logic ambiguous. | Phase 3, Phase 4, Phase 5, design |
| 6 | P2 | Weakness | Preview generation and R2 helper ownership are not consistently assigned across the design doc and phase contracts. | The design doc assigns preview generation to the worker pipeline after queueing in `docs/plans/2026-04-26-photo-courier-design.md:103-114`. The detailed Phase 2 plan makes preview generation part of upload registration and an exit criterion in `docs/plans/2026-04-27-photo-courier-phase-2.md:24-28`. Phase 3 explicitly treats preview ownership as an open question in `docs/plans/2026-04-27-photo-courier-phase-3.md:55-56`. There is also an R2 helper path drift: Phase 2 names `lib/r2.ts` in `docs/plans/2026-04-27-photo-courier-phase-2.md:24-24`, `250-324`, while Phase 3 expects `lib/r2/client.ts:presignGet(...)` in `docs/plans/2026-04-27-photo-courier-phase-3.md:66-69`. | The Phase 2→3 handoff for image transport is directionally aligned but not locked; implementers can easily build the wrong preview owner or wrong helper surface. | Phase 2, Phase 3, design |

## 5. Notable Successes
- Success: The later-phase plans are broadly aligned on Personal-mode-first scope and on keeping `open_pool` / `host_only` out of beta-critical UI paths.
- Why it matters: That consistency reduces privacy-scope drift even though several API/ownership contracts still need reconciliation.

- Success: Phases 2 and 3 are mostly aligned on the Postgres-backed `photo_jobs` queue and on preview keys / upload registration producing worker-consumable photo rows.
- Why it matters: The ingestion spine is more coherent than the later gallery/legal handoffs.

## 6. Residual Risk Summary
- Highest-risk area: The Phase 4 handoff into Phases 5 and 6; most unresolved contracts cluster around enrollment, matching, gallery retrieval, and legal gates.
- Confidence level: High for the findings above; they are backed by explicit line-level contradictions rather than inference alone.
- Unknowns / blind spots:
  - No source code or migrations were audited, only planning docs
  - Some shared docs may be intentionally superseded, but the plans do not consistently say so

## 7. Audit Boundary Reminder
- This audit reports diagnosis only.
- No fixes were implemented during this audit.
