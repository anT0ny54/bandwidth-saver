# Changelog

All notable changes to this project will be documented in this file.

## v0.2.2

- `prehook.js`, `content.js`: fixed a preload lifecycle bug where removing `imagesrcset` and repurposing the link in the same task could restore the removed responsive URL. Both execution worlds now restore it only while the attribute still exists as the empty parking placeholder or contains the exact proxy value written by the extension.
- `prehook.js`: pending `src`, `srcset`, and `loading` values are now checked against their browser-facing parking placeholders before settings flush, so a page-side removal cannot be undone by a late settings event.
- `README.md`: documented the preload-removal guarantee and final-flush validation for parked image values.

- `prehook.js`: proxy-construction failures now fail closed for eligible HTTP(S) `img.src` and `<picture><source>.src` assignments, including relative URLs resolved against `document.baseURI`. Excluded hosts, skipped assets, existing proxy URLs, restored elements, and non-HTTP(S) values are left intact.
- `build.sh`: JavaScript syntax checks now follow the manifest's script/module split — service/content scripts are parsed in CommonJS mode to reject module-only syntax, while popup/options/defaults are parsed as ES modules.
- `README.md`: documented the eligible-URL fail-closed behavior and runtime-aware build validation.
- `prehook.js`: image-preload `href` and responsive `imagesrcset` now fail closed when proxy URL construction throws, including property, attribute, and `relList` activation paths; the original values remain parked for retry on the next settings event. An empty `imagesrcset` placeholder is now created when needed, preserving pending imagesrcset-only preload assignments until settings arrive.
- `README.md`: documented fail-closed preload handling and the retained placeholder for imagesrcset-only hints.
- `prehook.js`: queued image and picture-source rewrites now retain their original pending values when proxy construction fails during settings flush; retries run on the next settings event from a snapshot, avoiding an immediate retry loop.
- `README.md`: documented retained pending image/source values and deferred retry behavior after a queued rewrite fails.
- `prehook.js`: direct `img.src`, image/picture `srcset`, and picture-source `src` assignments now retain their originals and retry after a proxy-construction failure when the next settings event arrives, instead of leaving only a blank placeholder.
- `README.md`: clarified that original values are retained for direct as well as settings-queued rewrite failures.

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
