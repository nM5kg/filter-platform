#!/usr/bin/env python3
"""Run SQL against the Filter Platform Neon DB via the HTTP /sql endpoint.
Usage: fpsql.py [--file schema.sql] ["<single statement>"]
Reads the connection URI from database_url.txt (0600) in this dir.
Prints per-statement status and, for SELECTs, row counts and rows.
Never prints the connection URI."""
import json, os, sys, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))

def run(query):
    uri = open(os.path.join(BASE, "database_url.txt")).read().strip()
    host = uri.split("@", 1)[1].split("/", 1)[0]
    req = urllib.request.Request(
        f"https://{host}/sql", data=json.dumps({"query": query}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Neon-Connection-String", uri)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()[:800]}")

def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--file":
        sql = open(sys.argv[2]).read()
    elif len(sys.argv) >= 2:
        sql = sys.argv[1]
    else:
        print("usage: fpsql.py [--file schema.sql] [\"<sql>\"]", file=sys.stderr)
        sys.exit(2)
    # Split on ";\n" — schema has no functions/triggers, so this is safe.
    stmts = [s.strip() for s in sql.split(";\n") if s.strip()]
    for i, stmt in enumerate(stmts):
        q = stmt if stmt.rstrip().endswith(";") else stmt + ";"
        try:
            out = run(q)
            rows = out.get("rows") or []
            print(f"[{i+1}/{len(stmts)}] OK rowCount={len(rows)} :: {q[:90]}")
            if rows:
                print(json.dumps(rows, indent=1)[:2000])
        except Exception as e:
            print(f"[{i+1}/{len(stmts)}] FAILED :: {q[:90]}\n  {e}")
            sys.exit(1)

if __name__ == "__main__":
    main()
