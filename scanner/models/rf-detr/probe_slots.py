"""Probe: which logit slot is 'person' in the exported RF-DETR ONNX models?
Runs Nano on a portrait (p1) and a dog photo (a1) and prints top slots."""
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv",
                                "lib", "python3.12", "site-packages"))
from rfdetr.export._runtime.preprocess import preprocess_to_nchw

BASE = os.path.dirname(os.path.abspath(__file__))
TESTSET = "/home/hatch/workspace/filter-platform/scanner/testset"


def probe(model_path, image_file):
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    _, _, h, w = sess.get_inputs()[0].shape
    img = Image.open(os.path.join(TESTSET, image_file)).convert("RGB")
    arr = preprocess_to_nchw(img, h, w, 3)
    dets, labels = sess.run(None, {"input": arr})
    prob = 1 / (1 + np.exp(-labels[0].astype(np.float64)))
    # top-5 query/slot pairs by score
    flat = prob.reshape(-1)
    idx = np.argsort(flat)[::-1][:5]
    print(f"{os.path.basename(model_path)} on {image_file} ({img.size}):")
    for i in idx:
        q, slot = divmod(int(i), prob.shape[1])
        print(f"  query {q} slot {slot} score {flat[i]:.4f} box(cxcywh)={np.round(dets[0][q], 3)}")
    # best score per slot 0..3 and 17/18
    for slot in (0, 1, 17, 18, 90):
        print(f"  slot {slot}: max score {prob[:, slot].max():.4f}")


if __name__ == "__main__":
    probe(os.path.join(BASE, "onnx-nano", "rfdetr-nano.onnx"), "p1-huang-portrait.jpg")
    probe(os.path.join(BASE, "onnx-nano", "rfdetr-nano.onnx"), "a1-dog-running.jpg")
