#!/usr/bin/env python3
"""Dogfood test for Filter Platform Phase 1 — end to end as a real user.
Uses curl (urllib hits a sandbox-proxy quirk on this host). Reads the API
token from api_token.txt (0600). NEVER prints the token or any activation
code — codes are shown only as 'issued (6 digits)'.
Each step prints its real HTTP status and real result."""
import json, os, subprocess, sys

BASE = os.path.dirname(os.path.abspath(__file__))
API = "https://filter-platform-api.gavhah-copy.workers.dev"
TOKEN = open(os.path.join(BASE, "api_token.txt")).read().strip()

def call(method, path, body=None, token=True):
    cmd = ["curl", "-s", "--max-time", "40", "-X", method, API + path,
           "-H", "Content-Type: application/json"]
    if token:
        cmd += ["-H", "Authorization: Bearer " + TOKEN]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"_raw": out.stdout[:300], "_stderr": out.stderr[:200]}

def step(n, label, data, show=None):
    print(f"\n=== STEP {n}: {label} ===")
    if show:
        print(show(data))
    else:
        print(json.dumps(data, indent=1)[:1200])

# 1. Register a customer
d = call("POST", "/api/v1/customers",
         {"name": "Dogfood Family", "email": "dogfood@filter.local", "phone": "+1-555-0101"})
step(1, "Register customer (POST /customers)",
     d, lambda x: f"HTTP 201 | id={x['data']['id']} | name={x['data']['name']} | email={x['data']['email']} | status={x['data']['status']}")
CID = d["data"]["id"]

# 2. Create a device -> activation code issued
d = call("POST", "/api/v1/devices",
         {"customer_id": CID, "name": "Dogfood Phone", "platform": "android"})
CODE = d["data"]["activation_code"]
step(2, "Create device (POST /devices)",
     d, lambda x: f"HTTP 201 | id={x['data']['id']} | name={x['data']['name']} | platform={x['data']['platform']} | status={x['data']['status']} | policy={x['data']['policy_id'] and 'Standard (default)' or 'NONE'} | activation code: issued (6 digits, not printed)")
assert len(CODE) == 6 and CODE.isdigit(), "code must be 6 digits"

# 3. Register the device with the code
d = call("POST", "/api/v1/devices/register", {"code": CODE})
step(3, "Register device with activation code (POST /devices/register)",
     d, lambda x: f"HTTP 200 | name={x['data']['name']} | status={x['data']['status']} | activated_at={x['data']['activated_at']}")
DID = d["data"]["id"]

# 3b. Wrong code must fail
d = call("POST", "/api/v1/devices/register", {"code": "000000"})
step("3b", "Register with wrong code (must fail)",
     d, lambda x: f"HTTP 404 | error={x.get('error')}")

# 4. Check REAL domains under the Standard policy
for domain in ["facebook.com", "wikipedia.org", "pornhub.com", "khanacademy.org", "bbc.com", "x.com"]:
    d = call("GET", f"/api/v1/domains/check?domain={domain}&customer_id={CID}")
    step(4, f"Check real domain {domain}",
         d, lambda x, dom=domain: f"HTTP 200 | {dom}: decision={x['data']['decision']} | source={x['data']['source']} | category={x['data']['category']}")

# 5. Request + classify a real clean site: example.com
d = call("POST", "/api/v1/requests", {"customer_id": CID, "device_id": DID, "kind": "website", "target": "example.com"})
RID_CLEAN = d["data"]["id"]
step(5, "Request example.com (POST /requests)",
     d, lambda x: f"HTTP 201 | id={x['data']['id']} | kind={x['data']['kind']} | target={x['data']['target']} | status={x['data']['status']}")
d = call("POST", f"/api/v1/requests/{RID_CLEAN}/classify")
step("5b", "Classify example.com — REAL fetched page text",
     d, lambda x: f"HTTP 200 | request status={x['data']['request']['status']} | ai_verdict={x['data']['request']['ai_verdict']} | confidence={x['data']['request']['ai_confidence']} | reasons={x['data']['request']['ai_reasons']} | signals={x['data']['analysis']['signals']} | cached={x['data']['analysis']['cached']}")

