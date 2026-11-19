# RF-DETR Nano & Small — CPU benchmark (ONNX Runtime)

**Date:** 2026-11-19 (morning, EST). **Author:** CPU-benchmark subagent.
**Status: PROVEN on CPU for the still-image filter task on this VM — with the limits in §7.**
No hosted API was used, no account was created, no code in the project was changed
and nothing was committed. This file is a measurement report only.

## 0. Verdict up front

| Model | Infer (session.run only) | End-to-end | Images/s (e2e) | Recall @0.50 | Recall @0.70 | Precision |
|---|---|---|---|---|---|---|
| **RF-DETR Nano** (384×384) | **327 ms** mean | **422 ms** mean | **2.37** | **1.000** (11/11) | **0.909** (10/11) | 1.000 |
| **RF-DETR Small** (512×512) | **572 ms** mean | **658 ms** mean | **1.52** | **1.000** (11/11) | **0.727** (8/11) | 1.000 |
| EfficientDet-Lite0 baseline (same 16 photos) | 1,477–2,539 ms (person+face detectors together) | — | ~0.4–0.7 | 0.727 (8/11) | 0.455 (5/11) | 1.000 |

Both RF-DETR models **beat** the EfficientDet-Lite0 baseline on recall at both
thresholds, with zero false positives on this set, and Nano is roughly **4–8× faster**
than the baseline's combined person+face time on this VM. **Nano is the recommendation:
it is faster than Small and, on this small set, better at threshold 0.70.**
Small costs 1.75× the compute for no accuracy gain here — do not pay for it.
The remaining miss at 0.70 is the single distant beach walker (d3, 0.57 Nano / 0.53 Small);
at 0.50 both models find all 11 person photos.

Capacity, honestly: one Nano stream does ~2.4 images/s end-to-end using ~1.4 cores.
A page with 20 images takes ~8.5 s single-stream, ~2–3 s with 4 parallel workers —
fine for a filter that covers content until decided, not instant, and not live video
(see §6 for the arithmetic and its assumptions). INT8 quantization and batching were
not tested and would likely speed this up further.

## 1. Official source & license verification

### 1.1 Source

- Official repo: **https://github.com/roboflow/rf-detr** — public, not a fork,
  default branch `develop`, commit `0739e61078032b83bfbac4029f949f64f68d9403` at check
  time, 10,110 stars, created 2025-03-19. README describes RF-DETR as "a real-time
  transformer architecture for object detection … developed by Roboflow".
- Official docs (export): **https://rfdetr.roboflow.com/1.4.0/learn/export/**
- Installed package: **`rfdetr` 1.12.1** from PyPI (newer than the 1.4.0 docs; see §4
  for the API differences this caused).

### 1.2 License — VERIFIED from the repo itself

- File read: `https://raw.githubusercontent.com/roboflow/rf-detr/develop/LICENSE`
  (full text, 371 lines). It is the **Apache License, Version 2.0, January 2004**
  (`http://www.apache.org/licenses/`), appendix copyright
  **"Copyright 2025 Roboflow, Inc."**, with the standard Sections 1–9
  (perpetual, worldwide, no-charge, royalty-free copyright + patent grant).
- GitHub repo metadata also lists **License: Apache License 2.0 (Apache-2.0)**.
- README states verbatim: "**Commercially usable under Apache 2.0.** The `rfdetr`
  package, RF-DETR Nano, Small, Medium and Large detection … are released under the
  Apache 2.0 license, so they're commercially usable out of the box: you can ship them
  in closed-source, commercial products, including self-hosted deployments, without
  paying a license fee or open-sourcing your code."
- README benchmark table lists RF-DETR-N **Apache 2.0** (COCO AP50 67.6) and
  RF-DETR-S **Apache 2.0** (COCO AP50 72.1).
- **Scope warning (read this):** only Nano / Small / Medium / Large detection (and the
  Seg family) are Apache 2.0. **Atto, Femto, Pico, XL and 2XL detection ship under the
  Roboflow Platform Model License 1.0** — commercial self-hosting of those requires the
  Enterprise add-on. We did not download, export, or test any PML model.
- **Open item, not verified here:** RF-DETR is built on a DINOv2 vision-transformer
  backbone (Meta). The repo's Apache 2.0 statement is Roboflow's assertion covering the
  shipped Nano/Small models; the DINOv2 upstream provenance was not separately traced
  in this session. Worth one explicit check before commercial shipment, not a blocker
  for testing.

