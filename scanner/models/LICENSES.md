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
- **Weights license:** **Apache 2.0, with a re-verify note.** Google's
  Object Detector docs page does NOT state a model-weights license
  (checked 2026-11-18 — the page only licenses its own text CC-BY 4.0
  and code samples Apache 2.0). The positive evidence is: (a) Google's
  framing that only *some* models have their own terms and names Gemma
  as the example — EfficientDet-Lite0 is not among them; (b) the
  `object_detection` Flutter package (pub.dev), which ships
  byte-identical copies of Google's official EfficientDet-Lite builds,
  states "Both models are Apache 2.0 licensed". That is a secondary
  source, not Google's own words — so before commercial shipment,
  confirm the weights license from Google directly (e.g. a MediaPipe
  model-terms page or a written confirmation). Until then this model
  is used in the prototype only.
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

## Evaluated but NOT shipped

### Intel Open Model Zoo — person-detection-0202

- **Code + weights license:** **Apache 2.0** — repo `LICENSE` fetched
  from GitHub 2026-11-18 (11,357 bytes, "Apache License, Version 2.0");
  the model README
  (`models/intel/person-detection-0202/README.md`) carries **no
  separate license**, so the model falls under the repo license.
  Model: MobileNetV2 + SSD, 3.143 GFLOPs, 1.817 MParams, input
  1×3×512×512 BGR, output `1,1,200,7` boxes.
- **Why not shipped:** OMZ distributes this model as OpenVINO IR
  (`.xml`/`.bin`) only — there is no browser runtime for it, and
  running it would need a conversion step (IR → ONNX) plus a native
  Node runtime (OpenVINO or onnxruntime-node) and image decoding in
  Node. The MediaPipe model above does the same job inside the
  detector page we already have. person-detection-0202 stays the
  documented alternative for a future Node-side detector.

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
