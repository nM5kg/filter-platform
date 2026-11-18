#!/usr/bin/env python3
"""Direct-upload deploy of the Filter Platform dashboard (public/index.html)
to Cloudflare Pages project filter-platform-dashboard, bypassing the broken
GitHub integration (error 8000011). Same flow as hotline-platform:
upload-token -> check-missing -> assets/upload -> upsert-hashes -> deployments.
Hash: blake3(base64(content) + ext) hex, first 32 chars.
Auth: custom.cloudflare connector surrogate (API token, never read directly)."""
import base64, json, os, sys, time, urllib.request, uuid
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
import blake3

ACCOUNT = "8682a959ffd0735a5c8d4c62251cae03"
PROJECT = "filter-platform-dashboard"
BASE = "https://api.cloudflare.com/client/v4"
HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "index.html")

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
    with OPENER.open(req, timeout=60) as resp:
        return read_json_response(resp)

def main():
    content = open(HTML_PATH, "rb").read()
    print(f"index.html: {len(content)} bytes")
    file_hash = blake3.blake3(base64.b64encode(content) + b"html").hexdigest()[:32]
    print(f"asset hash: {file_hash}")

    tok = cf_request("GET", f"/accounts/{ACCOUNT}/pages/projects/{PROJECT}/upload-token")
    jwt = tok["result"]["jwt"]
    print("upload-token: ok")

    missing = cf_request("POST", "/pages/assets/check-missing", {"hashes": [file_hash]}, bearer_jwt=jwt)
    print(f"check-missing: {json.dumps(missing.get('result'))}")

    up = cf_request("POST", "/pages/assets/upload", [
        {"key": file_hash, "value": base64.b64encode(content).decode(),
         "metadata": {"contentType": "text/html; charset=utf-8"}, "base64": True}
    ], bearer_jwt=jwt)
    print(f"assets/upload: {json.dumps(up.get('result'))}")

    ups = cf_request("POST", "/pages/assets/upsert-hashes", {"hashes": [file_hash]}, bearer_jwt=jwt)
    print(f"upsert-hashes: {json.dumps(ups.get('result'))}")

    boundary = f"----MusePages{uuid.uuid4().hex}"
    manifest = json.dumps({"/index.html": file_hash})
    parts = []
    def field(name, value, ctype="text/plain; charset=utf-8"):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n{value}\r\n".encode())
    field("manifest", manifest, "application/json")
    field("branch", "main")
    field("commit_message", "Deploy Filter Platform dashboard (direct upload)")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/accounts/{ACCOUNT}/pages/projects/{PROJECT}/deployments",
        data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    with OPENER.open(req, timeout=60) as resp:
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
