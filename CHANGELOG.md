# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
