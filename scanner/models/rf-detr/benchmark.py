"""CPU benchmark: RF-DETR Nano / Small (official ONNX exports) on the 16-photo
labeled test set (~/workspace/filter-platform/scanner/testset/).

Method (all from the official rfdetr 1.12.1 package, no third-party code):
- Preprocess: rfdetr.export._runtime.preprocess.preprocess_to_nchw
  (torchvision to_tensor -> resize antialias=False -> ImageNet normalize).
- Inference: plain onnxruntime InferenceSession, CPUExecutionProvider,
  intra_op_num_threads=2, inter_op_num_threads=1.
- Decode: rfdetr.export._runtime.decode.decode_detections, background_class_id=None
  (official COCO checkpoints: final slot is COCO id 90, not background).
  Person = class slot 1 (COCO category id 1; verified by probe: portrait top
  detection is slot 1 @ 0.981, dog photo top is slot 18 = COCO id 18 'dog').
- Thresholds 0.50 and 0.70 are decoded from the SAME raw outputs (no re-inference).
- Timing: 1 warmup image (not counted), then N timed passes over all 16 images.
  Reports session.run-only time and end-to-end (preprocess+run+decode) time.
- CPU: process user+sys time over the timed section / wall time (avg cores used).
- Peak RSS: /proc/self/status VmHWM at end of the model run.
"""
import json
import os
import resource
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv",
                                "lib", "python3.12", "site-packages"))
from rfdetr.export._runtime.decode import decode_detections
from rfdetr.export._runtime.preprocess import preprocess_to_nchw

BASE = os.path.dirname(os.path.abspath(__file__))
TESTSET = "/home/hatch/workspace/filter-platform/scanner/testset"
PERSON_SLOT = 1  # COCO category id 1; verified by probe_slots.py


def rss_gb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) / 1024 / 1024
    return -1


def cpu_time():
    r = resource.getrusage(resource.RUSAGE_SELF)
    return r.ru_utime + r.ru_stime


