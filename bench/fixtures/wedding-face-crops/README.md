# wedding-face-crops

Face crop fixtures for **Phase 3 Task 11** offline threshold tuning.
These photos are used ONLY for local benchmark evaluation and are NOT served by the application.

---

## Source

**LFW — Labeled Faces in the Wild**
University of Massachusetts, Amherst
Homepage: http://vis-www.cs.umass.edu/lfw/

**License (verbatim from the LFW homepage):**
> "LFW is available for academic / non-commercial research use."

Download mirror used: https://ndownloader.figshare.com/files/5976018
SHA-256 of `lfw.tgz`: `055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0`

---

## LFW identities included (5/8)

Photos were selected by spreading picks across the full index range for each identity (indices 0, 25%, 50%, 75%, 100%) to maximise pose and lighting variety.

| Folder | LFW identity | Photos | Total in LFW |
|--------|-------------|--------|-------------|
| `lfw_george_w_bush/` | George_W_Bush | 5 | 530 |
| `lfw_colin_powell/` | Colin_Powell | 5 | 236 |
| `lfw_tony_blair/` | Tony_Blair | 5 | 144 |
| `lfw_gerhard_schroeder/` | Gerhard_Schroeder | 5 | 109 |
| `lfw_junichiro_koizumi/` | Junichiro_Koizumi | 5 | 60 |

**Total: 25 photos (5 LFW identities × 5 photos each)**

---

## TODO — team identities still needed

Before Task 11's bench eval can run, 3 more identities must be added by the user:

- Add 3 consenting team members, 5 photos each
- Place them in folders named `team_<name>/` (e.g., `team_alice/`)
- **Get explicit consent from each person before adding their photos**
- This will bring the total to 8 identities × 5 photos = 40 face crops as required by Task 11

---

## manifest.json

The `manifest.json` file is auto-generated. Do NOT create it manually.
After team identities are added, run:

```
phostro-bench init-labeled-manifest --dataset-dir bench/fixtures/wedding-face-crops/
```

---

## What is gitignored

- `bench/.lfw-cache/` — the raw 172 MB `lfw.tgz` download
- `bench/fixtures/wedding-face-crops/_extract/` — the full LFW extraction (~200 MB)
