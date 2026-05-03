# Threshold Decision — 2026-05-03

Phase 3 Task 11. Locks production face-recognition matching thresholds.

## Chosen values

```json
{
  "match_max_distance": 0.528,
  "maybe_max_distance": 0.595
}
```

Cosine distance over 128-d SFace embeddings. Lower distance = more similar.

- `distance ≤ 0.528` → **match** ("this is you")
- `0.528 < distance ≤ 0.595` → **maybe** ("is this you? — confirm")
- `distance > 0.595` → **no match**

## Dataset

- 8 identities × 5 photos = 40 face crops, all from LFW (Labeled Faces in the Wild)
- Source: figshare mirror of the canonical UMass LFW tarball, sha256 `055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0`
- License: LFW academic / non-commercial research use
- Identities (5 photos each, sampled across each person's available range, not first-5-sequential):
  - George_W_Bush, Colin_Powell, Tony_Blair, Gerhard_Schroeder, Junichiro_Koizumi (initial 5, committed in `e1c3171`)
  - Donald_Rumsfeld, Hugo_Chavez, Jacques_Chirac (added for this eval)

## Why LFW-only (no team identities)

The plan recommended mixing LFW with 3 consenting team identities for distribution coverage (LFW is celebrity press photos — well-lit, mostly frontal, professional quality; production data is amateur event photography). We chose to ship LFW-only for v1 and accept the trade-off.

**The trade-off:** thresholds tuned on professional LFW photos are likely **tighter** than amateur photos require. In production this biases errors toward false negatives ("you're not in any photos") rather than false positives ("matched the wrong person"). False negatives are the safer error mode for user trust — a missed match is fixable in Phase 4 retuning; a wrong match destroys trust permanently.

**Phase 4 retuning trigger:** if recall drops below 0.7 in the first 100 beta users, retune on real beta-collected pairs.

## Eval method

```
phostro-bench eval-labeled \
  --manifest bench/fixtures/wedding-face-crops/manifest.json \
  --out bench/reports \
  --models bench/models \
  --target-precision 0.95
```

- 40 samples embedded successfully (100% face-detect + align rate)
- 780 pairs evaluated (80 within-identity positive / 700 between-identity negative)

## Distance distributions

| Pair set | Count | Min | P50 | P95 | Max | Mean |
|---|---|---|---|---|---|---|
| Same identity | 80 | 0.153 | 0.373 | 0.494 | 0.528 | 0.372 |
| Different identity | 700 | 0.596 | 0.894 | 1.026 | 1.175 | 0.894 |

Clean separation: max within-identity (0.528) is below min between-identity (0.596). Gap = 0.068.

## Operating points from the eval

- **Best F1 = 1.000** at threshold ≤ 0.528413, precision 1.000, recall 1.000
- **Precision guardrail (≥0.95)** at threshold ≤ 0.528413 — same point

The eval found perfect separation on this dataset. Recall ≥ 0.95 across the entire useful threshold range, so the plan's "threshold at recall ≈ 0.85" mechanism for picking `maybe_max_distance` is degenerate here.

## Threshold rationale

- **`match_max_distance = 0.528`** — exactly the within-identity max distance. Anything closer than the worst within-identity pair we observed is conservatively a confident match.
- **`maybe_max_distance = 0.595`** — just below the closest between-identity pair (0.596). The "maybe" band [0.528, 0.595] absorbs the gap zone where production photos will likely land more often than this clean LFW set suggests.

## Hard cases (signposts for Phase 4 retuning)

Closest within-identity pairs (all under 0.528, but tight):
- Junichiro_Koizumi 0031 vs 0060 → 0.528
- Junichiro_Koizumi 0001 vs 0031 → 0.514
- Tony_Blair 0073 vs 0108 → 0.514
- Tony_Blair 0001 vs 0144 → 0.499
- George_W_Bush 0133 vs 0530 → 0.494

Closest between-identity pairs (all above 0.595):
- George_W_Bush 0265 vs Gerhard_Schroeder 0055 → 0.596
- George_W_Bush 0530 vs Tony_Blair 0073 → 0.620
- George_W_Bush 0001 vs Gerhard_Schroeder 0055 → 0.633

Interesting signal: George_W_Bush and Tony_Blair / Gerhard_Schroeder produce the tightest non-match pairs — same era of news photography, similar poses behind podiums, similar suits. This is the kind of confounder amateur event photos won't replicate, but co-attendees with similar features might.

## Approval

Approver: ivanma819@gmail.com (single approver — solo project)
Date: 2026-05-03

## Known limitations

1. **LFW distribution shift.** Celebrity press photos are not amateur event photography. Real wedding/party photos have more pose variance, lighting variance, and motion blur. Expect production within-identity distances to land HIGHER than the 0.528 ceiling we observed.
2. **Small dataset (40 photos).** ROC tuning on 780 pairs gives a coarse view of the threshold landscape. Phase 4 should retune on ≥1000 real production pairs.
3. **No team identity coverage.** The plan recommended 3-5 consenting team identities for distribution coverage; we deferred this to Phase 4.
4. **Perfect separation may mask brittleness.** F1 = 1.0 means the eval cannot tell us how the model behaves at the boundary. Phase 4 needs harder pairs (different events, different lighting, partial faces).

## Phase 4 retuning checklist

- [ ] Collect ≥1000 pairs from real beta uploads
- [ ] Include cross-event pairs (same person at different events) to test temporal/clothing invariance
- [ ] Re-run `phostro-bench eval-labeled` against the larger set
- [ ] If best F1 < 0.85 OR best precision < 0.95 at the chosen recall: escalate, do NOT auto-update thresholds
- [ ] Update this doc with the new run-id and rationale
