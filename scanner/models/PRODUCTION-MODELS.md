# Production person-detection models — research notes

**Date:** 2026-11-18. **Author:** research subagent (production-model review).
**Status:** research only. **Nothing in this file is legal advice.** No license
stated here is settled for commercial shipment — see §7.

Labels used throughout: **VERIFIED** = checked first-hand from the primary
source in this session; **SECONDARY** = stated by a third party, not the
rights holder; **UNVERIFIED** = not confirmed.

Decision context (Yakob, 2026-11-18 ~12:55 EST): EfficientDet-Lite0 stays
for **prototype / first testing only**. Do not confirm it as the production
model until exact weights, hash, source and license are verified. For
production, research Intel Person Detection and other clearly-licensed
models. Check **all upstream dependencies AND model weights**, not just the
program license. Ultralytics YOLO (AGPL-3.0) is already excluded and is not
re-proposed here.

---

## 1. EfficientDet-Lite0 (current prototype model)

### 1.1 File in the repo — hash CONFIRMED

| Item | Value |
|---|---|
| File | `scanner/models/efficientdet_lite0.tflite` (float16) |
| Size | **7,254,339 bytes** |
| SHA-256 (computed independently in this session) | **`4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993`** |
| Coordinator's earlier measurement | same value — **confirmed, no correction** |
| Source (per `models/LICENSES.md` + `scanner/README.md`) | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite` — Google's official MediaPipe model bucket, the same URL Google's own Object Detector web demo uses |
| What it is | EfficientDet-Lite0, EfficientNet-Lite0 backbone + BiFPN, 320×320 input, trained on COCO (80 classes); scanner allowlists only `person` |
| Benchmarks (Google's docs page) | Pixel 6: float16 **53.97 ms CPU** / 27.97 ms GPU; int8 29.31 ms CPU; float32 61.30 ms CPU |

Re-verify: `sha256sum scanner/models/efficientdet_lite0.tflite`

### 1.2 (a) Google's MediaPipe Object Detector docs — VERIFIED: no weights license stated

Page: https://developers.google.com/edge/mediapipe/solutions/vision/object_detector
(crawled 2026-11-18; "Last updated 2026-11-17 UTC").

- The page **names** `efficientdet_lite0.tflite` and links the int8 / float16 /
  float32 builds from `storage.googleapis.com/mediapipe-models/...`.
- The **only** "license" text on the whole page is the standard footer
  (2 matches, both the footer): *"Except as otherwise noted, the content of
  this page is licensed under the Creative Commons Attribution 4.0 License,
  and code samples are licensed under the Apache 2.0 License."*
- **No model-weights license is stated anywhere on the page.** No model
  card is linked for EfficientDet-Lite0. The page licenses its own *text*
  (CC-BY 4.0) and *code samples* (Apache 2.0) — neither covers the
  `.tflite` weights.
- The MediaPipe *code* (`@mediapipe/tasks-vision`, repo
  `google-ai-edge/mediapipe`) is Apache 2.0 — that is the **runtime**, not
  the weights.

### 1.3 (b) The three secondary sources — what each actually says

**1. pub.dev `object_detection` package — SECONDARY, and it does NOT cover our exact file.**
https://pub.dev/packages/object_detection

Verbatim (checked 2026-11-18):
> "All TFLite models are sourced from Google's MediaPipe framework. Google
> publishes no standalone model card for the EfficientDet-Lite object
> detectors, so the underlying EfficientDet paper is archived in
> `doc/model_cards/`"
>
> "`efficientdet_lite0.tflite` (13,836,895 bytes, SHA-256
> `40338edf5ec70d43e318b0a716a84d4564cd1802759a7a07170c7e43796dbf58`) and
> `efficientdet_lite2.tflite` (23,096,891 bytes, SHA-256
> `ad2abbf2b4e10585e15176fd7b5ef03c28dda959ae26fc142549fdd1814db91d`) are
> byte-identical to Google's official MediaPipe float32 v1 builds … Both
> models are Apache 2.0 licensed."

Critical nuance: the byte-identity claim and the "Apache 2.0 licensed"
sentence refer to the **float32 v1** builds (13,836,895 bytes). Our repo
file is the **float16** build (7,254,339 bytes, different hash). The
float16 file comes from the same official bucket, so the claim *probably*
extends to it — but the pub.dev evidence, read strictly, does not cover
the exact file we ship. This is a third-party package's assertion, not
Google's own words, and it cites no Google license text.

**2. PitchOverlay — SECONDARY, one FAQ sentence, no citation.**
https://pitchoverlay.site/ (FAQ, checked 2026-11-18)

Verbatim:
> "Q: Which model does the detection use, and can I swap it? A: The default
> detector is MediaPipe Object Detector with EfficientDet-Lite0, which is
> Apache-2.0 licensed — we deliberately avoid Ultralytics YOLOv8 weights in
> the default path because of their AGPL licence."

A commercial product's FAQ asserting Apache 2.0. No link to a Google
license, no hash, no model-card reference. Useful as corroboration only.

**3. "KTag SBOM citing TF Hub" — UNVERIFIED, could not be located.**
Two web searches for "KTag SBOM" / "ktag" + EfficientDet / TensorFlow Hub
found **no** SBOM source by that name saying anything about
EfficientDet-Lite0. The only "KTag" hits are an unrelated hobby-electronics
project (ktag.clubk.club — a hardware "Bill of Materials" for a
microcontroller board, nothing to do with ML models). Possibly a
misremembered name. **Treat this source as non-existent until someone
produces a URL.** It contributes nothing to the evidence trail.

### 1.4 (c) TensorFlow Hub model page — VERIFIED: Kaggle-gated, unreadable

- `https://tfhub.dev/tensorflow/lite-model/efficientdet/lite0/detection/metadata/1`
  no longer serves a model page: curl follows it to
  `https://www.kaggle.com/models/tensorflow/efficientdet/tfLite/lite0-detection-metadata/1?tfhub-redirect=true`
  (HTTP 200 after redirect).