def run_model(name, onnx_path, passes=1):
    with open(os.path.join(TESTSET, "manifest.json")) as f:
        manifest = json.load(f)
    images = manifest["images"]  # 16 entries, person_present bool

    t0 = time.time()
    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(onnx_path, sess_options=so, providers=["CPUExecutionProvider"])
    _, _, h, w = sess.get_inputs()[0].shape
    load_s = time.time() - t0
    print(f"[{name}] session loaded in {load_s:.1f}s, input {w}x{h}, "
          f"intra_op=2 inter_op=1, RSS {rss_gb():.2f} GB", flush=True)

    # Warmup on the first image (not counted).
    img0 = Image.open(os.path.join(TESTSET, images[0]["file"])).convert("RGB")
    arr0 = preprocess_to_nchw(img0, h, w, 3)
    t_w = time.time()
    sess.run(None, {"input": arr0})
    print(f"[{name}] warmup run: {time.time() - t_w:.2f}s", flush=True)

    per_photo = {}  # id -> {truth, best_person_score, n_person@0.50, n_person@0.70, times...}
    infer_times, e2e_times = [], []
    cpu0, wall0 = cpu_time(), time.time()
    for p in range(passes):
        for entry in images:
            path = os.path.join(TESTSET, entry["file"])
            img = Image.open(path).convert("RGB")
            t_pre = time.time()
            arr = preprocess_to_nchw(img, h, w, 3)
            t_run = time.time()
            dets, labels = sess.run(None, {"input": arr})
            t_dec = time.time()
            res = {}
            for thr in (0.50, 0.70):
                dec = decode_detections(dets[0], labels[0], img.size,
                                        threshold=thr, background_class_id=None)
                person = dec.confidence[dec.class_id == PERSON_SLOT]
                res[thr] = {"n": int(len(person)),
                            "best": float(person.max()) if len(person) else 0.0}
            t_end = time.time()
            infer_ms = (t_dec - t_run) * 1000
            e2e_ms = (t_end - t_pre) * 1000
            infer_times.append(infer_ms)
            e2e_times.append(e2e_ms)
            rec = per_photo.setdefault(entry["id"], {
                "file": entry["file"], "category": entry["category"],
                "person_present": entry["person_present"],
                "count": entry.get("count"),
                "infer_ms": [], "e2e_ms": [],
                "best_person_score": 0.0, "n_person@0.50": 0, "n_person@0.70": 0,
            })
            rec["infer_ms"].append(round(infer_ms, 1))
            rec["e2e_ms"].append(round(e2e_ms, 1))
            # best score across passes = max over decoded person scores at thr 0.50 run
            # (decode at 0.50 keeps every detection >= 0.50; for the true best we need
            # the max over ALL person slots, so recompute from raw logits cheaply:)
            prob = 1 / (1 + np.exp(-labels[0].astype(np.float64)))
            best = float(prob[:, PERSON_SLOT].max())
            rec["best_person_score"] = max(rec["best_person_score"], best)
            rec["n_person@0.50"] = max(rec["n_person@0.50"], res[0.50]["n"])
            rec["n_person@0.70"] = max(rec["n_person@0.70"], res[0.70]["n"])
            print(f"[{name}] p{p+1} {entry['id']:18s} truth={str(entry['person_present']):5s} "
                  f"best_person={best:.3f} n@0.50={res[0.50]['n']} n@0.70={res[0.70]['n']} "
                  f"infer={infer_ms:.0f}ms e2e={e2e_ms:.0f}ms", flush=True)
    wall = time.time() - wall0
    cpu = cpu_time() - cpu0
    infer = np.array(infer_times)
    e2e = np.array(e2e_times)

    def metrics(thr):
        key = f"n_person@{thr:.2f}"
        tp = sum(1 for r in per_photo.values() if r["person_present"] and r[key] > 0)
        fn = sum(1 for r in per_photo.values() if r["person_present"] and r[key] == 0)
        fp = sum(1 for r in per_photo.values() if not r["person_present"] and r[key] > 0)
        tn = sum(1 for r in per_photo.values() if not r["person_present"] and r[key] == 0)
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
                "precision": round(prec, 3), "recall": round(rec, 3)}

    summary = {
        "model": name,
        "onnx_path": onnx_path,
        "input_hw": [h, w],
        "threads": {"intra_op": 2, "inter_op": 1},
        "passes": passes,
        "n_images": len(images),
        "session_load_s": round(load_s, 2),
        "infer_ms": {"mean": round(float(infer.mean()), 1), "median": round(float(np.median(infer)), 1),
                     "min": round(float(infer.min()), 1), "max": round(float(infer.max()), 1)},
        "e2e_ms": {"mean": round(float(e2e.mean()), 1), "median": round(float(np.median(e2e)), 1),
                   "min": round(float(e2e.min()), 1), "max": round(float(e2e.max()), 1)},
        "images_per_sec_infer": round(1000.0 / float(infer.mean()), 3),
        "images_per_sec_e2e": round(1000.0 / float(e2e.mean()), 3),
        "cpu_avg_cores": round(cpu / wall, 2),
        "cpu_time_s": round(cpu, 1),
        "wall_timed_s": round(wall, 1),
        "peak_rss_gb": round(rss_gb(), 2),
        "metrics@0.50": metrics(0.50),
        "metrics@0.70": metrics(0.70),
        "per_photo": per_photo,
    }
    print(f"[{name}] SUMMARY infer mean {summary['infer_ms']['mean']} ms "
          f"({summary['images_per_sec_infer']} img/s), e2e mean {summary['e2e_ms']['mean']} ms "
          f"({summary['images_per_sec_e2e']} img/s), cpu {summary['cpu_avg_cores']} cores, "
          f"peak RSS {summary['peak_rss_gb']} GB", flush=True)
    print(f"[{name}] @0.50 {summary['metrics@0.50']}  @0.70 {summary['metrics@0.70']}", flush=True)
    return summary


if __name__ == "__main__":
    name = sys.argv[1]  # nano | small
    passes = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    onnx_path = os.path.join(BASE, f"onnx-{name}", f"rfdetr-{name}.onnx")
    out = run_model(f"RF-DETR-{name.capitalize()}", onnx_path, passes)
    out_path = os.path.join(BASE, f"results-{name}.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print("wrote", out_path)
