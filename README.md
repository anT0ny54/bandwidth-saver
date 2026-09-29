# 🛡️ Bandwidth Saver

> Reduce image bandwidth usage by rewriting image requests through [wsrv.nl](https://wsrv.nl/) — an on-the-fly image cache, resizing, and compression CDN powered by Nginx, libvips, and Cloudflare — before the browser downloads them.

**Bandwidth Saver** is a lightweight Manifest V3 browser extension focused on reducing image data usage while preserving normal browser image behavior.

It is designed to work conservatively: image interception happens early, while browser-controlled features such as `srcset` selection and lazy loading are preserved.

---

## ✨ Features

- **Image proxying** — routes eligible remote images through the wsrv.nl image optimization proxy.
- **Quality control** — Small (45), Normal (60), or Sharp (80), with optional custom quality.
- **Maximum width** — HD (768 px), Full HD (1024 px), or no limit, with optional custom width.
- **Grayscale mode** — requests grayscale images through the proxy (**enabled by default**, matching the original Bandwidth Hero `convertBw: true` behavior).
- **WebP output** — eligible images are delivered as WebP for efficient transfer.
- **Double-proxy protection** — already processed proxy URLs are never wrapped again.
- **`src` support** — handles normal HTML and JavaScript-assigned image URLs.
- **`srcset` support** — rewrites image URLs without taking over the browser's candidate selection.
- **Lazy-loading support** — preserves normal lazy-loading behavior; rewrites common `data-*` lazy-load attributes (`data-src`, `data-lazy-src`, `data-original`, etc.).
- **Dynamic pages** — handles images added after the initial page load.
- **Duplicate-work protection** — uses lightweight caching/markers (`WeakMap` srcset caches, `data-bh-*` markers) to avoid repeatedly processing the same DOM data.
- **Early URL classification** — skips unsupported, excluded, already-proxied, SVG, and known tiny/tracking URLs before expensive processing.
- **SVG handling** — external SVG images are left untouched; SVG data URLs are not proxied.
- **Statistics batching** — reduces frequent storage writes.
- **Configuration caching** — a `storage.local` mirror (`bhOpts`, ~5 ms reads) avoids repeatedly parsing the same proxy settings from `storage.sync` (~30–80 ms).
- **Chromium & Firefox compatibility** — Manifest V3 with `browser_specific_settings.gecko` (Firefox 128+).

### Default image settings

Actual values from [`defaults.js`](defaults.js):

```text
Enabled:        true
Quality:        Normal — 60
Max width:      HD — 768 px
Grayscale:      true
Output:         WebP
Without enlargement: we=1
Device pixel ratio:  dpr=2
Browser cache:  1 day (maxage=1d)
Excluded domains: google.com gstatic.com
```

A typical request is standardized as:

```text
https://wsrv.nl/?url=<encoded-source-url>&q=60&w=768&fit=inside&we=1&dpr=2&maxage=1d&page=-1&n=-1&output=webp
```

(plus `&filt=greyscale` when grayscale is on — the default).

---

## 🧩 How it works

Bandwidth Saver intercepts eligible image URLs **before the original image request is allowed to consume bandwidth**.

The simplified flow is:

```text
Web page
   │
   ├── <img src>
   ├── srcset
   ├── JavaScript Image()
   ├── setAttribute()
   └── dynamically inserted images
          │
          ▼
   Early interception
          │
          ├── Already proxy URL? ──► Leave unchanged
          ├── Excluded/unsupported? ► Leave unchanged
          ├── SVG/tiny/tracking? ──► Leave unchanged
          │
          ▼
   Build optimized proxy URL
          │
          ▼
   Image optimization proxy (wsrv.nl)
          │
          ▼
   Optimized image
          │
          ▼
   Browser
```

Proxy requests use a stable wsrv.nl parameter order: `url`, `q`, `w`, `fit`, `we=1`, `dpr=2`, optional `filt=greyscale`, `maxage=1d`, `page=-1`, `n=-1`, and `output=webp`. The source image URL is URL-encoded with `encodeURIComponent` as required by wsrv.nl.

The extension does **not** wait for an image to finish downloading before deciding whether to proxy it. Waiting for `naturalWidth`, image load events, or similar information would defeat the purpose of bandwidth saving.

### Why DNR image redirects were removed

An earlier version used Chrome's `declarativeNetRequest` `regexSubstitution` to redirect image requests. This was removed because DNR inserts the captured URL **raw** — it cannot call `encodeURIComponent`. For any image URL containing query parameters, the substitution produced a malformed proxy URL:

```text
Original URL:  https://example.com/img/photo.jpg?auto=webp&width=1092
DNR result:    malformed — original query params orphaned into the proxy's own query string
```

Image `src` rewriting is now done entirely in content scripts (`content.js` and `prehook.js`), which **can** call `encodeURIComponent`. The only DNR rule kept is **Rule 2**, which strips CSP headers so proxy images can load. Legacy Rule 1 is actively removed on every service-worker refresh to clean up leftovers from previous versions.

---

## 🏗️ Interception architecture

The interception path is intentionally conservative and split across two layers, both injected at `document_start` on all URLs and all frames.

### Layer 1 — `prehook.js` (synchronous)

Runs before the HTML parser and handles JavaScript-driven image assignments. It patches:

- `HTMLImageElement.prototype.src`
- `HTMLImageElement.prototype.srcset`
- `Element.prototype.setAttribute` (for `src` / `srcset` on `<img>` and `<source>`)
- `Image()` constructor

If options haven't loaded yet when an assignment occurs, the original value is stashed in `data-bh-pending-src` / `data-bh-pending-srcset` and the element is added to a `pending` set; once storage responds, pending elements are resolved. Zero wasted bytes — the proxy URL is set before any network request fires.

### Layer 2 — `content.js` (async, after storage read)

Handles images and attributes that appear in the parsed DOM and images introduced later by dynamic applications:

- **(A) HTML-parsed `<img src="...">`** — the browser's C++ HTML parser sets `src` natively, bypassing the JS property-setter patch. By the time this script's storage callback fires (~5–50 ms), the browser may have already started fetching the original image. Rewriting `src` here causes the browser to cancel the in-flight original request and fetch from the proxy instead. A tiny amount of the original image's bytes may already be in flight — unavoidable in MV3 since `webRequestBlocking` was removed.
- **(B) Lazy-load data attributes** (`data-src`, `data-iurl`, `data-lazy-src`, `data-original`, `data-url`, `data-hi-res`, `data-lazy`, `data-echo`) — rewritten so that when a lazy-loader later does `img.src = img.dataset.src`, prehook receives the proxy URL and the browser never fetches the original.
- **(C) Inline CSS `background-image`** — rewritten via `el.style.backgroundImage`. Best-effort: stylesheet-defined backgrounds may already be loading.

### Service worker (`service-worker.js`)

Handles extension background tasks:

- configuration/storage synchronization (keeps the `storage.local` `bhOpts` mirror current)
- statistics (images processed, bytes saved; batched writes)
- extension state
- DNR rule refresh (CSP stripping only) with a concurrency guard
- other non-page interception work

Note: the service worker inlines its own copy of `DEFAULTS` (Kiwi/Cromite do not support ES module service workers), kept in sync with `defaults.js`.

---

### Proxy duplication

An image that already uses the configured optimization proxy is left alone.

```text
original image → optimization proxy → already optimized URL
```

will **not** become `proxy → proxy → proxy`. This prevents additional requests, latency, and bandwidth consumption.

---

## 🚫 Images intentionally skipped

Not every image should be sent through an optimization proxy. Early checks skip:

- already-proxied URLs (wsrv.nl)
- non-HTTP(S) URLs
- excluded domains (default: `google.com`, `gstatic.com`)
- unsupported URL types
- external SVG images
- SVG data URLs
- known tiny/tracking image URL patterns (e.g. `1x1`, `2x2`, `pixel`, `spacer`, `tracking` in the path, or `w`/`h`/`width`/`height` query params ≤ 32 px, plus `/pagead/i`)

Tiny/tracking detection is deliberately conservative and based on URL patterns only. The extension does **not** use image dimensions obtained after download to make this decision.

---

## 🙏 Credits

Bandwidth Saver builds on ideas and techniques from the open-source bandwidth-saving ecosystem, including:

- [Bandwidth Hero](https://github.com/ayastreb/bandwidth-hero)
- [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2)
- [wsrv.nl](https://wsrv.nl/)

See the repository license and source files for applicable third-party licenses and attribution.

---

## 🔒 Protected behavior

The following areas are considered part of the **stable core** and should not be changed casually.

### 1. Prehook interception

Do not delay or redesign the early interception path without a full regression test. The extension must continue to intercept image URLs before the original download whenever possible.

### 2. MutationObserver behavior

Do not introduce aggressive delayed batching. An earlier experimental implementation that aggressively batched MutationObserver work caused compatibility problems with **Google Image Search** and was reverted.

### 3. Proxy URL construction

Do not change the working proxy URL construction without testing:

- normal images
- query-string image URLs
- grayscale
- quality
- maximum width
- WebP output
- already-proxied URLs

### 4. Double-proxy protection

Already processed proxy URLs must never be wrapped again.

---

## 📦 Installation

### From source

1. Download or clone the repository.
2. Open the extensions page in your browser:
   - Chromium: `chrome://extensions`
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on (or `about:addons` for signed builds)
3. Enable **Developer mode** (Chromium).
4. Select **Load unpacked**.
5. Choose the Bandwidth Saver project directory.
6. Open the extension popup/settings and configure quality, max width, grayscale, and excluded domains.

The exact availability of extension APIs can vary between browsers. Firefox support requires version **128.0+** (per `browser_specific_settings.gecko` in `manifest.json`).

### Permissions used

From `manifest.json`:

- `storage` — settings and statistics
- `tabs` — reload current page after settings change; per-site exclude UI
- `declarativeNetRequestWithHostAccess` — CSP header stripping (DNR Rule 2)
- `webRequest` — extension state handling
- Host permissions: `<all_urls>` — required to intercept images on every website

---

## 🏗️ Build

The repository includes a reproducible build script:

```bash
bash build.sh
```

It validates `manifest.json` (single source of truth for the version), stages the required files, sets a fixed `SOURCE_DATE_EPOCH` (1709856000) for reproducibility, and produces:

```text
dist/bandwidth-saver-*.zip
SHA256: <printed after build>
```

Custom output directory:

```bash
bash build.sh --out /path/to/dir
```

For development, the unpacked extension can be loaded directly through the browser's extension manager.

---

## 📁 Project structure

```text
bandwidth-saver/
├── manifest.json          # MV3 manifest — single source of truth for version
├── defaults.js            # Shared DEFAULTS (quality 60, grayscale true, maxWidth 768, exclusions)
├── prehook.js             # Layer 1: sync interception of JS-driven image assignments
├── content.js             # Layer 2: HTML-parsed src, lazy-load data-*, inline backgrounds
├── service-worker.js      # Background: storage sync, stats, DNR CSP rule, state
├── popup.html / popup.js  # Toolbar popup: enable toggle, quality presets, per-site exclude
├── options.html / options.js  # Settings page: quality/width presets + custom values, stats, reset
├── icons/                 # 16/32/48/128 px icons (+ disabled variants)
├── _locales/en/           # Localized name/description
├── build.sh               # Reproducible zip build
├── CHANGELOG.md           # (currently empty — populated at release time)
└── LICENSE
```

---

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |

## ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
