# Labeled Benchmark Report — Milestone 0

Generated: 2026-05-03 01:01 UTC

## Dataset Summary

- **Dataset:** `wedding-face-crops`
- **Manifest:** `/Users/ivanma/Desktop/asumare/phostro/.worktrees/phase-3-recognition/bench/fixtures/wedding-face-crops/manifest.json`
- **Samples:** 40 total, 40 embedded, 0 failed
- **Identities:** 8
- **Pairs evaluated:** 780 (80 positive, 700 negative)
- **Pairs skipped:** 0
- **Crop re-detect + align hit rate:** 100.0%

## Operating Points

### Best F1

| Threshold | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| 0.528413 | 1.0000 | 1.0000 | 1.0000 | 80 | 0 | 0 | 700 |

### Precision Guardrail (target >= 0.95)

| Threshold | Precision | Recall | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| 0.528413 | 1.0000 | 1.0000 | 1.0000 | 80 | 0 | 0 | 700 |

## Distance Distributions

| Pair set | Count | Min | P50 | P95 | Max | Mean |
|---|---|---|---|---|---|---|
| Same identity | 80 | 0.153 | 0.3728 | 0.4944 | 0.5284 | 0.372 |
| Different identity | 700 | 0.5957 | 0.8944 | 1.0264 | 1.1754 | 0.8937 |

## Hard Cases

### Farthest Same-Identity Pairs

- `lfw_junichiro_koizumi_junichiro_koizumi_0031` vs `lfw_junichiro_koizumi_junichiro_koizumi_0060` -> distance `0.528413`
- `lfw_junichiro_koizumi_junichiro_koizumi_0001` vs `lfw_junichiro_koizumi_junichiro_koizumi_0031` -> distance `0.514113`
- `lfw_tony_blair_tony_blair_0073` vs `lfw_tony_blair_tony_blair_0108` -> distance `0.513534`
- `lfw_tony_blair_tony_blair_0001` vs `lfw_tony_blair_tony_blair_0144` -> distance `0.499244`
- `lfw_george_w_bush_george_w_bush_0133` vs `lfw_george_w_bush_george_w_bush_0530` -> distance `0.494118`

### Closest Different-Identity Pairs

- `lfw_george_w_bush_george_w_bush_0265` vs `lfw_gerhard_schroeder_gerhard_schroeder_0055` -> distance `0.595678`
- `lfw_george_w_bush_george_w_bush_0530` vs `lfw_tony_blair_tony_blair_0073` -> distance `0.620138`
- `lfw_george_w_bush_george_w_bush_0001` vs `lfw_gerhard_schroeder_gerhard_schroeder_0055` -> distance `0.632732`
- `lfw_george_w_bush_george_w_bush_0530` vs `lfw_tony_blair_tony_blair_0001` -> distance `0.638688`
- `lfw_george_w_bush_george_w_bush_0530` vs `lfw_gerhard_schroeder_gerhard_schroeder_0055` -> distance `0.642085`

## Sample Failures

_None._

## Per-Sample Detail

