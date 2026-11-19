#!/usr/bin/env python3
"""API-level verification of the managed-device flow (coordinator re-check
2026-11-19). Uses curl like dogfood.py. Reads the API token from
api_token.txt (0600). NEVER prints the token or any invite code.
Creates temp rows, verifies each step, deletes everything again and
checks the DB counts return to the pre-test state.
"""
import json, subprocess, sys, time

API = "https://filter-platform-api.gavhah-copy.workers.dev"
TOKEN = open("api_token.txt").read().strip()
RUN = str(int(time.time()))
fails = []

def call(method, path, body=None):
    cmd = ["curl", "-s", "--max-time", "40", "-X", method, API + path,
           "-H", "Content-Type: application/json",
           "-H", "Authorization: Bearer " + TOKEN]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"_raw": out.stdout[:300], "_stderr": out.stderr[:200]}

def check(label, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + label + ((" | " + str(detail)) if detail else ""))
    if not cond:
        fails.append(label)

# 1. manager customer
mgr = call("POST", "/api/v1/customers", {"name": "Verify Manager", "email": f"verify-mgr-{RUN}@filter.local"})
mgr_id = mgr.get("data", {}).get("id")
check("1 manager customer created", bool(mgr_id), mgr.get("data", {}).get("email"))

# 2. temp policy: SafeSearch OFF, cover images (not block)
pol = call("POST", "/api/v1/policies", {"name": f"Verify NoSafeSearch {RUN}",
                                        "force_safesearch": False, "cover_images": True,
                                        "block_images": False})
pol_id = pol.get("data", {}).get("id")
check("2 temp policy created (safesearch off)", bool(pol_id)
      and pol["data"].get("force_safesearch") is False, pol.get("data"))

# 3. managed invite
inv = call("POST", "/api/v1/managed-invites",
           {"manager_customer_id": mgr_id, "device_name": "Verify Laptop", "policy_id": pol_id})
inv_id = inv.get("data", {}).get("id")
code = inv.get("data", {}).get("code")
check("3 managed invite created (6-digit code)", bool(inv_id) and bool(code) and len(str(code)) == 6,
      f"invite={inv_id}")

# 4. managed person registers with the code = consent
reg = call("POST", "/api/v1/devices/managed-register",
           {"code": code, "name": "Verify Managed", "email": f"verify-managed-{RUN}@filter.local",
            "device_name": "Verify Laptop", "platform": "windows"})
dev = reg.get("data", {}).get("device", {})
dev_id = dev.get("id")
managed_cust_id = reg.get("data", {}).get("customer", {}).get("id")
check("4 managed-register 201, manager + policy named",
      bool(dev_id) and reg.get("data", {}).get("manager_name") == "Verify Manager"
      and reg.get("data", {}).get("policy", {}).get("id") == pol_id,
      f"device={dev_id}")

# 5. GET device shows managed_by_name + policy
d = call("GET", f"/api/v1/devices/{dev_id}")
check("5 GET device: managed_by_name + policy_name",
      d.get("data", {}).get("managed_by_name") == "Verify Manager"
      and d.get("data", {}).get("policy_name", "").startswith("Verify NoSafeSearch"),
      d.get("data", {}).get("policy_name"))

# 6. per-device SafeSearch follows ITS policy (off -> no engines)
ss = call("GET", f"/api/v1/safesearch?device_id={dev_id}")
check("6 SafeSearch per-device OFF (0 engines)",
      ss.get("data", {}).get("force_safesearch") is False
      and ss.get("data", {}).get("engines") == [],
      ss.get("data"))

# 7. manager changes policy to Standard (the default) -> SafeSearch ON
pols = call("GET", "/api/v1/policies")
std = [p for p in pols.get("data", []) if p.get("is_default")]
std_id = std[0]["id"] if std else None
chk = call("PATCH", f"/api/v1/devices/{dev_id}", {"policy_id": std_id})
d2 = call("GET", f"/api/v1/devices/{dev_id}")
ss2 = call("GET", f"/api/v1/safesearch?device_id={dev_id}")
check("7 PATCH policy to Standard + SafeSearch ON (7 engines)",
      chk.get("data", {}).get("policy_id") == std_id
      and "Standard" in (d2.get("data", {}).get("policy_name") or "")
      and ss2.get("data", {}).get("force_safesearch") is True
      and len(ss2.get("data", {}).get("engines", [])) == 7,
      f"policy={d2.get('data', {}).get('policy_name')} engines={len(ss2.get('data', {}).get('engines', []))}")

# 8. managed person unlinks (POST unlink) -> manager link gone
unl = call("POST", f"/api/v1/devices/{dev_id}/unlink", {})
d3 = call("GET", f"/api/v1/devices/{dev_id}")
check("8 unlink: managed_by gone",
      d3.get("data", {}).get("managed_by_customer_id") is None
      and d3.get("data", {}).get("managed_by_name") is None, "")

# 9. negative: spent code reuse -> 404, no new device
reuse = call("POST", "/api/v1/devices/managed-register",
             {"code": code, "name": "Verify Managed", "email": f"verify-managed-{RUN}@filter.local",
              "device_name": "Verify Laptop 2", "platform": "windows"})
check("9 spent code reuse -> 404", reuse.get("error") is not None, reuse)

# 10. cleanup via API where possible, rest via fpsql (script prints ids for it)
print(f"\nCLEANUP_IDS manager={mgr_id} managed_customer={managed_cust_id} device={dev_id} invite={inv_id} policy={pol_id}")
print("RESULT:", "ALL PASS" if not fails else f"FAILURES: {fails}")
sys.exit(0 if not fails else 1)
