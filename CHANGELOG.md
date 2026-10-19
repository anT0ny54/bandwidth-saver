# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-10-19

### Fixed

- **Queued responsive images while disabled** (`prehook.js`): pending `srcset`
  values are no longer rewritten during settings flush when compression is off;
  empty pending `src`/`srcset` values are also cleaned up correctly.
- **Failed-image recovery on reused elements** (`prehook.js`, `content.js`): a
  failed proxy URL is remembered so lazy-loader retries do not replace the
  restored image, while assigning a genuinely new source clears the old restore
  state and restores normal interception.
- **Enable/reset behavior** (`content.js`, `popup.js`, `options.js`): enabling
  compression schedules a scan of already-present DOM images, and UI enable,
  disable, and reset actions reload the active HTTP(S) page when necessary.
- **Excluded-site handling** (`service-worker.js`): CSP stripping and Save-Data
  rules now exclude requests initiated by excluded domains as well as direct
  requests to those domains, including frames opened by excluded pages.
- **Statistics input validation** (`service-worker.js`): byte headers must be
  complete non-negative integer strings; partial values such as `123junk` are
  no longer counted.
- **Image preload classification** (`prehook.js`, `content.js`): an explicit
  non-image `as` value is no longer overridden by an image MIME type.
- **Picture-source fallback** (`content.js`): when a proxied image candidate
  fails, sibling `<picture><source>` candidates are restored too, including
  cases where the `<img>` itself has no `src` or `srcset` to restore.
- **Mutation-queue overflow recovery** (`content.js`): the mutation backlog now
  has a strict record cap and performs a forced DOM reconciliation if records
  are dropped, preserving coverage under heavy DOM churn.
- **Independent Save-Data setting** (`service-worker.js`): the Save-Data request
  rule remains active when enabled even if image compression is disabled; CSP
  stripping still follows the compression toggle.

### Changed

- Updated the README with concrete DOM interception coverage and known limits,
  and clarified when setting changes reload the active page.
- Updated the build workflow to use the same checkout action major as the
  keep-alive workflow.

### Removed

- Removed the popup's nearest-preset helper and unused preset constant; custom
  quality values no longer falsely highlight a built-in preset.

