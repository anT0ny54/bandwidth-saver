# 🛡️ Bandwidth Saver

> Reduce image bandwidth usage by rewriting image requests through an image optimization wsrv.nl on-the-fly image cache, resizing, and compression CDN powered by Nginx, libvips, and Cloudflare before the browser downloads them.

**Bandwidth Saver** is a lightweight Manifest V3 Chromium extension focused on reducing image data usage while preserving normal browser image behavior.

It is designed to work conservatively: image interception happens early, while browser-controlled features such as `srcset` selection and lazy loading are preserved.

---

## ✨ Features

- **Image proxying** — routes eligible remote images through an image optimization proxy.
- **Quality control** — configurable image quality.
- **Maximum width** — optionally limits oversized images before delivery.
- **Grayscale mode** — optionally requests grayscale images through the proxy.
- **WebP output** — eligible images are delivered as WebP for efficient transfer.
- **Double-proxy protection** — already processed proxy URLs are never wrapped again.
- **`src` support** — handles normal HTML and JavaScript-assigned image URLs.
- **`srcset` support** — rewrites image URLs without taking over the browser's candidate selection.
- **Lazy-loading support** — preserves normal lazy-loading behavior.
- **Dynamic pages** — handles images added after the initial page load.
- **Duplicate-work protection** — uses lightweight caching/markers to avoid repeatedly processing the same DOM data.
- **Early URL classification** — skips unsupported, excluded, already-proxied, SVG, and known tiny/tracking URLs before expensive processing.
- **SVG handling** — external SVG images are left untouched; SVG data URLs are not proxied.
- **Statistics batching** — reduces frequent storage writes.
- **Configuration caching** — avoids repeatedly parsing the same proxy settings.
- **Chromium compatibility** — designed for Chromium browsers supporting Manifest V3.

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
   Image optimization proxy
          │
          ▼
   Optimized image
          │
          ▼
   Browser
```

Proxy requests use wsrv.nl's native `q`, `w`, `fit`, `we`, `filt`, `maxage`, `page`, `n`, and `output=webp` parameters.

The extension does **not** wait for an image to finish downloading before deciding whether to proxy it. This is important because waiting for `naturalWidth`, image load events, or similar information can defeat the purpose of bandwidth saving.

---

## 🏗️ Interception architecture

The interception path is intentionally conservative.

### `prehook.js`

Runs early and handles JavaScript-driven image assignments.

It protects the most important part of the extension: rewriting image URLs before the browser performs the original download.

The interception layer covers image APIs/properties such as:

- `HTMLImageElement.src`
- `srcset`
- `setAttribute`
- `Image()`

### `content.js`

Handles images and attributes that appear in the parsed DOM and images introduced later by dynamic applications.

It is responsible for areas such as:

- normal `<img src>`
- `srcset`
- lazy-loading `data-*` attributes
- dynamically inserted images
- relevant inline `background-image` URLs


### Service worker

The service worker handles extension background tasks such as:

- configuration/storage synchronization
- statistics
- extension state
- other non-page interception work

---


### Proxy duplication

An image that already uses the configured optimization proxy is left alone.

For example:

```text
original image
      ↓
optimization proxy
      ↓
already optimized URL
```

will **not** become:

```text
proxy → proxy → proxy
```

This prevents additional requests, latency, and bandwidth consumption.

---

## 🚫 Images intentionally skipped

Not every image should be sent through an optimization proxy.

The extension performs early checks for cases such as:

- already-proxied URLs
- non-HTTP(S) URLs
- excluded domains
- unsupported URL types
- external SVG images
- SVG data URLs
- known tiny/tracking image URL patterns
- favicon/icon-style resources where appropriate

Tiny/tracking detection is deliberately conservative. The extension does not use image dimensions obtained after download to make this decision.

---


# 🙏 Credits

Bandwidth Guardian builds on ideas and techniques from the open-source bandwidth-saving ecosystem, including:

- [Bandwidth Hero](https://github.com/ayastreb/bandwidth-hero)
- [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2)
- [wsrv.nl](https://wsrv.nl/)

See the repository license and source files for applicable third-party licenses and attribution.

---.

# 🔒 Protected behavior

The following areas are considered part of the **stable core** and should not be changed casually.

## 1. Prehook interception

Do not delay or redesign the early interception path without a full regression test.

The extension must continue to intercept image URLs before the original download whenever possible.

## 2. MutationObserver behavior

Do not introduce aggressive delayed batching.

An earlier experimental implementation that aggressively batched MutationObserver work caused compatibility problems with **Google Image Search** and was reverted.

## 3. Proxy URL construction

Do not change the working proxy URL construction without testing:

- normal images
- query-string image URLs
- grayscale
- quality
- maximum width
- WebP output
- already-proxied URLs

## 4. Double-proxy protection

Already processed proxy URLs must never be wrapped again.

---

# 📦 Installation

### From source

1. Download or clone the repository.
2. Open the extensions page in your Chromium-based browser:
   - `chrome://extensions`
   - or the equivalent page provided by your browser.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the Bandwidth Guardian project directory.
6. Open the extension settings and configure the image proxy.

The exact availability of extension APIs can vary between Chromium-based browsers.

---

# 🏗️ Build

If the repository includes the build script:

```bash
bash build.sh
```

The generated package uses the version declared by `manifest.json`.

For development, the unpacked extension can be loaded directly through the browser's extension manager.

---

# 📁 Project structure

The exact files may evolve between releases, but the main extension components are organized around:

```text
bandwidth-guardian/
├── manifest.json
├── prehook.js
├── content.js
├── defaults.js
├── popup.html
├── popup.js
├── options.html
├── options.js
├── service-worker.js
├── icons/
├── _locales/
├── build.sh
└── CHANGELOG.md
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
