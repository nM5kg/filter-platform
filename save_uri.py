#!/usr/bin/env python3
"""Fetch the pooled connection URI for the Filter Platform project and save it
to database_url.txt (0600). Prints only non-secret metadata, never the URI.
Usage: save_uri.py <project_id> <branch_id>"""
import json, os, sys, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")

project_id, branch_id = sys.argv[1], sys.argv[2]
path = (f"/projects/{project_id}/connection_uri?branch_id={branch_id}"
        f"&role_name=filter_admin&database_name=filter&pooled=true")
req = urllib.request.Request(f"https://console.neon.tech/api/v2{path}")
add_surrogate_to_request(req, "custom.neon", allowed_hosts=["console.neon.tech"])
with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as resp:
    out = read_json_response(resp)
uri = out["uri"]
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database_url.txt")
with open(target, "w") as f:
    f.write(uri.strip() + "\n")
os.chmod(target, 0o600)
print("saved to", target)
print("host:", uri.split("@", 1)[1].split("/", 1)[0])
print("database: filter, role: filter_admin, pooled: yes")
