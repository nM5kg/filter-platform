"""Export RF-DETR Small to ONNX using the official rfdetr export path (rfdetr 1.12.1)."""
import os
import time

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")

import torch

torch.set_num_threads(2)

from rfdetr import RFDETRSmall


def rss_gb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) / 1024 / 1024
    return -1


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    ckpt = os.path.join(base, "rf-detr-small.pth")
    print("torch", torch.__version__, "threads", torch.get_num_threads(), flush=True)
    t0 = time.time()
    model = RFDETRSmall(pretrain_weights=ckpt)
    print(f"model loaded in {time.time() - t0:.1f}s, peak RSS {rss_gb():.2f} GB", flush=True)
    print("resolution:", model.model.resolution, "num_classes:",
          getattr(model.model, "args", None) and model.model.args.num_classes, flush=True)
    t1 = time.time()
    out = model.export(output_dir=os.path.join(base, "onnx-small"),
                       format="onnx", opset_version=17)
    print(f"exported -> {out} in {time.time() - t1:.1f}s, peak RSS {rss_gb():.2f} GB", flush=True)


if __name__ == "__main__":
    main()
