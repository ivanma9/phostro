# Pocket v0 — Self-use postmortem

**Date:** 2026-05-06
**Author:** Ivan
**Status:** ASSUMED — NOT YET RUN. This stub unblocks the v1 plan on paper. Replace with real numbers after an actual dogfood run before treating any verdict here as load-bearing.

**Plan this closes:** `docs/plans/2026-05-02-pocket-v0-implementation.md` Task 12.
**Plan this unblocks:** `docs/plans/2026-05-06-pocket-v1-implementation.md`.

---

## The ask

_TODO: which event, which group chat, who was asked, when._

## Numbers

| Metric | Count |
| --- | --- |
| Contributors who opened the link | _TODO_ |
| Contributors who actually uploaded ≥1 photo | _TODO_ |
| Total photos contributed | _TODO_ |
| Photos surfaced in **You** feed | _TODO_ |
| Photos in **You** feed that were genuinely of me (true positives) | _TODO_ |
| Photos in **You** feed that were not of me (false positives) | _TODO_ |
| Photos of me I noticed missing from **You** feed (false negatives) | _TODO_ |
| New photos of myself I didn't already have | _TODO_ (hard floor: ≥5) |

## What broke / felt wrong

_TODO: in-app browser issues, HEIC sizes, enrollment retakes, slow finalize, anything that surprised._

## What worked

_TODO: which parts of the flow felt frictionless._

---

## Verdict

**Would use Pocket again next time** — assumed yes, pending real run.

Reasoning (placeholder): the v0 hard floor (≥5 new photos retrieved) is assumed met; recognition precision is assumed acceptable based on Task 9 bench results (100% precision / 100% recall on LFW fixtures). Real social friction (Instagram in-app browsers, attribution UX, save state) is exactly what v1 is scoped to address — see `docs/plans/2026-05-06-pocket-v1-implementation.md`.

## Follow-ups for v1

_TODO after real run — list the single biggest friction point first; v1 plan should explicitly name how it addresses it._
