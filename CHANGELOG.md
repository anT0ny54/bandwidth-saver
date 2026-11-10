# Changelog

All notable changes to this project will be documented in this file.

## v0.2.1

- `prehook.js`: corrected Web IDL conversion for `HTMLImageElement.srcset`, `HTMLSourceElement.srcset`, and `HTMLLinkElement.imageSrcset`; all three are `USVString` properties and now normalize lone UTF-16 surrogates before proxy rewriting, matching native browser setters. `README.md` now distinguishes these property conversions from `setAttribute()`'s `DOMString` behavior.
- `prehook.js`, `content.js`: responsive image preload candidate lists in `HTMLLinkElement.imageSrcset` / `imagesrcset` are now intercepted alongside `href`, including parser-created links, dynamic property/attribute assignments, and `imagesrcset`-only preload hints. Both execution worlds retain and restore the original candidate list when the link is repurposed; removing `imagesrcset` clears its saved/parked state.
- `prehook.js`: image preloads activated with `link.relList.add()`, `remove()`, `replace()`, `toggle()`, or `.value` are now preflighted synchronously, preventing the rel-token API from starting an original-URL preload before the mutation observer runs.
- `prehook.js`: patched DOM setters and `setAttribute()` now follow native Web IDL `DOMString` / `USVString` conversion. `Symbol` values throw `TypeError`, URL properties replace lone UTF-16 surrogates, and intercepted attribute names/values do not invoke custom stringifiers more than once.
- `service-worker.js`: corrected the statistics retry counter so a batch is dropped on the third consecutive failed flush attempt, matching `MAX_STATS_FLUSH_FAILURES` and the documented limit.
- `README.md`: documented responsive preload coverage, synchronous `relList` handling, the parser-insertion limitation, and Web IDL string-conversion behavior.
- Verified the DOM behavior in headless Chromium: 20 DOM string-conversion / coercion assertions, 3 settings-pending `USVString` checks, 9 responsive-preload regression checks, 8 `relList` interception/network checks, 12 general DOM smoke checks, and 12 settings-gate / lifecycle checks passed. `build.sh` also passes; the manifest version remains `0.2.1`.

- `service-worker.js`: the settings mirror (`bhOpts`) is rewritten only when its contents differ from the stored copy. The worker wakes on every proxied image response, and each wake previously wrote the mirror and broadcast a storage change to every open tab.
- `service-worker.js`: the DNR ruleset is rebuilt only when it differs from the rules Chrome already holds. Identical refreshes no longer call `updateDynamicRules`.
- `service-worker.js`: the stale-refresh handling that was duplicated in two DNR callbacks is consolidated into `releaseStaleRefresh()`, with the same behavior.
- `content.js`: the synchronous-settings fallback now mirrors the normalized settings snapshot instead of raw sync values, so the local mirror always matches what the page actually uses.
- `options.js`: in the excluded-sites list, Enter now inserts a newline (it previously saved and blocked newlines). Ctrl/⌘+Enter saves there; Enter still saves from the custom quality and width fields.
- `options.js`: a quality or width change made from the popup or another page no longer erases a custom value that is being typed.
- `options.js`: removed an unreachable guard around the version label, and fixed indentation of its constant declarations.
- `service-worker.js`, `content.js`: updated comments that still described Save-Data as a single rule.
- `README.md`: corrected the exclusion-parsing description (the DNR code does add a hostname validity filter); documented the mirror and ruleset write-skipping, the keyboard shortcuts, and the shared reload helper.
- Verified in headless Chromium with the unpacked extension: Save-Data across enabled, disabled, off, and excluded settings; the DNR write is skipped for an equivalent exclusion list and performed for a real change; DOM rewriting (images, srcset, lazy attributes, preloads, backgrounds, dynamically added backgrounds); CSP stripping and exclusion; failed-proxy restore; corrupt settings fallback; settings-page save, reset, and reset-stats; the Enter/Ctrl+Enter behavior; and the custom-value preservation.