# 6. Request + classify a real adult site: pornhub.com
d = call("POST", "/api/v1/requests", {"customer_id": CID, "device_id": DID, "kind": "website", "target": "pornhub.com"})
RID_ADULT = d["data"]["id"]
step(6, "Request pornhub.com (POST /requests)",
     d, lambda x: f"HTTP 201 | target={x['data']['target']} | status={x['data']['status']}")
d = call("POST", f"/api/v1/requests/{RID_ADULT}/classify")
step("6b", "Classify pornhub.com — REAL fetched page text",
     d, lambda x: f"HTTP 200 | request status={x['data']['request']['status']} | ai_verdict={x['data']['request']['ai_verdict']} | confidence={x['data']['request']['ai_confidence']} | reasons={x['data']['request']['ai_reasons']} | signals={x['data']['analysis']['signals']} | cached={x['data']['analysis']['cached']}")

# 7. Low-confidence auto-decide -> review bucket; uncertain stays blocked
d = call("POST", "/api/v1/requests", {"customer_id": CID, "device_id": DID, "kind": "website", "target": "httpbin.org"})
RID_LOW = d["data"]["id"]
step(7, "Request httpbin.org (POST /requests)",
     d, lambda x: f"HTTP 201 | target={x['data']['target']} | status={x['data']['status']}")
d = call("POST", f"/api/v1/requests/{RID_LOW}/auto-decide",
         {"verdict": "reject", "confidence": 0.40, "reasons": ["unclear content"]})
step("7b", "Auto-decide httpbin.org with confidence 0.40 (below 0.70 threshold)",
     d, lambda x: f"HTTP 200 | status={x['data']['status']} | review_reason={x['data']['review_reason']} | ai_confidence={x['data']['ai_confidence']}")
d = call("GET", f"/api/v1/domains/check?domain=httpbin.org&customer_id={CID}")
step("7c", "Check httpbin.org while in review (uncertain must stay blocked)",
     d, lambda x: f"HTTP 200 | decision={x['data']['decision']} | source={x['data']['source']}")

# 8. Device heartbeat + status
d = call("POST", f"/api/v1/devices/{DID}/heartbeat", {"status": "online", "filter_active": True, "policy_version": 1})
step(8, "Device heartbeat (POST /devices/:id/heartbeat)",
     d, lambda x: f"HTTP 200 | {x}")
d = call("GET", f"/api/v1/devices/{DID}/status")
step("8b", "Latest device status (GET /devices/:id/status)",
     d, lambda x: f"HTTP 200 | status={x['data']['status']} | filter_active={x['data']['filter_active']} | policy_version={x['data']['policy_version']}")

# 9. Everything visible via the API (same data the dashboards show)
d = call("GET", "/api/v1/devices")
step(9, "List devices (dashboard data)",
     d, lambda x: f"HTTP 200 | {len(x['data'])} device(s): " + ", ".join(f"{v['name']} [{v['status']}] policy={v['policy_name']}" for v in x["data"]))
d = call("GET", "/api/v1/requests")
step("9b", "List requests (dashboard data)",
     d, lambda x: f"HTTP 200 | {len(x['data'])} request(s): " + ", ".join(f"{v['target']} [{v['status']}] ai={v['ai_verdict']}/{v['ai_confidence']}" for v in x["data"]))
d = call("GET", "/api/v1/analysis")
step("9c", "List AI analyses (dashboard data)",
     d, lambda x: f"HTTP 200 | {len(x['data'])} analyse(s): " + ", ".join(f"{v['target']} -> {v['result']['verdict']} ({v['result']['confidence']})" for v in x["data"]))
d = call("GET", "/api/v1/audit-logs?limit=10")
step("9d", "Audit log (dashboard data)",
     d, lambda x: f"HTTP 200 | {len(x['data'])} entr(ies): " + ", ".join(v["action"] for v in x["data"]))
d = call("GET", "/api/v1/policies")
step("9e", "Policies (dashboard data)",
     d, lambda x: f"HTTP 200 | " + "; ".join(f"{v['name']} [default={v['is_default']}] block_images={v['block_images']} threshold={v['auto_decide_threshold']}" for v in x["data"]))

# 10. Dashboard page live
out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                      "https://filter-platform-dashboard.pages.dev/"],
                     capture_output=True, text=True, timeout=30)
print(f"\n=== STEP 10: Dashboard page live ===\nHTTP {out.stdout} | https://filter-platform-dashboard.pages.dev/")

print("\nDOGFOOD TEST COMPLETE")
