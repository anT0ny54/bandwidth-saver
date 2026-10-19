# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-10-19

### Fixed

- **Picture source property interception** (`prehook.js`): `HTMLSourceElement.prototype.src` assignments for `<picture><source>` elements are now patched like `srcset`, so script-set source URLs cannot bypass early interception.
- **Protected picture-source fallback** (`prehook.js`): if an eligible `<picture><source>` `src`/`srcset` rewrite unexpectedly fails, the attribute is parked instead of falling through to the original HTTP(S) URL.
- **Missing MAIN-world defaults** (`prehook.js`): added the missing `DEFAULTS`
  object and merge defaults into partial settings snapshots. Older or partial
  local mirrors no longer throw while building proxy configuration and leave
  queued image URLs parked on `about:blank`.
- **Statistics reset race** (`service-worker.js`, `options.js`): reset requests
  now clear pending counters and serialize the zero-write after any in-flight
  flush, so pre-reset totals cannot reappear after the UI reports success.
- **Excluded-page loading behavior** (`content.js`): the isolated-world scan no
  longer forces `loading="lazy"` on pages excluded from the extension.
- **Unoptimized preload race** (`prehook.js`): script-created image preloads are
  rewritten or parked before the raw href is assigned when the activation
  attribute is being set. The original href is retained and restored if the
  link is changed to a non-image-preload purpose, without overwriting a newer
  URL assigned by the page during reuse.
- **Quality clamp bypass** (`content.js`, `prehook.js`): a quality of `0` (or
  any value the UI never produces) no longer silently becomes `60`. The old
  `|| 60` fallback ran before the `Math.max(1, …)` clamp and defeated it;
  zero is now correctly clamped to `1`, and only `null`/`undefined`/`NaN`
  fall back to the default.
- **Redundant settings processing** (`content.js`): when the sync fallback
  path refreshed the `bhOpts` local mirror, the local `onChanged` listener
  fired and re-ran `applyOpts` on the identical value. The echo is now
  detected with `sameOpts` and skipped, halving settings work on sync storms.
- **Duplicate sync notifications** (`content.js`): sync change notifications
  that resolve to the already-applied settings are skipped before cache resets
  or another MAIN-world event is emitted.

### Changed

- Removed unrelated third-party project promotion from `README.md`; the documentation stays focused on this extension.
- `updateIcon()` (`service-worker.js`) accepts the known `enabled` value from
  `storage.onChanged`, skipping an extra `storage.sync` read per toggle.
- `reloadCurrentPage()` (`options.js`) uses a single `chrome.tabs.query` call
  for both the active-tab fast path and the fallback, halving the round-trips.
- `proxyUrlCache` in both worlds is now a true LRU (entries are re-inserted on
  read) instead of FIFO eviction, improving hit rates on long-lived pages.
- `proxyHost` is derived from `WSRV_PROXY` in both worlds instead of a second
  hardcoded `"wsrv.nl"` string.
- `build.sh` now fails the build if the intentionally duplicated helpers and
  constants (`WSRV_PROXY`, `TINY_DIM_RE`, `parseSrcset`, `buildProxyUrl`)
  drift apart between `content.js` and `prehook.js`, and verifies that
  `DEFAULTS` matches across all four copies. The URL-literal comparison no
  longer mistakes `//` inside `https://` for a line comment.
- `popup.js` no longer assumes `tabs.create()` returns a Promise; callback-style
  failures fall back to `runtime.openOptionsPage()`.

### Removed

- Unreachable `!url.startsWith("https://wsrv.nl/")` guard in
  `service-worker.js`: the `webRequest` listener is already filtered to
  `https://wsrv.nl/*`, so the check could never fail.
- Redundant `.toLowerCase()` calls on hostnames that are already
  spec-lowercase (`location.hostname`, `URL.hostname`).
- No-op `let mo = null;` initializer in `content.js`; the observer is a
  single `const` now.
- Unused `.input.invalid` and `.btn.full` CSS rules in `options.html`.

### Notes

- `shouldSkip`/`excludedHost` still walk the domain-label chain per candidate;
  precomputing a suffix structure is only worth it if users report large
  exclude lists.

