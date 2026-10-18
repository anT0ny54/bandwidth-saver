# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-10-19

### Fixed

- **Popup exclusion indicator with trailing-dot domains**: the popup's domain
  parser did not strip a trailing dot (e.g. `example.com.`). The background
  script and content scripts excluded such domains correctly, but the popup
  showed the site as not excluded. The parser now normalizes domains the same
  way the background/content layers do.
- **Symbol-argument crash in the MAIN-world `src` setter** (`prehook.js`): the
  setter's catch handler re-converted the assigned value with `String(value)`.
  If a page assigned a Symbol, that conversion would throw inside the handler
  and turn a handled error into an uncaught one. The value is now converted
  once, outside the handler, with a safe fallback.
- **Dead conditional in the lazy-attribute rewriter** (`content.js`): the code
  checked whether the iterated attribute name was a srcset attribute, which is
  impossible there (data-srcset is handled in a separate branch). The
  impossible branch is removed with a comment explaining why only the original
  src is remembered.
- **MAIN-world catch fallbacks** (`prehook.js`): the `src`/`srcset`/`loading`
  and `link.href` setter catch handlers still forwarded the raw assigned
  value; a Symbol rethrows on string conversion and escaped as an uncaught
  error. Every catch fallback now uses the value converted once, safely,
  before the try block.
- **Restored images re-proxied** (`prehook.js`, `content.js`):
  `data-bw-restored` was only honored by the isolated full-scan. The
  MAIN-world property setters and `setAttribute` patch, and the
  content-script mutation re-scan, now pass restored elements through
  untouched, so a restored original `src`/`srcset` (including `<source>`
  candidates) is no longer silently routed back through the proxy.

### Removed

- **Tracking-pixel/URL pattern matching** (`content.js`, `prehook.js`): the
  ad/tracking endpoint regex (`pagead`, `doubleclick`, `google-analytics`,
  `criteo`, and friends) and the tiny-URL name matching (`1x1`, `2x2`,
  `pixel`, `spacer`, `tracking`) were removed. The extension no longer
  inspects or matches tracking-related URL patterns; content images are still
  skipped when they carry explicit tiny dimensions (≤ 32) in width/height
  query parameters, and the README skip list reflects this.
- **Dead `proxyBase` plumbing** (`prehook.js`, `content.js`): the proxy is
  hardcoded to `wsrv.nl`, so the injected `proxyBase` field and every
  always-true `!opts.proxyBase` check are removed; the settings event payload
  no longer carries the field.
- **Constant `sep: "?"` proxy-config field** — inlined at the single call
  site in both worlds.

### Changed

- Corrected a stale DNR-rules comment in the service worker ("only Rule 2 is
  active" — Rule 3/Save-Data is also conditionally active).
- `content.js` parses each candidate URL exactly once (`resolveImage`
  returns the `URL` object reused by `shouldSkip`/`buildProxyUrl`), replacing
  the previous resolve-then-reparse flow.
- Corrected the service-worker banner comment, which still claimed only DNR
  Rule 2 exists; Rules 2 (CSP stripping) and 3 (Save-Data header) are both
  described accurately now.
- Corrected the MAIN-world proxy-comment conflict: the code intentionally
  sends `default=1` (the proxy falls back to the source image when its own
  processing fails); the comment that claimed the opposite is fixed.
- Version bumped to `0.1.7`.
