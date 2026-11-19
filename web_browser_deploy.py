#!/usr/bin/env python3
"""Deploy the Filter Platform web-browser proxy Worker via Cloudflare API
(custom.cloudflare). Secret value is read from a 0600 file, never printed.
Usage: web_browser_deploy.py
Worker: filter-platform-web-browser
URL: https://filter-platform-web-browser.gavhah-copy.workers.dev
The API token is bound as a secret_text binding (same pattern as deploy.py):
it is used server-side only, for the domain check against filter-platform-api.
It NEVER appears in client-side code, URLs, or injected scripts."""
import json, sys, urllib.request, urllib.error, uuid
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCT = "8682a959ffd0735a5c8d4c62251cae03"
WORKER = "filter-platform-web-browser"
BASE = "/home/hatch/workspace/filter-platform"

code = open(f"{BASE}/web-browser-worker.js", "rb").read()
api_token = open(f"{BASE}/api_token.txt").read().strip()
meta = json.dumps({
    "main_module": "web-browser-worker.js",
    "compatibility_date": "2026-11-18",
    "bindings": [
        {"type": "secret_text", "name": "API_TOKEN", "text": api_token},
        {"type": "service", "name": "FILTER_API", "service": "filter-platform-api"},
    ],
})
boundary = "----cfdeploy" + uuid.uuid4().hex
body = b""
body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n".encode()
body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"web-browser-worker.js\"; filename=\"web-browser-worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode() + code + b"\r\n"
body += f"--{boundary}--\r\n".encode()
r = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/workers/scripts/{WORKER}",
    data=body, method="PUT",
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
add_surrogate_to_request(r, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.build_opener().open(r, timeout=120) as resp:
        out = read_json_response(resp)
        res = out.get("result") or {}
        print(json.dumps({"success": out.get("success"), "errors": out.get("errors"),
                          "id": res.get("id"), "etag": res.get("etag"),
                          "modified_on": res.get("modified_on")}, indent=2))
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:2000])
    sys.exit(1)

# API-uploaded Workers have their workers.dev route DISABLED by default
# (edge returns 404 error 1042 until enabled). Enable it via POST.
sub = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/workers/scripts/{WORKER}/subdomain",
    data=json.dumps({"enabled": True}).encode(), method="POST",
    headers={"Content-Type": "application/json"})
add_surrogate_to_request(sub, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.build_opener().open(sub, timeout=60) as resp:
        print("subdomain:", json.dumps(read_json_response(resp).get("result")))
except urllib.error.HTTPError as e:
    print("subdomain HTTP", e.code)
    print(e.read().decode()[:500])
    sys.exit(1)

print("worker URL: https://filter-platform-web-browser.gavhah-copy.workers.dev")