- The Kaggle page is a JavaScript app: `browser.open` on it failed with
  "no extractable content". No license text, model card, or download is
  retrievable from it without a Kaggle session. TF Hub as a readable
  license source for this model is **dead**.

### 1.5 EfficientDet verdict

| Question | Answer |
|---|---|
| Hash / source | **VERIFIED.** File matches the coordinator's hash; source is Google's official MediaPipe bucket. |
| Code (tasks-vision runtime) license | **VERIFIED Apache 2.0.** |
| Weights license | **UNVERIFIED.** No Google source states it. Best evidence is two secondary assertions (pub.dev, PitchOverlay), and the pub.dev one strictly covers the float32 build, not our float16 file. The TF Hub page that might have stated it is Kaggle-gated. |
| What would settle it | (1) A Google page, model card, or terms text that names the EfficientDet-Lite weights license; or (2) written confirmation from Google; or (3) a switch to the **float32 v1** build whose hash pub.dev documents (still secondary evidence, but at least the exact file would be covered). Until then: **prototype only**, per Yakob's decision. |

---

## 2. Intel Open Model Zoo — person-detection-0202 (leading production candidate)

### 2.1 Source and license — VERIFIED

- Repo: https://github.com/openvinotoolkit/open_model_zoo
  (GitHub API: license `Apache-2.0`).
- Repo `LICENSE` fetched 2026-11-18: **11,357 bytes, "Apache License,
  Version 2.0, January 2004"** — full Apache 2.0 text.
- Model dir: `models/intel/person-detection-0202/` — `README.md` carries
  **no separate license**, and `model.yml` has an explicit license field:
  `license: https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/LICENSE`
  (the repo LICENSE). The model therefore falls under the repo's Apache 2.0.
- **Caveat (VERIFIED, and important):** an Intel Community thread dated
  2026-11-18 asks exactly this question for a commercial edge product
  shipping OMZ IR files (incl. person-detection-0202): does Apache 2.0 cover
  the downloadable weights, and do training-data terms limit commercial use?
  Intel's staff answer was: check each model's `model.yml`, training-data
  restrictions "may need separate confirmation", and "it's best to ask
  Intel directly for written confirmation about the weights, datasets, and
  redistribution requirements before shipping them."
  https://community.intel.com/t/commercial-use-of-open-model-zoo-intel-models-weights-licence-and-training-data/144990
  So: the repo license is Apache 2.0 and the model has no separate terms,
  but **Intel itself recommends written confirmation before commercial
  shipment** — the weights question is not closed by the repo LICENSE alone.
  Also open: whether any non-commercial training data was used (the thread
  raises WIDER FACE / IMDB-WIKI for the *face* and *age-gender* models;
  person-detection-0202 itself is a MobileNetV2-SSD trained by Intel, and
  its README names no training dataset — the dataset question for this
  specific model is UNVERIFIED).

