#!/usr/bin/env bash
# Bandwidth Guardian — reproducible extension build

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
for item in sys.argv[2:]:
    if not os.path.exists(os.path.join(os.path.dirname(manifest_path), item)):
        raise SystemExit(f'Missing staged item: {item}')
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
! grep -q '^bandwidth-saver-main/' <<< "$ZIP_ENTRIES"

echo "Built: $ZIPFILE"
echo "SHA256: $(sha256sum "$ZIPFILE" | awk '{print $1}')"
