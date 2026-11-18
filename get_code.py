#!/usr/bin/env python3
"""Save the demo pending device's activation code to activation_code_demo.txt
(0600). Prints only 'saved', never the code."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fpsql import run

out = run("SELECT activation_code FROM devices WHERE status = 'pending' LIMIT 1")
row = out["rows"][0]
code = row["activation_code"] if isinstance(row, dict) else row[0]
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "activation_code_demo.txt")
with open(target, "w") as f:
    f.write(code.strip() + "\n")
os.chmod(target, 0o600)
print("saved to", target)
