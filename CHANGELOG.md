# Changelog

All notable changes to this project will be documented in this file.

## v0.2.0

- Fixed an infinite self-trigger loop in `content.js`: `srcset`/`data-srcset`
  were rewritten with an unconditional `setAttribute`, which queues a mutation
  record even for an identical value. For a mixed list where one candidate is
  skipped (e.g. `icon.svg 1x, photo.jpg 2x`, or a tiny-dimension candidate) the
  mutation filter re-queued the element, so it re-wrote itself on every
  macrotask. Both attributes are now written only when the value changes
  (`setIfChanged`).
- Fixed the toolbar icon turning “disabled” when the synced `enabled` key was
  removed (e.g. storage cleared): `service-worker.js` now falls back to
  `DEFAULTS.enabled`, as every other reader already does.
- Fixed a double-count in the statistics flush: if the watchdog released a
  stalled flush and its read callback arrived late, the batch was written and
  also returned for retry. A late callback is now ignored. Stored totals with a
  missing/corrupt field are treated as 0 instead of turning the sum into `NaN`.
- `parseDomains()` in `defaults.js` now drops entries that normalize to
  nothing (e.g. a bare `https://`), so they no longer produce stray separators
  in the saved exclusion list.
- Optimized `content.js`: the `style` mutation caused by its own inline
  background rewrite is recognised and skipped instead of being re-parsed.
- Removed redundant code: the duplicate `settled` guard in `doRefreshRules`
  and the `done` wrapper in `mirrorToLocal` (`finish` is now idempotent and
  clears its own watchdog), the always-true `typeof sendResponse` check, the
  duplicated empty-stats literals in `options.js` (one `EMPTY_STATS`), and the
  unused `.btn:disabled` rule in `options.html`.
- README: corrected the statistics description (savings can be negative) and
  documented the behaviours above.
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
- Fixed a statistics bug in `service-worker.js`: if reading the stored totals
  failed (`lastError`, or a synchronous throw), the flush still wrote just the
  new batch over them, wiping the accumulated statistics. The batch is now kept
  and retried.
- Fixed the popup layout: the compression-settings card touched the enable card
  above it. All popup cards now share one `.card + .card` spacing rule.
- Fixed the settings page “Reset stats” action reloading the whole form, which
  discarded unsaved edits. Only the statistics display is refreshed now.
- Removed duplicated domain-list parsing: `popup.js` and `options.js` now share
  `parseDomains()` from `defaults.js`, and the `domainKey` helpers in
  `content.js`/`prehook.js` reuse their existing domain-set parsers.
- Removed a stale “proxy failures are left on the proxy URL” comment in
  `prehook.js` that contradicted the browser-side restore fallback, and the
  always-true `if (el)` guards in its `rewriteSrcset`.
- Optimized `content.js`: mutation records that can never trigger a rewrite
  (`src`/`srcset`/lazy attributes on non-image elements, link attributes on
  non-`<link>` elements) are dropped before entering the bounded queue, and a
  media `<source>` outside `<picture>` is retired after its first lazy check.
- `build.sh`: removed a redundant staged-file existence check (already covered
  by the copy loop) and added `sameOpts` to the content/prehook parity check, as
  the README already described. `build.yml`: the release step reuses the
  already-read manifest version.
- Fourth full audit (every file read end-to-end, `build.sh` baseline verified
  before and after the edits below).
- Fixed the popup “Remove exclusion” action: when several entries covered the
  current host (e.g. both `example.com` and `www.example.com`), only the first
  was removed, so the site stayed excluded while the button claimed otherwise.
  All covering entries are now removed.
- Optimized `prehook.js`: the patched `Element.prototype.setAttribute` now
  returns immediately for every attribute name other than the seven it
  intercepts (`src`, `srcset`, `loading`, `href`, `rel`, `as`, `type`), before
  any `instanceof` check. The preload `MutationObserver` also ignores attribute
  records whose target is not a `<link>` (e.g. `<a href>`).
- Optimized `content.js`: `rewriteImg` returns before touching non-`<img>`/
  `<source>` elements (they are no longer added to `doneImg`), and `rewriteBg`
  skips building a style declaration for elements with no `style` attribute.
- Optimized `popup.js`: the active-tab lookup is no longer repeated when only
  `enabled` changes (the site card does not depend on it).
- Removed redundant code: the always-true `output !== bg` test in `rewriteBg`,
  the `findExcludedDomain` helper (replaced by one shared `coversHost` test),
  a redundant `|| 0` in `options.js` stats rendering, a double space in the
  `#widthPresets` selector, and the unused `site` class in `popup.html`.
