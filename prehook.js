// Bandwidth Guardian — prehook (runs at document_start)
// Intercepts <img src>, srcset, and new Image() assignments to prevent the
// original full-resolution images from ever being downloaded.
(() => {
  // Fixed image proxy: wsrv.nl. The browser receives the processed image
  // from wsrv.nl; it does not download the original image URL directly.
  const WSRV_PROXY = "https://wsrv.nl/";
  // Minimal fallback used only when the local settings mirror is unavailable.
  const defaults = {
    enabled: true, proxyBase: WSRV_PROXY, quality: 40, grayscale: true,
    maxWidth: 1280, excludeDomains: "google.com gstatic.com", isWebpSupported: false
  };

  let opts = null;        // loaded options (null until storage responds)
  let ready = false;      // true once options have loaded
  let excludedDomains = new Set();
  let proxyConfig = null;
  const pending = new Set(); // <img> elements waiting for opts to be ready
  const srcsetCache = new WeakMap();

  const safeURL = u => { try { return new URL(u); } catch { return null; } };
  const toDomainSet = text => new Set(
    String(text || "")
      .split(/[, \n\r\t]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
  );
  const isHttp = u => /^https?:\/\//i.test(u);
  const TINY_URL_RE = /(?:^|[._\/-])(1x1|2x2|pixel|spacer|tracking)(?:[._\/-]|$)/i;
  const TINY_DIM_RE = /(?:[?&](?:w|width|h|height)=)(?:[0-9]|[12][0-9]|3[0-2])(?:[&#]|$)/i;
  const isTinyOrTracking = u => TINY_URL_RE.test(u) || TINY_DIM_RE.test(u);
  const SVG_URL_RE = /\.svg(?:[?#]|$)/i;
  const isWsrvUrl = u => {
    try { return new URL(u).hostname.toLowerCase() === "wsrv.nl"; } catch { return false; }
  };

  function updateProxyConfig(next) {
    opts = next;
    const base = String(opts.proxyBase || "").trim();
    if (!base) { proxyConfig = null; return; }
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 40) || 40));
    const maxWidth = Number(opts.maxWidth) || 0;
    const jpeg = opts.isWebpSupported ? "0" : "1";
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      bw: opts.grayscale ? "1" : "0", jpeg,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
  }

  function buildProxyUrl(orig) {
    if (!proxyConfig || !isHttp(orig)) return orig;

    const { base, sep, quality, bw, jpeg, maxWidth, grayscale } = proxyConfig;
    const parts = [
      // Bandwidth Guardian proxy-compatible parameters requested by the user.
      "url="       + encodeURIComponent(orig),
      "quality="   + quality,
      "bw="        + bw,
      "jpeg="      + jpeg
    ];

    if (maxWidth) {
      parts.push("max_width=" + maxWidth);
    }

    // Native wsrv.nl equivalents. Keeping both sets makes the generated URL
    // compatible with the requested interface while ensuring wsrv actually
    // performs the requested transformations.
    parts.push("q=" + quality);

    if (maxWidth) {
      // Preserve aspect ratio and never enlarge smaller images.
      parts.push("w=" + maxWidth);
      parts.push("fit=inside");
      parts.push("we");
    }

    if (grayscale) {
      parts.push("filt=greyscale");
    }

    if (jpeg === "1") {
      parts.push("output=jpg");
    }

    return base + sep + parts.join("&");
  }

  function excludedHost(host) {
    return excludedDomains.has(String(host || "").toLowerCase());
  }

  // Flush any <img> elements that were queued before opts loaded.
  function flushPending() {
    for (const img of pending) {
      pending.delete(img);
      try {
        const orig = img.dataset.bhPendingSrc;
        if (orig) {
          img.removeAttribute("data-bh-pending-src");
          nativeSetSrc(img, decideSrc(orig) ?? orig);
        }
        const pendingSrcset = img.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          img.removeAttribute("data-bh-pending-srcset");
          nativeSetSrcset(img, rewriteSrcset(pendingSrcset, img));
        }
      } catch {}
    }
  }

  // Try storage.local first (bhOpts mirror written by the service worker, ~5 ms).
  // If bhOpts is missing — fresh install, service worker not yet run, or browser
  // restart before onStartup fired — fall back to storage.sync so we never
  // silently use empty defaults and let original images through.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      updateProxyConfig({ ...d.bhOpts, proxyBase: WSRV_PROXY });
      excludedDomains = toDomainSet(opts.excludeDomains);
      ready = true;
      flushPending();
    } else {
      chrome.storage.sync.get(defaults, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        excludedDomains = toDomainSet(opts.excludeDomains);
        ready = true;
        flushPending();
        // Write the mirror so subsequent pages load fast
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror, instant).
  // Fallback: sync area — catches changes when the service worker is inactive
  // or not supported (Kiwi/Cromite).
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      updateProxyConfig({ ...(changes.bhOpts.newValue || defaults), proxyBase: WSRV_PROXY });
      excludedDomains = toDomainSet(opts.excludeDomains);
      ready = true;
    } else if (area === "sync") {
      chrome.storage.sync.get(defaults, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        excludedDomains = toDomainSet(opts.excludeDomains);
        ready = true;
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Capture native property descriptors BEFORE we patch them
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;

  function nativeSetSrc(el, v) { srcDesc.set.call(el, v); }
  function nativeSetSrcset(el, v) { srcsetDesc?.set?.call(el, v); }
  function nativeSourceSetSrcset(el, v) { sourceSrcsetDesc?.set?.call(el, v); }

  function rewriteSrcset(ss, el) {
    if (!ss) return ss;
    if (el) {
      const cached = srcsetCache.get(el);
      if (cached && cached.input === ss) return cached.output;
    }

    const parts = ss.split(",");
    let touched = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) continue;
      const url = m[1];
      if (!isHttp(url) || isWsrvUrl(url) || SVG_URL_RE.test(url) || isTinyOrTracking(url.toLowerCase())) continue;
      const u = safeURL(url);
      if (!u || (opts && excludedHost(u.hostname))) continue;
      parts[i] = buildProxyUrl(url) + (m[2] || "");
      touched = true;
    }
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  function decideSrc(original) {
    if (!isHttp(original)) return original;
    // Never proxy a URL that is already produced by wsrv.nl. This is important
    // because content.js also rewrites parser-created images; without this guard
    // the prehook wraps the wsrv URL a second time.
    if (isWsrvUrl(original)) return original;
    if (isTinyOrTracking(original.toLowerCase()) || /\.svg(?:[?#]|$)/i.test(original)) return original;
    const u = safeURL(original);
    if (!u) return original;
    if (opts && excludedHost(u.hostname)) return original;
    if (!ready || !opts || !opts.proxyBase) {
      return null; // signal to queue this element
    }
    return buildProxyUrl(original);
  }

  // ── Patch <img>.src ────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const decided = decideSrc(String(value));
        if (decided === null) {
          this.dataset.bhPendingSrc = String(value);
          pending.add(this);
          nativeSetSrc(this, "about:blank");
        } else {
          nativeSetSrc(this, decided);
        }
      } catch {
        nativeSetSrc(this, value);
      }
    }
  });

  // ── Patch <img>.srcset ─────────────────────────────────────────────────────
  if (srcsetDesc && srcsetDesc.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSetSrcset(this, "");
          } else {
            nativeSetSrcset(this, rewriteSrcset(v, this));
          }
        } catch {
          nativeSetSrcset(this, value);
        }
      }
    });
  }

  // ── Patch <source>.srcset inside <picture> ────────────────────────────────
  if (sourceProto && sourceSrcsetDesc && sourceSrcsetDesc.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
          } else {
            nativeSourceSetSrcset(this, rewriteSrcset(v, this));
          }
        } catch {
          nativeSourceSetSrcset(this, value);
        }
      }
    });
  }

  // ── Patch Element.prototype.setAttribute for attribute-based src assignment ─
  Element.prototype.setAttribute = function(name, value) {
    try {
      const n = String(name).toLowerCase();
      if (this instanceof HTMLImageElement && (n === "src" || n === "srcset")) {
        if (n === "src") {
          const decided = decideSrc(String(value));
          if (decided === null) {
            this.dataset.bhPendingSrc = String(value);
            pending.add(this);
            return setAttr.call(this, "src", "about:blank");
          }
          return setAttr.call(this, "src", decided);
        } else if (n === "srcset") {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            return setAttr.call(this, "srcset", "");
          }
          return setAttr.call(this, "srcset", rewriteSrcset(v, this));
        }
      }
      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts || !opts.proxyBase) {
          this.dataset.bhPendingSrcset = v;
          return setAttr.call(this, "srcset", v);
        }
        return setAttr.call(this, "srcset", rewriteSrcset(v, this));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── Patch Image() constructor ──────────────────────────────────────────────
  // new Image().src = "..." also goes through the patched src setter above.
  const NativeImage = window.Image;
  function PatchedImage(width, height) {
    const img = new NativeImage(width, height);
    return img;
  }
  PatchedImage.prototype = NativeImage.prototype;
  Object.defineProperty(window, "Image", { configurable: true, writable: true, value: PatchedImage });
})();
