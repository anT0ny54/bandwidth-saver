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
# popup/options/defaults use ES module syntax; --input-type=module forces
# module parsing regardless of the .js extension, so no temp .mjs copies.
for js in service-worker.js prehook.js content.js popup.js options.js defaults.js; do
  node --check --input-type=module < "$ROOT_DIR/$js" >/dev/null || {
    echo "ERROR: JavaScript syntax check failed: $js" >&2
    exit 1
  }
done

# Shared-code parity check. content.js and prehook.js intentionally duplicate
# several helpers/constants because MAIN-world code cannot import modules —
# but that means a fix in one file can silently miss the other. Fail the build
# if the duplicated pieces drift apart.
python3 - "$ROOT_DIR/content.js" "$ROOT_DIR/prehook.js" \
  "$ROOT_DIR/defaults.js" "$ROOT_DIR/service-worker.js" <<'PYPARITY'
import re, sys

def strip_comments(s):
    """Strip JavaScript comments without mistaking quoted URLs for comments."""
    out = []
    i = 0
    quote = None
    while i < len(s):
        ch = s[i]
        if quote:
            out.append(ch)
            if ch == "\\" and i + 1 < len(s):
                i += 1
                out.append(s[i])
            elif ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            out.append(ch)
        elif s.startswith("//", i):
            end = s.find("\n", i)
            if end < 0:
                break
            out.append("\n")
            i = end
        elif s.startswith("/*", i):
            end = s.find("*/", i + 2)
            if end < 0:
                break
            out.append(" ")
            i = end + 1
        else:
            out.append(ch)
        i += 1
    return "".join(out)

def const_block(src, name):
    if name == "DEFAULTS":
        # This object has inline comments containing semicolons, so remove
        # comments before extracting its literal.
        clean = strip_comments(src)
        m = re.search(r"const\s+DEFAULTS\s*=\s*(\{.*?\})\s*;", clean, re.S)
        return m.group(1) if m else None
    m = re.search(rf"const\s+{name}\s*=\s*(.*?);", src, re.S)
    if not m:
        return None
    # Do not parse `//` as a comment inside a quoted URL such as
    # `https://wsrv.nl/`; compare that string literal verbatim.
    return m.group(1) if name == "WSRV_PROXY" else strip_comments(m.group(1))

def fn_block(src, name):
    m = re.search(rf"function\s+{name}\s*\([^)]*\)\s*\{{.*?\n  \}}", src, re.S)
    return strip_comments(m.group(0)) if m else None

content_src = open(sys.argv[1], encoding="utf-8").read()
prehook_src = open(sys.argv[2], encoding="utf-8").read()

for name, grab in (("WSRV_PROXY", const_block), ("TINY_DIM_RE", const_block),
                   ("parseSrcset", fn_block), ("buildProxyUrl", fn_block)):
    a, b = grab(content_src, name), grab(prehook_src, name)
    if a is None or b is None:
        raise SystemExit(f"ERROR: could not extract '{name}' for parity check")
    norm = lambda s: re.sub(r"\s+", " ", s).strip()
    if norm(a) != norm(b):
        raise SystemExit(
            f"ERROR: shared code '{name}' differs between content.js and "
            "prehook.js — apply the same fix to both."
        )

# DEFAULTS is copied into each execution context because the classic service
# worker and MAIN world cannot import the shared ES module. Compare all copies.
default_sources = [
    ("content.js", content_src),
    ("prehook.js", prehook_src),
    ("defaults.js", open(sys.argv[3], encoding="utf-8").read()),
    ("service-worker.js", open(sys.argv[4], encoding="utf-8").read()),
]
normalized_defaults = []
for label, src in default_sources:
    block = const_block(src, "DEFAULTS")
    if block is None:
        raise SystemExit(f"ERROR: could not extract 'DEFAULTS' from {label}")
    block = re.sub(r",\s*}", "}", block)
    block = re.sub(r"\s*}", "}", block)
    normalized_defaults.append((label, re.sub(r"\s+", " ", block).strip()))
if len({block for _, block in normalized_defaults}) != 1:
    details = ", ".join(label for label, _ in normalized_defaults)
    raise SystemExit(f"ERROR: shared DEFAULTS differ across {details}")
PYPARITY

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
