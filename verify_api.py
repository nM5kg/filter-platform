#!/usr/bin/env python3
"""Live-verify filter-platform-api. Reads the API token from api_token.txt
(0600); never prints it. Prints status code + short summary per check."""
import json, os, urllib.request, urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
API = "https://filter-platform-api.gavhah-copy.workers.dev"
TOKEN = open(os.path.join(BASE, "api_token.txt")).read().strip()

def call(method, path, body=None, token=True):
    req = urllib.request.Request(API + path, method=method)
    # Cloudflare 403s default Python urllib User-Agents on workers.dev;
    # send a browser User-Agent (same gotcha as the Yiddish Tools API).
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
    req.add_header("Connection", "close")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    if token:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}

def show(label, status, data, expect):
    ok = "OK " if status == expect else "FAIL"
    print(f"{ok} {label}: HTTP {status} (expect {expect})")
    return data

s, d = call("GET", "/health", token=False)
show("health (no token)", s, d, 200)
print("   ", json.dumps(d)[:160])

s, d = call("GET", "/api/v1/customers", token=False)
show("customers without token", s, d, 401)

s, d = call("GET", "/api/v1/customers")
show("customers", s, d, 200)
cust = d["data"][0]
print("    customer:", cust["name"], "| devices:", cust["device_count"])
CID = cust["id"]

s, d = call("GET", "/api/v1/devices")
show("devices", s, d, 200)
for dev in d["data"]:
    print("    device:", dev["name"], dev["platform"], dev["status"], "| policy:", dev["policy_name"])

s, d = call("GET", "/api/v1/policies")
show("policies", s, d, 200)
pol = d["data"][0]
print("    policy:", pol["name"], "| block_images:", pol["block_images"],
      "| require_approval:", pol["require_approval_for_new_sites"],
      "| is_default:", pol["is_default"], "| threshold:", pol["auto_decide_threshold"])

s, d = call("GET", "/api/v1/domains")
show("domains", s, d, 200)
print("    domains:", len(d["data"]), "->",
      [(x["domain"], x["decision"]) for x in d["data"]])

s, d = call("GET", f"/api/v1/domains/check?domain=facebook.com&customer_id={CID}")
show("check facebook.com", s, d, 200)
print("    decision:", d["data"])

s, d = call("GET", f"/api/v1/domains/check?domain=example-news-site.com&customer_id={CID}")
show("check example-news-site.com (pending request)", s, d, 200)
print("    decision:", d["data"])

s, d = call("GET", f"/api/v1/domains/check?domain=some-open-site.org&customer_id={CID}")
show("check some-open-site.org (unlisted, open policy)", s, d, 200)
print("    decision:", d["data"])

s, d = call("GET", "/api/v1/applications")
show("applications", s, d, 200)
print("    apps:", [(x["package_id"], x["decision"]) for x in d["data"]])

s, d = call("GET", "/api/v1/blocked-words")
show("blocked-words", s, d, 200)
print("    words:", [x["word"] for x in d["data"]])

s, d = call("GET", "/api/v1/requests")
show("requests", s, d, 200)
req0 = d["data"][0]
print("    request:", req0["kind"], req0["target"], req0["status"])
RID = req0["id"]

s, d = call("GET", "/api/v1/audit-logs?limit=5")
show("audit-logs", s, d, 200)
print("    recent:", [(x["action"]) for x in d["data"]])

# Auto-decide the seeded pending request with HIGH confidence -> approved,
# which must add example-news-site.com to the customer's allow list.
s, d = call("POST", f"/api/v1/requests/{RID}/auto-decide",
            {"verdict": "approve", "confidence": 0.95, "reasons": ["news site", "no explicit content"]})
show("auto-decide approve (conf 0.95)", s, d, 200)
print("    status now:", d["data"]["status"], "| ai_verdict:", d["data"]["ai_verdict"],
      "| ai_confidence:", d["data"]["ai_confidence"])

s, d = call("GET", f"/api/v1/domains/check?domain=example-news-site.com&customer_id={CID}")
show("check example-news-site.com after approve", s, d, 200)
print("    decision:", d["data"])

# Create a fresh request and auto-decide with LOW confidence -> review bucket.
s, d = call("POST", "/api/v1/requests",
            {"customer_id": CID, "kind": "website", "target": "murky-site.example"})
show("create request murky-site.example", s, d, 201)
RID2 = d["data"]["id"]
s, d = call("POST", f"/api/v1/requests/{RID2}/auto-decide",
            {"verdict": "reject", "confidence": 0.40, "reasons": ["unclear content"]})
show("auto-decide low confidence (0.40)", s, d, 200)
print("    status now:", d["data"]["status"], "| review_reason:", d["data"]["review_reason"])
s, d = call("GET", f"/api/v1/domains/check?domain=murky-site.example&customer_id={CID}")
show("check murky-site.example (in review)", s, d, 200)
print("    decision:", d["data"])

# Device registration with the demo activation code (read from file, not printed).
CODE = open(os.path.join(BASE, "activation_code_demo.txt")).read().strip()
s, d = call("POST", "/api/v1/devices/register", {"code": CODE})
show("device register with activation code", s, d, 200)
print("    device now:", d["data"]["name"], d["data"]["status"])

s, d = call("GET", "/api/v1/devices")
show("devices after registration", s, d, 200)
print("    statuses:", [(x["name"], x["status"]) for x in d["data"]])