### 2.2 Model files, sizes, hashes — ⚠️ PUBLISHED HASHES DO NOT MATCH THE SERVED FILES

`model.yml` (master, fetched 2026-11-18) lists these files, all under
`https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/person-detection-0202/`:

| File | Size (bytes) | Checksum in `model.yml` |
|---|---|---|
| `FP32/person-detection-0202.xml` | 185,467 | `fc218405…` |
| `FP32/person-detection-0202.bin` | 7,269,196 | `e807fab1…` |
| `FP16/person-detection-0202.xml` | 254,889 | `7746ed65…` |
| `FP16/person-detection-0202.bin` | 3,634,654 | `2a149bc8…` |
| `FP16-INT8/person-detection-0202.xml` (2022.3 bucket) | 490,566 | `5945dc07…` |
| `FP16-INT8/person-detection-0202.bin` (2022.3 bucket) | 1,942,006 | `f3c64f38…` |

Full published checksums (SHA-256, per `model.yml`):
- FP16 `.bin`: `2a149bc8c2f02965c59a998d7ca7868e4ba537c223ae492a8a177386f98997d8c15204f1c7fe847a51c660d9d4116d10`
- FP16 `.xml`: `7746ed6534bb59c9d16e7af4dbcbc768772288d48aca7e081c059eb1924ea956c67f23381a860a0bf0e187d66b7f1955`
- FP32 `.bin`: `e807fab165c5327cf726eea6f5d70832dd4bbaec865d929b1ead67061759cf809debf0e43d53b23d612b4c3320eab578`

**Hash verification FAILED (measured 2026-11-18).** I downloaded the
served files and hashed them:

| File | Served size | Served SHA-256 (measured) | Matches `model.yml`? |
|---|---|---|---|
| FP16 `.bin` | 3,634,654 ✓ | `11599bdd44bf863d7d1783ed99b2bc406e7d6588ecd5b5ce8381e366cc634914` | **NO** |
| FP16 `.xml` | 254,889 ✓ | `50fff87826a372356b33010a4b8a0676019118ca06d7f78317156bb044426aac` | **NO** |
| FP32 `.bin` | 7,269,196 ✓ | `3d8a00710877e5a94bc6ecb2e5f4514975647376f1e04031d89a75e723a3be02` | **NO** |

Sizes match exactly but hashes differ — the bucket files were evidently
re-exported (e.g. a newer IR version) without `model.yml` being updated,
or vice versa. Consequences:
- **Do not use the `model.yml` checksums to verify a download** — they
  will fail against the files actually served today.
- The files I measured are the current ground truth for the 2023.0 bucket;
  re-hash on every download and record the measured hash.
- `omz_downloader` against master `model.yml` would presumably fail its
  checksum check — use a pinned OMZ release's downloader/model list, or
  download directly and verify against the measured hashes above.
- There is **no `.onnx` variant** distributed by Intel for this model —
  OMZ ships IR (`.xml`/`.bin`) only.

### 2.3 What the model is — VERIFIED (model README + model.yml)

- Architecture: **MobileNetV2 backbone + two SSD heads** (1/16 and 1/8
  feature maps), clustered prior boxes for 512×512. Source framework:
  PyTorch. AP 0.322 @ IoU 0.50:0.95 (Intel internal test set).
- **3.143 GFLOPs, 1.817 MParams.**
- Input: `image`, shape **`1, 3, 512, 512` (NCHW), BGR** color order.
- Output: one blob, shape **`1, 1, 200, 7`** — up to 200 detections, each
  `[image_id, label, conf, x_min, y_min, x_max, y_max]` (normalized coords).
  `label` 0 = person. **Person-only detector** (unlike EfficientDet's 80
  COCO classes — no allowlist needed).
