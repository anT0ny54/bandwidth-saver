// Bandwidth Saver — prehook (runs at document_start in the MAIN world)
// Installs synchronous DOM hooks before page JavaScript can assign image URLs.
// Extension APIs/settings never cross into this world; content.js sends a
// JSON-only DOM event after reading the local settings mirror.
(() => {
  // Fixed image proxy. MAIN-world code cannot use extension APIs.
  const WSRV_PROXY = "https://wsrv.nl/";
  const SETTINGS_EVENT = "__BANDWIDTH_SAVER_SETTINGS__";

  let opts = null;
  let ready = false;
  let excludedDomains = new Set();
  let proxyConfig = null;
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  const pending = new Set(); // <img>/<source> elements waiting for opts to be ready
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

  // Navigation hard-stop: once the user leaves the page, do not keep queuing
  // microtasks or rewriting DOM in the outgoing document. This prevents heavy
  // MutationObserver work from starving Chrome's navigation commit.
  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { preloadObserver && preloadObserver.disconnect(); } catch {}
    try { pending.clear(); } catch {}
    try { proxyUrlCache.clear(); } catch {}
    srcsetCache = new WeakMap();
  }

  // Flush image/source/link elements queued while settings were loading.
  function flushPending() {
    if (destroyed) return;
    for (const el of pending) {
      pending.delete(el);
      try {
        // <link rel="preload" as="image"> queued with a stashed original href.
        if (el instanceof HTMLLinkElement) { processPreloadLink(el); continue; }
        // <img>.loading values set before settings were known.
        if (el instanceof HTMLImageElement && loadingDesc && loadingDesc.set) {
          const pendingLoading = el.dataset.bhPendingLoading;
          if (pendingLoading !== undefined) {
            el.removeAttribute("data-bh-pending-loading");
            if (!opts.enabled || !opts.proxyBase || pageExcluded) {
              loadingDesc.set.call(el, pendingLoading);
            } else {
              loadingDesc.set.call(el, pendingLoading === "eager" ? "eager" : "lazy");
            }
          }
        }
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

  // Settings arrive from content.js through a JSON-only DOM event.
  function receiveSettings(event) {
    if (destroyed || typeof event.detail !== "string") return;
    try {
      const next = JSON.parse(event.detail);
      if (!next || typeof next !== "object") return;
      applyOpts(next);
      flushPending();
    } catch {}
  }
  document.addEventListener(SETTINGS_EVENT, receiveSettings);

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
    if (!ready || !opts) return null; // queue until settings are known
    if (!opts.enabled || !opts.proxyBase) return original;
    if (pageExcluded) return original;
    if (skipAbsolute(absolute)) return original;
    return buildProxyUrl(absolute);
  }

  // Called from the setAttribute patch, the link.href property patch, the
  // MutationObserver, and flushPending. Idempotent: re-running it on a link
  // whose href is already a proxy URL is a no-op.
  function processPreloadLink(el) {
    try {
      if (destroyed) return;
      if (!isImagePreloadLink(el)) return;
      const stashed = el.dataset.bhPreloadHref;
      const current = el.getAttribute("href");
      // decidePreloadHref must see the ORIGINAL url, never "about:blank".
      const original = stashed || current;
      if (!original || original === "about:blank") return;
      const decided = decidePreloadHref(original);
      if (decided === null) {
        // Settings not loaded yet: stash the original and drop href so the
        // browser cannot start downloading the full-resolution image.
        if (!stashed) el.dataset.bhPreloadHref = original;
        pending.add(el);
        // Never write the same value from inside an observed attribute callback;
        // same-value setAttribute can still enqueue a mutation in some engines.
        if (current !== "about:blank") setAttr.call(el, "href", "about:blank");
      } else {
        if (stashed) el.removeAttribute("data-bh-preload-href");
        if (current !== decided) setAttr.call(el, "href", decided);
      }
    } catch {}
  }

  // ── Per-image proxy failure fallback ───────────────────────────────────────
  function rememberOriginal(el, attr, value) {
    if (!value) return;
    if (el.getAttribute(attr) !== value) setAttr.call(el, attr, value);
  }

  function restoreFailedImage(img) {
    if (!(img instanceof HTMLImageElement) || img.hasAttribute("data-bh-failed")) return;
    const current = img.currentSrc || img.getAttribute("src") || "";
    if (!isWsrvUrl(current)) return;
    const originalSrc = img.getAttribute("data-bh-original-src");
    const originalSrcset = img.getAttribute("data-bh-original-srcset");
    setAttr.call(img, "data-bh-failed", "1");
    if (originalSrc) nativeSetSrc(img, originalSrc);
    else if (originalSrcset) nativeSetSrcset(img, originalSrcset);
    else if (img.parentElement?.tagName === "PICTURE") {
      for (const source of img.parentElement.querySelectorAll("source[data-bh-original-srcset]")) {
        const original = source.getAttribute("data-bh-original-srcset");
        if (original) nativeSourceSetSrcset(source, original);
      }
    }
  }

  document.addEventListener("error", event => {
    if (!destroyed) restoreFailedImage(event.target);
  }, true);

  // ── Patch <img>.src ────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const original = String(value);
        if (this.hasAttribute("data-bh-failed")) {
          nativeSetSrc(this, value);
          return;
        }
        const decided = decideSrc(original);
        if (decided === null) {
          this.dataset.bhPendingSrc = original;
          pending.add(this);
          nativeSetSrc(this, "about:blank");
        } else {
          if (decided !== original) rememberOriginal(this, "data-bh-original-src", original);
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
            const rewritten = rewriteSrcset(v, this);
            if (rewritten !== v) rememberOriginal(this, "data-bh-original-srcset", v);
            nativeSetSrcset(this, rewritten);
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
            const rewritten = rewriteSrcset(v, this);
            if (rewritten !== v) rememberOriginal(this, "data-bh-original-srcset", v);
            nativeSourceSetSrcset(this, rewritten);
          }
        } catch {
          nativeSourceSetSrcset(this, value);
        }
      }
    });
  }

  // ── Patch <img>.loading ──────────────────────────────────────────────────────
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
          if (!ready || !opts) {
            this.dataset.bhPendingLoading = v;
            pending.add(this);
            loadingDesc.set.call(this, "lazy");
          } else if (!opts.enabled || !opts.proxyBase || pageExcluded) {
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
            const decided = decidePreloadHref(String(value));
            if (decided === null) {
              this.dataset.bhPreloadHref = String(value);
              pending.add(this);
              linkHrefDesc.set.call(this, "about:blank");
              return;
            }
            linkHrefDesc.set.call(this, decided);
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

      // Handle these before the generic src/srcset gate; otherwise the early
      // return below makes the loading and preload branches unreachable.
      if (this instanceof HTMLImageElement && n === "loading") {
        const v = String(value || "").toLowerCase();
        if (!ready || !opts) {
          this.dataset.bhPendingLoading = v;
          pending.add(this);
          return setAttr.call(this, "loading", "lazy");
        }
        if (!opts.enabled || !opts.proxyBase || pageExcluded) return setAttr.call(this, "loading", v);
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
          const original = String(value);
          if (this.hasAttribute("data-bh-failed")) return setAttr.call(this, "src", value);
          const decided = decideSrc(original);
          if (decided === null) {
            this.dataset.bhPendingSrc = original;
            pending.add(this);
            return setAttr.call(this, "src", "about:blank");
          }
          if (decided !== original) rememberOriginal(this, "data-bh-original-src", original);
          return setAttr.call(this, "src", decided);
        } else if (n === "srcset") {
          const v = String(value || "");
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            return setAttr.call(this, "srcset", "");
          }
          if (!opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
          const rewritten = rewriteSrcset(v, this);
          if (rewritten !== v) rememberOriginal(this, "data-bh-original-srcset", v);
          return setAttr.call(this, "srcset", rewritten);
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
        const rewritten = rewriteSrcset(v, this);
          if (rewritten !== v) rememberOriginal(this, "data-bh-original-srcset", v);
          return setAttr.call(this, "srcset", rewritten);
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