### 1.3 No hosted inference

Roboflow's hosted inference service was **not** used. Everything ran locally from
downloaded weights. No Roboflow account, no API key, no credits.

## 2. Weights — exact files, URLs, hashes

There is **no official pre-built ONNX download** for Nano/Small. The official route is
export from the official PyTorch checkpoints with the repo's own exporter
(`model.export()`, opset 17). The checkpoints come from Roboflow's own file server;
the URLs and MD5s below are taken from the repo's own asset table
(`src/rfdetr/assets/model_weights.py`, `ModelWeights` enum, `develop` branch) and the
downloads were verified against them.

| Model | Official checkpoint URL | Local file | Size (bytes) | MD5 (repo-published → measured) | SHA-256 (measured) |
|---|---|---|---|---|---|
| Nano | `https://repo.roboflow.com/rfdetr/nano_coco/checkpoint_best_regular.pth` | `rf-detr-nano.pth` | 366,287,238 | `fb6504cce7fbdc783f7a46991f07639f` → **match** | `d8d6b9ee57d4d0ed2b1f305163624712a0532cb7bce0c747317984fc5457440d` |
| Small | `https://repo.roboflow.com/rfdetr/small_coco/checkpoint_best_regular.pth` | `rf-detr-small.pth` | 386,045,550 | `fb37061c1af7bace359c91b723a8d5c1` → **match** | `d81979a9213a2109345158ce9232668df4c1ae52e9b8db3f2ec0a8cbad959b33` |

Notes:
- Both MD5s match the values published in the repo's asset table — the files are
  byte-identical to the official checkpoints.
- The `.pth` files (~366/386 MB) are much larger than the deployment parameter count
  (~30.5 M / 32.1 M params ≈ 122/128 MB FP32); they evidently carry extra tensors
  (training state). The exported ONNX files are the deployment-size artifacts (§3).
- Hugging Face mirrors exist (`Roboflow/rf-detr-nano`, `Roboflow/rf-detr-small`,
  `model.safetensors`); they were **not** used — the checkpoints above are what the
  `rfdetr` package itself downloads, so the export path is the package's own.

## 3. ONNX exports (official `rfdetr` exporter)

Export command (per model, `rfdetr` 1.12.1):

```python
from rfdetr import RFDETRNano   # / RFDETRSmall
model = RFDETRNano(pretrain_weights="/abs/path/rf-detr-nano.pth")
model.export(output_dir="onnx-nano", format="onnx", opset_version=17)
```

| Model | ONNX file | Size (bytes) | SHA-256 | Input | Outputs | Opset | Export time | Peak RSS (export proc.) |
|---|---|---|---|---|---|---|---|---|
| Nano | `onnx-nano/rfdetr-nano.onnx` | 116,607,449 | `26728b72ccbb264678566993bc63007d48622490d547aff950814c9f9bee0851` | `input` [1,3,384,384] float32 | `dets` [1,300,4], `labels` [1,300,91] | 17 | 6.2 s export step (whole script 33 s incl. imports + model load) | 1.14 GB |
| Small | `onnx-small/rfdetr-small.onnx` | 123,850,761 | `f3db46a84daff4e64ff1e466a1dd463aa8f2d26bf1f6f20bb43516f508d8eb95` | `input` [1,3,512,512] float32 | `dets` [1,300,4], `labels` [1,300,91] | 17 | 6.9 s (load 7.4 s) | 1.34 GB |

- Exporter: `rfdetr` 1.12.1, producer `pytorch 2.14.0`. FP32 (the `fp16` export flag
  applies only to TensorRT, not ONNX).
- Embedded ONNX metadata (`rfdetr_inference`): `task: detect`, `variant:
  rfdetr-nano/small`, `input_layout: NCHW`, `input_dtype: float32`,
  `means: [0.485, 0.456, 0.406]`, `stds: [0.229, 0.224, 0.225]`,
  `resize_interpolation: bilinear`, `resize_antialias: false`,
  `box_format: cxcywh_normalized`, `num_classes: 90`, `num_select: 300`,
  `selection_policy: all_logits`, `class_id_to_name: {"1": "person", … "90": "toothbrush"}`.
