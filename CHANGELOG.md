# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-10-18

### Fixed

- **Popup exclusion indicator with trailing-dot domains**: the popup's domain
  parser did not strip a trailing dot (e.g. `example.com.`). The background
  script and content scripts excluded such domains correctly, but the popup
  showed the site as not excluded. The parser now normalizes domains the same
  way the background/content layers do.
- **Dead conditional in the lazy-attribute rewriter** (`content.js`): the code
  checked whether the iterated attribute name was a srcset attribute, which is
  impossible there (data-srcset is handled in a separate branch). The
  impossible branch is removed with a comment explaining why only the original
  src is remembered.

### Changed

- Corrected a stale DNR-rules comment in the service worker ("only Rule 2 is
  active" — Rule 3/Save-Data is also conditionally active).
- Version bumped to `0.1.7`.

## [0.1.6] - 2026-10-18

### Changed

- **Chromium-only manifest**: removed the Firefox-only
  `browser_specific_settings.gecko` block and the Firefox `background.scripts`
  event-page fallback from the manifest. Both are ignored (with unpacked-load
  warnings) by Chrome/Kiwi/Cromite, which are the only supported targets.
- Updated the README installation section to remove Firefox instructions.

### Fixed

- **Potential crash in the MAIN-world `setAttribute` patch** (`prehook.js`): the
  error handler referenced the `n` variable declared inside the `try` block.
  If an attribute name could not be converted to a string (e.g. a Symbol), the
  catch block itself would throw a `ReferenceError`. The variable is now
  declared outside the `try` so the handler always has a defined value.

## [0.1.5] - 2026-10-18

### Fixed

- **Inaccurate proxy description on the settings page**: the Image proxy hint
  claimed the request always uses `we=1` and `dpr=2`. In reality the code sends
  `fit=inside`, `we=1`, and a device pixel ratio clamped to 1–2 (matching the
  actual `buildProxyUrl` implementation and the README).
- **Dead CSS class in the popup**: the site-exclusion pill was assigned a
  non-existent `excluded` style class. The class assignment now matches the
  styles actually defined in `popup.html`.
- **Indentation slip in `prehook.js`**: one `return` inside the setAttribute
  srcset branch was dedented, making the block misleading to read. No
  behavioral change.

### Changed

- Version bumped to `0.1.5`.

## [0.1.4] - 2026-10-17

### Fixed

- **MAIN world declaration missing for `prehook.js`** (critical): the manifest
  never set `"world": "MAIN"` for the prehook content script, so it silently ran
  in the isolated world in every browser. Page JavaScript therefore interacted
  with the *unpatched* DOM setters, and the prehook's "capture native descriptors
  before patching" step actually captured the isolated world's own script
  environment instead of the page's. The manifest now declares
  `world: "MAIN"` for `prehook.js` and `world: "ISOLATED"` for `content.js`
  explicitly.
- **Firefox background page never ran**: Manifest V3 in Firefox does not support
  `background.service_worker`. The manifest now declares both
  `service_worker` (Chromium) and `scripts` (Firefox event page) for the same
  `service-worker.js`, which uses only callback-based chrome APIs and works in
  both runtimes.
- **Excluded-domain changes did not reload the page**: the settings page's save
  handler documented "reload whenever a URL-shaping setting changed" but only
  compared quality and max width. Saving a changed exclusion list now also
  triggers the reload.
- **Popup site card did not refresh after exclude/re-include**: clicking
  "Exclude this site" updated storage but left the pill and button label stale
  until the popup was reopened. The UI now refreshes immediately.

### Removed

- Dead `sameOpts` helper in `prehook.js` (only `content.js` needed it; the
  MAIN-world copy was never referenced).

### Changed

- Version bumped to `0.1.4`. `options_page` replaced with `options_ui`
  (`open_in_tab: true`), which is the cross-browser form of the same setting
  and matches how the popup opens the settings page.

## [0.1.3] - previous release

- Initial tracked release: two-layer interception architecture (MAIN-world
  prehook + isolated-world content script), wsrv.nl proxying with quality,
  max-width, grayscale and excluded-domain settings, Save-Data header via DNR,
  CSP header stripping via DNR, proxy-failure origin fallback, batched
  statistics, and reproducible `build.sh` packaging.
