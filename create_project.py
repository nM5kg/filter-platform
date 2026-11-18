#!/usr/bin/env python3
"""Create the Filter Platform Neon project (new, separate from all others).
Usage: create_project.py
Prints the project JSON (no secrets in it)."""
import json, sys, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")

body = {
    "project": {
        "name": "Filter Platform",
        "org_id": "org-sweet-forest-73854992",
        "pg_version": 17,
        "region_id": "aws-us-east-2",
        "branch": {"name": "main", "database_name": "filter", "role_name": "filter_admin"},
    }
}
req = urllib.request.Request(
    "https://console.neon.tech/api/v2/projects",
    data=json.dumps(body).encode(), method="POST")
req.add_header("Content-Type", "application/json")
add_surrogate_to_request(req, "custom.neon", allowed_hosts=["console.neon.tech"])
try:
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=120) as resp:
        out = read_json_response(resp)
        print(json.dumps(out, indent=2))
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:2000])
    sys.exit(1)
