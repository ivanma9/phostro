# Phase 2 Readiness Audit

## 1. Scope
- Category: implementation-readiness audit for `docs/plans/2026-04-27-photo-courier-phase-2.md`
- Repository: `/Users/ivanma/Desktop/asumare/phostro`
- Boundaries / assumptions:
  - Audited the Phase 2 plan against current repo files it depends on today: `db/schema.ts`, current `app/api` routes, current event pages, tests, CI/workflow, `package.json`, `README.md`, `.env.example`, and the existing worker stub.
  - Checked the Phase 3 plan only where Phase 2 claims a cross-phase contract.
  - No fixes were implemented during the audit.

## 2. Measurement Method
| Metric | Tool | Command | Methodology | Limitations |
|---|---|---|---|---|
| Phase 2 task count | `rg`, `wc` | `rg -n '^### Task' docs/plans/2026-04-27-photo-courier-phase-2.md \| wc -l` | Counted explicit task sections to size audit surface. | Does not measure task complexity. |
| Current API surface | `find`, `sed`, `nl` | `find app/api -type f \| wc -l` plus file reads | Checked whether planned routes/helpers/pages already exist or conflict with current structure. | File count alone does not prove feature completeness. |
| Current app/event page surface | `find`, `sed`, `nl` | `find 'app/(app)' -type f \| wc -l` plus file reads | Verified existing join/event pages and where Phase 2 would attach UI. | Does not measure UX completeness. |
| Current test coverage surface | `find`, `sed`, `nl` | `find tests -type f \| wc -l`; `find e2e -type f \| wc -l` | Checked whether plan assumptions about helper tests, e2e, and auth bypass match the repo. | File counts are a proxy, not coverage %. |
| Current schema baseline | `sed`, `nl` | `nl -ba db/schema.ts` | Verified what tables and enums exist before Phase 2 schema work. | Does not validate runtime migrations. |
| Current CI strategy | `sed`, `nl` | `nl -ba .github/workflows/ci.yml` | Compared Phase 2 exit criteria/tasks to actual CI database and e2e setup. | Does not inspect repo secrets or external CI settings. |
| Cross-phase contract check | `sed`, `nl` | `nl -ba docs/plans/2026-04-27-photo-courier-phase-2.md`; `nl -ba docs/plans/2026-04-27-photo-courier-phase-3.md` | Compared the names and hook points that Phase 3 says it will consume from Phase 2. | Looks at plan docs, not future code. |

## 3. Baseline Numbers
| Baseline | Value | Unit | Denominator / Context |
|---|---|---|---|
| Phase 2 task sections | 17 | tasks | `docs/plans/2026-04-27-photo-courier-phase-2.md` |
| Current `app/api` files | 7 | files | Repo currently has auth, events, me, and test-login routes only |
| Current `(app)` files | 4 | files | Includes existing event page, join page, new-event page, home page |
| Current Vitest test files | 12 | files | `tests/**/*.test.ts` |
| Current Playwright spec files | 1 | file | Existing e2e already covers event create + attendee join |
| Current `lib/` files | 6 | files | Includes auth helpers and existing `lib/events/join.ts` |
| Current worker files | 3 | files | Stub FastAPI worker already exists |
| Current schema tables relevant to Phase 2 | 4 | tables | `users`, `events`, `magic_link_tokens`, `event_members`; no `photos` or `photo_jobs` yet |

