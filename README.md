# 🛡️ Bandwidth Saver

> Reduce image bandwidth usage by rewriting image URLs to go through [wsrv.nl](https://wsrv.nl/) — an on-the-fly image cache, resizing, and compression CDN powered by Nginx, libvips, and Cloudflare.

**Bandwidth Saver** is a small Manifest V3 browser extension. Content scripts rewrite eligible `http(s)` image URLs into wsrv.nl URLs, so the browser downloads a resized, recompressed (and by default grayscale) WebP instead of the original.

It is conservative by design: it rewrites URLs and lets the browser keep doing `srcset` selection and lazy loading itself.

---

## ⚠️ Read this first (real-world trade-offs)

- **Privacy:** every rewritten image URL — and therefore which images your pages load — is sent to **wsrv.nl / Cloudflare**, a third party. The proxy, not the extension, fetches the original image. Do not use it on sites you consider sensitive; add them to the exclusion list.
- **Only publicly reachable images work.** wsrv.nl fetches the image from its own servers, without your cookies or network position. Images behind a login, on an intranet/localhost, or restricted by hotlink/IP rules will show as broken. If a proxied image still fails to load, the extension **falls back to the original URL once** (flagged with `data-bh-failed`), so the image is not left broken. Workaround for systematic failures: exclude the site.
- **CSP is stripped.** So proxied images can load on pages with a strict `img-src`, the extension removes `Content-Security-Policy` headers from page and frame responses (except on excluded domains). That removes a security layer on every non-excluded site. This is the trade-off of the approach in MV3.
- **Some original bytes may still be downloaded.** Interception is best-effort, see [Interception architecture](#️-interception-architecture).
- **Grayscale is on by default.** Turn it off in the popup or settings if you want colour.
- **Statistics are delivered bytes, not "bytes saved".** See [Statistics](#-statistics).

---

## ✨ Features

- **Image proxying** — routes eligible remote images through wsrv.nl.
- **Quality** — presets Small (45), Normal (60), Sharp (80), or a custom value from 1 to 100.
- **Maximum width** — presets HD (768 px), Full HD (1024 px), No limit (0), or any custom width ≥ 0.
- **Grayscale** — requests `filt=greyscale` (**enabled by default**, matching the original Bandwidth Hero `convertBw: true`).
- **WebP output** — every proxied image is requested as `output=webp`; animated/multi-page images are kept (`n=-1`, `page=-1`).
- **Double-proxy protection** — URLs already on `wsrv.nl` are never wrapped again.
- **`src` and `srcset`** — rewrites each `srcset` candidate individually (URLs containing commas, such as `w_400,h_300`, are parsed correctly) without choosing candidates for the browser.
- **Lazy-load attributes** — rewrites `data-src`, `data-iurl`, `data-lazy-src`, `data-original`, `data-url`, `data-hi-res`, `data-lazy`, `data-echo`, and `data-srcset` on non-media elements.
- **Image preloads** — `<link rel="preload" as="image">` hints are rewritten (or parked until settings arrive) so preloaded bytes are compressed.
- **Inline CSS backgrounds** — rewrites inline `background-image: url(...)` tokens while preserving gradients and multiple backgrounds.
- **Dynamic pages** — a `MutationObserver` handles nodes and attributes added or changed after load.
- **Automatic fallback** — a proxied image that fires `error` is restored to its original URL exactly once and flagged with `data-bh-failed` so neither execution world rewrites it again.
- **Duplicate-work protection** — per-element, per-config-signature `WeakMap` caches avoid reprocessing the same value, and become eligible again automatically when settings change.
- **Early URL classification** — skips unsupported, excluded, already-proxied, SVG, icon, and known tiny/tracking URLs before building a proxy URL.
- **Per-site exclusion** — from the popup or the settings page; subdomains of an excluded domain are excluded too.
- **Settings mirror** — settings live in `storage.sync`; the service worker mirrors them to `storage.local` (`bhOpts`) because content scripts read local storage faster.
- **Statistics batching** — counters are flushed to storage at most every ~750 ms.

### Default settings

Values from [`defaults.js`](defaults.js):

```text
Enabled:          true
Quality:          Normal — 60
Max width:        HD — 768 px
Grayscale:        true
Excluded domains: (none)
```

Fixed request parameters (not user-configurable): `fit=inside`, `we=1`, `maxage=30d`, `page=-1`, `n=-1`, `output=webp`, `default=1`. `dpr` is `min(2, devicePixelRatio)` and is sent only when a max width is set.

A typical request:

```text
https://wsrv.nl/?url=<encoded-source-url>&q=60&w=768&fit=inside&we=1&dpr=1&filt=greyscale&maxage=30d&page=-1&n=-1&output=webp&default=1
```

Parameter order is stable: `url`, `q`, then — **only when max width is not "No limit"** — `w`, `fit`, `we`, `dpr`; then `filt=greyscale` if enabled; then `maxage`, `page`, `n`, `output`, `default`. The source URL is encoded with `encodeURIComponent`.

> **Note on `dpr`:** wsrv.nl treats `dpr` as a multiplier of `w`, so with `w=768` and `dpr=2` the delivered image can be up to **1536 px** wide (`we=1` prevents upscaling smaller images). The extension caps `dpr` at 2 and uses the device's actual `devicePixelRatio` below that. The "max width" setting is therefore the CSS-pixel width, not the pixel width of the file.
>
> **`default=1`** makes wsrv.nl itself fall back to the original image when processing fails; the extension additionally restores the original URL on any load error.

---

## 🧩 How it works

```text
Web page (<img>, srcset, data-* lazy attrs, preloads, inline backgrounds, dynamic DOM)
   │
   ▼
Content scripts (prehook.js in the MAIN world + content.js in the isolated world)
   │
   ├── already wsrv.nl URL?      ──► leave unchanged
   ├── excluded/non-http(s)?     ──► leave unchanged
   ├── SVG / icon / tiny / ad?   ──► leave unchanged
   ├── data-bh-failed?           ──► leave unchanged (proxy already failed once)
   │
   ▼
Build wsrv.nl URL (encoded source + quality/width/grayscale/webp)
   │
   ▼
wsrv.nl  ──►  optimized image  ──►  browser
   │                                      │
   └─────── error? ──► restore original ◄─┘ (once, then data-bh-failed)
```

The extension never waits for an image to load or checks `naturalWidth` to decide whether to proxy it; that would defeat the purpose.

### Why DNR image redirects were removed

An earlier version used `declarativeNetRequest` `regexSubstitution` to redirect image requests. DNR inserts the captured URL **raw** and cannot call `encodeURIComponent`, so any image URL with its own query string produced a malformed proxy URL. Image rewriting is now done in content scripts only. The one remaining DNR rule is CSP stripping (Rule 2); legacy Rule 1 is removed on every service-worker refresh to clean up old installs.

---

## 🏗️ Interception architecture

Two separate `content_scripts` entries, both at `document_start`, on all URLs and all frames:

| File | Execution world | Role |
| :--- | :--- | :--- |
| `prehook.js` | **`MAIN`** (page's own world) | Synchronous DOM hooks; zero wasted bytes for JS-set URLs |
| `content.js` | isolated (default) | Storage access, parser-set attributes, observer, failure fallback |

The two worlds share the DOM but **never** share JavaScript objects or extension APIs:

```text
Page JavaScript / HTML parser
          │
          ▼
   prehook.js — MAIN world
   synchronous DOM hooks (src, srcset, setAttribute, loading, preloads)
          │
          │  "bh:settings" window event, detail = JSON string
          ▼
   content.js — ISOLATED world
   chrome.storage + DOM processing + error fallback
          │
          ▼
   service-worker.js
   settings mirror / CSP (DNR) / stats / icon
```

### Layer 1 — `prehook.js` (MAIN world)

Runs in the page's own JavaScript world (`"world": "MAIN"` in the manifest), so page code hits the hooks directly. It patches:

- `HTMLImageElement.prototype.src`
- `HTMLImageElement.prototype.srcset`
- `HTMLSourceElement.prototype.srcset`
- `HTMLImageElement.prototype.loading`
- `HTMLLinkElement.prototype.href` (image preloads)
- `Element.prototype.setAttribute` (for `src`/`srcset` on `<img>`/`<source>` and preload attributes on `<link>`)

`new Image()` needs no separate patch: its `src` goes through the patched prototype.

**Settings bridge.** MAIN-world code has no access to `chrome.*` APIs, so `prehook.js` never touches storage. `content.js` reads the settings and publishes them with `window.dispatchEvent(new CustomEvent("bh:settings", { detail: <JSON string> }))`; `prehook.js` parses the JSON and flushes its queue. If settings have not arrived yet, the original value is stashed in `data-bh-pending-src` / `data-bh-pending-srcset` / `data-bh-preload-href`, the live value is parked (`about:blank` / empty), and the element is queued. A 1.5 s watchdog releases the queue with original values if the event never arrives, so a page is never left broken.

**Proxy-failure state** crosses the same boundary as a DOM attribute: `content.js` sets `data-bh-failed` on an image whose proxy request failed, and every hook in `prehook.js` passes values through untouched for flagged elements.

### Layer 2 — `content.js` (isolated world)

- Reads settings from the `storage.local` mirror (`bhOpts`, ~5 ms), falling back to `storage.sync` and re-writing the mirror, then publishes them to the MAIN world via `bh:settings`.
- Handles what the prehook cannot:
  - **(A) HTML-parsed `<img src>` / `srcset`** — the parser sets these natively. By the time settings are read (typically milliseconds), the browser may already have started the original request. Rewriting the attribute makes the browser switch to the proxy URL; a small amount of the original may already be in flight. This cannot be avoided in MV3 without `webRequestBlocking`.
  - **(B) Lazy-load `data-*` attributes** — rewritten so that when a lazy-loader copies them into `src`, the URL is already a proxy URL. Skipped on `iframe`, `script`, `a`, `link`, `video`, `audio`, `embed`, `object`, `button`, `input`, `form`, `meta`, and on URLs ending in non-image extensions (`.mp4`, `.js`, `.html`, …) so embeds and share links are not broken.
  - **(C) Inline `background-image`** — best-effort; backgrounds from stylesheets are not rewritten.
  - **(D) Parser-created image preloads**, and forcing `loading="lazy"` on parser-created `<img>` elements.
- Watches the DOM with a bounded, macrotask-batched `MutationObserver` (see *Protected behavior*).
- Restores the original URL for any proxied `<img>`/`<source>` that fires `error` (capture-phase listener; `error` does not bubble), flags it `data-bh-failed`, and clears its done-marker.
- When settings change, bumps a config signature so per-element caches become eligible again and re-scans the page — changes apply to the open tab without a reload.

### Service worker (`service-worker.js`)

- mirrors `storage.sync` settings into `storage.local` (`bhOpts`)
- refreshes the toolbar icon (enabled/disabled)
- collects statistics from `webRequest.onCompleted` on `https://wsrv.nl/*` image requests
- installs/removes the DNR CSP-stripping rule (refreshed when **enabled** or **excluded domains** change), guarded against concurrent refreshes

It is a classic (non-module) worker written with callbacks, because Kiwi/Cromite do not support ES-module service workers.

### Settings defaults are duplicated on purpose

`defaults.js` is imported by the popup and options pages. `content.js` and `service-worker.js` cannot import it, so they carry inline copies marked `KEEP IN SYNC`. `prehook.js` carries **no** copy: it receives every setting through the `bh:settings` bridge. Change `defaults.js` plus the two inline copies together.

---

## 🚫 Images intentionally skipped

Skipped by URL only (never by downloaded dimensions):

- already-proxied `wsrv.nl` URLs
- non-`http(s)` URLs, including `data:` and `blob:`
- empty `src` values (`img.src = ""` is passed through, not proxied)
- excluded domains (none by default) and their subdomains
- SVG URLs (`.svg`), `.ico` files, and anything containing `favicon`
- tiny/tracking patterns: `1x1`, `2x2`, `pixel`, `spacer`, `tracking` as a path/filename token; `w`/`h`/`width`/`height` query values ≤ 32
- known ad/tracking URLs: `pagead`, `cleardot`/`pixel` gifs, Google ads/analytics endpoints, YouTube tracking, DoubleClick, googlesyndication, Facebook pixel/impression, bitmedia, Yahoo pixel, Criteo
- elements flagged `data-bh-failed` (the proxy already failed once for them)

`content.js` and `prehook.js` use the same skip rules (and the same tracking regex).

---

## 📊 Statistics

The settings page shows **images processed** and **bytes delivered by wsrv.nl**. Bytes come from the response's `content-length` header on non-cached wsrv.nl image responses. Consequences:

- It is *not* a "bytes saved" figure — wsrv.nl does not report original sizes.
- Responses without a `content-length` header are not counted, so totals can under-report.
- Cached responses are not counted.

---

## 🙏 Credits

Bandwidth Saver builds on ideas and techniques from the open-source bandwidth-saving ecosystem, including:

- [Bandwidth Hero](https://github.com/ayastreb/bandwidth-hero)
- [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2)
- [wsrv.nl](https://wsrv.nl/)

See the repository license and source files for applicable third-party licenses and attribution.

---

## 🔒 Protected behavior

These areas are the **stable core** and should not be changed casually.

### 1. Execution-world boundary
`prehook.js` must stay in the MAIN world and must never call `chrome.*` APIs. Settings flow only through the `bh:settings` JSON event; failure state only through the `data-bh-failed` attribute. Do not pass live objects across worlds.

### 2. Prehook interception
Do not delay or redesign the early interception path without a full regression test. Intercept image URLs before the original download whenever possible.

### 3. MutationObserver behavior
Do not introduce aggressive delayed batching. An earlier experiment that batched MutationObserver work aggressively caused compatibility problems with **Google Image Search** and was reverted.

### 4. Proxy URL construction
Do not change the proxy URL construction without testing: normal images, query-string image URLs, grayscale, quality, maximum width (including "No limit"), WebP output, and already-proxied URLs.

### 5. Double-proxy protection
Already processed proxy URLs must never be wrapped again.

---

## 📦 Installation

### From source

1. Download or clone the repository.
2. Open the extensions page:
   - Chromium: `chrome://extensions`
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on
3. Enable **Developer mode** (Chromium).
4. Select **Load unpacked** and choose the project directory (Firefox: select `manifest.json`).
5. Open the popup/settings to configure quality, max width, grayscale, and excluded domains.

Firefox requires **128.0+** (`browser_specific_settings.gecko`), which is also the first version supporting `"world": "MAIN"` content scripts. Browser support beyond Chromium should be verified on your build; Kiwi/Cromite are handled by the classic-worker design.

### Using it

- **Popup:** enable toggle, grayscale toggle, quality presets (changing quality reloads the tab), per-site exclude, reload button, link to settings.
- **Settings page:** enable, grayscale, quality and width presets or custom values, excluded domains, statistics, reset. Custom values are validated on Save (quality 1–100, width 0 or more). Saving a changed quality or width reloads the active web tab.
- Changes are applied to the open tab immediately (the page is re-scanned with the new config); popup/options flows that reload the tab do so to re-fetch already-cached images.

### Permissions used

From `manifest.json`:

- `storage` — settings, settings mirror, statistics
- `tabs` — read the active tab's URL for the per-site exclude button; reload the tab after settings change
- `declarativeNetRequestWithHostAccess` — CSP header stripping (Rule 2)
- `webRequest` — read-only observation of wsrv.nl image responses for statistics (no blocking)
- Host permissions `<all_urls>` — required to run on every website

---

## 🏗️ Build

```bash
bash build.sh
```

The script reads the version from `manifest.json` (single source of truth) and validates it, stages the required files (including `LICENSE`), checks that every file referenced by the manifest exists, sets fixed file timestamps (`SOURCE_DATE_EPOCH=1709856000`) for a reproducible zip, verifies the archive, and prints:

```text
Built: dist/bandwidth-saver-<version>.zip
SHA256: <hash>
```

Custom output directory: `bash build.sh --out /path/to/dir`.

The GitHub Actions workflow `build.yml` runs this on every push to `main` (and manually) and creates or updates a GitHub Release named after the manifest version. `Keep-Alive.yml` makes a periodic commit to keep the fork's scheduled workflows active.

For development, load the unpacked folder directly.

---

## 📁 Project structure

```text
bandwidth-saver/
├── manifest.json          # MV3 manifest — single source of truth for the version
├── defaults.js            # DEFAULTS for popup/options (inline copies elsewhere)
├── prehook.js             # Layer 1: MAIN-world DOM hooks, settings via bh:settings event
├── content.js             # Layer 2: isolated world — storage, parsed attrs, observer, fallback
├── service-worker.js      # Settings mirror, icon, stats, DNR CSP rule
├── popup.html / popup.js  # Toolbar popup
├── options.html / options.js  # Settings page
├── icons/                 # 16/32/48/128 px icons (+ disabled variants)
├── _locales/en/           # Localized name/description
├── build.sh               # Reproducible zip build
├── .github/workflows/     # build.yml (build + release), Keep-Alive.yml
├── CHANGELOG.md           # Release history
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
