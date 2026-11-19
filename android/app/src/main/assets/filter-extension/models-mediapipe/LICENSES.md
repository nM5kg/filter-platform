# Model & library licenses — scanner/models/

Every file in this directory that is not our own code is listed here
with its license and source. Rule: **code license and model-weights
license are different things and both must be checked.** Re-verify
before shipping, and re-check on every model update.

## Shipped in this directory

### MediaPipe ObjectDetector — EfficientDet-Lite0 (person detector, primary)

- **File:** `efficientdet_lite0.tflite` (7,254,339 bytes, float16)
  SHA-256: `4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993`
- **Source (downloaded 2026-11-18):**
  `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`
  (Google's official MediaPipe model bucket — the same URL Google's own
  Object Detector web demo uses.)
- **Code license:** `@mediapipe/tasks-vision` 1.2.3 — **Apache 2.0**
  (npm registry `license` field, verified 2026-11-18; the MediaPipe
  GitHub repo `google-ai-edge/mediapipe` is Apache 2.0, and Google's
  MediaPipe Tasks overview states "Apache 2.0 (SDK); some models have
  their own terms (for example, Gemma)").
- **Weights license:** **UNVERIFIED — prototype only.** Yakob's decision
  2026-11-18: EfficientDet-Lite0 stays for prototype / first testing ONLY;
  do NOT confirm it as the production model until exact weights, hash,
  source and license are verified. Google's Object Detector docs page does
  NOT state a model-weights license (checked 2026-11-18 — the page only
  licenses its own text CC-BY 4.0 and code samples Apache 2.0). The
  secondary evidence, checked 2026-11-18 (full trail in
  `PRODUCTION-MODELS.md` §1): (a) Google's framing that only *some*
  models have their own terms and names Gemma as the example —
  EfficientDet-Lite0 is not among them (weak inference, not a license);
  (b) the `object_detection` Flutter package (pub.dev) states "Both models
  are Apache 2.0 licensed" — BUT its byte-identity evidence covers the
  **float32 v1** builds (13,836,895 bytes), NOT our float16 file, so
  strictly it does not cover the exact file we ship; (c) PitchOverlay's
  FAQ asserts Apache 2.0 with no citation to Google; (d) the "KTag SBOM
  citing TF Hub" source could NOT be located (two searches, 2026-11-18) —
  treat as non-existent until a URL is produced; (e) TF Hub is now
  Kaggle-gated and unreadable — no license text retrievable. What would
  settle it: a Google model-terms page/card naming the EfficientDet-Lite
  weights license, written confirmation from Google, or switching to the
  float32 v1 build pub.dev actually documents (still secondary evidence,
  but at least the exact file would be covered). Until then this model is
  used in the prototype only. Nothing here is legal advice.
- **What it is:** EfficientDet-Lite0 trained on COCO (80 classes); the
  scanner allowlists only the `person` class. Runs on CPU via WASM.

### face-api.js tinyFaceDetector (face detector, fallback + complement)

- **Files:** `face-api.js` (@vladmandic fork 1.7.15),
  `tiny_face_detector_model-weights_manifest.json`,
  `tiny_face_detector_model.bin` (193 KB)
- **Code license:** **MIT** (vladmandic fork `LICENSE` on GitHub +
  npm `license: MIT`, verified 2026-11-18).
- **Weights license:** **MIT** — the weights ship in the same MIT
  repository as the code; no separate weights license is stated.
- **Bundled library:** TensorFlow.js inside face-api — **Apache 2.0**.

### MediaPipe Tasks Vision runtime (WASM)

- **Files:** `tasks-vision/vision_bundle.mjs` (155,990 bytes,
  SHA-256 `fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5`),
  `tasks-vision-wasm/vision_wasm_internal.js` + `.wasm` (14,665,716 bytes)
- **License:** **Apache 2.0** (part of `@mediapipe/tasks-vision` 1.2.3).
- **Note:** only the `vision_wasm_internal` pair is copied here; the
  `vision_wasm_module_internal` pair from the npm package is unused.

## Evaluated — production candidates (Yakob decision 2026-11-18)

### Intel Open Model Zoo — person-detection-0202 (PRODUCTION CANDIDATE)

- **Code + weights license:** **Apache 2.0** — repo `LICENSE` fetched
  from GitHub 2026-11-18 (11,357 bytes, "Apache License, Version 2.0");
  GitHub API SPDX `Apache-2.0`; the model README
  (`models/intel/person-detection-0202/README.md`) carries **no
  separate license**, so the model falls under the repo license, and
  `model.yml` has an explicit `license:` field pointing at the repo
  LICENSE. Model: MobileNetV2 + SSD, 3.143 GFLOPs, 1.817 MParams, input
  1×3×512×512 BGR, output `1,1,200,7` boxes, person-only.
- **⚠️ Hash mismatch (measured 2026-11-18):** published `model.yml`
  checksums do NOT match the files the 2023.0 bucket serves today
  (sizes match exactly, hashes differ). FP16 `.bin` (3,634,654 bytes):
  published sha256 `2a149bc8c2f02965c59a998d7ca7868e4ba537c223ae492a8a177386f98997d8c15204f1c7fe847a51c660d9d4116d10`,
  served (measured) sha256
  `11599bdd44bf863d7d1783ed99b2bc406e7d6588ecd5b5ce8381e366cc634914`.
  Do NOT verify downloads against `model.yml` checksums; re-hash on
  every download and record the measured hash. Full detail in
  `PRODUCTION-MODELS.md` §2.2.
- **⚠️ Written confirmation still needed:** an Intel Community thread
  from 2026-11-18 asks exactly whether Apache 2.0 covers the weights
  for commercial shipment; Intel staff answered to get **written
  confirmation from Intel** before shipping. So the license is the
  best-documented of the bunch, yet not closed.
- **Conversion path (verified as the route, not yet executed):** OMZ
  distributes IR (`.xml`/`.bin`) only — no `.onnx`. IR → ONNX with the
  community tool `openvino2onnx`
  (`pip install openvino2onnx; openvino2onnx person-detection-0202.xml`).
  Then ONE ONNX file serves all three surfaces: `onnxruntime-web`
  (WASM CPU) for the browser extension, `onnxruntime-android` (official
  Maven AAR) for the GeckoView app, `onnxruntime-node` for the scanner.
  Do NOT run IR natively on Android via OpenVINO — no official prebuilt
  Android artifact exists, only a from-source build. TFLite is reachable
  only via the fiddly `openvino2tensorflow` IR→TF→TFLite route. The
  conversion has NOT been run yet — IR→ONNX fidelity + detection parity
  on the labeled test set are still to be proven.
- **Why not shipped yet:** no converted ONNX file exists; hash mismatch
  unresolved; Intel written confirmation not sought. It is the leading
  production candidate (smallest, person-only, cheapest conversion),
  provided those three are resolved.

### RF-DETR Nano (Roboflow) — license-cleanest fallback

- **License:** **Apache 2.0** — repo LICENSE on `master` (not `main`);
  README states Nano/Small/Medium/Large are "commercially usable out of
  the box… in closed-source, commercial products"; Hugging Face
  `Roboflow/rf-detr-nano` README front-matter `license: apache-2.0`.
  XL/2XL are PML 1.0 — EXCLUDED.
- **Size/spec:** 30,467,298 F32 params → ~122 MB FP32 (~30 MB INT8 est.);
  384×384 input; 48.4 mAP COCO; official ONNX export built in
  (`pip install "rfdetr[onnx]"`, `model.export("onnx")`, opset 17). No
  published phone-CPU latency; file hashes not yet downloaded. Phone
  performance must be measured before it can be chosen. Full detail in
  `PRODUCTION-MODELS.md` §3.

### RT-DETR R50vd (Baidu) — server-side at best

- **License:** **Apache 2.0** (repo LICENSE verified + HF README
  `license: apache-2.0`). 43,019,372 F32 params → ~172 MB FP32;
  640×640 input; 55.3 mAP, 108 FPS on T4 GPU only. Repo ships an ONNX
  export script. Almost certainly too heavy for a phone — scanner/server
  side at best. Full detail in `PRODUCTION-MODELS.md` §3.

### Ultralytics YOLO (v5 / v8 / v11 / v26) — EXCLUDED

- **License:** **GNU AGPL-3.0** — `LICENSE` fetched from GitHub
  2026-11-18 (34,523 bytes, "GNU AFFERO GENERAL PUBLIC LICENSE,
  Version 3"). The AGPL covers the code **and** the model weights
  (Ultralytics states the AGPL applies even to models trained from
  scratch with their tools; a separate Enterprise License is sold).
- **Verdict:** copyleft — **do not use** in a closed commercial SaaS
  without buying the Enterprise License. No YOLO model or code is
  present in this repository.

## How to re-verify

```bash
# OMZ repo license + model README (no separate license in the README)
curl -sL https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/LICENSE | head -3
curl -sL https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/models/intel/person-detection-0202/README.md | grep -i license
# Ultralytics license (expect AGPL-3.0)
curl -sL https://raw.githubusercontent.com/ultralytics/ultralytics/main/LICENSE | head -3
# tasks-vision license (expect Apache-2.0)
npm view @mediapipe/tasks-vision license version
# Model file integrity
sha256sum efficientdet_lite0.tflite   # expect 4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993
```