## 4. Findings (Ranked)
| Rank | Severity | Type | Finding | Evidence | Impact | Scope |
|---|---|---|---|---|---|---|
| 1 | P1 | Weakness | `/admin/jobs` is not implementable as written because it depends on `scheduled_for`, which the proposed `photo_jobs` schema never defines. | Phase 2 lines 29, 205-227, 820-824. | Exit criterion 6 cannot be met and the operator view query contract is internally inconsistent before implementation starts. | Task 3, Task 13, exit criteria |
| 2 | P1 | Weakness | The presign route has conflicting authorization semantics: tests require `403` for non-members, but the implementation auto-inserts membership. | Phase 2 lines 25, 337-340, 363-369, 394-395; existing explicit join flow already lives at `app/(app)/events/[id]/join/page.tsx` and `lib/events/join.ts`. | This bypasses the planned share-link join flow, changes event-membership semantics from page-driven to API-driven, and makes the task impossible to test cleanly without deciding one behavior. | Task 5, join flow, event membership |
| 3 | P1 | Weakness | The photo-register task has contradictory state expectations: the task description/test says success leaves `processing_state='uploaded'`, while the implementation and expected output synchronously advance it to `queued`. | Phase 2 lines 413-418, 459-475, 481-485. | Test expectations, operator counters, and Phase 3 queue-consumer assumptions cannot all be written against one stable state machine. | Task 6, preview/job contract |
| 4 | P1 | Weakness | The CI acceptance criteria are not wired to the repo’s actual workflow, and Task 15 contradicts itself on the intended strategy. | Exit criterion 8 at Phase 2 line 31 requires a Neon branch + ephemeral R2 prefix; current CI uses local Postgres service in `.github/workflows/ci.yml`; Task 15 lines 872-886 first says “no real R2 creds” then chooses real R2 secrets. | Phase 2 cannot be declared done in the current repo without first deciding whether CI runs on local Postgres or Neon, and whether e2e uses mocked or real R2. | Exit criteria, Task 15, CI |
| 5 | P2 | Weakness | Several tasks are stale relative to current repo structure, including duplicate join/auth work and the wrong e2e auth-bypass path. | Phase 2 lines 640-680 and 903-949 vs existing `app/(app)/events/[id]/join/page.tsx`, `lib/events/join.ts`, `components/SignInForm.tsx`, `app/api/auth/request/route.ts`, `app/api/auth/verify/route.ts`, and `app/api/test-login/route.ts`. | Following the plan literally would duplicate already-shipped join work and break the new Playwright spec by targeting `/api/__test/login` instead of the existing `/api/test-login`. | Task 9, Task 16 |
| 6 | P2 | Weakness | “Daily reconciliation” is specified as an exit criterion, but the plan only adds a manual script and a CI teardown use case; it never defines a scheduler or execution venue. | Phase 2 line 32, Task 8 lines 579-624, Task 15 lines 886-888; repo currently has only one workflow file (`.github/workflows/ci.yml`) and no scheduled job config. | Cleanup-on-failure is not operationally complete, so the exit criterion overpromises what the repo will actually automate. | Exit criterion 9, Task 8, Task 15 |
| 7 | P2 | Weakness | Phase 2 and Phase 3 already disagree on the contract names that the next phase will consume. | Phase 2 lines 24, 249-318, 471-473 vs Phase 3 lines 66-69. | Even if Phase 2 ships, Phase 3 will either need doc churn or compatibility shims because it expects `lib/r2/client.ts` and an `enqueuePhotoJob(photoId)` hook that Phase 2 does not create. | Cross-phase contract |
| 8 | P3 | Opportunity | A few code snippets are not compile-ready and should be corrected in the plan before implementation starts. | Phase 2 line 226 uses `sql` without an import; lines 531-532 and 849-850 use `import type { photos }` even though `photos` is a value export. | These are easy fixes, but they create unnecessary friction if someone follows the plan literally. | Task 3, Task 7, Task 14 |

## 5. Notable Successes
- The repo already has the core join/auth scaffolding that Phase 2 wants to build on.
- Why it matters: `app/(app)/events/[id]/join/page.tsx`, `lib/events/join.ts`, join-focused Vitest coverage, and an existing Playwright join scenario mean the plan does not need to invent that flow from scratch.

- The current repo structure cleanly accommodates the new areas Phase 2 needs.
- Why it matters: `db/schema.ts`, `app/api/events/[id]`, `app/(app)/events/[id]`, `lib/`, `components/`, `e2e/`, and the worker/env placeholders are all already in place, so most file paths are structurally plausible.

## 6. Residual Risk Summary
- Highest-risk area: the queue/admin/CI contract, because it contains multiple internal contradictions and also defines the handoff to Phase 3.
- Confidence level: high for repo-structure mismatches and contract contradictions; medium for deploy/runtime concerns like HEIC support because those are explicitly deferred to device/deploy smoke.
- Unknowns / blind spots:
  - No external CI secrets or Neon branch automation settings were inspected.
  - R2 bucket policy/CORS behavior was not tested live.
  - Vercel runtime behavior for `sharp`/HEIC was not exercised.

## 7. Audit Boundary Reminder
- This audit reports diagnosis only.
- No fixes were implemented during this audit.
