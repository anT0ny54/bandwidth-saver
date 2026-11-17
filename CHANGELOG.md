# Changelog

All notable changes to this project will be documented in this file.

## v0.2.2

Fourth maintenance pass on the current release. The manifest version is unchanged.

- `defaults.js`: the settings-page reload fallback now handles Chromium versions before 121, where `tabs.Tab.lastAccessed` is unavailable. It selects the nearest eligible HTTP(S) tab by tab-strip position instead of treating every candidate as equally recent. On newer Chromium versions, the most recently accessed tab still takes priority.
- `defaults.js`: the settings-page fallback uses access timestamps only when every eligible tab provides one; partial timestamp data now falls back consistently to tab-strip proximity. Equal-distance ties prefer the preceding tab, the more likely source page when settings opens beside it.
- Exclusion lists: every copy of the domain parser (`defaults.js`, `content.js`, `prehook.js`, `service-worker.js`) now uses one shared `normalizeDomainToken()`. Internationalized names are converted to punycode, so `bücher.de` matches the `xn--bcher-kva.de` hostname the browser reports. Previously such entries were silently ignored. A leading `*.` is also stripped, so `*.example.com` covers the same sites as `example.com`.
- `content.js`, `prehook.js`: `parseSrcset` now recognises only ASCII whitespace and commas as separators, as the HTML spec requires, and uses character-code checks instead of a regular expression per character. Both layers are identical, and the build's parity check still passes. A non-ASCII space such as U+00A0 is now part of a candidate URL rather than a separator.
- `.github/workflows/build.yml`: the release job no longer checks out the repository or reads the manifest a second time. The build job exports the version as an output, and the release job uses the downloaded zip.
- `build.sh`: the manifest version is read and validated in one Python call, and the unreachable archive-folder check is removed. This edit does not change the archive contents.
- `README.md`: updated the exclusion-parsing and srcset descriptions to match the behavior above.
