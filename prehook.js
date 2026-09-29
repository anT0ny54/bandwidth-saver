// Bandwidth Guardian — prehook (runs at document_start)
// Intercepts <img src>, srcset, and new Image() assignments to prevent the
// original full-resolution images from ever being downloaded.
(() => {
  // Fixed image proxy: wsrv.nl. The browser receives the processed image
  // from wsrv.nl; it does not download the original image URL directly.
  const WSRV_PROXY = "https://wsrv.nl/";
  // Minimal fallback used only when the local settings mirror is unavailable.
  const defaults = {
    enabled: true, proxyBase: WSRV_PROXY, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: "google.com gstatic.com"
  };

  let opts = null;        // loaded options (null until storage responds)
  let ready = false;      // true once options have loaded
  let excludedDomains = new Set();
  let proxyConfig = null;
  const pageHost = location.hostname.toLowerCase();
  const pending = new Set(); // <img>/<source> elements waiting for opts to be ready
  let srcsetCache = new WeakMap();

  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  const toDomainSet = text => new Set(
    String(text || "")
      .split(/[, \n\r\t]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
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
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
  }

  function buildProxyUrl(orig) {
    if (!proxyConfig || !isHttp(orig)) return orig;

    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const parts = [
      "url=" + encodeURIComponent(orig),
      "q=" + quality
    ];

    if (maxWidth) {
      // Preserve aspect ratio and never enlarge smaller images.
      parts.push("w=" + maxWidth, "fit=inside", "we=1", "dpr=2");
    }

    if (grayscale) {
      parts.push("filt=greyscale");
    }

    // wsrv.nl supports these natively; keep animated/multi-page inputs intact
    // while delivering a browser-friendly WebP response.
    parts.push("maxage=1d", "page=-1", "n=-1", "output=webp");

    return base + sep + parts.join("&");
  }

  function excludedHost(host) {
    let h = String(host || "").toLowerCase().replace(/\.$/, "");
    while (h) {
      if (excludedDomains.has(h)) return true;
      const dot = h.indexOf(".");
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return false;
  }

  // Flush image/source elements queued while settings were loading.
  function flushPending() {
    for (const el of pending) {
      pending.delete(el);
      try {
        const pendingSrc = el.dataset.bhPendingSrc;
        if (pendingSrc && el instanceof HTMLImageElement) {
          el.removeAttribute("data-bh-pending-src");
          nativeSetSrc(el, decideSrc(pendingSrc) ?? pendingSrc);
        }
        const pendingSrcset = el.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          el.removeAttribute("data-bh-pending-srcset");
          const rewritten = rewriteSrcset(pendingSrcset, el);
          if (el instanceof HTMLImageElement) {
            nativeSetSrcset(el, rewritten);
          } else if (sourceProto && el instanceof HTMLSourceElement) {
            nativeSourceSetSrcset(el, rewritten);
          }
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
        srcsetCache = new WeakMap();
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
      srcsetCache = new WeakMap();
      excludedDomains = toDomainSet(opts.excludeDomains);
      ready = true;
    } else if (area === "sync") {
      chrome.storage.sync.get(defaults, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        srcsetCache = new WeakMap();
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
    if (excludedHost(pageHost)) return ss;

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
      const absolute = resolveHttp(url);
      if (!absolute || isWsrvUrl(absolute) || SVG_URL_RE.test(absolute) ||
          isTinyOrTracking(absolute.toLowerCase())) continue;
      const u = safeURL(absolute);
      if (!u || (opts && excludedHost(u.hostname))) continue;
      parts[i] = buildProxyUrl(absolute) + (m[2] || "");
      touched = true;
    }
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  function decideSrc(original) {
    const absolute = resolveHttp(original);
    if (!absolute) return original;
    // Never proxy a URL that is already produced by wsrv.nl. This is important
    // because content.js also rewrites parser-created images; without this guard
    // the prehook wraps the wsrv URL a second time.
    if (isWsrvUrl(absolute)) return original;
    if (!ready || !opts) return null; // queue until settings are known
    if (!opts.enabled || !opts.proxyBase) return original;
    if (excludedHost(pageHost)) return original;
    if (isTinyOrTracking(absolute.toLowerCase()) || /\.svg(?:[?#]|$)/i.test(absolute)) return original;
    const u = safeURL(absolute);
    if (!u || excludedHost(u.hostname)) return original;
    return buildProxyUrl(absolute);
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
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSetSrcset(this, "");
          } else if (!opts.enabled || !opts.proxyBase) {
            nativeSetSrcset(this, v);
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
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSourceSetSrcset(this, "");
          } else if (!opts.enabled || !opts.proxyBase) {
            nativeSourceSetSrcset(this, v);
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
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            return setAttr.call(this, "srcset", "");
          }
          if (!opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
          return setAttr.call(this, "srcset", rewriteSrcset(v, this));
        }
      }
      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts) {
          this.dataset.bhPendingSrcset = v;
          pending.add(this);
          return setAttr.call(this, "srcset", "");
        }
        if (!opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
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
