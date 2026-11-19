#!/usr/bin/env python3
"""Classify-cache check for the 2026-11-19 re-run (extra cases, case G).
Creates a throwaway customer + device (dogfood pattern), classifies the
same target twice via the live API, then deletes everything it created
and verifies the deletion. Reads the API token from api_token.txt —
NEVER prints it. Appends results to results-rereun-extra-2026-11-19.json.
"""
import json, os, subprocess, sys, time

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
API = "https://filter-platform-api.gavhah-copy.workers.dev"
TOKEN = open(os.path.join(ROOT, "api_token.txt")).read().strip()
RUN_ID = str(int(time.time()))

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

def classify_twice(customer_id, device_id, target):
    runs = []
    for i in (1, 2):
        t0 = time.time()
        req = call("POST", "/api/v1/requests",
                   {"customer_id": customer_id, "device_id": device_id,
                    "kind": "website", "target": target})
        rid = (req.get("data") or {}).get("id")
        cls = None
        if rid:
            cls = call("POST", f"/api/v1/requests/{rid}/classify")
        runs.append({
            "call": i,
            "elapsedMs": round((time.time() - t0) * 1000),
            "requestId": rid,
            "requestError": None if rid else req,
            "cached": ((cls.get("data") or {}).get("analysis") or {}).get("cached") if cls else None,
            "verdict": ((cls.get("data") or {}).get("request") or {}).get("ai_verdict") if cls else None,
            "confidence": ((cls.get("data") or {}).get("request") or {}).get("ai_confidence") if cls else None,
        })
        print(f"classify {target} #{i}:", json.dumps(runs[-1]))
    return runs

def main():
    out_path = os.path.join(ROOT, "extension", "verify", "results-rereun-extra-2026-11-19.json")
    results = json.load(open(out_path))
    case = {"note": "Throwaway customer+device created for this check, deleted afterwards (dogfood pattern)."}
    try:
        c = call("POST", "/api/v1/customers",
                 {"name": "Rereun Cache Check", "email": f"rereun-cache-{RUN_ID}@filter.local", "phone": "+1-555-0102"})
        cid = (c.get("data") or {}).get("id")
        print("customer:", cid)
        if not cid:
            case["error"] = c
            raise SystemExit("customer creation failed")
        d = call("POST", "/api/v1/devices",
                 {"customer_id": cid, "name": "Rereun Cache Device", "platform": "android"})
        did = (d.get("data") or {}).get("id")
        print("device:", did)
        if not did:
            case["error"] = d
            raise SystemExit("device creation failed")
        case["customerId"] = cid
        case["deviceId"] = did
        # example.com: classified by dogfood 2026-11-18, likely still in the 24h cache.
        case["exampleCom"] = classify_twice(cid, did, "example.com")
        # example.org: never classified before — expect cold (cached=false) then warm (cached=true).
        case["exampleOrg"] = classify_twice(cid, did, "example.org")
    finally:
        # Cleanup via fpsql.py (single statements only — multi-statement
        # SELECTs fail in fpsql.py). FK order: requests -> devices -> customers.
        cleanup = {}
        try:
            did = case.get("deviceId")
            cid = case.get("customerId")
            def sql(stmt):
                r = subprocess.run(["python3", "fpsql.py", stmt],
                                   cwd=ROOT, capture_output=True, text=True, timeout=60)
                return (r.stdout or "").strip()
            if cid:
                cleanup["requestsDeleted"] = sql(f"DELETE FROM approval_requests WHERE customer_id = '{cid}';")
            if did:
                cleanup["deviceDeleted"] = sql(f"DELETE FROM devices WHERE id = '{did}';")
            if cid:
                cleanup["customerDeleted"] = sql(f"DELETE FROM customers WHERE id = '{cid}';")
                cleanup["requestsLeft"] = sql(f"SELECT count(*) FROM approval_requests WHERE customer_id = '{cid}';")
                cleanup["customersLeft"] = sql(f"SELECT count(*) FROM customers WHERE id = '{cid}';")
            if did:
                cleanup["devicesLeft"] = sql(f"SELECT count(*) FROM devices WHERE id = '{did}';")
            print("cleanup:", json.dumps(cleanup))
        except Exception as e:
            cleanup["error"] = str(e)[:300]
        case["cleanup"] = cleanup
    results["cases"]["classifyCache"] = case
    json.dump(results, open(out_path, "w"), indent=2)
    print("Updated", out_path)

if __name__ == "__main__":
    main()