- CPU cost: 3.143 GFLOPs at 512×512 is heavier than EfficientDet-Lite0
  (~0.4–0.5 GFLOPs at 320×320). Intel's own benchmark table (ovkit, citing
  OpenVINO CPU): **13.4 ms / 75 FPS** for person-detection-0202 on an
  unspecified Intel CPU — treat as indicative, not a phone-CPU number.
  No published phone/ARM CPU latency was found.
- Used by Intel's own demos: Object Detection (C++/Python), Pedestrian
  Tracker, Social Distance.

### 2.4 Conversion path to a browser / Android-usable runtime

There is **no direct browser runtime for OpenVINO IR**. The path is
IR → ONNX → ONNX Runtime. Concretely:

**Step 1 — IR → ONNX (build machine, one-off).**
- Tool: **`openvino2onnx`** (PyPI, `pip install openvino2onnx`;
  https://pypi.org/project/openvino2onnx). CLI shape:
  `openvino2onnx person-detection-0202.xml [person-detection-0202.onnx]`
  Supports IR v10 (OpenVINO <2023) and IR v11 (OpenVINO ≥2023).
  **Community tool, not Intel-official** — conversion fidelity must be
  verified (run the same test set through IR and ONNX and compare boxes).
- Alternative: **PINTO0309 `openvino2tensorflow`**
  (https://pypi.org/project/openvino2tensorflow) — IR → TensorFlow
  SavedModel → then ONNX or **TFLite**. This is the only documented
  IR → TFLite route; it is also community-maintained and fiddly (the author
  notes layer-support gaps). Prefer the direct IR → ONNX route.
- The **other direction is official**: OpenVINO Model Converter (`ovc`,
  `pip install openvino`) converts ONNX → IR. It does **not** convert
  IR → ONNX.

**Step 2a — Browser extension: `onnxruntime-web` (npm, MIT).**
- `npm install onnxruntime-web` (MIT license — npm registry `license`
  field; Microsoft/onnxruntime repo is MIT). Runs ONNX in the browser via
  **WASM CPU** (SIMD + multi-threaded builds) with optional WebGPU/WebNN.
- Fits the extension directly: bundle the `.onnx` + `ort` WASM files,
  `ort.InferenceSession.create(model)`, feed a 512×512 BGR tensor,
  post-process the `1,1,200,7` output in JS (same math as the scanner's
  current detector, different tensor layout). No server, no download at
  runtime. MV3-compatible (WASM in extension pages/service worker needs
  the standard `wasm-unsafe-eval` CSP consideration — verify at build time).

**Step 2b — GeckoView Android app: `onnxruntime-android` (Maven, MIT).**
- ONNX Runtime ships an official Android AAR
  (`com.microsoft.onnxruntime:onnxruntime-android`, Java/Kotlin API,
  CPU + NNAPI execution providers). This is the **recommended** Android
  path: convert once to ONNX, ship the `.onnx` in app assets, run it
  through ONNX Runtime's Java API from the GeckoView app's native side,
  and pass results across the WebExtension native bridge. Same `.onnx`
  file serves the extension and the app.
- **Not recommended: running IR natively via OpenVINO on Android.**
  OpenVINO *can* be built for Android from source
  (`openvino/docs/dev/build_android.md`: `arm64-v8a`, ARM CPU plugin,
  Java API, produces `libopenvino.so`), but there is **no official
  prebuilt Android release / Maven artifact**, and the build is
  notoriously painful — an Intel forum thread from Dec 2025 reports a
  user stuck for 2 months failing to produce the Java `.so`/AAR. A
  from-source OpenVINO Android build is a project in itself; do not make
  the browser prototype depend on it.
- Note: ONNX Runtime also has an **OpenVINO execution provider**, but it
  targets x86 Intel hardware (server/desktop), not Android ARM — it does
  not help on phones.

**Recommended production shape:** one canonical artifact — the ONNX
conversion of person-detection-0202 (or RF-DETR, §3) — run by
`onnxruntime-web` in the extension and `onnxruntime-android` in the
GeckoView app. The scanner (Node) can use `onnxruntime-node` on the same
file, replacing the current MediaPipe/TFLite detector.

### 2.5 Blockers

- **(a) GeckoView Android prototype:** no blocker in principle —
  `onnxruntime-android` is official and maintained. The real work is the
  IR → ONNX conversion + detection-parity test, and plumbing camera/page
  frames from GeckoView through the native bridge to ONNX Runtime. The
  single biggest blocker is **the conversion itself being unverified**:
  no one has yet produced an ONNX file from this IR and shown it detects
  people identically.
- **(b) Browser extension:** the model is bigger and hungrier than
  EfficientDet-Lite0 (512×512 input, 3.1 GFLOPs vs ~0.5; FP16 .bin
  3.6 MB → ONNX FP32 likely ~7 MB, INT8 ~2 MB). The biggest blocker is
  **CPU cost per image in WASM** on low-end machines plus the
  **hash-mismatch / provenance** issue in §2.2 — the served files cannot
  currently be verified against Intel's published checksums, which is a
  supply-chain red flag to clear before shipping.
- **License blocker (both):** Intel's own staff recommend **written
  confirmation** that Apache 2.0 covers the weights + derivatives for
  commercial shipment (see §2.1). Get that, or accept the residual risk
  explicitly.

---

## 3. Candidate 2 — RF-DETR Nano (Roboflow) — Apache 2.0, ONNX-native

### 3.1 License — VERIFIED (repo + model card)

- Repo: https://github.com/roboflow/rf-detr — GitHub API license
  **`Apache-2.0`**; `LICENSE` file fetched from the `master` branch
  (note: it 404s on `main` — the file lives on `master`): "Apache License,
  Version 2.0, January 2004".
- README states explicitly (checked 2026-11-18):
  > "**Commercially usable under Apache 2.0.** The `rfdetr` package,
  > RF-DETR Nano, Small, Medium and Large detection … are released under
  > the Apache 2.0 license, so they're commercially usable out of the box:
  > you can ship them in closed-source, commercial products, including
  > self-hosted deployments, without paying a license fee or open-sourcing
  > your code."
- Hugging Face `Roboflow/rf-detr-nano` README front-matter: `license:
  apache-2.0` (verified from the raw README; the HF API `license` field
  itself returns null — the declaration lives in the README, not API
  metadata).
- **Exclusions inside the same family:** XL / 2XL (and Atto/Femto/Pico)
  detection weights are under Roboflow's **PML 1.0** (commercial
  self-hosting needs an Enterprise add-on). Only **Nano / Small / Medium /
  Large** are Apache 2.0. Do not use XL/2XL.
- Corroboration: Roboflow's own supported-models page lists RF-DETR as
  "Apache 2.0 (free for commercial use); XL and 2XL: PML 1.0"; TI's
  EdgeAI ModelHub RF-DETR README lists `license: apache-2.0` and notes
  Nano–Large are Apache 2.0, XL/2XL are PML 1.0.

### 3.2 Model facts — VERIFIED where stated

| Item | Value |
|---|---|
| Architecture | DETR-family transformer detector, 300 learned queries; COCO-pretrained |
| Variants (Apache 2.0) | Nano 384×384, Small 512×512, Medium 576×576, Large 704×704 |
| Nano params | **30,467,298 (F32)** per HF `safetensors` metadata → **~122 MB as FP32** weights; ONNX export will be similar size unless quantized (INT8 export supported by the `rfdetr` package) |
| Nano accuracy | 48.4 mAP [.5:.95] on COCO val2017 (TI EdgeAI README); Small 53.0, Medium 54.7, Large 56.5 — far above person-detection-0202's 0.322 AP and EfficientDet-Lite0 |
| Output | 300 boxes (cx, cy, w, h, 0–1) + 300×91 class scores (sigmoid); person = COCO class 0 — filter to `person` like today |
| CPU cost | **UNVERIFIED for CPU.** No published phone/CPU latency found in this session. Jetson/edge validation exists (TI TDA4VH). 30M params at 384×384 is a much heavier model than EfficientDet-Lite0 — expect materially slower CPU inference; must be measured on target hardware. |
| ONNX export | **Official, built in:** `pip install "rfdetr[onnx]"`, then `model.export("onnx")` (opset 17 by default, static batch). TI's EdgeAI repo ships a `prepare_model.py` that does the same. No third-party converter needed — this is the cleanest conversion story of any candidate. |
| Runtime fit | Same as §2.4: `onnxruntime-web` (extension) + `onnxruntime-android` (GeckoView app) + `onnxruntime-node` (scanner). One `.onnx` serves all three. |

### 3.3 Blockers

- **(a) GeckoView Android:** **model size + CPU cost.** ~122 MB FP32
  (Nano) is ~17× the current 7 MB TFLite; even INT8 it is ~30 MB, and a
  30M-param transformer at 384×384 will be slow on phone CPUs. Biggest
  blocker: **measure Nano INT8 on a real mid-range Android phone before
  committing** — it may be too slow for per-image scanning, in which case
  the model is a non-starter for the phone no matter how clean the license.
- **(b) Browser extension:** same size/CPU problem, plus extension
  packaging (a 30–120 MB model blob inside an MV3 extension is heavy;
  download-on-first-use from our own hosting is an option but adds a
  distribution step). License is the cleanest of all candidates; the
  blocker is purely performance/size.

---

## 4. Candidate 3 — RT-DETR R50vd (Baidu / Peking University) — Apache 2.0

### 4.1 License — VERIFIED (repo + model card)

- Repo: https://github.com/lyuwenyu/RT-DETR — GitHub API license
  **`Apache-2.0`**; `LICENSE` file fetched: "Apache License, Version 2.0,
  January 2004". The repo README itself notes "LW-DETR and D-FINE are
  Apache 2.0" alongside RT-DETR.
- Hugging Face `PekingU/rtdetr_r50vd` README: front-matter `license:
  apache-2.0` and a "License: Apache-2.0" line (verified from raw README).
- No PML-style split in this family — the whole RT-DETR / RT-DETRv2 line
  in this repo is Apache 2.0 as far as verified. (RT-DETRv2 lives in the
  same repo.)

### 4.2 Model facts

| Item | Value |
|---|---|
| Architecture | DETR-family real-time detector, ResNet-50 backbone + hybrid encoder |
| Params (R50vd) | **43,019,372 (F32)** per HF metadata → **~172 MB as FP32** |
| Input | 640×640 (RT-DETR default) |
| Accuracy / speed (repo README) | 55.3 mAP (Objects365-pretrained R50), **108 FPS on a T4 GPU** — GPU numbers only; no CPU/phone latency published |
| ONNX export | Repo ships an export script (`tools/export_onnx.py`); exact flags to be confirmed from the script at conversion time. No official prebuilt ONNX on the HF repo page checked — the HF repo ships `model.safetensors` only. |
| Runtime fit | Same ONNX Runtime story as §2.4 (§3.2). |

### 4.3 Blockers

- **(a) GeckoView Android:** **size is the worst of the three
  candidates** (~172 MB FP32, 43M params, 640×640 input). Almost certainly
  too heavy for per-image phone scanning without aggressive quantization,
  which is itself unverified work. Biggest blocker: size/CPU.
- **(b) Browser extension:** same — the heaviest candidate; only viable
  if quantized and measured. License is clean; performance is the problem.
- Verdict: keep as a **server-side / scanner-side** option (where a GPU or
  strong CPU exists), not a phone/extension first choice.

---

## 5. Also noted — D-FINE (brief, not a primary recommendation)

- Repo: https://github.com/Peterande/D-FINE — GitHub API license
  **`Apache-2.0`**; `LICENSE` file fetched from `master`: Apache 2.0.
- The RF-DETR README states "LW-DETR and D-FINE are Apache 2.0", and an
  independent license-policy doc records that an official D-FINE
  collaborator confirmed the `*_coco.pth` checkpoints are Apache-2.0
  (SECONDARY — collaborator confirmation, not a license file in the
  weights repo).
- D-FINE-S is reported at 53.4 mAP, 10.3 FPS on Jetson Orin Nano Super,
  640 input (visionanalysis.org, 2026-11-11 — secondary benchmark).
- ONNX export is supported (multiple secondary sources).
- **Why not a primary candidate here:** checkpoint-level license evidence
  is thinner than RF-DETR's (no explicit "commercially usable out of the
  box" weights statement in the D-FINE repo itself was verified in this
  session), and no params/file size was verified first-hand. Worth a
  follow-up check if RF-DETR's phone performance disappoints.

