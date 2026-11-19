#!/usr/bin/env bash
# Package the Filter Platform browser extension (v1.2.0) for the Download Center.
# Run from ~/workspace/filter-platform/:
#   ./package-extension.sh
#
# Builds public/our-filter-extension-1.2.0.zip from extension/ EXCLUDING
# test-only content (verify/, test-page/) and dev docs (README.md,
# MANIFEST-PATCH-B.md). Then verifies the ZIP contents, computes sha256 +
# size, and writes them into public/versions.json (extension fields only;
# the android object is preserved untouched).
#
# Does NOT modify anything under extension/ (another agent is verifying it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$ROOT/extension"
OUT_DIR="$ROOT/public"
VERSION="$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")"
ZIP_NAME="our-filter-extension-${VERSION}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"
VERSIONS_JSON="$OUT_DIR/versions.json"

echo "extension version (from manifest.json): $VERSION"
echo "zip: $ZIP_PATH"

# --- 1. Build the ZIP (paths relative to extension/ root, so manifest.json
#        is at the ZIP root and Chrome can load it unpacked) ---
rm -f "$ZIP_PATH"
cd "$EXT_DIR"
zip -r -q -9 "$ZIP_PATH" . \
  -x 'verify/*' \
     'test-page/*' \
     'README.md' \
     'MANIFEST-PATCH-B.md' \
     '*.DS_Store' \
     '__pycache__/*'
cd "$ROOT"

# --- 2. Verify ZIP contents: no test/verify files, no secrets ---
echo "--- ZIP contents ---"
unzip -l "$ZIP_PATH"
if unzip -l "$ZIP_PATH" | grep -E '(^|/)(verify|test-page)/' ; then
  echo "ERROR: ZIP contains verify/ or test-page/ files" >&2
  exit 1
fi
if unzip -l "$ZIP_PATH" | grep -iE 'api_token|database_url|secret|\.pem|\.key' ; then
  echo "ERROR: ZIP contains a suspicious secret-looking file" >&2
  exit 1
fi
# Also scan file contents for anything that looks like a bundled credential.
if unzip -p "$ZIP_PATH" | grep -a -iE 'api_token|database_url' ; then
  echo "ERROR: ZIP contents mention api_token/database_url" >&2
  exit 1
fi
echo "ZIP contents OK: no verify/, test-page/ or secret files."

# --- 3. sha256 + size ---
SHA256="$(sha256sum "$ZIP_PATH" | cut -d' ' -f1)"
SIZE="$(stat -c%s "$ZIP_PATH")"
echo "size: $SIZE bytes ($(numfmt --to=iec-i --suffix=B "$SIZE"))"
echo "sha256: $SHA256"
PAGES_LIMIT=$((25 * 1024 * 1024))
if [ "$SIZE" -gt "$PAGES_LIMIT" ]; then
  echo "WARNING: ZIP is OVER the Cloudflare Pages ~25 MB per-file limit ($PAGES_LIMIT bytes)." >&2
  echo "Pages cannot host this file as-is — see report." >&2
else
  echo "Under the Pages ~25 MB per-file limit."
fi

# --- 4. Write extension fields into public/versions.json (keep android) ---
python3 - "$VERSIONS_JSON" "$VERSION" "$ZIP_NAME" "$SHA256" "$SIZE" <<'PYEOF'
import json, sys
path, version, zip_name, sha256, size = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
data["extension"] = {
    "version": version,
    "file": zip_name,
    "url": "/" + zip_name,
    "sha256": sha256,
    "size_bytes": size,
}
# android object: created here only if missing; never overwritten.
data.setdefault("android", {
    "status": "testing",
    "version": "0.2.0",
    "download_url": None,
    "sha256": None,
    "size_bytes": None,
    "note": "Android app is still in testing — no public download until release signing is done.",
})
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"versions.json updated: extension {version}, {size} bytes, sha256 {sha256[:16]}…")
PYEOF

echo "DONE: $ZIP_NAME"