- **Class-slot layout (verified empirically, not assumed):** the `labels` tensor has
  91 slots. A probe run showed the portrait's top detection is **slot 1 @ 0.981**
  (box covering the whole person) and the dog photo's top is **slot 18 @ 0.485**
  (COCO id 18 = dog). So **slot N = COCO category id N; slot 1 = person;
  slot 0 = background/no-object; slot 90 = toothbrush**. The benchmark therefore
  counts a detection as "person" iff `class_id == 1`, and decodes with
  `background_class_id=None` (the export helper's default of `-1` would wrongly drop
  the toothbrush slot; irrelevant to person, but wrong in general for these
  checkpoints — the helper's own docstring says to pass `None` for sparse COCO
  checkpoints).
- Preprocessing used (the package's own): `rfdetr.export._runtime.preprocess.
  preprocess_to_nchw` — torchvision `to_tensor` → resize to the square model
  resolution with `antialias=False` → ImageNet normalize. **Aspect ratio is NOT
  preserved** (plain stretch to square); that is `RFDETR.predict()`'s own default
  convention, so the benchmark matches what the model expects — but a production
  scanner should know the image is distorted before inference.
- Decoding used (the package's own): `rfdetr.export._runtime.decode.
  decode_detections` — per-class sigmoid, top-k query/class pairs before thresholding,
  `cxcywh` → pixel `xyxy`. Thresholds 0.50 and 0.70 are decoded from the **same** raw
  outputs (no re-inference).

## 4. Environment & install steps

### 4.1 VM (this machine, 2026-11-19)

| Item | Value |
|---|---|
| CPU | AMD EPYC 9D25 126-Core Processor (host); **4 vCPUs visible** (`nproc` = 4) |
| CPU quota | **1.5 CPU** (shared, 1500 millicores) |
| Memory | Host 7.7 GB total; cell limit ~6.0 GB (`sharedMemoryLimitBytes` 6,442,450,944); host `MemAvailable` was ~1.0–1.3 GB during the runs (other agents' work sharing the host) |
| OS / Python | Linux, Python 3.12.3 |
| Runtime | onnxruntime **1.32.0**, torch **2.14.0+cpu**, torchvision **0.29.2+cpu**, rfdetr **1.12.1**, numpy, Pillow |

### 4.2 Install (reproducible)

All work in `scanner/models/rf-detr/`, in a venv (`venv/`, 1.7 GB) so the system
Python is untouched:

```bash
cd scanner/models/rf-detr
python3 -m venv venv
# torch: pip's download from download.pytorch.org truncated repeatedly
# (187.2/209.5 MB then failed after 11 resume attempts), so the wheel was
# fetched with curl --retry + resume and hash-verified, then installed locally:
curl -C - -L --retry 3 -o 'torch-2.14.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl' \
  'https://download-r2.pytorch.org/whl/cpu/torch-2.14.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl'
# sha256 a09987c95ec4cffdb6df798d3d641558110a334cfccce22f2f046d83142bc260 (match)
./venv/bin/python -m pip install './torch-2.14.0+cpu-cp312-cp312-manylinux_2_28_x86_64.whl'
./venv/bin/python -m pip install 'torchvision==0.29.2+cpu' --index-url https://download.pytorch.org/whl/cpu
./venv/bin/python -m pip install numpy Pillow "rfdetr[onnx]" onnxruntime
```

### 4.3 Gotchas hit (recorded so nobody re-hits them)

1. **System pip is PEP 668 externally-managed** — plain `pip install --user torch`
   refuses; a venv (or `--break-system-packages`) is required.
2. **pip cannot reliably download the ~200 MB torch wheel through this egress proxy**
   (truncated at ~187 MB after 11 resume attempts, twice); `curl -C -` with retries
   completed it (second download ran at ~46 MB/s; speed varies wildly).
3. **torch 2.15.0+cpu has no matching torchvision yet.** The CPU index's newest
   torchvision is 0.29.2+cpu, which pairs with torch 2.14.x; with torch 2.15,
   `import rfdetr` dies with `RuntimeError: operator torchvision::nms does not exist`.
   Fix used: **torch 2.14.0+cpu + torchvision 0.29.2+cpu**.
4. **The docs are stale on the extra name.** `rfdetr.roboflow.com/1.4.0` says
   `pip install "rfdetr[onnxexport]"`; PyPI now serves **rfdetr 1.12.1**, which has no
   `onnxexport` extra — the correct extra is **`rfdetr[onnx]`** (onnx + onnxruntime).
   The `model.export()` API itself is unchanged.
5. **GitHub API is rate-limited on the shared egress IP** (used only for repo
   inspection; the weights come from `repo.roboflow.com`, unaffected).
6. The `.pth` checkpoints are ~3× the deployment size (§2) — do not ship them; ship
   the `.onnx` files.

## 5. Benchmark method

- Test set: `scanner/testset/` — the same 16 real Wikimedia Commons photos as the
  EfficientDet run. Ground truth from `manifest.json` / `TESTSET.md`: **11
  person-present, 5 no-person** (2 dogs, 2 landscapes, 1 vintage camera).
- Runner: `benchmark.py` (in `rf-detr/`). One `InferenceSession` per model,
  `CPUExecutionProvider`, `intra_op_num_threads=2`, `inter_op_num_threads=1`
  (2 threads ≈ the 1.5-CPU quota; ORT defaults would oversubscribe it).
- Per image: preprocess → `session.run` → decode at 0.50 and 0.70 from the same
  outputs. **"Infer" = `session.run` only. "E2E" = preprocess + run + decode.**
  Reported times are means over **2 full passes × 16 images = 32 inferences** per
  model, after 1 uncounted warmup image. Scores were bit-identical across the two
  passes (deterministic); only timing varies.
- CPU usage = process user+sys time ÷ wall time over the timed section (average
  cores used). Peak RSS = `/proc/self/status` VmHWM at end of the model run.
- Image-level verdict: person present iff ≥1 detection with class slot 1 at/above
  the threshold. Recall = TP/11, precision = TP/(TP+FP).

## 6. Results

### 6.1 Headline (2 passes × 16 images)

| | Nano | Small |
|---|---|---|
| Input | 384×384 | 512×512 |
| Session load | 0.63 s | 0.67 s |
| Infer mean / median / min–max | **327.2 / 320.0 / 260.5–401.6 ms** | **571.9 / 559.9 / 509.5–793.7 ms** |
| Infer images/s | **3.06** | **1.75** |
| E2E mean / median / min–max | **422.4 / 414.5 / 344.6–497.8 ms** | **658.2 / 644.8 / 551.6–896.8 ms** |
| E2E images/s | **2.37** | **1.52** |
| Avg CPU cores used | 1.39 | 1.37 |
| Peak RSS (benchmark process) | 0.71 GB | 0.81 GB |
| Recall @0.50 / precision @0.50 | **1.000 / 1.000** (TP 11, FP 0, FN 0, TN 5) | **1.000 / 1.000** (TP 11, FP 0, FN 0, TN 5) |
| Recall @0.70 / precision @0.70 | **0.909 / 1.000** (TP 10, FP 0, FN 1, TN 5) | **0.727 / 1.000** (TP 8, FP 0, FN 3, TN 5) |

Raw per-photo JSON: `RF-DETR-RESULTS-NANO.json`, `RF-DETR-RESULTS-SMALL.json`
(next to this report; canonical copies in `rf-detr/results-{nano,small}.json`).

### 6.2 Per-photo — Nano (best person score; counts at each threshold; infer ms, both passes)

| Photo | Truth | Best person | Persons @0.50 | Persons @0.70 | Infer ms (p1 / p2) |
|---|---|---|---|---|---|
| b1-back-soldier | person ×1 | **0.974** | 1 | 1 | 398 / 261 |
| b2-behind-back | person ×1 | **0.832** | 1 | 1 | 295 / 316 |
| b3-back-tattoo | person ×1 | **0.982** | 1 | 1 | 308 / 333 |
| d1-crowd-funeral | person (many) | **0.703** | 7 | 1 | 380 / 370 |
| d2-crowd-street-night | person (many) | **0.714** | 5 | 1 | 337 / 323 |
| d3-lone-beach | person ×1 | **0.568** | 1 | 0 | 388 / 344 |
| g1-team-cincinnati | person ×11 | **0.865** | 10 | 6 | 314 / 308 |
| g2-imperial-family | person ×7 | **0.951** | 6 | 6 | 380 / 308 |
| g3-west-point-1899 | person ~14 | **0.915** | 11 | 11 | 402 / 310 |
| p1-huang-portrait | person ×1 | **0.981** | 1 | 1 | 312 / 321 |
| p2-khrushchev-portrait | person ×1 | **0.981** | 1 | 1 | 315 / 299 |
| a1-dog-running | none | 0.035 | 0 | 0 | 319 / 325 |
| a2-dog-stream | none | 0.033 | 0 | 0 | 315 / 322 |
| l1-glacier-lake | none | 0.061 | 0 | 0 | 314 / 314 |
| l2-mountain-lake | none | 0.219 | 0 | 0 | 330 / 322 |
| o1-vintage-camera | none | 0.055 | 0 | 0 | 262 / 325 |

### 6.3 Per-photo — Small

| Photo | Truth | Best person | Persons @0.50 | Persons @0.70 | Infer ms (p1 / p2) |
|---|---|---|---|---|---|
| b1-back-soldier | person ×1 | **0.977** | 1 | 1 | 561 / 523 |
| b2-behind-back | person ×1 | **0.937** | 1 | 1 | 524 / 515 |
| b3-back-tattoo | person ×1 | **0.985** | 1 | 1 | 514 / 532 |
| d1-crowd-funeral | person (many) | **0.617** | 6 | 0 | 581 / 576 |
| d2-crowd-street-night | person (many) | **0.690** | 5 | 0 | 599 / 521 |
| d3-lone-beach | person ×1 | **0.528** | 1 | 0 | 544 / 545 |
| g1-team-cincinnati | person ×11 | **0.900** | 11 | 8 | 622 / 571 |
| g2-imperial-family | person ×7 | **0.952** | 6 | 5 | 584 / 510 |
| g3-west-point-1899 | person ~14 | **0.917** | 10 | 9 | 637 / 526 |
| p1-huang-portrait | person ×1 | **0.983** | 1 | 1 | 597 / 563 |
| p2-khrushchev-portrait | person ×1 | **0.983** | 1 | 1 | 535 / 588 |
| a1-dog-running | none | 0.044 | 0 | 0 | 520 / 559 |
| a2-dog-stream | none | 0.042 | 0 | 0 | 535 / 542 |
| l1-glacier-lake | none | 0.051 | 0 | 0 | 755 / 609 |
| l2-mountain-lake | none | 0.122 | 0 | 0 | 794 / 593 |
| o1-vintage-camera | none | 0.115 | 0 | 0 | 520 / 608 |

### 6.4 What the per-photo numbers say

- **Back views are fixed.** EfficientDet missed b1 and b2 outright (0.0). Nano finds
  b1 at **0.974** and b2 at **0.832**; Small at 0.977 / 0.937. This was the prototype's
  biggest safety gap (2 of the 3 misses to ALLOW) and it is closed.
- **The distant walker is found at 0.50, not at 0.70.** d3 scores 0.568 (Nano) /
  0.528 (Small) — the third EfficientDet miss to ALLOW is now a detection at the
  0.50 threshold, but still below 0.70. At the project's 0.70 policy threshold Nano
  misses only d3; Small also misses both crowds (d1 0.617, d2 0.690 — both detected,
  just below 0.70).
- **Crowds score lower than single people** on both models (0.62–0.71 best), because
  each person is small. At 0.50 both models still catch the crowds (5–7 persons each).
- **Groups are still undercounted** (g1: 10–11 of 11 — actually good; g2: 6 of 7;
  g3: 10–11 of ~14). Verdicts are right; do not use the count as a headcount.
- **No false positives.** Best person score on any no-person photo is 0.219 (Nano,
  mountain lake) / 0.122 (Small) — far below 0.50. The dog photos top out at 0.035 /
  0.044 for person (the dog itself is detected as dog, slot 18 @ 0.485 in the probe).
- **Small is not better here.** At 0.50 both are perfect; at 0.70 Nano (0.909) beats
  Small (0.727) on this set, and Nano is 1.75× faster. Small's higher COCO AP does
  not translate into better person recall on these 16 photos. (n=16 — do not
  over-read this; the point is Small earns no advantage to justify its cost.)

### 6.5 Comparison vs EfficientDet-Lite0 baseline (same set)

Baseline figures re-verified from `scanner/testset/results.json` in this session:
at 0.50, 8 of 11 person photos reach threshold (b3, d1, d2, g1, g2, g3, p1, p2) →
recall 0.727; at 0.70, 5 of 11 → recall 0.455; precision 1.000 at both. Baseline
speed: mean 2,539 ms/image loaded run / 1,477 ms quiet run — but that time covers
**both** the person detector and the face detector together, so it is not a pure
person-model comparison; even so, Nano's 327 ms inference (422 ms end-to-end) is
several times faster than the baseline pipeline on the same VM.

| | Recall @0.50 | Recall @0.70 | Precision | Missed to ALLOW @0.70 | Speed (this VM) |
|---|---|---|---|---|---|
| EfficientDet-Lite0 (+face) | 0.727 | 0.455 | 1.000 | 3 (b1, b2, d3) | 1,477–2,539 ms/img (both detectors) |
| **RF-DETR Nano** | **1.000** | **0.909** | 1.000 | 1 (d3) | **327 ms infer / 422 ms e2e** |
| **RF-DETR Small** | **1.000** | **0.727** | 1.000 | 3 (d1, d2, d3) | **572 ms infer / 658 ms e2e** |

### 6.6 Is this speed usable for the filter? (honest judgement)

What was measured: **one Nano stream = ~2.4 images/s end-to-end** on a shared
1.5-CPU slice of an AMD EPYC host, using ~1.4 cores and 0.71 GB RAM. A server is
not this VM: a dedicated 8-core box running 4–6 Nano workers in parallel would do
roughly **10–15 images/s** (≈ 36,000–54,000 images/hour) if it scales linearly,
before any caching. Illustrative arithmetic for 10,000 customers (assumptions
stated, not measured): at 10 scanned images per customer per hour → 100,000/hour →
~2–3 such servers; at 100/hour → ~20–30 servers. Two things cut that drastically
in practice: (1) URL/content-hash caching and dedup — the same popular images are
seen by thousands of customers and need scanning once; (2) most page images are
small icons/logos that can be skipped by size/type before the model ever runs.
What this speed does **not** do: live video frame-by-frame (a 60 s clip at 1 fps is
60 images ≈ 25 s of Nano time) — video needs frame sampling plus a separate design,
and was not tested here. A page with 20 photos takes ~8.5 s single-stream,
~2–3 s with 4 workers — acceptable for a cover-until-decided filter, not instant.
Bottom line: **Nano on CPU is fast enough for the still-image scanner, including on
shared-server economics, provided caching/dedup is built; it is not a video solution
and it is not free of server cost** (the model/API is $0; the servers, electricity
and bandwidth are not).

## 7. Limits — what this does NOT prove

- **n = 16 photos, 11 positive / 5 negative.** Recall 1.000 and precision 1.000 are
  encouraging, not a production accuracy claim. Five negatives cannot rule out rare
  false positives; eleven positives cannot prove back-view/distant recall in general.
- **Real-site validation was not done here** (no BBC/Wikipedia/Commons crawl with
  RF-DETR). That is the next measurement before any cutover.
- **Single VM, shared host.** Timings were stable across two passes (means within
  ~5%), but host load from other agents varied; treat ±10% as noise.
- **Threads fixed at 2.** Other thread counts, batching, and concurrent-worker
  scaling were not measured.
- **INT8 quantization not tested.** The exporter supports it and it would likely
  cut latency further; it needs its own accuracy re-check (quantization can move
  borderline scores like d3's 0.568).
- **Preprocessing goes through torch** (torchvision resize) in the measured e2e
  time (~95 ms/image of the e2e total); a numpy/OpenCV preprocessing path could
  shave that, untested.
- **Only still images.** Video frames, canvas/WebGL captures, live streams, and
  dynamic content were not benchmarked.
- **License caveat** (§1.2): the DINOv2 backbone provenance was not separately
  traced; Atto/Femto/Pico/XL/2XL are PML 1.0, not Apache — stay on Nano/Small/
  Medium/Large.

## 8. Files produced (all under `scanner/models/`)

| Path | What it is |
|---|---|
| `RF-DETR-BENCHMARK.md` (this file) | Full report |
| `RF-DETR-RESULTS-NANO.json`, `RF-DETR-RESULTS-SMALL.json` | Raw per-photo results (2 passes) |
| `rf-detr/rf-detr-nano.pth`, `rf-detr-small.pth` | Official checkpoints (MD5-verified, §2) |
| `rf-detr/onnx-nano/rfdetr-nano.onnx`, `rf-detr/onnx-small/rfdetr-small.onnx` | Official exports (SHA-256, §3) |
| `rf-detr/benchmark.py`, `rf-detr/export_nano.py`, `rf-detr/export_small.py`, `rf-detr/probe_slots.py` | Scripts used (export / probe / benchmark) |
| `rf-detr/model_weights.py` | Copy of the repo's asset table (URLs + published MD5s) |
| `rf-detr/venv/` (1.7 GB), `rf-detr/torch-2.14.0+cpu-….whl` | Reproducible environment + torch wheel |

Reproduce: `cd scanner/models/rf-detr && ./venv/bin/python benchmark.py nano 2`
(or `small 2`). Export again: `./venv/bin/python export_nano.py`.
