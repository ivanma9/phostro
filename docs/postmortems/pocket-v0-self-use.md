# Pocket v0 — Self-use postmortem

**Date:** 2026-05-08
**Author:** Ivan
**Status:** REAL — first end-to-end dogfood completed on 2026-05-08 against the deployed Pocket v0 + multi-angle ArcFace upgrade.

**Plan this closes:** `docs/plans/2026-05-02-pocket-v0-implementation.md` Task 12.
**Plan this informs:** `docs/plans/2026-05-06-pocket-v1-implementation.md`.

---

## The ask

Founder ran a self-test against the deployed preview at `https://phostro-git-pocket-v0-asu-mare.vercel.app`:

1. Created a pocket named `New p`.
2. Enrolled 3 angles (frontal/left/right) under the new multi-angle ArcFace flow at `/me/face/enroll`.
3. Self-uploaded 6 photos via the contributor share link from a private browsing tab. 1 upload failed (size or upload-step error); 5 succeeded and went through the worker `/detect` pipeline.
4. Ground-truthed each photo manually.

This was a self-only test, not a real grad-chat broadcast. That ships next.

## Numbers

| Metric | Count |
| --- | --- |
| Contributors who opened the link | 1 (self via private tab) |
| Contributors who actually uploaded ≥1 photo | 1 (self) |
| Total photos contributed | 5 (1 upload also attempted, failed before finalize) |
| Photos surfaced in **You** feed at threshold 0.60 | 2 |
| Photos in **You** feed that were genuinely of me (true positives) | 2 |
| Photos in **You** feed that were not of me (false positives) | 0 |
| Photos of me missing from **You** feed (false negatives) | 1 (glasses) |

**Precision at 0.60 threshold:** 100% (2/2)
**Recall at 0.60 threshold:** 67% (2/3 self photos)

## Per-photo distances (multi-angle ArcFace, R50, 512-d)

| Photo | min distance to enrolled embeddings | ground truth | verdict |
|---|---|---|---|
| A | 0.544 | me | matched ✓ |
| B | 0.587 | me | matched ✓ |
| C | 0.858 | me, with glasses | missed (filtered) |
| D | 0.859 | not me | correctly excluded |
| E | 0.948 | not me | correctly excluded |

The glasses photo (C) at 0.858 is *indistinguishable* from a non-self photo (D) at 0.859 at the embedding level. Multi-angle enrollment did not solve this — ArcFace treats "me with glasses" as effectively a different identity unless explicitly enrolled in that look. Any threshold tight enough to include C would also include D (false positive).

## What broke / felt wrong

1. **"Your photos (0)" with no signal that processing was still running.** When uploads finished, the pocket page showed `Your photos (0)` with no progress indicator. The cron drain runs every 2 minutes; in that window I assumed the system was broken when it was just mid-flight. *v0 hotfix shipped:* the empty state now reads `Still analyzing N photos…` while photo_jobs are queued/claimed.

2. **No "All photos" view for the owner.** Photos that didn't match my face were invisible — I had no way to verify what contributors uploaded vs what the matcher caught. For a recall-imperfect system this is critical. *v0 hotfix shipped:* added an "All contributions" section below the You feed showing every uploaded photo, faded slightly to indicate "matcher didn't link this".

3. **Glasses recall miss.** Predicted yesterday with the SFace dogfood. ArcFace + 3-angle enrollment improved unglassed recall but didn't close the glasses gap. Top v1 task.

4. **Stale Vercel alias bug.** The `*-username-*.vercel.app` alias I was using doesn't auto-update on `vercel deploy`. Spent ~30 minutes confused about why "deployed" code wasn't actually live. Fixed by switching to the branch alias `phostro-git-pocket-v0-asu-mare.vercel.app` and adding `scripts/deploy-preview.sh` that re-aliases atomically.

5. **CORS mismatches when alias changed.** Switching to the branch alias broke R2 CORS until I added the new origin to the bucket policy. Easy to fix but easy to miss — wildcards in `AllowedOrigins` aren't reliably supported by R2.

6. **One upload silently failed in a 6-photo batch.** The contributor flow's "4 of 5 succeeded" earlier and "5 of 6 succeeded" today both surfaced silent per-photo failures. *v0 hotfix shipped:* `ContributorUpload.tsx` now collects the failure reason for each photo and surfaces them at end of batch.

## What worked

- **Direct-to-R2 upload (init→PUT→finalize) bypassed Vercel's 4.5MB body cap cleanly.** Full-resolution iPhone HEIC selfies went through without size-related failures once that was wired.
- **Multi-angle enrollment with pose validation.** Each angle's RetinaFace yaw was checked against the claimed angle. Solid behavioral check that prevents the trivial "tap left three times while looking forward" exploit.
- **Cron-driven dispatcher (`/api/internal/drain-queue` every 2 min) drained the queue reliably.** Once the architecture stopped trying to run a long-lived dispatcher process on Vercel, the cron approach was straightforward and self-recovering.
- **Worker scale-to-zero on Fly.** First-request cold start is ~5-15s for ONNX load; cron isolation absorbs that latency without affecting user-facing requests.
- **Precision was perfect on the dogfood sample (0 false positives).** That's the more valuable property of the two; recall is recoverable through "All contributions" view, but a stranger in the You feed would be a serious trust problem.

---

## Verdict

**Would use Pocket again next time** — yes, with caveats.

For unglassed photos, the matching is honestly fine. 67% recall is below the 90%+ where this becomes "magic," but the All-contributions fallback means I never actually lose a photo — I just have to scroll for the glasses ones. That's better than Google Photos in one dimension (zero false positives means I trust the You feed) and worse in another (glasses miss).

The dogfood was small (5 photos, 1 contributor — me). Real signal will come from the grad-chat broadcast next, where I don't pre-know which photos contain me.

## Follow-ups for v1

Ranked by what the dogfood actually surfaced, highest first:

1. **Optional "alternate look" enrollment** (glasses / hats / different hair). Today's biggest recall miss. Without this, anyone who wears glasses regularly will hit ~67% recall on their own social photos — that's the cliff. Should be opt-in (most users won't need it; users who do need it will see 33% recall otherwise). Added to v1 plan as Task 5b.
2. **Per-photo confirm/exclude in the UI.** Owner taps a photo in "All contributions" → "yes, this is me" → photo gets added to the You feed AND its embedding is added to `user_face_embeddings` as an additional reference. Closes the glasses gap by capturing the user's actual social-photo distribution. v1+ effort.
3. **Better contributor in-flight UX.** Progress bar shipped today as part of the dogfood; per-photo failure surfacing also shipped. Should be tested under flaky cellular before beta.
4. **Threshold needs labeled re-tune at scale.** 0.60 is dogfood-empirical from 5 photos. Re-run `phostro-bench eval-labeled` with a real labeled set (≥50 self-photos across glasses/no-glasses/lighting variants) before any wider beta.
