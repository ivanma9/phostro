# Phase 6 Readiness Audit

Date: 2026-04-27
Repository: `/Users/ivanma/Desktop/asumare/phostro`
Scope: readiness of `docs/plans/2026-04-27-photo-courier-phase-6.md` against the current repo, earlier phase contracts, and current package/tooling/deployment assumptions.

## Verdict

Not implementation-ready.

Phase 6 is not ready to execute in this repository today. The biggest blocker is not just missing implementation work, but missing prerequisite phases: the current repo still only contains the Phase 1-style auth/event baseline, while Phase 6 assumes Phase 2-5 storage, worker, enrollment, matching, gallery, save-tracking, and archive surfaces already exist. On top of that, the Phase 6 plan itself has several internal contract gaps around scheduled notifications, cleanup scope, geofence rollback, and account-deletion semantics.

## How this was measured

Tooling and commands used:

- Tool: `rg --files`, `nl`, `sed`, `find`
  - Command: repo inventory and line-numbered reads of the Phase 6 plan, schema, current routes, worker, CI, and earlier phase plans
  - Method: verify whether each referenced contract surface already exists and whether task file targets are valid
  - Limitation: absence checks rely on the current checkout only

- Tool: `node`
  - Command: small one-off scripts to count existing/missing planned files, prerequisite tables, and package dependencies
  - Method: quantify repo readiness instead of relying on qualitative impressions
  - Limitation: scripts only checked the specific Phase 2-6 surfaces named in the plans

- Tool: official docs review
  - Command: Vercel and Resend documentation lookup
  - Method: verify current cron, env, and email API assumptions
  - Limitation: this audit does not validate the workspace's actual Vercel billing tier or DNS ownership

## Baseline numbers

- Current Drizzle schema tables: 4
  - `users`, `events`, `magic_link_tokens`, `event_members`
- Current `app/api` route handlers: 7
- Phase 2-5 prerequisite tables present in `db/schema.ts`: 0 / 10
  - Missing: `photos`, `photoJobs`, `faceDetections`, `faceClusters`, `faceEnrollmentFrames`, `userEventMatches`, `consentAcceptances`, `auditEvents`, `photoViews`, `photoSaves`
