// Bandwidth Saver — prehook (runs at document_start)
// Intercepts <img src>, srcset, and new Image() assignments to prevent the
// original full-resolution images from ever being downloaded.
(() => {
  // Fixed image proxy: wsrv.nl. The browser receives the processed image
  // from wsrv.nl; it does not download the original image URL directly.
  const WSRV_PROXY = "https://wsrv.nl/";
  // Minimal fallback used only when the local settings mirror is unavailable.
  // KEEP IN SYNC with defaults.js, content.js and service-worker.js.
  const defaults = {
    enabled: true, proxyBase: WSRV_PROXY, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: "google.com gstatic.com"
  };

  let opts = null;        // loaded options (null until storage responds)
  let ready = false;      // true once options have loaded
  let excludedDomains = new Set();
  let proxyConfig = null;
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
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
  // Parity with content.js (KEEP IN SYNC): favicons/icons and known ad/tracking URLs.
  const ICON_URL_RE = /favicon|\.ico(?:[?#]|$)/i;
  const TRACKING_RE = /pagead|(?:pixel|cleardot)\.*\.(?:gif|jpg|jpeg)|google\.(?:[a-z.]+)\/(?:ads|generate_204|.*\/log204)+|google-analytics\.(?:[a-z.]+)\/(?:r|collect)+|youtube\.(?:[a-z.]+)\/(?:api|ptracking|player_204|live_204)+|doubleclick\.(?:[a-z.]+)\/(?:pcs|pixel|r)+|googlesyndication\.(?:[a-z.]+)\/ddm|pixel\.facebook\.(?:[a-z.]+)|facebook\.(?:[a-z.]+)\/(?:impression\.php|tr)+|ad\.bitmedia\.io|yahoo\.(?:[a-z.]+)\/pixel|criteo\.net\/img|ad\.doubleclick\.net/i;
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

  // Single place that (re)builds every derived value from a settings object.
  function applyOpts(next) {
    updateProxyConfig({ ...next, proxyBase: WSRV_PROXY });
    srcsetCache = new WeakMap();
    excludedDomains = toDomainSet(opts.excludeDomains);
    proxyUrlCache.clear();
    pageExcluded = excludedHost(pageHost);
    ready = true;
  }

  const sameOpts = (a, b) => !!a && !!b && ["enabled", "quality", "grayscale", "maxWidth", "excludeDomains"]
    .every(k => a[k] === b[k]);

  function buildProxyUrl(orig) {
    if (!proxyConfig || !isHttp(orig)) return orig;

    const cached = proxyUrlCache.get(orig);
    if (cached) return cached;

    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const parts = [
      "url=" + encodeURIComponent(orig),
      "q=" + quality
    ];

    if (maxWidth) {
      // Preserve aspect ratio and never enlarge smaller images. Limit DPR to 2
      // so high-density displays do not silently double the requested pixels again.
      const dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
      parts.push("w=" + maxWidth, "fit=inside", "we=1", "dpr=" + dpr);
    }

    if (grayscale) {
      parts.push("filt=greyscale");
    }

    // Keep animated/multi-page inputs intact and use a longer browser cache to
    // reduce repeat downloads while retaining a bounded freshness window.
    // default=1 makes wsrv.nl fall back to the original URL if processing fails.
    parts.push("maxage=30d", "page=-1", "n=-1", "output=webp", "default=1");

    const result = base + sep + parts.join("&");
    if (proxyUrlCache.size >= PROXY_CACHE_LIMIT) {
      proxyUrlCache.delete(proxyUrlCache.keys().next().value);
    }
    proxyUrlCache.set(orig, result);
    return result;
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
      applyOpts(d.bhOpts);
      flushPending();
    } else {
      chrome.storage.sync.get(defaults, synced => {
        applyOpts(synced);
        flushPending();
        // Write the mirror so subsequent pages load fast
        chrome.storage.local.set({ bhOpts: { ...synced, proxyBase: WSRV_PROXY } });
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror, instant).
  // Fallback: sync area — catches changes when the service worker is inactive
  // or not supported (Kiwi/Cromite).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      applyOpts(changes.bhOpts.newValue || defaults);
      if (ready) flushPending();
    } else if (area === "sync") {
      chrome.storage.sync.get(defaults, synced => {
        const changed = !sameOpts(synced, opts);
        applyOpts(synced);
        if (ready) flushPending();
        // The service worker normally refreshes the mirror; only write when it differs.
        if (changed) chrome.storage.local.set({ bhOpts: { ...synced, proxyBase: WSRV_PROXY } });
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

  // Spec-style srcset parser: a comma inside a URL (e.g. Cloudinary "w_400,h_300")
  // is part of the URL; only trailing commas or a comma after descriptors end a candidate.
  function parseSrcset(ss) {
    const out = [];
    const n = ss.length;
    let i = 0;
    while (i < n) {
      while (i < n && /[\s,]/.test(ss[i])) i++;
      if (i >= n) break;
      const s = i;
      while (i < n && !/\s/.test(ss[i])) i++;
      let url = ss.slice(s, i);
      let desc = "";
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
      } else {
        const d = i;
        while (i < n && ss[i] !== ",") i++;
        desc = ss.slice(d, i).trim();
      }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  // Shared skip decision for a resolved absolute http(s) URL (srcset + src).
  function skipAbsolute(absolute) {
    if (isWsrvUrl(absolute) || SVG_URL_RE.test(absolute) || ICON_URL_RE.test(absolute) ||
        isTinyOrTracking(absolute.toLowerCase()) || TRACKING_RE.test(absolute)) return true;
    const u = safeURL(absolute);
    return !u || excludedHost(u.hostname);
  }

  function rewriteSrcset(ss, el) {
    if (!ss) return ss;
    if (pageExcluded) return ss;

    if (el) {
      const cached = srcsetCache.get(el);
      if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    }

    const cands = parseSrcset(ss);
    let touched = false;
    const parts = cands.map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      if (!absolute || skipAbsolute(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  function decideSrc(original) {
    // img.src = "" is used by pages to clear an image; never proxy the page URL.
    if (!original || !String(original).trim()) return original;
    const absolute = resolveHttp(original);
    if (!absolute) return original;
    // Never proxy a URL that is already produced by wsrv.nl. This is important
    // because content.js also rewrites parser-created images; without this guard
    // the prehook wraps the wsrv URL a second time.
    if (isWsrvUrl(absolute)) return original;
    if (!ready || !opts) return null; // queue until settings are known
    if (!opts.enabled || !opts.proxyBase) return original;
    if (pageExcluded) return original;
    if (skipAbsolute(absolute)) return original;
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
      if (n !== "src" && n !== "srcset") return setAttr.call(this, name, value);
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

})();
