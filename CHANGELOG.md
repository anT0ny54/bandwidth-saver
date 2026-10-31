# Changelog

All notable changes to this project will be documented in this file.

## v0.2.0

- Optimized `content.js` lazy-attribute filtering: generic non-image elements matched only by `data-*` lazy selectors are retired after first inspection, and later mutation records for those elements are ignored. This avoids repeatedly resolving ambiguous `data-src`/`data-url` values that strict image-only mode intentionally never proxies.
- Removed the redundant single-use `urlRe` alias in `content.js` inline
  background rewriting; the shared `BG_URL_RE` constant is used directly.
- Hoisted the clamped `devicePixelRatio` computation out of `buildProxyUrl`
  into `applyOpts` in both `content.js` and `prehook.js`. The value only
  changes on zoom or monitor moves, so it is now computed once per settings
  application instead of on every uncached proxy-URL build.
- Full codebase audit (content script, prehook, service worker, popup,
  options, build script, workflows): no dead code, no cross-world conflicts,
  and no bugs found. All cross-world duplicated helpers verified in sync
  with the `build.sh` parity check.
- Second full audit (all sources, HTML/CSS, build script, workflows, icons):
  still no dead code, conflicts, or bugs. One micro-optimization applied:
  `rewriteBg` in `content.js` now marks elements with no `background-image`
  as done, so non-background `url(...)` styles (e.g. `cursor: url(...)`)
  matched by the `[style*='url(' i]` selector are no longer re-parsed on
  every mutation batch.
- Third full audit, this time covering every remaining source end-to-end
  (README, both HTML pages including all CSS, `_locales`, workflows, LICENSE,
  icons): no dead code, no conflicts, and no bugs found. Verified the shared
  `DEFAULTS` copies, the content/prehook parity helpers, all popup/options DOM
  id lookups, and the toast-state CSS classes (`show`/`ok`/`warn`/`err`, which
  are composed dynamically in `showToast`).
- Removed the redundant hardcoded `QUALITY_PRESETS`/`WIDTH_PRESETS` arrays in
  `options.js`; they are now derived from the preset buttons' `data-q`/`data-w`
  attributes, so the markup is the single source of truth for preset values
  and the two can no longer drift apart.
