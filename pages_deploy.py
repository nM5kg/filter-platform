#!/usr/bin/env python3
"""Direct-upload deploy of the Filter Platform Pages site
(filter-platform-dashboard) — bypassing the broken GitHub integration
(error 8000011). Same flow as hotline-platform:
upload-token -> check-missing -> assets/upload -> upsert-hashes -> deployments.
Hash: blake3(base64(content) + ext) hex, first 32 chars.
Auth: custom.cloudflare connector surrogate (API token, never read directly).

Deploys EVERYTHING in public/ recursively: index.html, download.html,
versions.json, browser.html, browser-assets/ (content.js, detector.js,
models, WASM, .tflite), test-pages/ (8 test pages + assets), and the
extension ZIP. Add a file under public/ and it ships on the next run;
remove it and it stops being deployed.
"""
import base64, json, mimetypes, os, sys, time, urllib.request, uuid
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
import blake3

ACCOUNT = "8682a959ffd0735a5c8d4c62251cae03"
PROJECT = "filter-platform-dashboard"
BASE = "https://api.cloudflare.com/client/v4"
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".tflite": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".css": "text/css; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")

OPENER = urllib.request.build_opener(NoRedirect())

def cf_request(method, path, body=None, bearer_jwt=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if bearer_jwt:
        req.add_header("Authorization", f"Bearer {bearer_jwt}")
    else:
        add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with OPENER.open(req, timeout=120) as resp:
        return read_json_response(resp)

def main():
    files = []
    for dirpath, dirnames, filenames in os.walk(PUBLIC_DIR):
        dirnames.sort()
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            rel = os.path.relpath(p, PUBLIC_DIR).replace(os.sep, "/")
            ext = os.path.splitext(name)[1].lower()
            if ext not in CONTENT_TYPES:
                if ext == "":
                    # Extensionless binary (e.g. face-api model shards like
                    # tiny_face_detector_model-shard1): upload as raw bytes.
                    # Skipping these used to ship a dashboard-HTML 404
                    # fallback instead of the weights, so the face detector
                    # failed to load on every page (2026-11-19).
                    content_type = "application/octet-stream"
                else:
                    print(f"skip (unknown type): {rel}")
                    continue
            else:
                content_type = CONTENT_TYPES[ext]
            content = open(p, "rb").read()
            file_hash = blake3.blake3(base64.b64encode(content) + ext.lstrip(".").encode()).hexdigest()[:32]
            files.append({"name": rel, "path": "/" + rel, "content": content,
                          "ext": ext, "hash": file_hash,
                          "content_type": content_type})
            print(f"{rel}: {len(content)} bytes, hash {file_hash}")

    tok = cf_request("GET", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/upload-token")
    jwt = tok["result"]["jwt"]
    print("upload-token: ok")

    hashes = [f["hash"] for f in files]
    missing = cf_request("POST", "/pages/assets/check-missing", {"hashes": hashes}, bearer_jwt=jwt)
    print(f"check-missing: {json.dumps(missing.get('result'))}")
    # check-missing returns the hashes that ARE missing (need upload).
    # If the shape is unexpected, upload everything rather than skip wrongly.
    missing_result = missing.get("result")
    missing_hashes = set(missing_result) if isinstance(missing_result, list) else set(hashes)
    # check-missing returns the hashes that ARE missing (need upload).
    for f in files:
        if f["hash"] not in missing_hashes:
            print(f"{f['name']}: already present, skip upload")
            continue
        up = cf_request("POST", "/pages/assets/upload", [
            {"key": f["hash"], "value": base64.b64encode(f["content"]).decode(),
             "metadata": {"contentType": f["content_type"]}, "base64": True}
        ], bearer_jwt=jwt)
        print(f"assets/upload {f['name']}: {json.dumps(up.get('result'))}")

    ups = cf_request("POST", "/pages/assets/upsert-hashes", {"hashes": hashes}, bearer_jwt=jwt)
    print(f"upsert-hashes: {json.dumps(ups.get('result'))}")

    boundary = f"----MusePages{uuid.uuid4().hex}"
    manifest = {f["path"]: f["hash"] for f in files}
    parts = []
    def field(name, value, ctype="text/plain; charset=utf-8"):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n{value}\r\n".encode())
    field("manifest", json.dumps(manifest), "application/json")
    field("branch", "main")
    field("commit_message", "Deploy Filter Platform dashboard + web browser demo (direct upload)")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/deployments",
        data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with OPENER.open(req, timeout=120) as resp:
        dep = read_json_response(resp)
    print(json.dumps(dep, indent=2))
    dep_id = dep["result"]["id"]
    url = dep["result"].get("url")
    print(f"deployment id: {dep_id}\nurl: {url}")

    for _ in range(30):
        time.sleep(4)
        st = cf_request("GET", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/deployments/{dep_id}")
        stage = st["result"].get("latest_stage", {})
        print(f"stage: {stage.get('name')} / {stage.get('status')}")
        if stage.get("name") == "deploy" and stage.get("status") in ("success", "failure", "canceled"):
            print(json.dumps(st["result"], indent=2)[:1500])
            break

if __name__ == "__main__":
    main()