- Phase 2-5 storage/image deps present in `package.json`: 0 / 4
  - Missing: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`, `exifr`
- Phase 6-specific deps present in `package.json`: 0 / 4
  - Missing: `@sentry/nextjs`, `date-fns`, `date-fns-tz`, `@maxmind/geoip2-node`
- Phase 6 env vars already represented in `.env.example`: 0
  - Missing examples include `CRON_SECRET`, `RESEND_FROM_ADDRESS`, `GEOFENCE_*`, `SENTRY_*`, `NEXT_PUBLIC_LEGAL_APPROVED`, `MAINTENANCE_MODE`
- Existing `docs/ops` or `docs/launch` files: 0
- Phase 6 file targets already present from the plan's Create/Modify lists: 7 / 62
  - Missing: 55 / 62

## Findings

### P0 Critical

1. **Phase 6 assumes Phases 2-5 are complete, but the current repo does not contain those contract surfaces.**
   - Evidence:
     - Phase 6 explicitly depends on `photos`, `photo_jobs`, `face_detections`, `face_clusters`, `consent_acceptances`, `photo_views`, `photo_saves`, and the Phase 4/5 endpoints and helpers at `docs/plans/2026-04-27-photo-courier-phase-6.md:74-80`.
     - The current schema only defines four tables at `db/schema.ts:20-77`.
     - The current event page is still a share-link page with no upload, enrollment, gallery, or settings surfaces at `app/(app)/events/[id]/page.tsx:22-31`.
     - The worker is still only a `/health` stub at `worker/main.py:1-8`.
   - Impact: the Phase 6 task list cannot be executed in sequence on this checkout because most dependencies are not just unfinished, but absent.
   - Scope: Tasks 2-12, plus the end-state and exit criteria.
   - Type: Weakness

2. **The notification plan never defines how future-dated sends are actually emitted.**
   - Evidence:
     - `dispatch()` is specified to leave rows in `status='pending'` when `scheduled_for > now()` and says "cron job picks it up" at `docs/plans/2026-04-27-photo-courier-phase-6.md:192-193`.
     - The per-kind handlers define scheduled mail kinds like daily new-photos, T-2d, T-2h, and host reminders at `docs/plans/2026-04-27-photo-courier-phase-6.md:196-199`.
     - No later task creates a notification-processing cron, queue consumer, or sweep route; the only cron tasks in the phase are cleanup and cleanup verification at `docs/plans/2026-04-27-photo-courier-phase-6.md:211-289`.
   - Impact: quiet-hours deferrals, daily new-photo sends, and expiry reminders can be inserted into the ledger but never delivered.
   - Scope: Tasks 3-4 and exit criteria 1-3.
   - Type: Weakness

3. **The expiry cleanup plan misses `user_event_matches`, even though earlier phases make it an explicit cleanup contract.**
   - Evidence:
     - Phase 4 says `user_event_matches` is event-scoped and should be cleaned up by Phase 6 expiry at `docs/plans/2026-04-27-photo-courier-phase-4.md:556-557`.
     - Phase 6's delete order omits `user_event_matches` at `docs/plans/2026-04-27-photo-courier-phase-6.md:220-221`.
     - Phase 6's verification pass also never names `user_event_matches` among the artifact counts at `docs/plans/2026-04-27-photo-courier-phase-6.md:269-273`.
   - Impact: expired events can leave behind event-scoped match records, violating the stated cleanup promise and creating privacy risk.
   - Scope: Tasks 5-6, end state, and cleanup verification.
   - Type: Weakness

### P1 High

4. **The Illinois geofence flow will not reach `/coming-soon` in the current UI, and the task list does not include the required client change.**
   - Evidence:
     - Task 8 says `/api/auth/request` should return 451 and "Frontend redirects to `/coming-soon`" at `docs/plans/2026-04-27-photo-courier-phase-6.md:343-345`.
     - The current sign-in client only treats non-OK responses as a generic error string and performs no redirect handling at `components/SignInForm.tsx:20-27`.
     - Task 8's file list does not include `components/SignInForm.tsx` or the sign-in page at `docs/plans/2026-04-27-photo-courier-phase-6.md:332-335`.
   - Impact: the legal block can fail closed in the API but still strand users on an error message instead of the intended region page.
   - Scope: Task 8 and exit criterion 6.
   - Type: Weakness

5. **The geofence rollback assumption is internally contradictory and does not match Vercel's current env behavior.**
   - Evidence:
     - Exit criterion 7 says `GEOFENCE_IL_ENABLED` can be flipped "within 5 minutes (no redeploy)" at `docs/plans/2026-04-27-photo-courier-phase-6.md:32`.
     - The rollback steps later require a redeploy at `docs/plans/2026-04-27-photo-courier-phase-6.md:352-356`.
     - Vercel's current environment variable docs say env changes apply only to new deployments, not previous ones: <https://vercel.com/docs/environment-variables>.
   - Impact: the documented emergency rollback procedure is unreliable as written, which is risky for a legal-control feature.
   - Scope: exit criterion 7 and Task 8.
   - Type: Weakness

6. **The cron design is missing explicit hosting-plan and concurrency assumptions.**
   - Evidence:
     - The plan schedules hourly jobs at `0 * * * *` and `15 * * * *` in `vercel.json` at `docs/plans/2026-04-27-photo-courier-phase-6.md:225-228` and `278`.
     - There is no `vercel.json` in the current repo baseline.
     - Vercel's current cron docs note:
       - hourly cron expressions are not deployable on Hobby plans: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
       - overlapping invocations and duplicate deliveries can occur unless you add a lock/idempotency mechanism: <https://vercel.com/docs/cron-jobs/manage-cron-jobs>
     - The current CI and local test setup only provision Postgres, not any cron/deploy harness, at `.github/workflows/ci.yml:12-32` and `docker-compose.test.yml:1-18`.
   - Impact: cleanup and verification can race or fail deployment depending on the Vercel plan, and the plan does not currently state either requirement.
   - Scope: Tasks 5-6 and Task 9 verification strategy.
   - Type: Weakness

7. **The consent and enrollment contracts drift between Phase 4 and Phase 6.**
   - Evidence:
     - Phase 4 defines the route as `POST /api/me/enroll` at `docs/plans/2026-04-27-photo-courier-phase-4.md:411-416`.
     - Phase 4 says missing consent should reject with 412 at `docs/plans/2026-04-27-photo-courier-phase-4.md:424`.
     - Phase 6 Step 6 tests `/api/enroll` at `docs/plans/2026-04-27-photo-courier-phase-6.md:322`, and Task 8 Step 4 also references `/api/enroll` at `348`.
     - Phase 6 Step 5 changes the consent-missing status to 403 at `docs/plans/2026-04-27-photo-courier-phase-6.md:320`.
   - Impact: implementers can update or test the wrong endpoint and ship inconsistent client/server error handling.
   - Scope: Tasks 7-8 and the Phase 4 handoff contract.
   - Type: Weakness

8. **Full-account deletion semantics are internally inconsistent and reference a user-to-detection ownership model that earlier phases do not define.**
   - Evidence:
     - Exit criterion 9 says uploaded photos are purged as part of account deletion at `docs/plans/2026-04-27-photo-courier-phase-6.md:34`.
     - Task 10 then says uploaded photos in events the user does not host should remain because they are host content at `docs/plans/2026-04-27-photo-courier-phase-6.md:438`.
     - That same step says to delete `face_detections` rows that link to the user "via cluster ownership" at `438`, but earlier phases only define `claimed_by_user_id` on `face_clusters`, not on `face_detections`, at `docs/plans/2026-04-27-photo-courier-phase-3.md:185-192`.
     - Phase 4's own profile deletion contract removes `face_enrollment_frames` and `user_event_matches`, not shared detection rows, at `docs/plans/2026-04-27-photo-courier-phase-4.md:540-542`.
   - Impact: deletion behavior is ambiguous at the product level and potentially destructive to shared event data at the data-model level.
   - Scope: Task 10, legal promises, and auditability.
   - Type: Weakness

### P2 Medium

9. **The notification preference model contradicts the "transactional, non-opt-out" requirement for expiry reminders.**
   - Evidence:
     - Exit criterion 2 says expiry reminders are transactional and non-opt-out at `docs/plans/2026-04-27-photo-courier-phase-6.md:27`.
     - Task 2 still defines `expiry_reminders_enabled` in `user_notification_preferences` at `docs/plans/2026-04-27-photo-courier-phase-6.md:120`.
     - Task 3 says the scheduler should return `null` when the relevant `*_enabled` flag is false at `docs/plans/2026-04-27-photo-courier-phase-6.md:169`.
   - Impact: the same email category is described as both mandatory and suppressible, which can produce either product inconsistency or legal/compliance confusion.
   - Scope: Tasks 2-4.
   - Type: Weakness

10. **Task 11 introduces a `beta_teardown` notification kind that is not allowed by the Task 2 enum.**
    - Evidence:
      - The `notification_deliveries.kind` enum does not include `beta_teardown` at `docs/plans/2026-04-27-photo-courier-phase-6.md:134`.
      - Task 11 says `--notify-attendees` sends a one-off email with kind `beta_teardown` at `docs/plans/2026-04-27-photo-courier-phase-6.md:463`.
    - Impact: the teardown flow cannot record its own send ledger without a schema change not listed in the plan.
    - Scope: Tasks 2 and 11.
    - Type: Weakness

11. **Several tasks require files/scripts that are not declared in their own file inventories.**
    - Evidence:
      - Task 2 Step 5 requires `scripts/seed-default-prefs.ts`, but the file list only names `db/schema.ts` and migrations at `docs/plans/2026-04-27-photo-courier-phase-6.md:110-112` and `152`.
      - Task 8 Step 6 requires `docs/ops/geofence-rollback.md`, but the Task 8 file list omits it at `docs/plans/2026-04-27-photo-courier-phase-6.md:332-335` and `352`.
      - Task 9 Step 7 requires `docs/launch/beta-checklist.md`, but the Task 9 file list omits it at `docs/plans/2026-04-27-photo-courier-phase-6.md:373-375` and `406`.
    - Impact: an implementer following only the task header will miss required deliverables.
    - Scope: Tasks 2, 8, and 9.
    - Type: Weakness

12. **The current test/deploy tooling does not support the cleanup and storage verification strategy as written.**
    - Evidence:
      - Task 5 expects MinIO or moto-backed R2 verification at `docs/plans/2026-04-27-photo-courier-phase-6.md:29-30` and `230`.
      - Task 6 expects failure-injection around R2 deletes and mocked Sentry at `docs/plans/2026-04-27-photo-courier-phase-6.md:280-282`.
      - Current test infra only provisions Postgres at `docker-compose.test.yml:1-18` and `.github/workflows/ci.yml:12-32`.
      - Current package and worker deps do not yet include the storage or observability libs the phase relies on at `package.json:22-45` and `worker/requirements.txt:1-2`.
    - Impact: the plan's verification story is good in principle, but not executable with the current repo tooling without an explicit setup task.
    - Scope: Tasks 5, 6, and 9.
    - Type: Weakness

## Acceptable assumptions vs blockers

### Acceptable assumptions

- Resend is a viable base for Phase 6 email:
  - verified domains are part of the product model
  - tags are supported as key/value pairs
  - idempotency keys are supported
  - Sources:
    - <https://resend.com/docs/api-reference/emails/send-email>
    - <https://resend.com/docs/dashboard/emails/tags>
- `app/(legal)/coming-soon/page.tsx` is a valid App Router path for `/coming-soon`.
- Keeping `cleanup_runs` and `cleanup_verification_failures` after event deletion is a sensible audit-retention strategy.
- Using versioned `consent_acceptances` is compatible with the Phase 4 table shape if Phase 4 is implemented as written.

### Blockers

- Phase 2-5 contract surfaces are absent from the current repo.
- There is no defined notification sweep mechanism for future-dated deliveries.
- The cleanup plan omits `user_event_matches`.
- The geofence rollback procedure is not currently valid for Vercel without redeploy.
- The Vercel plan tier and concurrency/locking requirements are unspecified.
- The account-deletion semantics need one product/legal answer before implementation.

## Cross-phase risks

- **Phase 4 -> Phase 6 endpoint drift:** `POST /api/me/enroll` becomes `/api/enroll` in Phase 6 text unless corrected.
- **Phase 4 -> Phase 6 consent drift:** 412 vs 403 for missing consent will cause client-state divergence if not normalized.
- **Phase 4 -> Phase 6 cleanup drift:** Phase 4 explicitly expects `user_event_matches` cleanup on expiry, but Phase 6 does not implement it.
- **Phase 5 -> Phase 6 notification dependency:** Phase 6 says it reuses the Phase 5 new-photo delta logic, but the current repo has no Phase 5 gallery or save ledger yet.
- **Phase 3 -> Phase 6 observability overlap:** Phase 3 already planned Sentry and structured-log wiring, while the current repo still has neither; whichever phase lands first should own the base integration to avoid duplicate setup work.

## Positive observations

- The Phase 6 plan is strong on end-state definition, testable exit criteria, and operational realism.
- Legal, deletion, incident response, and cleanup verification are surfaced explicitly instead of being left implicit.
- The plan correctly treats counsel sign-off as a launch gate rather than a nice-to-have.

## Source links

- Vercel environment variables: <https://vercel.com/docs/environment-variables>
- Vercel cron management and concurrency: <https://vercel.com/docs/cron-jobs/manage-cron-jobs>
- Vercel cron limits and pricing: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Resend send email API: <https://resend.com/docs/api-reference/emails/send-email>
- Resend email tags: <https://resend.com/docs/dashboard/emails/tags>
