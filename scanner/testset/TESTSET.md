# Labeled test set — person detector (v0.2.0)

16 real photos from Wikimedia Commons (see `manifest.json` for source
file-page URLs and ground truth). Ground truth was verified by looking
at every image (see `contact-sheet.jpg` for the first 14; `b1` and `a2`
were checked individually after their delayed download).

Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO `person`
class) + face-api.js tinyFaceDetector fallback — the exact same
`detector.js` the live scanner uses. Policy threshold 0.70, score
floor 0.40. Run: `node ../test_person.js` (full results in
`results.json`).

## Per-image results (final run, 2026-11-18, n=16)

| ID | Category | Truth | Verdict | Conf | Via | Persons found | Faces found | Detect ms |
|---|---|---|---|---|---|---|---|---|
| b1-back-soldier | behind | person ×1 | **none** ❌ | 0 | – | 0 | 0 | 3058 |
| b2-behind-back | behind | person ×1 | **none** ❌ | 0 | – | 0 | 0 | 2679 |
| b3-back-tattoo | behind | person ×1 | person | 0.896 | person | 1 | 0 | 2722 |
| d1-crowd-funeral | distant | person (many) | uncertain | 0.612 | person | 5 | 0 | 3165 |
| d2-crowd-street-night | distant | person (many) | uncertain | 0.640 | person | 5 | 0 | 3206 |
| d3-lone-beach | distant | person ×1 | **none** ❌ | 0 | – | 0 | 0 | 3033 |
| g1-team-cincinnati | group | person ×11 | uncertain | 0.660 | person+face | 7 | 1 | 1561 |
| g2-imperial-family | group | person ×7 | person | 0.899 | person | 6 | 0 | 1937 |
| g3-west-point-1899 | group | person (~14) | person | 0.736 | person | 10 | 0 | 2666 |
| p1-huang-portrait | portrait | person ×1 | person | 0.968 | person+face | 1 | 1 | 2460 |
| p2-khrushchev-portrait | portrait | person ×1 | person | 0.987 | person+face | 1 | 1 | 2793 |
| a1-dog-running | animal | none | none | 0 | – | 0 | 0 | 3596 |
| a2-dog-stream | animal | none | none | 0 | – | 0 | 0 | 3079 |
| l1-glacier-lake | landscape | none | none | 0 | – | 0 | 0 | 1938 |
| l2-mountain-lake | landscape | none | none | 0 | – | 0 | 0 | 1344 |
| o1-vintage-camera | object | none | none | 0 | – | 0 | 0 | 1341 |

## Metrics (on the `person` verdict, threshold 0.70)

- **n = 16** (11 person-present, 5 no-person). Small sample — read the
  numbers as indicative, not as a production accuracy claim.
- **TP = 5, FP = 0, FN = 6, TN = 5**
- **Precision = 1.000** (no false person on any control image)
- **Recall = 0.455** (5 of 11 person images reached `person`)
- **Uncertain on person images = 3** (d1, d2, g1 — all stay covered on
  the device, so these are safe, not leaks)
- **Missed to ALLOW = 3** (b1, b2, d3 — person present, detection
  `none`; these are the real safety gap)
- **Mean detect time 2,539 ms/image, median 2,722 ms** (both detectors
  together, one evaluate per image; VM was loaded during this run —
  an earlier quiet run of the same 14 images gave mean 1,477 ms,
  median 1,425 ms. Per-image time is CPU-contention sensitive.)

## What the numbers actually say

- **The person detector finds people the face detector cannot see.**
  On g2 (1913 family photo) and g3 (1899 baseball team) face-api
  found **0 faces**; the person model found 6 of 7 and 10 of ~14
  people. On b3 (man from behind) face found 0, person found 1 at
  0.896. The two portrait controls were found by both (person
  0.968/0.980, face 0.929/0.987).
- **Back views are still weak: 1 of 3.** b3 was found, but b1
  (soldier from behind, plain background, large and centered) and b2
  (guitarist from behind, black-and-white) were missed entirely —
  person 0, face 0. b1 was re-checked twice in isolation after the
  run: still 0 persons, 0 faces both times — a stable model miss,
  not flakiness (camouflage pattern is the likely cause, but that is
  a guess, not a verified reason). Back-view recall needs a better
  model or a second pass (e.g. tiled/crop detection) before it can
  be claimed as solved.
- **Distant/small figures score low and land in REVIEW, not BLOCK.**
  Both crowds were detected (5 persons each) but at 0.61–0.64, below
  the 0.70 threshold → `uncertain` → REVIEW (covered, safe). The
  single distant beach walker (d3) scored below the 0.40 floor and
  was missed to ALLOW. Cause: EfficientDet-Lite0 resizes every
  image to 320×320, so a person who is ~30 px tall in a 960 px image
  becomes ~10 px at model input. Tiled detection (crop + detect)
  would help; it is not built yet.
- **Groups are undercounted.** g1: 7 of 11 found, best 0.660 →
  uncertain. g2: 6 of 7. g3: 10 of ~14. The verdict is still right
  (`person` or `uncertain` → blocked/covered), but person *counts*
  in the Visual Content Map undercount groups — do not use `persons`
  as a headcount.
- **No false positives.** Dog (×2, one small/distant), two
  landscapes, and a vintage camera (round flash reflector) all came
  back `none` from both detectors. Precision 1.0 on this small set
  is encouraging but not proof — 5 negatives cannot rule out rare
  false positives.
- **The face detector alone would have scored far worse here.**
  Face-only on this set: TP = 2 (p1, p2 only — g1's single face was
  0.522, below threshold), FN = 9. The person model is what lifts
  recall from 0.18 to 0.455. The old face-only detector's real-site
  numbers were still good on frontal portraits (that is what news
  homepages mostly show), which is why the site comparison below is
  closer than the test-set gap suggests.

## Download note

`b1-back-soldier.png` and `a2-dog-stream.jpg` first failed with
Wikimedia HTTP 429 via Python/curl (the shared sandbox egress IP is
throttled by Wikimedia). Both were then fetched successfully through
headless Chromium (same egress relay, HTTP 200) and verified by eye.