| Sample | Identity | File | Align | Crop faces | Total ms |
|---|---|---|---|---|---|
| `lfw_colin_powell_colin_powell_0001` | `lfw_colin_powell` | `lfw_colin_powell/Colin_Powell_0001.jpg` | `crop_redetect_align` | 1 | 237.9 |
| `lfw_colin_powell_colin_powell_0060` | `lfw_colin_powell` | `lfw_colin_powell/Colin_Powell_0060.jpg` | `crop_redetect_align` | 1 | 172.2 |
| `lfw_colin_powell_colin_powell_0119` | `lfw_colin_powell` | `lfw_colin_powell/Colin_Powell_0119.jpg` | `crop_redetect_align` | 1 | 189.1 |
| `lfw_colin_powell_colin_powell_0177` | `lfw_colin_powell` | `lfw_colin_powell/Colin_Powell_0177.jpg` | `crop_redetect_align` | 1 | 384.8 |
| `lfw_colin_powell_colin_powell_0236` | `lfw_colin_powell` | `lfw_colin_powell/Colin_Powell_0236.jpg` | `crop_redetect_align` | 1 | 234.6 |
| `lfw_donald_rumsfeld_donald_rumsfeld_0001` | `lfw_donald_rumsfeld` | `lfw_donald_rumsfeld/Donald_Rumsfeld_0001.jpg` | `crop_redetect_align` | 1 | 242.0 |
| `lfw_donald_rumsfeld_donald_rumsfeld_0030` | `lfw_donald_rumsfeld` | `lfw_donald_rumsfeld/Donald_Rumsfeld_0030.jpg` | `crop_redetect_align` | 1 | 212.0 |
| `lfw_donald_rumsfeld_donald_rumsfeld_0060` | `lfw_donald_rumsfeld` | `lfw_donald_rumsfeld/Donald_Rumsfeld_0060.jpg` | `crop_redetect_align` | 1 | 156.9 |
| `lfw_donald_rumsfeld_donald_rumsfeld_0090` | `lfw_donald_rumsfeld` | `lfw_donald_rumsfeld/Donald_Rumsfeld_0090.jpg` | `crop_redetect_align` | 1 | 160.2 |
| `lfw_donald_rumsfeld_donald_rumsfeld_0121` | `lfw_donald_rumsfeld` | `lfw_donald_rumsfeld/Donald_Rumsfeld_0121.jpg` | `crop_redetect_align` | 1 | 193.7 |
| `lfw_george_w_bush_george_w_bush_0001` | `lfw_george_w_bush` | `lfw_george_w_bush/George_W_Bush_0001.jpg` | `crop_redetect_align` | 1 | 167.5 |
| `lfw_george_w_bush_george_w_bush_0133` | `lfw_george_w_bush` | `lfw_george_w_bush/George_W_Bush_0133.jpg` | `crop_redetect_align` | 1 | 152.4 |
| `lfw_george_w_bush_george_w_bush_0265` | `lfw_george_w_bush` | `lfw_george_w_bush/George_W_Bush_0265.jpg` | `crop_redetect_align` | 2 | 162.3 |
| `lfw_george_w_bush_george_w_bush_0398` | `lfw_george_w_bush` | `lfw_george_w_bush/George_W_Bush_0398.jpg` | `crop_redetect_align` | 1 | 160.9 |
| `lfw_george_w_bush_george_w_bush_0530` | `lfw_george_w_bush` | `lfw_george_w_bush/George_W_Bush_0530.jpg` | `crop_redetect_align` | 2 | 200.0 |
| `lfw_gerhard_schroeder_gerhard_schroeder_0001` | `lfw_gerhard_schroeder` | `lfw_gerhard_schroeder/Gerhard_Schroeder_0001.jpg` | `crop_redetect_align` | 1 | 164.4 |
| `lfw_gerhard_schroeder_gerhard_schroeder_0028` | `lfw_gerhard_schroeder` | `lfw_gerhard_schroeder/Gerhard_Schroeder_0028.jpg` | `crop_redetect_align` | 1 | 155.9 |
| `lfw_gerhard_schroeder_gerhard_schroeder_0055` | `lfw_gerhard_schroeder` | `lfw_gerhard_schroeder/Gerhard_Schroeder_0055.jpg` | `crop_redetect_align` | 1 | 169.8 |
| `lfw_gerhard_schroeder_gerhard_schroeder_0082` | `lfw_gerhard_schroeder` | `lfw_gerhard_schroeder/Gerhard_Schroeder_0082.jpg` | `crop_redetect_align` | 1 | 162.7 |
| `lfw_gerhard_schroeder_gerhard_schroeder_0109` | `lfw_gerhard_schroeder` | `lfw_gerhard_schroeder/Gerhard_Schroeder_0109.jpg` | `crop_redetect_align` | 1 | 147.2 |
| `lfw_hugo_chavez_hugo_chavez_0001` | `lfw_hugo_chavez` | `lfw_hugo_chavez/Hugo_Chavez_0001.jpg` | `crop_redetect_align` | 1 | 152.0 |
| `lfw_hugo_chavez_hugo_chavez_0017` | `lfw_hugo_chavez` | `lfw_hugo_chavez/Hugo_Chavez_0017.jpg` | `crop_redetect_align` | 1 | 171.7 |
| `lfw_hugo_chavez_hugo_chavez_0035` | `lfw_hugo_chavez` | `lfw_hugo_chavez/Hugo_Chavez_0035.jpg` | `crop_redetect_align` | 1 | 203.6 |
| `lfw_hugo_chavez_hugo_chavez_0053` | `lfw_hugo_chavez` | `lfw_hugo_chavez/Hugo_Chavez_0053.jpg` | `crop_redetect_align` | 1 | 179.8 |
| `lfw_hugo_chavez_hugo_chavez_0071` | `lfw_hugo_chavez` | `lfw_hugo_chavez/Hugo_Chavez_0071.jpg` | `crop_redetect_align` | 1 | 155.2 |
| `lfw_jacques_chirac_jacques_chirac_0001` | `lfw_jacques_chirac` | `lfw_jacques_chirac/Jacques_Chirac_0001.jpg` | `crop_redetect_align` | 1 | 161.2 |
| `lfw_jacques_chirac_jacques_chirac_0013` | `lfw_jacques_chirac` | `lfw_jacques_chirac/Jacques_Chirac_0013.jpg` | `crop_redetect_align` | 1 | 173.1 |
| `lfw_jacques_chirac_jacques_chirac_0026` | `lfw_jacques_chirac` | `lfw_jacques_chirac/Jacques_Chirac_0026.jpg` | `crop_redetect_align` | 1 | 180.9 |
| `lfw_jacques_chirac_jacques_chirac_0039` | `lfw_jacques_chirac` | `lfw_jacques_chirac/Jacques_Chirac_0039.jpg` | `crop_redetect_align` | 1 | 178.1 |
| `lfw_jacques_chirac_jacques_chirac_0052` | `lfw_jacques_chirac` | `lfw_jacques_chirac/Jacques_Chirac_0052.jpg` | `crop_redetect_align` | 1 | 172.2 |
| `lfw_junichiro_koizumi_junichiro_koizumi_0001` | `lfw_junichiro_koizumi` | `lfw_junichiro_koizumi/Junichiro_Koizumi_0001.jpg` | `crop_redetect_align` | 2 | 171.3 |
| `lfw_junichiro_koizumi_junichiro_koizumi_0016` | `lfw_junichiro_koizumi` | `lfw_junichiro_koizumi/Junichiro_Koizumi_0016.jpg` | `crop_redetect_align` | 1 | 152.3 |
| `lfw_junichiro_koizumi_junichiro_koizumi_0031` | `lfw_junichiro_koizumi` | `lfw_junichiro_koizumi/Junichiro_Koizumi_0031.jpg` | `crop_redetect_align` | 2 | 175.5 |
| `lfw_junichiro_koizumi_junichiro_koizumi_0045` | `lfw_junichiro_koizumi` | `lfw_junichiro_koizumi/Junichiro_Koizumi_0045.jpg` | `crop_redetect_align` | 1 | 199.5 |
| `lfw_junichiro_koizumi_junichiro_koizumi_0060` | `lfw_junichiro_koizumi` | `lfw_junichiro_koizumi/Junichiro_Koizumi_0060.jpg` | `crop_redetect_align` | 1 | 173.0 |
| `lfw_tony_blair_tony_blair_0001` | `lfw_tony_blair` | `lfw_tony_blair/Tony_Blair_0001.jpg` | `crop_redetect_align` | 2 | 189.7 |
| `lfw_tony_blair_tony_blair_0037` | `lfw_tony_blair` | `lfw_tony_blair/Tony_Blair_0037.jpg` | `crop_redetect_align` | 1 | 157.9 |
| `lfw_tony_blair_tony_blair_0073` | `lfw_tony_blair` | `lfw_tony_blair/Tony_Blair_0073.jpg` | `crop_redetect_align` | 1 | 172.1 |
| `lfw_tony_blair_tony_blair_0108` | `lfw_tony_blair` | `lfw_tony_blair/Tony_Blair_0108.jpg` | `crop_redetect_align` | 1 | 176.6 |
| `lfw_tony_blair_tony_blair_0144` | `lfw_tony_blair` | `lfw_tony_blair/Tony_Blair_0144.jpg` | `crop_redetect_align` | 3 | 194.9 |

_Full threshold sweep, pair records, and skipped-pair detail are in `labeled_report.json`._