## 6. What was NOT proposed — and why

- **Ultralytics YOLO (v5/v8/v11/v26):** AGPL-3.0, code and weights —
  already excluded by Yakob. Not re-proposed.
- **MediaPipe's other detectors (SSD MobileNetV2, BlazeFace, etc.):**
  same license situation as EfficientDet-Lite0 (same bucket, no weights
  license stated) — no clearer, so not a production answer.
- **ONNX Model Zoo SSD/YOLO entries:** several are YOLO-derived (AGPL)
  or carry no verifiable weights license in the model repo; not pursued.

---

## 7. Comparison table

| | EfficientDet-Lite0 (prototype) | person-detection-0202 (Intel OMZ) | RF-DETR Nano | RT-DETR R50vd |
|---|---|---|---|---|
| Size (weights) | **7.3 MB** (float16 TFLite) | **3.6 MB** FP16 / 7.3 MB FP32 (.bin) → ONNX ~7 MB FP32 | **~122 MB** FP32 (~30 MB INT8, est.) | **~172 MB** FP32 |
| Input | 320×320 | 512×512 | 384×384 | 640×640 |
| Params / FLOPs | ~3.9M / ~0.5 GFLOPs | 1.817M / 3.143 GFLOPs | 30.5M / not published | 43.0M / not published |
| CPU cost (published) | 54 ms (Pixel 6 CPU, float16) | 13.4 ms (Intel CPU, per ovkit — not a phone) | not published — must measure | not published — must measure |
| Classes | 80 COCO (filter to person) | **person only** | 80 COCO (filter to person) | 80 COCO (filter to person) |
| Accuracy | good (COCO) | AP 0.322 (Intel internal set) | 48.4 mAP COCO | 55.3 mAP (Objects365 pretrain) |
| Weights license | **UNVERIFIED** (see §1.5) | Apache 2.0 per repo + model.yml; **written confirmation from Intel recommended** | **Apache 2.0, stated for weights incl. commercial closed-source use** (repo README + HF README) | **Apache 2.0** (repo LICENSE + HF README) |
| Hash verified | ✅ sha256 confirmed (§1.1) | ⚠️ **published hashes do NOT match served files** (§2.2) | not yet downloaded/hashed | not yet downloaded/hashed |
| Format | TFLite (runs today) | IR → **needs IR→ONNX conversion** | PyTorch → **official ONNX export** | PyTorch → repo ONNX export script |
| Extension runtime | MediaPipe WASM (works today) | onnxruntime-web (MIT) | onnxruntime-web (MIT) | onnxruntime-web (MIT) |
| GeckoView runtime | MediaPipe Android / TFLite (works today) | onnxruntime-android (MIT) | onnxruntime-android (MIT) | onnxruntime-android (MIT) |
| Biggest blocker (a) Android | — (already works) | **unverified IR→ONNX conversion + parity test** | **~122 MB + phone CPU speed unmeasured** | **~172 MB, almost certainly too heavy** |
| Biggest blocker (b) Extension | — (already works) | **WASM CPU cost + hash/provenance mismatch** | **size + CPU cost** | **size + CPU cost** |

