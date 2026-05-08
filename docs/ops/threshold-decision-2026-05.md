# Threshold Decision — 2026-05-07 (PLACEHOLDER)

## Status

**Placeholder.** This doc reserves the slot referenced from `worker/config/thresholds.json` but the bench eval has not yet been re-run against ArcFace R50. Production deploy MUST update this doc + thresholds.json + the deployed `MATCH_MAX_DISTANCE` env on Fly + Vercel before cutover.

## Provisional values

```json
{
  "match_max_distance": 0.55,
  "maybe_max_distance": 0.60
}
```

Rationale:

- ArcFace R50 (`w600k_r50.onnx`, trained on Glint360K) operating-point literature reports same-identity cosine distances clustering at 0.15–0.50 with the L2-normalized convention used in `worker/recognition/embed.py`. Different-identity pairs typically land at 0.60–1.40.
- 0.55 is conservative: tight enough to exclude most stranger pairs, loose enough to absorb amateur-photo distribution shift the LFW eval cannot represent.
- Numerically incomparable to the prior SFace 0.92 stop-gap. **Do not carry over** any SFace-derived calibration. The dogfood note in `thresholds.json` from 2026-05-07 documenting SFace's failure on glasses (self-with-glasses 0.903) is preserved here for history but not used as a reference for the new threshold.

## Acceptance criteria for un-marking PLACEHOLDER

1. Re-run `phostro-bench eval-labeled` against `bench/fixtures/wedding-face-crops/manifest.json` with the new model. Capture distributions, hard cases, operating points. LFW must still produce clean separation as a sanity check (not as the production threshold source).
2. Re-capture the founder's dogfood pairs (self-no-glasses × multiple, self-with-glasses × 1, not-self × 1) under the new model. Record actual distances. Required predictions to verify (from design doc):
   - Self-with-glasses vs self-no-glasses < 0.55
   - Self-no-glasses vs self-no-glasses < 0.40
   - Not-self vs self > 0.85
3. Set `match_max_distance` = max(within-identity max in dogfood, LFW within-identity max + 0.05). `maybe_max_distance` = `match_max_distance + 0.05`.
4. Update `thresholds.json` with the new numbers and the actual `_eval_date`.
5. Update Fly + Vercel `MATCH_MAX_DISTANCE` env (`fly secrets set` + Vercel env) in lockstep with the new file.
6. Replace this `## Status` block with the eval summary (distributions, hard cases, approver).

Until those steps are complete, the deployed worker may match too leniently or too strictly; a stranger-in-the-feed false positive is the strictly worse failure mode. Manual sanity check on first 50 production matches after cutover is required.

## Phase 4 retuning checklist (carried over from 2026-04 doc)

- [ ] Collect ≥1000 pairs from real beta uploads
- [ ] Include cross-event pairs (same person at different events)
- [ ] Re-run `phostro-bench eval-labeled` on the larger set
- [ ] If best F1 < 0.85 OR best precision < 0.95: escalate before auto-updating
