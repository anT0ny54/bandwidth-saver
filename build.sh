#!/usr/bin/env bash
# Bandwidth Saver — reproducible extension build

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="$ROOT_DIR/dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || { echo "ERROR: --out requires a directory" >&2; exit 2; }
      OUTDIR="$2"
      shift 2
      ;;
    *)
      echo "Usage: bash build.sh [--out DIR]" >&2
      exit 2
      ;;
  esac
done

OUTDIR="$(mkdir -p "$OUTDIR" && cd "$OUTDIR" && pwd)"

VERSION="$(python3 - "$ROOT_DIR/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    print(json.load(f)['version'])
PY
)"

# Fast preflight: validate every shipped JavaScript file before packaging.
# This catches syntax regressions early and requires only the Node runtime.
CHECK_TMP="$(mktemp -d)"
for js in service-worker.js prehook.js content.js popup.js options.js defaults.js; do
  # popup/options/defaults use ES module syntax; check them as .mjs so older
  # Node versions (which treat .js as CommonJS) don't reject import/export.
  cp "$ROOT_DIR/$js" "$CHECK_TMP/${js%.js}.mjs"
  node --check "$CHECK_TMP/${js%.js}.mjs" >/dev/null || {
    echo "ERROR: JavaScript syntax check failed: $js" >&2
    rm -rf "$CHECK_TMP"
    exit 1
  }
done
rm -rf "$CHECK_TMP"

# The manifest is the single source of truth for the extension version.
# Do not hard-code a release version here: every manifest version must build.
python3 - "$VERSION" <<'PYVERCHECK'
import re, sys
version = sys.argv[1]
if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
    raise SystemExit(f"ERROR: invalid extension version: {version!r}")
PYVERCHECK

ZIPFILE="$OUTDIR/bandwidth-saver-$VERSION.zip"
SOURCE_DATE_EPOCH=1709856000

INCLUDE=(
  manifest.json
  defaults.js
  service-worker.js
  prehook.js
  content.js
  popup.html
  popup.js
  options.html
  options.js
  _locales
  icons
  LICENSE
)

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

for item in "${INCLUDE[@]}"; do
  if [[ ! -e "$ROOT_DIR/$item" ]]; then
    echo "ERROR: required build file is missing: $item" >&2
    exit 1
  fi
  cp -R "$ROOT_DIR/$item" "$STAGING/"
done

python3 - "$STAGING/manifest.json" "${INCLUDE[@]}" <<'PY'
import json, os, sys
manifest_path = sys.argv[1]
with open(manifest_path, encoding='utf-8') as f:
    manifest = json.load(f)
assert manifest.get('manifest_version') == 3, 'Manifest V3 required'
version = manifest.get('version')
assert isinstance(version, str) and version, 'Manifest version missing'
root = os.path.dirname(manifest_path)
for item in sys.argv[2:]:
    if not os.path.exists(os.path.join(root, item)):
        raise SystemExit(f'Missing staged item: {item}')

# Every file the manifest references must be in the package.
refs = set()
def collect(v):
    if isinstance(v, str):
        if v.endswith(('.js', '.html', '.png', '.json')):
            refs.add(v)
    elif isinstance(v, dict):
        for x in v.values(): collect(x)
    elif isinstance(v, list):
        for x in v: collect(x)
collect({k: v for k, v in manifest.items() if k != 'browser_specific_settings'})
for ref in sorted(refs):
    if not os.path.exists(os.path.join(root, ref)):
        raise SystemExit(f'Manifest references missing file: {ref}')
PY

find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
rm -f "$ZIPFILE"
(
  cd "$STAGING"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | zip -X -q "$ZIPFILE" -@
)

unzip -tq "$ZIPFILE" >/dev/null
ZIP_ENTRIES="$(unzip -Z1 "$ZIPFILE")"
grep -Fxq 'manifest.json' <<< "$ZIP_ENTRIES"
grep -Fxq 'popup.html' <<< "$ZIP_ENTRIES"
grep -Fxq 'options.html' <<< "$ZIP_ENTRIES"
# NOTE: a bare `! cmd` is exempt from `set -e`, so use an explicit if.
if grep -q '^bandwidth-saver-main/' <<< "$ZIP_ENTRIES"; then
  echo "ERROR: zip contains a top-level project folder" >&2
  exit 1
fi

echo "Built: $ZIPFILE"
echo "SHA256: $(sha256sum "$ZIPFILE" | awk '{print $1}')"