**Recommendation from this research:** person-detection-0202 is the
most practical production candidate (smallest, person-only, cheapest to
convert, Apache 2.0 repo license), **provided** the §2.2 hash mismatch is
resolved and Intel written confirmation is sought. RF-DETR Nano is the
license-cleanest candidate and the fallback if the Intel weights question
or the conversion fails — but its phone performance must be measured
first; it may be too heavy. Neither is confirmed for production yet.

---

## 8. What remains UNVERIFIED — needed before commercial shipment

1. **EfficientDet-Lite0 weights license** — no Google source states it.
   Settle via a Google model-terms page/card or written confirmation, or
   switch to the float32 v1 build pub.dev documents (still secondary).
2. **Intel person-detection-0202 weights** — repo is Apache 2.0 and the
   model has no separate terms, but Intel staff recommend **written
   confirmation** covering weights + derivatives + redistribution before
   shipping. Also open: training dataset for this specific model (not
   named in its README).
3. **Intel hash mismatch (§2.2)** — published `model.yml` checksums do not
   match the files the 2023.0 bucket serves today (sizes match, hashes
   don't). Resolve: find which OMZ release's `model.yml` matches the
   served files, or pin the measured hashes above and re-verify on every
   download. Do not ship a model whose provenance hash fails.
4. **"KTag SBOM" source** — could not be located at all; disregard until
   a URL is produced.
5. **IR → ONNX conversion fidelity** — no converted ONNX exists yet for
   person-detection-0202. Must produce one (`openvino2onnx`) and prove
   detection parity against the IR model on the labeled test set.
6. **Phone CPU performance** — no candidate has a published phone-CPU
   latency. Measure person-detection-0202 (ONNX) and RF-DETR Nano (INT8)
   on a real mid-range Android phone before choosing.
7. **RF-DETR / RT-DETR file hashes** — neither model was downloaded in
   this session; hash on download and record.
8. **D-FINE checkpoint license** — only a secondary collaborator
   confirmation found; verify in the weights repo before considering it.
9. **All upstream dependencies of the runtimes** (ONNX Runtime MIT,
   `openvino2onnx` license, `rfdetr` package deps) — runtime licenses were
   noted (MIT/Apache 2.0) but dependency trees were not audited here.
   `openvino2onnx`'s own license was not checked in this session.
10. **This file is not legal advice.** Before shipment, have counsel
    confirm the chosen model's weights license and the Intel written
    confirmation.

## 9. Re-verify commands

```bash
# EfficientDet-Lite0 (expect 4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993)
sha256sum scanner/models/efficientdet_lite0.tflite

# Intel OMZ repo license + model.yml (note: served-file hashes differ, see §2.2)
curl -sL https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/LICENSE | head -3
curl -sL https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/models/intel/person-detection-0202/model.yml | grep -E "checksum|license"

# RF-DETR repo license (master branch, not main) + README commercial-use statement
curl -sL https://raw.githubusercontent.com/roboflow/rf-detr/master/LICENSE | head -3
curl -sL https://raw.githubusercontent.com/roboflow/rf-detr/master/README.md | grep -i -m2 "Commercially usable"

# RT-DETR repo license
curl -sL https://raw.githubusercontent.com/lyuwenyu/RT-DETR/main/LICENSE | head -3

# Download + hash Intel FP16 (compare with §2.2 measured hashes, NOT model.yml)
curl -sL -o /tmp/pd0202.bin https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/person-detection-0202/FP16/person-detection-0202.bin
sha256sum /tmp/pd0202.bin   # expect 11599bdd44bf863d7d1783ed99b2bc406e7d6588ecd5b5ce8381e366cc634914
```

## Sources (all checked 2026-11-18)

- MediaPipe Object Detector docs: https://developers.google.com/edge/mediapipe/solutions/vision/object_detector
- pub.dev object_detection: https://pub.dev/packages/object_detection
- PitchOverlay: https://pitchoverlay.site/
- TF Hub (redirects to Kaggle, unreadable): https://tfhub.dev/tensorflow/lite-model/efficientdet/lite0/detection/metadata/1
- OMZ repo + model: https://github.com/openvinotoolkit/open_model_zoo (LICENSE; models/intel/person-detection-0202/{README.md,model.yml})
- Intel community weights-license thread: https://community.intel.com/t/commercial-use-of-open-model-zoo-intel-models-weights-licence-and-training-data/144990
- openvino2onnx: https://pypi.org/project/openvino2onnx ; openvino2tensorflow: https://pypi.org/project/openvino2tensorflow
- OpenVINO Android build doc: https://github.com/openvinotoolkit/openvino/blob/master/docs/dev/build_android.md
- onnxruntime-web (MIT): https://www.npmjs.com/package/onnxruntime-web (registry license field)
- RF-DETR repo: https://github.com/roboflow/rf-detr ; HF: https://huggingface.co/Roboflow/rf-detr-nano ; TI EdgeAI RF-DETR: https://github.com/TexasInstruments/edgeai-modelhub (models/vision/detection/RF-DETR/README.md)
- RT-DETR repo: https://github.com/lyuwenyu/RT-DETR ; HF: https://huggingface.co/PekingU/rtdetr_r50vd
- D-FINE repo: https://github.com/Peterande/D-FINE
