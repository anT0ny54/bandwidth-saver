// Bandwidth Saver — prehook (MAIN world, document_start)
//
// Installs synchronous DOM hooks BEFORE the HTML parser runs so page
// JavaScript hits its native DOM property hooks for <img src>, srcset,
// setAttribute(), loading, and image preloads.
//
// ══ EXECUTION-WORLD BOUNDARY ══════════════════════════════════════════════════
//
//  This file runs in the page's MAIN world (manifest: "world": "MAIN").
//  MAIN-world code must NOT depend on extension APIs (chrome.*) — they do not
//  exist here. Settings arrive exclusively from content.js (ISOLATED world)
//  through the "bh:settings" DOM event, whose detail is a JSON string. No
//  JavaScript objects are shared across the execution-world boundary;
//  proxy-failure state is communicated with the data-bh-failed DOM attribute,
//  which is visible in both worlds.
//
//  Flow:
//
//    Page JavaScript / HTML parser
//          │
//          ▼
//      prehook.js (this file, MAIN world)
//      synchronous DOM hooks. Like v0.0.9, requests made before settings
//      arrive load the ORIGINAL url, so the hostname is resolved through
//      the USER's DNS resolver (a network redirect to the proxy would move
//      that lookup to the proxy's resolver instead — see service-worker).
//          │
//          │  window event "bh:settings" (JSON string)
//          ▼
//      content.js (ISOLATED world) — chrome.storage + DOM processing
//          │
//          ▼
//      service-worker.js — settings mirror / CSP / stats / icon
//
// ══════════════════════════════════════════════════════════════════════════════
(() => {
  // Fixed image proxy: wsrv.nl. The browser receives the processed image
  // from wsrv.nl; it does not download the original image URL directly.
  const WSRV_PROXY = "https://wsrv.nl/";

  let opts = null;        // loaded options (null until the bridge event fires)
  let ready = false;      // true once options have arrived from content.js
  let excludedDomains = new Set();
  let proxyConfig = null;
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  let srcsetCache = new WeakMap();
  let destroyed = false; // true once the page is navigating away; stop all DOM work
  let preloadObserver = null; // declared up front; stop() references it

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
  // Proxy-failure fallback is shared across worlds via this DOM attribute
  // (set by content.js when a proxied image fires "error"). Never rewrite a
  // flagged element again.
  const isFailed = el =>
    !!(el && el.hasAttribute && el.hasAttribute("data-bh-failed"));

  function updateProxyConfig(next) {
    opts = next;
    const base = WSRV_PROXY;
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: "?", quality,
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

  // ── Settings bridge (ISOLATED world → MAIN world) ──────────────────────────
  // content.js reads chrome.storage and publishes JSON-serialized settings.
  // The detail payload is a plain string — no JS objects cross worlds.
  window.addEventListener("bh:settings", e => {
    if (destroyed) return;
    let next = null;
    try { next = JSON.parse(e.detail); } catch { return; }
    if (!next || typeof next !== "object") return;
    applyOpts(next);
  });

  // Navigation hard-stop: once the user leaves the page, do not keep queuing
  // microtasks or rewriting DOM in the outgoing document. This prevents heavy
  // MutationObserver work from starving Chrome's navigation commit.
  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { preloadObserver && preloadObserver.disconnect(); } catch {}
    try { proxyUrlCache.clear(); } catch {}
    srcsetCache = new WeakMap();
  }

  // Capture native property descriptors BEFORE we patch them
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;
  const loadingDesc = Object.getOwnPropertyDescriptor(imgProto, "loading");
  const linkProto = HTMLLinkElement.prototype;
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto, "href");
  const inputProto = HTMLInputElement.prototype;
  const inputSrcDesc = Object.getOwnPropertyDescriptor(inputProto, "src");

  function nativeSetSrc(el, v) { srcDesc.set.call(el, v); }
  function nativeSetSrcset(el, v) { srcsetDesc?.set?.call(el, v); }
  function nativeSourceSetSrcset(el, v) { sourceSrcsetDesc?.set?.call(el, v); }
  function nativeSetInputSrc(el, v) { inputSrcDesc?.set?.call(el, v); }

  // Spec-style srcset parser: a comma inside a URL (e.g. Cloudinary "w_400,h_300")
  // is part of the URL; only trailing commas or a comma after descriptors end a candidate.
  // KEEP IN SYNC with parseSrcset in content.js.
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
    if (!ready || !opts || !opts.enabled || !opts.proxyBase || pageExcluded) return ss;

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
    // Settings not known yet: load the original, exactly like v0.0.9. The
    // browser resolves the hostname through the USER's resolver first;
    // content.js rewrites the attribute afterwards if still eligible.
    if (!ready || !opts) return original;
    if (!opts.enabled || !opts.proxyBase) return original;
    if (pageExcluded) return original;
    if (skipAbsolute(absolute)) return original;
    return buildProxyUrl(absolute);
  }

  // ── <link rel="preload" as="image"> support ────────────────────────────────
  // A preload hint makes the browser download the full-resolution image URL
  // directly — bypassing every <img> patch. We therefore rewrite the preload's
  // href to the proxy URL (or stash and blank it until settings are known).
  const isImagePreloadLink = el =>
    el instanceof HTMLLinkElement &&
    /(?:^|\s)preload(?:\s|$)/i.test(el.rel || "") &&
    (String(el.getAttribute("as") || "").toLowerCase() === "image" ||
     /^image\//i.test(el.getAttribute("type") || ""));

  function decidePreloadHref(original) {
    if (!original || !String(original).trim()) return original;
    const absolute = resolveHttp(original);
    if (!absolute) return original;
    // Already a proxy URL (e.g. re-processing our own write): leave it alone.
    if (isWsrvUrl(absolute)) return original;
    if (!ready || !opts) return original;
    if (!opts.enabled || !opts.proxyBase) return original;
    if (pageExcluded) return original;
    if (skipAbsolute(absolute)) return original;
    return buildProxyUrl(absolute);
  }

  // Called from the setAttribute patch, the link.href property patch, the
  // whose href is already a proxy URL is a no-op.
  function processPreloadLink(el) {
    try {
      if (destroyed) return;
      if (!isImagePreloadLink(el)) return;
      const current = el.getAttribute("href");
      if (!current) return;
      const decided = decidePreloadHref(current);
      // Never write the same value from inside an observed attribute callback;
      // same-value setAttribute can still enqueue a mutation in some engines.
      if (current !== decided) setAttr.call(el, "href", decided);
    } catch {}
  }

  // ── Patch <img>.src ────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        // Proxy-failure fallback (set by content.js): never re-proxy.
        if (isFailed(this)) { nativeSetSrc(this, value); return; }
        nativeSetSrc(this, decideSrc(String(value)));
      } catch {
        nativeSetSrc(this, value);
      }
    }
  });

  // ── Patch <input type="image">.src ─────────────────────────────────────────
  // Form image buttons fetch through HTMLInputElement.src, bypassing every
  // <img> patch — an original-host request (and DNS lookup) would leak.
  if (inputSrcDesc && inputSrcDesc.set) {
    Object.defineProperty(inputProto, "src", {
      configurable: true,
      enumerable: inputSrcDesc.enumerable,
      get: inputSrcDesc.get,
      set(value) {
        try {
          if (isFailed(this) || String(this.type).toLowerCase() !== "image") {
            nativeSetInputSrc(this, value);
            return;
          }
          nativeSetInputSrc(this, decideSrc(String(value)));
        } catch {
          nativeSetInputSrc(this, value);
        }
      }
    });
  }

  // ── Patch <img>.srcset ─────────────────────────────────────────────────────
  if (srcsetDesc && srcsetDesc.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          // Proxy-failure fallback (set by content.js): never re-proxy.
          if (isFailed(this)) { nativeSetSrcset(this, value); return; }
          const v = String(value || "");
          if (!ready || !opts || !opts.enabled || !opts.proxyBase) {
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
          // Proxy-failure fallback (set by content.js): never re-proxy.
          if (isFailed(this)) { nativeSourceSetSrcset(this, value); return; }
          const v = String(value || "");
          if (!ready || !opts || !opts.enabled || !opts.proxyBase) {
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

  // ── Patch <img>.loading ────────────────────────────────────────────────────
  // Force lazy loading while the extension is active so offscreen images are
  // never downloaded. Explicit eager requests from the page are respected so
  // carousels / above-the-fold logic keep working.
  if (loadingDesc && loadingDesc.set) {
    Object.defineProperty(imgProto, "loading", {
      configurable: true,
      enumerable: loadingDesc.enumerable,
      get: loadingDesc.get,
      set(value) {
        try {
          const v = String(value || "").toLowerCase();
          if (!ready || !opts || !opts.enabled || !opts.proxyBase || pageExcluded) {
            loadingDesc.set.call(this, v);
          } else {
            loadingDesc.set.call(this, v === "eager" ? "eager" : "lazy");
          }
        } catch {
          loadingDesc.set.call(this, value);
        }
      }
    });
  }

  // ── Patch <link>.href property for image preloads ──────────────────────────
  // Direct property assignment (link.href = "...") bypasses setAttribute.
  if (linkHrefDesc && linkHrefDesc.set) {
    Object.defineProperty(linkProto, "href", {
      configurable: true,
      enumerable: linkHrefDesc.enumerable,
      get: linkHrefDesc.get,
      set(value) {
        try {
          if (isImagePreloadLink(this)) {
            // Proxy-failure fallback (set by content.js): never re-proxy.
            if (isFailed(this)) { linkHrefDesc.set.call(this, value); return; }
            linkHrefDesc.set.call(this, decidePreloadHref(String(value)));
            return;
          }
        } catch {}
        linkHrefDesc.set.call(this, value);
      }
    });
  }

  // ── Patch Element.prototype.setAttribute for attribute-based assignment ────
  Element.prototype.setAttribute = function(name, value) {
    try {
      if (destroyed) return setAttr.call(this, name, value);
      const n = String(name).toLowerCase();

      // Proxy-failure fallback: let the page manage a failed element directly.
      if ((n === "src" || n === "srcset") && isFailed(this)) {
        return setAttr.call(this, name, value);
      }

      // Handle these before the generic src/srcset gate; otherwise the early
      // return below makes the loading and preload branches unreachable.
      if (this instanceof HTMLImageElement && n === "loading") {
        const v = String(value || "").toLowerCase();
        if (!ready || !opts || !opts.enabled || !opts.proxyBase || pageExcluded) {
          return setAttr.call(this, "loading", v);
        }
        return setAttr.call(this, "loading", v === "eager" ? "eager" : "lazy");
      }

      if (this instanceof HTMLLinkElement &&
          (n === "href" || n === "rel" || n === "as" || n === "type")) {
        // Let the attribute land first so isImagePreloadLink() sees the full
        // rel/as/href combination (order of attribute sets is page-controlled).
        setAttr.call(this, name, value);
        processPreloadLink(this);
        return;
      }

      if (n !== "src" && n !== "srcset") return setAttr.call(this, name, value);
      if (this instanceof HTMLImageElement && (n === "src" || n === "srcset")) {
        if (n === "src") {
          return setAttr.call(this, "src", decideSrc(String(value)));
        } else if (n === "srcset") {
          const v = String(value || "");
          if (!ready || !opts || !opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
          return setAttr.call(this, "srcset", rewriteSrcset(v, this));
        }
      }
      if (this instanceof HTMLInputElement && n === "src") {
        if (String(this.type).toLowerCase() !== "image") return setAttr.call(this, name, value);
        return setAttr.call(this, "src", decideSrc(String(value)));
      }
      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts || !opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
        return setAttr.call(this, "srcset", rewriteSrcset(v, this));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── MutationObserver for <link rel="preload" as="image"> ──────────────────
  // The HTML parser sets attributes natively, bypassing our JS patches. Watch
  // for link elements added to the DOM and for rel/as/href/type changes.
  preloadObserver = new MutationObserver(mutations => {
    if (destroyed) return;
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n instanceof HTMLLinkElement) processPreloadLink(n);
          if (n.querySelectorAll) {
            n.querySelectorAll('link[rel~="preload"]').forEach(processPreloadLink);
          }
        });
      } else {
        processPreloadLink(m.target);
      }
    }
  });
  // document exists at document_start even before documentElement is parsed;
  // observing it with subtree covers the parser-created links that follow.
  preloadObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "rel", "as", "type"]
  });

  // Free the outgoing page immediately on normal navigation. Skip persisted
  // pageshow/bfcache restores so back/forward keeps working.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });

})();
