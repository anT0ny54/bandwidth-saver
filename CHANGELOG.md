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

### Removed

- **Tracking-pixel/URL pattern matching** (`content.js`, `prehook.js`): the
  ad/tracking endpoint regex (`pagead`, `doubleclick`, `google-analytics`,
  `criteo`, and friends) and the tiny-URL name matching (`1x1`, `2x2`,
  `pixel`, `spacer`, `tracking`) were removed. The extension no longer
  inspects or matches tracking-related URL patterns; content images are still
  skipped when they carry explicit tiny dimensions (≤ 32) in width/height
  query parameters, and the README skip list reflects this.

### Changed

- Corrected a stale DNR-rules comment in the service worker ("only Rule 2 is
  active" — Rule 3/Save-Data is also conditionally active).
- Corrected the MAIN-world proxy-comment conflict: the code intentionally
  sends `default=1` (the proxy falls back to the source image when its own
  processing fails); the comment that claimed the opposite is fixed.
- Version bumped to `0.1.7`.
### Fixed

- Potential uncaught exception in the MAIN-world `src`/`srcset` catch handlers
  when a page assigned a Symbol or unstringifiable value: the catch paths fell
  back to the raw assigned value, which the native setter would re-convert and
  throw on. Values are now converted once, outside the handlers, and the catch
  paths reuse the safe conversion (`prehook.js`).
- Stale `data-bh-pending-loading` left on elements when the native `loading`
  descriptor is unavailable: the queued value was never flushed or cleared
  (`prehook.js`).

### Removed

- Dead `proxyBase` conditionals across `content.js` and `prehook.js`:
  `applyOpts()` always injects the hardcoded proxy, so `!opts.proxyBase`
  could never be true. The settings payload no longer carries a redundant
  `proxyBase` key.
- Redundant `sep` constant in the proxy config (both worlds) and duplicate
  hostname parsing in `shouldSkip()` (`content.js`).

### Changed

- Merged the byte-for-byte duplicated `decideSrc()` and `decidePreloadHref()`
  into a single `decideUrl()` (`prehook.js`).

