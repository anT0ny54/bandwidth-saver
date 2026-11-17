# Changelog

All notable changes to this project will be documented in this file.

## v0.2.3

Maintenance updates to the current release. The manifest version is unchanged.

- `defaults.js`: the settings-page reload fallback now handles Chromium versions before 121, where `tabs.Tab.lastAccessed` is unavailable. It selects the nearest eligible HTTP(S) tab by tab-strip position instead of treating every candidate as equally recent. On newer Chromium versions, the most recently accessed tab still takes priority.
- `defaults.js`: the settings-page fallback uses access timestamps only when every eligible tab provides one; partial timestamp data now falls back consistently to tab-strip proximity. Equal-distance ties prefer the preceding tab, the more likely source page when settings opens beside it.
- Exclusion lists: every copy of the domain parser (`defaults.js`, `content.js`, `prehook.js`, `service-worker.js`) now uses one shared `normalizeDomainToken()`. Internationalized names are converted to punycode, so `bücher.de` matches the `xn--bcher-kva.de` hostname the browser reports. Previously such entries were silently ignored. A leading `*.` is also stripped, so `*.example.com` covers the same sites as `example.com`.
- `content.js`, `prehook.js`: `parseSrcset` now recognises only ASCII whitespace and commas as separators, as the HTML spec requires, and uses character-code checks instead of a regular expression per character. Both layers are identical, and the build's parity check still passes. A non-ASCII space such as U+00A0 is now part of a candidate URL rather than a separator.
- `.github/workflows/build.yml`: the release job no longer checks out the repository or reads the manifest a second time. The build job exports the version as an output, and the release job uses the downloaded zip.
- `build.sh`: the manifest version is read and validated in one Python call, and the unreachable archive-folder check is removed. This edit does not change the archive contents.
- `README.md`: updated the exclusion-parsing and srcset descriptions to match the behavior above.
- `content.js`: the 800 ms storage failsafe now schedules a deferred full-document reconciliation after publishing defaults. Mutation records can be consumed before settings are ready; without this scan, parser-created images could remain unprocessed indefinitely when both storage callbacks were dropped. A later real settings snapshot still triggers its own reconciliation.
- `README.md`: documented the failsafe reconciliation behavior in the settings-bridge section.
- `content.js`: until the first complete storage snapshot is loaded, sync change events now trigger a full `storage.sync.get()` instead of merging a partial change payload over the defaults failsafe. This prevents a single changed key from temporarily replacing other customized settings in the local mirror. The first real snapshot still triggers reconciliation when it supersedes the failsafe.
- `README.md`: documented the full-sync-read behavior before the first storage snapshot.
- `content.js`: a late complete settings snapshot now restores only extension-tracked image, srcset, lazy-attribute, and inline-background proxy rewrites that still match their saved originals before applying the real settings. This fixes stale fallback quality/width/grayscale and avoids leaving images compressed when the stored setting is disabled. The defaults failsafe now relies on the existing unknown-to-enabled scan instead of making a redundant second scan request.
- `README.md`: documented safe restore-and-rebuild behavior when real settings supersede the defaults failsafe.
- `service-worker.js`: if the initial DNR settings read or local-mirror read completes only after its watchdog expires, its stale result is discarded and a fresh read is started only when no newer operation has taken over. If a callback is dropped entirely, the watchdog still releases the guard so a later settings event can retry.
- `README.md`: documented late storage-callback recovery for DNR refreshes and the local settings mirror.
- `build.sh`: release-version validation now rejects numeric components above Chrome’s 65,535 limit and non-ASCII or leading-zero forms before packaging. The project’s existing three-part release-version convention is preserved.
- `service-worker.js`: a stats-flush timeout now distinguishes a delayed read from an already-issued write. A pre-write timeout retains the batch for retry; an ambiguous write timeout is not replayed because the write may already have committed and a retry would double-count. A late callback-reported write failure remains retryable unless a statistics reset has superseded that batch; an ambiguous timeout does not clear the consecutive-failure counter, which resets only after a confirmed successful write.
- `README.md`: documented the statistics write-timeout and reset behavior.
