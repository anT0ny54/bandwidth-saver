# 🛡️ Bandwidth Saver

> Reduce image bandwidth usage by routing eligible image requests through [wsrv.nl](https://wsrv.nl/), an on-the-fly image optimization proxy.

**Bandwidth Saver** is a Manifest V3 browser extension designed around an early-interception architecture. Page JavaScript interception runs in the **MAIN world**, while extension storage and other extension APIs remain in the **isolated world**.

## ⚠️ Read this first

- **Privacy:** rewritten image URLs are sent to **wsrv.nl / Cloudflare**, which fetches the source image. Do not use proxying on sites you consider sensitive; add them to the exclusion list.
- **Publicly reachable sources:** wsrv.nl must be able to fetch the source image. When a proxied image request fails, the extension restores that image's original URL once and marks it with `data-bh-failed` so it is not immediately proxied again.
- **CSP:** the service worker removes CSP and CSP-Report-Only response headers from page/frame responses on non-excluded sites so proxy-domain images can load. This reduces the page's CSP protection and is an intentional trade-off.
- **HTML parser images:** parser-created `<img src>` attributes can begin loading before the isolated content script receives settings. The synchronous MAIN-world hooks cover page-JavaScript assignments; parser-created resources are handled by the content-script layer as soon as settings are available.
- **Grayscale:** enabled by default. Disable it in the popup/settings if colour is required.
- **Statistics:** non-cached successful wsrv.nl image responses are counted from response headers. `Content-Length` measures processed bytes delivered to the browser; `X-Upstream-Response-Length` measures source bytes received by wsrv.nl. When both are present, estimated savings are upstream bytes minus delivered bytes. The custom header may be absent, so savings are only accumulated for responses with both usable headers.

## ✨ Features

- **MAIN-world early interception** at `document_start`.
- **JSON/DOM-event settings bridge** from isolated `content.js` to MAIN-world `prehook.js`.
- **Temporary parking** of page-created images, `srcset`, image preloads, and loading assignments until settings arrive.
- **Normal images and `srcset`** including `<picture>` / `<source>` candidates.
- **Lazy-loading attributes:** `data-src`, `data-iurl`, `data-lazy-src`, `data-original`, `data-url`, `data-hi-res`, `data-lazy`, `data-echo`, and `data-srcset`.
- **Image preloads:** `<link rel="preload" as="image">`, including dynamically assigned `href`, `rel`, `as`, and `type`.
- **Inline CSS backgrounds:** best-effort rewriting of HTTP(S) `url(...)` values in inline `background-image`.
- **Dynamic DOM support:** mutation observers process inserted and changed elements.
- **Per-image proxy fallback:** failed proxy image loads restore the saved original URL and set `data-bh-failed`.
- **Configurable quality, grayscale, maximum width, and excluded domains.**
- **Double-proxy protection:** wsrv.nl URLs are never wrapped again.
- **Bounded URL/cache work:** proxy URL caches are capped and srcset work is cached per element.
- **Fast settings mirror:** `storage.sync` is mirrored to `storage.local` as `bhOpts` for faster content-script startup.
- **Batched statistics:** proxy response sizes are accumulated and flushed about every 750 ms.
- **CSP handling:** Declarative Net Request removes CSP response headers on eligible page/frame requests.
- **Reproducible build:** `build.sh` validates, stages, timestamps, packages, and verifies the extension deterministically.

### Default settings

The shared defaults in `defaults.js` are:

```text
Enabled:          true
Quality:          60
Max width:        768 px
Grayscale:        true
Excluded domains: empty
```

The proxy URL is fixed to:

```text
https://wsrv.nl/
```

When maximum width is enabled, the request includes `w=<maxWidth>`, `fit=inside`, `we=1`, and a DPR value clamped to `1..2`. The request also uses `q=<quality>`, optional `filt=greyscale`, `maxage=1d`, `page=-1`, `n=-1`, `output=webp`, and `default=1`.

`default=1` asks wsrv.nl to fall back to the source image if its own processing fails. The extension's `data-bh-failed` fallback is a second, browser-side fallback for a failed proxy image request.

## 🧩 Execution-world architecture

The execution-world boundary is intentional:

```text
Page JavaScript / HTML parser
          │
          ▼
   prehook.js — MAIN world
   synchronous native DOM hooks
          │
          │ JSON string in DOM event
          ▼
   content.js — ISOLATED world
   chrome.storage + DOM processing
          │
          ▼
   service-worker.js
   settings mirror / CSP / stats / icon
```

### `prehook.js` — MAIN world

Injected at `document_start`, before page JavaScript runs. It captures native descriptors before patching and hooks:

- `HTMLImageElement.prototype.src`
- `HTMLImageElement.prototype.srcset`
- `HTMLSourceElement.prototype.srcset`
- `HTMLImageElement.prototype.loading`
- `HTMLLinkElement.prototype.href`
- `Element.prototype.setAttribute`

It also observes parser-created and dynamically inserted image preloads with a `MutationObserver`.

`new Image()` does not need a separate constructor replacement: its `src` assignment reaches the patched `HTMLImageElement.prototype.src` setter.

If settings have not arrived, eligible page-created image URLs are temporarily replaced with `about:blank` and stored in element-local `data-bh-pending-*` state. Once the settings event arrives, pending work is flushed.

MAIN-world code **does not use `chrome.*` APIs**.

### Settings bridge

`content.js` reads the settings from `storage.local` first. It then publishes a JSON-serialized snapshot through:

```text
__BANDWIDTH_SAVER_SETTINGS__
```

No JavaScript object, storage object, or `chrome.*` API crosses the world boundary.

The service worker maintains the `bhOpts` local mirror from `storage.sync`. If the mirror is missing, `content.js` falls back to `storage.sync`, writes the mirror, and publishes the settings.

### `content.js` — ISOLATED world

This layer handles work the MAIN-world hooks cannot see directly, especially parser-created DOM resources and broad DOM scanning:

- parser-created `<img src>` and `srcset`
- `<source srcset>`
- lazy `data-*` attributes
- `data-srcset`
- inline `background-image`
- parser-created and dynamic image preloads
- dynamically inserted/changed elements

Its `MutationObserver` batches mutation records into a macrotask and bounds queued records to avoid unbounded memory use during pathological DOM churn.

### Proxy failure fallback

When the MAIN-world layer changes an image to a proxy URL, it retains the original source on that element. If the image emits an error while its current source is wsrv.nl, the extension:

1. sets `data-bh-failed="1"`;
2. restores the saved original `src` or `srcset` when available;
3. restores saved `<picture><source>` candidates when needed;
4. lets subsequent content-script scans skip that failed image.

This prevents a failed proxy request from becoming a permanent broken image while avoiding an immediate proxy loop.

## Why image redirects are not done with DNR

An earlier DNR `regexSubstitution` approach could not safely URL-encode a captured source URL. Image URLs containing their own query strings could therefore produce malformed proxy URLs.

Image URL rewriting is consequently performed by `prehook.js` and `content.js`, where `encodeURIComponent()` is available. DNR is retained only for CSP response-header handling. Legacy image redirect Rule 1 is removed on service-worker refresh.

## 🚫 Images intentionally skipped

The URL classifier skips:

- non-HTTP(S) resources such as `data:` and `blob:`
- already-proxied `wsrv.nl` URLs
- excluded domains and their subdomains
- SVG URLs and icon/favicon URLs
- obvious tiny/tracking URLs such as `1x1`, `2x2`, `pixel`, `spacer`, `tracking`, or dimensions ≤ 32 in common width/height query parameters
- known ad/tracking endpoint patterns

The extension makes these decisions from URLs; it does not download an image merely to inspect its dimensions.

## 📊 Statistics

The settings page shows:

- **Images:** successful, non-cached wsrv.nl image responses with a usable `Content-Length`
- **Proxy bytes:** the sum of `Content-Length`, representing processed image bytes delivered to the browser
- **Bytes saved:** the sum of `X-Upstream-Response-Length - Content-Length` for responses where both headers contain valid non-negative byte counts

`X-Upstream-Response-Length` represents the number of bytes wsrv.nl received from the original image server; `Content-Length` represents the processed response size delivered by wsrv.nl. For example, 100,000 upstream bytes and 30,000 delivered bytes means 70,000 bytes saved (70%). Savings are an estimate for observed individual responses, not total account usage. If the custom upstream header is missing, that response contributes to image/proxy-byte totals but not to the savings total. Savings can be negative when the processed image is larger than its source. Browser JavaScript CORS visibility is separate from this extension statistic: the extension reads response headers through the browser extension `webRequest` API.

## ⚙️ Settings and UI

### Popup

The popup provides:

- enable/disable
- grayscale
- quality presets
- current-site exclusion
- page reload
- settings-page access

### Settings page

The settings page provides:

- enable/disable
- grayscale
- quality presets or custom 1–100
- maximum-width presets or custom values ≥ 0
- excluded domains
- statistics and reset
- reset-to-defaults

Quality and width changes reload the active page when needed. Existing resources are not retroactively guaranteed to change without a reload.

## 🔐 Permissions

From `manifest.json`:

- `storage` — settings, local mirror, and statistics
- `tabs` — active-tab URL lookup and reload
- `declarativeNetRequestWithHostAccess` — CSP response-header removal
- `webRequest` — read-only observation of wsrv.nl image responses for statistics
- `<all_urls>` host access — required for document-start interception on websites

## 📦 Installation

### From source

1. Download or clone the repository.
2. Open the extensions page:
   - Chromium: `chrome://extensions`
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on
3. Enable Developer mode where required.
4. Load the project directory as an unpacked extension, or select `manifest.json` for Firefox.

The manifest declares a Chromium-style MV3 service worker and the MAIN-world content script explicitly. Browser-specific support should be verified on the target browser; the service worker intentionally uses classic callback-based APIs rather than ES-module syntax for compatibility with Chromium-derived browsers such as Kiwi/Cromite.

## 🏗️ Build

```bash
bash build.sh
```

The script:

1. reads the version from `manifest.json`;
2. validates JavaScript syntax;
3. stages only files required by the manifest/package;
4. verifies manifest references;
5. applies a fixed `SOURCE_DATE_EPOCH`;
6. creates a sorted zip without extra timestamps;
7. tests the resulting archive; and
8. prints the SHA-256 hash.

Custom output directory:

```bash
bash build.sh --out /path/to/dir
```

GitHub Actions runs the same build on pushes to `main` and manual dispatch, uploads the artifact, and publishes/replaces the manifest-version release asset.

## 📁 Project structure

```text
bandwidth-saver/
├── manifest.json
├── defaults.js
├── prehook.js             # MAIN-world synchronous interception
├── content.js             # ISOLATED-world storage + DOM processing
├── service-worker.js      # settings mirror, icon, stats, DNR CSP rule
├── popup.html / popup.js
├── options.html / options.js
├── icons/
├── _locales/en/
├── build.sh
├── .github/workflows/
├── CHANGELOG.md
└── LICENSE
```

## 🙏 Credits

Bandwidth Saver builds on ideas and techniques from the open-source bandwidth-saving ecosystem, including:

- [Bandwidth Hero](https://github.com/ayastreb/bandwidth-hero)
- [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2)
- [wsrv.nl](https://wsrv.nl/)

See `LICENSE` and the source files for applicable third-party licensing and attribution.

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

## ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
