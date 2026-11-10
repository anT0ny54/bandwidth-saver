// Bandwidth Saver — prehook (runs at document_start in the MAIN world)
// Installs synchronous DOM hooks before page JavaScript can assign image URLs.
// Extension APIs/settings never cross into this world; content.js sends a
// JSON-only DOM event after reading the local settings mirror.
(() => {
  // Fixed image proxy. MAIN-world code cannot use extension APIs.
  const WSRV_PROXY = "https://wsrv.nl/";
  const SETTINGS_EVENT = "__BANDWIDTH_SAVER_SETTINGS__";
  // Defaults mirror content.js, defaults.js and service-worker.js. Older local
  // mirrors may be partial, so normalize every incoming snapshot before use.
  const DEFAULTS = {
    enabled: true, saveData: true, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: "", fallbackToOrigin: true
  };
  // Derived from WSRV_PROXY so the proxy host lives in exactly one string per
  // file (parity with content.js).
  const proxyHost = new URL(WSRV_PROXY).hostname;

  let opts = null;
  let ready = false;
  let excludedDomains = new Set();
  let proxyConfig = null;
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  // location.hostname is spec-lowercase already.
  const pageHost = location.hostname;
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  const pending = new Set(); // <img>/<source> elements waiting for opts to be ready
  let srcsetCache = new WeakMap();
  // Clamped once per applyOpts(); see the matching hoist in content.js.
  let dpr = 1;
  let destroyed = false; // true once the page is navigating away; stop all DOM work
  let preloadObserver = null; // declared up front; stop() references it
  const ORIGINAL_SRC_ATTR = "data-bw-original-src";
  const ORIGINAL_SRCSET_ATTR = "data-bw-original-srcset";
  const RESTORED_SRC_ATTR = "data-bw-restored-src";
  const RESTORED_SRCSET_ATTR = "data-bw-restored-srcset";
  const FAILED_PROXY_SRC_ATTR = "data-bw-failed-proxy-src";
  const FAILED_PROXY_SRCSET_ATTR = "data-bw-failed-proxy-srcset";
  const ORIGINAL_PRELOAD_HREF_ATTR = "data-bw-original-preload-href";
  const APPLIED_PRELOAD_HREF_ATTR = "data-bw-applied-preload-href";
  const PENDING_PRELOAD_HREF_ATTR = "data-bh-preload-href";
  const ORIGINAL_PRELOAD_IMAGESRCSET_ATTR = "data-bw-original-preload-imagesrcset";
  const APPLIED_PRELOAD_IMAGESRCSET_ATTR = "data-bw-applied-preload-imagesrcset";
  const PENDING_PRELOAD_IMAGESRCSET_ATTR = "data-bh-preload-imagesrcset";
  // Written only by content.js (which owns data-srcset fallback state), but
  // cleared here too: when a restored element is reused for a new source,
  // restoredAssignment() wipes every restore marker and this one must not
  // survive to mislead a later restore.
  const ORIGINAL_DATA_SRCSET_ATTR = "data-bw-original-data-srcset";
  const RESTORED_STATE_ATTRS = [
    "data-bw-restored", RESTORED_SRC_ATTR, RESTORED_SRCSET_ATTR,
    FAILED_PROXY_SRC_ATTR, FAILED_PROXY_SRCSET_ATTR,
    ORIGINAL_SRC_ATTR, ORIGINAL_SRCSET_ATTR, ORIGINAL_DATA_SRCSET_ATTR
  ];

  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const toDomainSet = text => new Set(
    String(text || "")
      .split(/[\s,]+/)
      .map(s => s.toLowerCase())
      .filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""))
      .filter(Boolean)
  );
  const isHttp = u => /^https?:\/\//i.test(u);
  const TINY_DIM_RE = /(?:[?&](?:w|width|h|height)=)(?:[0-9]|[12][0-9]|3[0-2])(?:[&#]|$)/i;
  const isTiny = u => TINY_DIM_RE.test(u);
  const SVG_URL_RE = /\.svg(?:[?#]|$)/i;
  // Parity with content.js (KEEP IN SYNC): favicons/icons.
  const ICON_URL_RE = /favicon|\.ico(?:[?#]|$)/i;

  function updateProxyConfig(next) {
    // Local mirrors written by older versions may not contain every setting.
    // Merge defaults before publishing to the MAIN world so one missing field
    // cannot leave its early-interception hooks parked on about:blank.
    opts = { ...DEFAULTS, ...(next && typeof next === "object" ? next : {}) };
    // ?? catches null/undefined; Number.isFinite catches NaN. Crucially, 0
    // stays 0 so Math.max(1, …) clamps it to 1 — the old `|| 60` turned 0
    // into 60 and silently bypassed the clamp.
    // Invalid maxWidth values fall back to DEFAULTS.maxWidth rather than
    // 0: a corrupt legacy value must not silently disable the width cap.
    const numericValue = value =>
      (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
        ? Number(value) : NaN;
    const rawQuality = numericValue(opts.quality ?? DEFAULTS.quality);
    const quality = Math.max(1, Math.min(100,
      Number.isFinite(rawQuality) ? Math.trunc(rawQuality) : DEFAULTS.quality));
    const rawMaxWidth = numericValue(opts.maxWidth ?? DEFAULTS.maxWidth);
    const truncatedMaxWidth = Math.trunc(rawMaxWidth);
    // Validate the raw value before truncation: Math.trunc(-0.5) is -0,
    // which compares >= 0 and would otherwise disable the width cap.
    const maxWidth = rawMaxWidth >= 0 && Number.isSafeInteger(truncatedMaxWidth)
      ? truncatedMaxWidth
      : DEFAULTS.maxWidth;
    // Store the normalized values back on the merged snapshot. That keeps
    // settings comparisons exact and prevents legacy string values from
    // repeatedly invalidating caches or looking like a settings change.
    opts.enabled = !!opts.enabled;
    opts.saveData = !!opts.saveData;
    opts.grayscale = !!opts.grayscale;
    opts.fallbackToOrigin = !!opts.fallbackToOrigin;
    opts.excludeDomains = String(opts.excludeDomains ?? DEFAULTS.excludeDomains);
    opts.quality = quality;
    opts.maxWidth = maxWidth;
    proxyConfig = { base: WSRV_PROXY, quality, maxWidth, grayscale: opts.grayscale };
  }

  // Single place that (re)builds every derived value from a settings object.
  function applyOpts(next) {
    updateProxyConfig(next);
    dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
    srcsetCache = new WeakMap();
    excludedDomains = toDomainSet(opts.excludeDomains);
    proxyUrlCache.clear();
    pageExcluded = excludedHost(pageHost);
    ready = true;
  }

  // saveData is intentionally not compared: the MAIN world never reads it
  // (no header access here), so a Save-Data-only toggle must not clear the
  // proxy URL and srcset caches.
  // Exclusion lists are compared by normalized effect, not raw spelling:
  // separator style, whitespace, casing, optional schemes/paths, and leading/
  // trailing dots all normalize to the same domain set and must not
  // invalidate the proxy URL/srcset caches. (Same normalization as the
  // popup/settings parsers and DNR validation.)
  // KEEP IN SYNC with content.js.
  const domainKey = text => Array.from(toDomainSet(text)).sort().join(" ");
  const sameOpts = (a, b) => !!a && !!b &&
    a.enabled === b.enabled &&
    a.quality === b.quality &&
    a.grayscale === b.grayscale &&
    a.maxWidth === b.maxWidth &&
    a.fallbackToOrigin === b.fallbackToOrigin &&
    domainKey(a.excludeDomains) === domainKey(b.excludeDomains);

  // content.js marks failed-proxy restores with data-bw-restored; those
  // originals must pass through both worlds untouched, never re-proxied.
  const isRestored = el =>
    !!el && el.nodeType === 1 && el.getAttribute?.("data-bw-restored") === "1";

  function sameResolvedUrl(a, b) {
    const ua = safeURL(a);
    const ub = safeURL(b);
    if (ua && ub && /^https?:$/.test(ua.protocol) && /^https?:$/.test(ub.protocol)) {
      return ua.href === ub.href;
    }
    return String(a ?? "") === String(b ?? "");
  }

  // A failed proxy restore is sticky only for the failed source. Ignore an
  // immediate lazy-loader retry of that proxy URL, allow the restored original
  // through unchanged, and clear the state when the page assigns a new source.
  function restoredAssignment(el, kind, value) {
    if (!isRestored(el)) return "continue";
    const src = kind === "src";
    const text = String(value ?? "");
    const failed = el.getAttribute(src ? FAILED_PROXY_SRC_ATTR : FAILED_PROXY_SRCSET_ATTR);
    if (failed && (src ? sameResolvedUrl(text, failed) : text === failed)) return "ignore";

    const restored = el.getAttribute(src ? RESTORED_SRC_ATTR : RESTORED_SRCSET_ATTR);
    const current = el.getAttribute(kind);
    const expected = restored ?? current ?? "";
    const matches = src ? sameResolvedUrl(text, expected) : text === expected;
    if (matches) return "keep";

    for (const attr of RESTORED_STATE_ATTRS) el.removeAttribute(attr);
    return "continue";
  }

  function rememberOriginal(el, src, srcset) {
    if (!opts?.fallbackToOrigin || !el || el.nodeType !== 1) return;
    if (src && el.getAttribute(ORIGINAL_SRC_ATTR) !== src) setAttr.call(el, ORIGINAL_SRC_ATTR, src);
    if (srcset && el.getAttribute(ORIGINAL_SRCSET_ATTR) !== srcset) setAttr.call(el, ORIGINAL_SRCSET_ATTR, srcset);
  }

  function clearPendingPreload(el) {
    if (!el.hasAttribute(PENDING_PRELOAD_HREF_ATTR) &&
        !el.hasAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR)) {
      pending.delete(el);
    }
  }

  function buildProxyUrl(orig) {
    const cached = proxyUrlCache.get(orig);
    if (cached) {
      // LRU touch: re-insert so frequently-hit URLs are evicted last (Map
      // preserves insertion order). FIFO evicted the oldest insert, which
      // punished exactly the hot keys on long-lived pages.
      proxyUrlCache.delete(orig);
      proxyUrlCache.set(orig, cached);
      return cached;
    }

    const { base, quality, maxWidth, grayscale } = proxyConfig;
    const parts = [
      "url=" + encodeURIComponent(orig),
      "q=" + quality
    ];

    if (maxWidth) {
      // Preserve aspect ratio and never enlarge smaller images. dpr was clamped
      // in applyOpts() so high-density displays don't double-request pixels.
      parts.push("w=" + maxWidth, "fit=inside", "we=1", "dpr=" + dpr);
    }

    if (grayscale) {
      parts.push("filt=greyscale");
    }

    // Keep animated/multi-page inputs intact and use a longer browser cache to
    // reduce repeat downloads while retaining a bounded freshness window.
    // default=1 asks wsrv.nl to fall back to the source image if its own
    // processing fails; the browser-side data-bw-restored fallback is a second
    // fallback for a failed proxy image request.
    parts.push("maxage=1d", "page=-1", "n=-1", "default=1", "output=webp");

    const result = base + "?" + parts.join("&");
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
    // preloadObserver is always assigned before this runs (stop() is only
    // reachable from the pagehide listener registered at the end of the IIFE),
    // and disconnect()/Map.clear()/Set.clear() cannot throw per spec.
    preloadObserver.disconnect();
    pending.clear();
    proxyUrlCache.clear();
    srcsetCache = new WeakMap();
  }

  // Flush image/source/link elements queued while settings were loading.
  function flushPending() {
    if (destroyed) return;
    for (const el of pending) {
      pending.delete(el);
      try {
        // Image-preload links queued with a stashed href or imagesrcset value.
        if (el instanceof HTMLLinkElement) { processPreloadLink(el); continue; }
        // <img>.loading values set before settings were known.
        if (el instanceof HTMLImageElement && loadingDesc && loadingDesc.set) {
          const pendingLoading = el.dataset.bhPendingLoading;
          if (pendingLoading !== undefined) {
            el.removeAttribute("data-bh-pending-loading");
            if (!opts.enabled || pageExcluded) {
              loadingDesc.set.call(el, pendingLoading);
            } else {
              loadingDesc.set.call(el, pendingLoading === "eager" ? "eager" : "lazy");
            }
          }
        }
        // A queued <source> may have been moved out of <picture> while the
        // settings read was pending. Re-check eligibility once at flush time
        // (before either pending attribute is processed) so a now-media
        // source is never sent through the image proxy.
        const isPictureSource = !(el instanceof HTMLSourceElement) ||
          el.parentElement?.tagName === "PICTURE";
        const pendingSrc = el.dataset.bhPendingSrc;
        if (pendingSrc !== undefined) {
          el.removeAttribute("data-bh-pending-src");
          if (!isPictureSource) {
            setAttr.call(el, "src", pendingSrc);
          } else {
            // applyOpts() ran before this flush (ready === true), so decideUrl()
            // cannot return null here.
            const decided = decideUrl(pendingSrc, el);
            if (decided !== pendingSrc) rememberResolvedOriginal(el, pendingSrc);
            if (el instanceof HTMLImageElement) nativeSetSrc(el, decided);
            else setAttr.call(el, "src", decided); // <picture><source> pending src
          }
        }
        const pendingSrcset = el.dataset.bhPendingSrcset;
        if (pendingSrcset !== undefined) {
          el.removeAttribute("data-bh-pending-srcset");
          // A queued picture source may also have moved into a media element
          // before settings arrived. Keep its srcset untouched just like src.
          const rewritten = isPictureSource ? rewriteSrcset(pendingSrcset, el) : pendingSrcset;
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
      const parsed = JSON.parse(event.detail);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const next = { ...DEFAULTS, ...parsed };
      // Identical settings snapshots are common during mirror refreshes and
      // storage storms. Re-applying them would clear both URL caches and
      // rebuild derived state without changing behavior.
      if (ready && sameOpts(next, opts)) return;
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
  const removeAttr = Element.prototype.removeAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "src") : null;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;
  const loadingDesc = Object.getOwnPropertyDescriptor(imgProto, "loading");
  const linkProto = HTMLLinkElement.prototype;
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto, "href");
  const linkRelDesc = Object.getOwnPropertyDescriptor(linkProto, "rel");
  const linkRelListDesc = Object.getOwnPropertyDescriptor(linkProto, "relList");
  const tokenListProto = DOMTokenList.prototype;
  const tokenListValueDesc = Object.getOwnPropertyDescriptor(tokenListProto, "value");
  const relListProbe = document.createElement("link").relList;
  const relListOwners = new WeakMap();
  const linkAsDesc = Object.getOwnPropertyDescriptor(linkProto, "as");
  const linkTypeDesc = Object.getOwnPropertyDescriptor(linkProto, "type");
  const linkImageSrcsetDesc = Object.getOwnPropertyDescriptor(linkProto, "imageSrcset");

  function nativeSetSrc(el, v) { srcDesc.set.call(el, v); }
  function nativeSetSrcset(el, v) { srcsetDesc?.set?.call(el, v); }
  function nativeSourceSetSrc(el, v) { sourceSrcDesc?.set?.call(el, v); }
  function nativeSourceSetSrcset(el, v) { sourceSrcsetDesc?.set?.call(el, v); }

  // A page can replace or remove an attribute after an earlier assignment was
  // parked. Clear only that attribute's pending value; retain the element in
  // the queue while any other pending image/loading operation remains.
  const PENDING_IMAGE_ATTRS = [
    'data-bh-pending-src', 'data-bh-pending-srcset', 'data-bh-pending-loading'
  ];
  function clearPending(el, kind) {
    const attr = `data-bh-pending-${kind}`;
    // Most assignments arrive after settings are ready and have no queued
    // state. Keep that hot path to one attribute check instead of scanning all
    // pending markers for every image/srcset/loading write.
    if (!el.hasAttribute(attr) && !pending.has(el)) return;
    if (el.hasAttribute(attr)) removeAttr.call(el, attr);
    if (!PENDING_IMAGE_ATTRS.some(name => el.hasAttribute(name)) &&
        !el.hasAttribute(PENDING_PRELOAD_HREF_ATTR) &&
        !el.hasAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR)) {
      pending.delete(el);
    }
  }

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
  function skipAbsolute(urlObj) {
    if (urlObj.hostname === proxyHost || SVG_URL_RE.test(urlObj.href) ||
        ICON_URL_RE.test(urlObj.href) || isTiny(urlObj.href)) return true;
    return excludedHost(urlObj.hostname);
  }

  function rewriteSrcset(ss, el, remember = true) {
    if (!ss) return ss;
    if (!opts?.enabled || pageExcluded) return ss;
    if (isRestored(el)) return ss;
    // srcset on <source> is an image candidate only inside <picture>. Media
    // source elements can carry unrelated src metadata and must not be proxied.
    if (el instanceof HTMLSourceElement &&
        !(el.parentElement && el.parentElement.tagName === "PICTURE")) return ss;

    const cached = srcsetCache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;

    const cands = parseSrcset(ss);
    let touched = false;
    const parts = cands.map(({ url, desc }) => {
      const urlObj = safeURL(url);
      if (!urlObj || !/^https?:$/.test(urlObj.protocol) || skipAbsolute(urlObj)) {
        return url + (desc ? " " + desc : "");
      }
      touched = true;
      return buildProxyUrl(urlObj.href) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    if (output !== ss && remember) rememberOriginal(el, null, ss);
    srcsetCache.set(el, { input: ss, output });
    return output;
  }

  // Shared URL decision for <img>/<source> src and image-preload hrefs
  // (pass no element for the preload case). Returns the original URL, null
  // when settings are not known yet (the caller parks the element), or the
  // proxy URL.
  function decideUrl(original, el) {
    // img.src = "" is used by pages to clear an image; never proxy the page URL.
    if (!original || !String(original).trim()) return original;
    if (el && isRestored(el)) return original;
    const urlObj = safeURL(original);
    if (!urlObj || !/^https?:$/.test(urlObj.protocol)) return original;
    // Never proxy a URL that is already produced by wsrv.nl. This is important
    // because content.js also rewrites parser-created images; without this guard
    // the prehook wraps the wsrv URL a second time.
    if (urlObj.hostname === proxyHost) return original;
    if (!ready || !opts) return null; // queue until settings are known
    if (!opts.enabled) return original;
    if (pageExcluded) return original;
    if (skipAbsolute(urlObj)) return original;
    return buildProxyUrl(urlObj.href);
  }

  // Remember the resolved absolute URL when a rewrite actually happened;
  // falls back to the raw string for non-HTTP(S) inputs.
  function rememberResolvedOriginal(el, s) {
    const u = safeURL(s);
    rememberOriginal(el, (u && /^https?:$/.test(u.protocol) && u.href) || s, null);
  }

  // ── <link rel="preload" as="image"> support ──────────────────────────────────
  // A preload hint makes the browser download the full-resolution image URL
  // directly — bypassing every <img> patch. We therefore rewrite the preload's
  // href to the proxy URL (or stash and blank it until settings are known).
  const isImagePreloadLink = el => {
    if (!(el instanceof HTMLLinkElement) || !/(?:^|\s)preload(?:\s|$)/i.test(el.rel || "")) {
      return false;
    }
    const as = String(el.getAttribute("as") || "").toLowerCase();
    const type = String(el.getAttribute("type") || "");
    // An image MIME type must not override an explicit non-image `as` value.
    return as === "image" || (!as && /^image\//i.test(type));
  };

  function restorePreloadHref(el) {
    const original = el.getAttribute(ORIGINAL_PRELOAD_HREF_ATTR) ||
      el.getAttribute(PENDING_PRELOAD_HREF_ATTR);
    if (original) {
      const current = el.getAttribute("href") || "";
      const applied = el.getAttribute(APPLIED_PRELOAD_HREF_ATTR);
      // Do not overwrite a URL the page deliberately assigned after changing the
      // link's purpose. Restore only our placeholder or the exact proxy URL we wrote.
      if (current === "about:blank" || (applied && current === applied)) {
        setAttr.call(el, "href", original);
      }
    }
    el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
    el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
    el.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
    clearPendingPreload(el);
  }

  function restorePreloadImagesrcset(el) {
    const original = el.getAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR) ||
      el.getAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
    if (original) {
      const current = el.getAttribute("imagesrcset") || "";
      const applied = el.getAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      // The empty value is our temporary parking placeholder. Otherwise restore
      // only the exact responsive candidate list that this hook rewrote.
      if (current === "" || (applied && current === applied)) {
        setAttr.call(el, "imagesrcset", original);
      }
    }
    el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
    el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
    el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
    clearPendingPreload(el);
  }

  function applyPreloadImagesrcset(el, original) {
    const current = el.getAttribute("imagesrcset") || "";
    // An empty assignment is a clear operation, not deferred work. Do not
    // leave an empty pending marker in the queue while settings are loading.
    if (!original) {
      el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      if (current !== original) setAttr.call(el, "imagesrcset", original);
      clearPendingPreload(el);
      return;
    }
    if (!ready || !opts) {
      setAttr.call(el, PENDING_PRELOAD_IMAGESRCSET_ATTR, original);
      el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      pending.add(el);
      if (current !== "") setAttr.call(el, "imagesrcset", "");
      return;
    }

    const rewritten = rewriteSrcset(original, el, false);
    el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
    if (rewritten !== original) {
      setAttr.call(el, ORIGINAL_PRELOAD_IMAGESRCSET_ATTR, original);
      setAttr.call(el, APPLIED_PRELOAD_IMAGESRCSET_ATTR, rewritten);
    } else {
      el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
    }
    if (current !== rewritten) setAttr.call(el, "imagesrcset", rewritten);
    clearPendingPreload(el);
  }

  function applyPreloadHref(el, original) {
    const current = el.getAttribute("href") || "";
    const decided = decideUrl(original, null);
    if (decided === null) {
      // Write through the captured native setter: the patched setAttribute
      // would only run its intercept-name gate and bail for this attribute.
      setAttr.call(el, PENDING_PRELOAD_HREF_ATTR, original);
      el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
      pending.add(el);
      if (current !== "about:blank") setAttr.call(el, "href", "about:blank");
      return;
    }

    el.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
    clearPendingPreload(el);
    if (decided !== original) {
      setAttr.call(el, ORIGINAL_PRELOAD_HREF_ATTR, original);
      setAttr.call(el, APPLIED_PRELOAD_HREF_ATTR, decided);
    } else {
      el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
    }
    if (current !== decided) setAttr.call(el, "href", decided);
  }

  function willBeImagePreloadLink(el, name, value) {
    const rel = name === "rel" ? String(value) : (el.getAttribute("rel") || "");
    const as = name === "as" ? String(value).toLowerCase() :
      String(el.getAttribute("as") || "").toLowerCase();
    const type = name === "type" ? String(value) : String(el.getAttribute("type") || "");
    return /(?:^|\s)preload(?:\s|$)/i.test(rel) &&
      (as === "image" || (!as && /^image\//i.test(type)));
  }

  // Called from the setAttribute patch, the link.href property patch, the
  // MutationObserver, and flushPending. Idempotent: re-running it on a link
  // whose href is already a proxy URL is a no-op.
  function processPreloadLink(el) {
    try {
      if (destroyed) return;
      if (!(el instanceof HTMLLinkElement)) return;
      if (!isImagePreloadLink(el)) {
        restorePreloadHref(el);
        restorePreloadImagesrcset(el);
        return;
      }

      const currentHref = el.getAttribute("href");
      if (currentHref === null) {
        // The page explicitly removed href. A stale parked/saved value must
        // not turn that removal into a later preload request. imagesrcset can
        // independently provide the responsive preload URL, so keep handling it.
        removeAttr.call(el, ORIGINAL_PRELOAD_HREF_ATTR);
        removeAttr.call(el, APPLIED_PRELOAD_HREF_ATTR);
        removeAttr.call(el, PENDING_PRELOAD_HREF_ATTR);
      } else {
        const stashedHref = el.getAttribute(PENDING_PRELOAD_HREF_ATTR);
        const savedHref = el.getAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
        // decideUrl must see the ORIGINAL URL, never "about:blank".
        const originalHref = stashedHref || savedHref || currentHref;
        if (originalHref && originalHref !== "about:blank") {
          applyPreloadHref(el, originalHref);
        }
      }

      const currentImagesrcset = el.getAttribute("imagesrcset");
      if (currentImagesrcset === null) {
        removeAttr.call(el, ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
        removeAttr.call(el, APPLIED_PRELOAD_IMAGESRCSET_ATTR);
        removeAttr.call(el, PENDING_PRELOAD_IMAGESRCSET_ATTR);
      } else if (currentImagesrcset ||
                 el.hasAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR) ||
                 el.hasAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR)) {
        const stashed = el.getAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
        const saved = el.getAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
        const original = stashed || saved || currentImagesrcset;
        if (original) applyPreloadImagesrcset(el, original);
      }
      clearPendingPreload(el);
    } catch {}
  }

  // ── Patch <img>.src ────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      // Convert before fail-open handling so Web IDL TypeErrors (notably for
      // Symbol values) propagate instead of being replaced with an empty URL.
      const s = toUSVString(value);
      const restored = restoredAssignment(this, "src", s);
      if (restored === "ignore") return;
      if (restored === "keep") { nativeSetSrc(this, s); return; }
      try {
        const decided = decideUrl(s, this);
        if (decided === null) {
          this.dataset.bhPendingSrc = s;
          pending.add(this);
          nativeSetSrc(this, "about:blank");
        } else {
          clearPending(this, "src");
          if (decided !== s) rememberResolvedOriginal(this, s);
          nativeSetSrc(this, decided);
        }
      } catch {
        clearPending(this, "src");
        if (ready && opts?.enabled && isHttp(s)) {
          nativeSetSrc(this, "about:blank");
        } else {
          nativeSetSrc(this, s);
        }
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
        // HTMLImageElement.srcset is a USVString IDL attribute.
        const v = toUSVString(value);
        const restored = restoredAssignment(this, "srcset", v);
        if (restored === "ignore") return;
        if (restored === "keep") { nativeSetSrcset(this, v); return; }
        try {
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSetSrcset(this, "");
          } else {
            clearPending(this, "srcset");
            if (!opts.enabled) nativeSetSrcset(this, v);
            else nativeSetSrcset(this, rewriteSrcset(v, this));
          }
        } catch {
          clearPending(this, "srcset");
          if (ready && opts?.enabled) nativeSetSrcset(this, "");
          else nativeSetSrcset(this, v);
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
        // HTMLSourceElement.srcset is a USVString IDL attribute.
        const v = toUSVString(value);
        const restored = restoredAssignment(this, "srcset", v);
        if (restored === "ignore") return;
        if (restored === "keep") { nativeSourceSetSrcset(this, v); return; }
        // Media <source> elements are not image candidates; keep them untouched
        // even while settings are still loading.
        if (!(this.parentElement && this.parentElement.tagName === "PICTURE")) {
          clearPending(this, "srcset");
          nativeSourceSetSrcset(this, v);
          return;
        }
        try {
          if (!ready || !opts) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSourceSetSrcset(this, "");
          } else {
            clearPending(this, "srcset");
            if (!opts.enabled) nativeSourceSetSrcset(this, v);
            else nativeSourceSetSrcset(this, rewriteSrcset(v, this));
          }
        } catch {
          clearPending(this, "srcset");
          if (ready && opts?.enabled) nativeSourceSetSrcset(this, "");
          else nativeSourceSetSrcset(this, v);
        }
      }
    });
  }

  // ── Patch <source>.src inside <picture> ───────────────────────────────────
  // Property assignment bypasses Element.prototype.setAttribute. Only picture
  // sources are image candidates; media <source> src values stay untouched.
  if (sourceProto && sourceSrcDesc && sourceSrcDesc.set) {
    Object.defineProperty(sourceProto, "src", {
      configurable: true,
      enumerable: sourceSrcDesc.enumerable,
      get: sourceSrcDesc.get,
      set(value) {
        const s = toUSVString(value);
        const restored = restoredAssignment(this, "src", s);
        if (restored === "ignore") return;
        if (restored === "keep") { nativeSourceSetSrc(this, s); return; }
        try {
          if (!(this.parentElement && this.parentElement.tagName === "PICTURE")) {
            clearPending(this, "src");
            nativeSourceSetSrc(this, s);
            return;
          }
          const decided = decideUrl(s, this);
          if (decided === null) {
            this.dataset.bhPendingSrc = s;
            pending.add(this);
            nativeSourceSetSrc(this, "about:blank");
            return;
          }
          clearPending(this, "src");
          if (decided !== s) rememberResolvedOriginal(this, s);
          nativeSourceSetSrc(this, decided);
        } catch {
          clearPending(this, "src");
          if (ready && opts?.enabled && isHttp(s)) nativeSourceSetSrc(this, "about:blank");
          else nativeSourceSetSrc(this, s);
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
        const v = toDOMString(value).toLowerCase();
        try {
          if (!ready || !opts) {
            this.dataset.bhPendingLoading = v;
            pending.add(this);
            loadingDesc.set.call(this, "lazy");
          } else {
            clearPending(this, "loading");
            if (!opts.enabled || pageExcluded) loadingDesc.set.call(this, v);
            else loadingDesc.set.call(this, v === "eager" ? "eager" : "lazy");
          }
        } catch {
          clearPending(this, "loading");
          loadingDesc.set.call(this, v);
        }
      }
    });
  }

  function preparePreloadActivation(el, name, value) {
    if (!willBeImagePreloadLink(el, name, value)) return;
    const href = el.getAttribute(PENDING_PRELOAD_HREF_ATTR) ||
      el.getAttribute(ORIGINAL_PRELOAD_HREF_ATTR) || el.getAttribute("href");
    if (href && href !== "about:blank") applyPreloadHref(el, href);

    const imagesrcset = el.getAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR) ||
      el.getAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR) || el.getAttribute("imagesrcset");
    if (imagesrcset) applyPreloadImagesrcset(el, imagesrcset);
  }

  // DOMTokenList methods mutate link.rel without passing through the rel
  // property setter or Element.setAttribute. Remember each native relList and
  // preflight its resulting token string before the browser can activate a
  // newly-added image preload.
  if (linkRelListDesc?.get) {
    Object.defineProperty(linkProto, "relList", {
      configurable: true,
      enumerable: linkRelListDesc.enumerable,
      get() {
        const list = linkRelListDesc.get.call(this);
        if (this instanceof HTMLLinkElement) relListOwners.set(list, this);
        return list;
      }
    });
  }

  function toDOMString(value) {
    // Web IDL DOMString conversion throws for Symbol, unlike String(Symbol).
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }

  function toUSVString(value) {
    // URL-reflecting DOM properties use USVString: replace lone UTF-16
    // surrogates with U+FFFD after the same Symbol-safe conversion.
    return toDOMString(value).replace(/[\uD800-\uDFFF]/g, (unit, index, text) => {
      const code = unit.charCodeAt(0);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = text.charCodeAt(index + 1);
        return next >= 0xDC00 && next <= 0xDFFF ? unit : "\uFFFD";
      }
      const previous = text.charCodeAt(index - 1);
      return previous >= 0xD800 && previous <= 0xDBFF ? unit : "\uFFFD";
    });
  }

  function patchRelListMutator(name) {
    const descriptor = Object.getOwnPropertyDescriptor(tokenListProto, name);
    if (!descriptor?.value || !descriptor.configurable || !tokenListValueDesc?.get ||
        !tokenListValueDesc?.set) return;
    Object.defineProperty(tokenListProto, name, {
      ...descriptor,
      value: function(...args) {
        const link = relListOwners.get(this);
        if (!link) return descriptor.value.apply(this, args);

        // Convert caller-supplied values once, just as the native Web IDL
        // method does. Reusing these strings for the probe and real list avoids
        // invoking user-defined toString() methods twice.
        let normalizedArgs;
        if (name === "add" || name === "remove") {
          normalizedArgs = args.map(toDOMString);
        } else if (name === "replace") {
          if (args.length < 2) return descriptor.value.apply(this, args);
          normalizedArgs = args.slice();
          normalizedArgs[0] = toDOMString(args[0]);
          normalizedArgs[1] = toDOMString(args[1]);
        } else {
          if (args.length < 1) return descriptor.value.apply(this, args);
          normalizedArgs = args.slice();
          normalizedArgs[0] = toDOMString(args[0]);
          if (args.length > 1) normalizedArgs[1] = !!args[1];
        }

        // Run the same native operation against a detached probe to obtain the
        // normalized next value and preserve the native token-validation rules.
        let predictedRel = null;
        try {
          tokenListValueDesc.set.call(relListProbe, tokenListValueDesc.get.call(this));
          descriptor.value.apply(relListProbe, normalizedArgs);
          predictedRel = tokenListValueDesc.get.call(relListProbe);
        } catch {}
        if (predictedRel !== null) {
          try { preparePreloadActivation(link, "rel", predictedRel); } catch {}
        }

        const result = descriptor.value.apply(this, normalizedArgs);
        processPreloadLink(link);
        return result;
      }
    });
  }

  for (const method of ["add", "remove", "replace", "toggle"]) {
    patchRelListMutator(method);
  }

  if (tokenListValueDesc?.get && tokenListValueDesc?.set && tokenListValueDesc.configurable) {
    Object.defineProperty(tokenListProto, "value", {
      ...tokenListValueDesc,
      set(value) {
        const link = relListOwners.get(this);
        if (!link) return tokenListValueDesc.set.call(this, value);

        // Convert once before preflight so objects with custom stringifiers
        // observe the same single conversion as a native DOMTokenList setter.
        const normalizedValue = toDOMString(value);
        let predictedRel = null;
        try {
          tokenListValueDesc.set.call(relListProbe, normalizedValue);
          predictedRel = tokenListValueDesc.get.call(relListProbe);
        } catch {}
        if (predictedRel !== null) {
          try { preparePreloadActivation(link, "rel", predictedRel); } catch {}
        }

        tokenListValueDesc.set.call(this, normalizedValue);
        processPreloadLink(link);
      }
    });
  }

  // ── Patch <link> properties for image preloads ─────────────────────────────
  // Direct property assignments bypass Element.prototype.setAttribute.
  if (linkHrefDesc && linkHrefDesc.set) {
    Object.defineProperty(linkProto, "href", {
      configurable: true,
      enumerable: linkHrefDesc.enumerable,
      get: linkHrefDesc.get,
      set(value) {
        const s = toUSVString(value);
        try {
          if (isImagePreloadLink(this)) {
            applyPreloadHref(this, s);
            return;
          }
        } catch {}
        linkHrefDesc.set.call(this, s);
      }
    });
  }

  for (const [name, descriptor] of [["rel", linkRelDesc], ["as", linkAsDesc], ["type", linkTypeDesc]]) {
    if (!descriptor?.set) continue;
    Object.defineProperty(linkProto, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        const s = toDOMString(value);
        try { preparePreloadActivation(this, name, s); } catch {}
        descriptor.set.call(this, s);
        processPreloadLink(this);
      }
    });
  }

  if (linkImageSrcsetDesc?.set) {
    Object.defineProperty(linkProto, "imageSrcset", {
      configurable: true,
      enumerable: linkImageSrcsetDesc.enumerable,
      get: linkImageSrcsetDesc.get,
      set(value) {
        // HTMLLinkElement.imageSrcset is a USVString IDL attribute.
        const s = toUSVString(value);
        try {
          if (isImagePreloadLink(this)) {
            applyPreloadImagesrcset(this, s);
            return;
          }
        } catch {}
        linkImageSrcsetDesc.set.call(this, s);
      }
    });
  }

  // ── Patch Element.prototype.setAttribute for attribute-based assignment ────
  Element.prototype.setAttribute = function(name, value) {
    if (destroyed) return setAttr.call(this, name, value);

    // DOMString-convert the name once. Pass the resulting primitive through to
    // the native method so custom name stringifiers are never invoked twice.
    const attrName = toDOMString(name);
    const n = attrName.toLowerCase();

    // setAttribute is among the hottest DOM calls on a page. Only eight
    // attribute names are intercepted, so unrelated values remain for native
    // Web IDL conversion and return before any instanceof test runs.
    if (n !== "src" && n !== "srcset" && n !== "loading" && n !== "href" &&
        n !== "rel" && n !== "as" && n !== "type" && n !== "imagesrcset") {
      return setAttr.call(this, attrName, value);
    }

    // Convert intercepted values before entering fail-open handling. This
    // preserves the native DOMString TypeError for Symbols rather than
    // swallowing it or replacing the input with an empty string.
    if (this instanceof HTMLImageElement && n === "loading") {
      const v = toDOMString(value).toLowerCase();
      if (!ready || !opts) {
        this.dataset.bhPendingLoading = v;
        pending.add(this);
        return setAttr.call(this, attrName, "lazy");
      }
      clearPending(this, "loading");
      if (!opts.enabled || pageExcluded) return setAttr.call(this, attrName, v);
      return setAttr.call(this, attrName, v === "eager" ? "eager" : "lazy");
    }

    if (this instanceof HTMLLinkElement && n === "imagesrcset") {
      if (isImagePreloadLink(this)) {
        applyPreloadImagesrcset(this, toDOMString(value));
        return;
      }
      return setAttr.call(this, attrName, value);
    }

    if (this instanceof HTMLLinkElement &&
        (n === "href" || n === "rel" || n === "as" || n === "type")) {
      const incoming = toDOMString(value);
      if (n === "href" && isImagePreloadLink(this)) {
        // Decide before the raw href reaches the browser; setting it first can
        // start an unoptimized preload before processPreloadLink cancels it.
        applyPreloadHref(this, incoming);
        return;
      }

      if (n !== "href") {
        try { preparePreloadActivation(this, n, incoming); } catch {}
      }
      setAttr.call(this, attrName, incoming);
      processPreloadLink(this);
      return;
    }

    // Remaining names: only src/srcset on <img>/<source> are intercepted
    // (loading and link attributes were fully handled above).
    if (n !== "src" && n !== "srcset") return setAttr.call(this, attrName, value);
    if (this instanceof HTMLImageElement) {
      const incoming = toDOMString(value);
      try {
        const restored = restoredAssignment(this, n, incoming);
        if (restored === "ignore") return;
        if (restored === "keep") return setAttr.call(this, attrName, incoming);
        if (n === "src") {
          const decided = decideUrl(incoming, this);
          if (decided === null) {
            this.dataset.bhPendingSrc = incoming;
            pending.add(this);
            return setAttr.call(this, attrName, "about:blank");
          }
          clearPending(this, "src");
          if (decided !== incoming) rememberResolvedOriginal(this, incoming);
          return setAttr.call(this, attrName, decided);
        }
        if (!ready || !opts) {
          this.dataset.bhPendingSrcset = incoming;
          pending.add(this);
          return setAttr.call(this, attrName, "");
        }
        clearPending(this, "srcset");
        if (!opts.enabled) return setAttr.call(this, attrName, incoming);
        return setAttr.call(this, attrName, rewriteSrcset(incoming, this));
      } catch (error) {
        // If an eligible image rewrite unexpectedly fails, do not fall through
        // to the original HTTP(S) value while protection is active. Conversion
        // errors have already happened above and still propagate natively.
        if (ready && opts?.enabled) {
          if (n === "src" || n === "srcset") clearPending(this, n);
          if (n === "src") return setAttr.call(this, attrName, "about:blank");
          return setAttr.call(this, attrName, "");
        }
        throw error;
      }
    }

    if (this instanceof HTMLSourceElement) {
      // Non-picture <source> elements are media sources. Pass them through
      // before conversion/parking so their values are never intercepted.
      if (!(this.parentElement && this.parentElement.tagName === "PICTURE")) {
        const passthrough = toDOMString(value);
        clearPending(this, n);
        return setAttr.call(this, attrName, passthrough);
      }

      const incoming = toDOMString(value);
      try {
        const restored = restoredAssignment(this, n, incoming);
        if (restored === "ignore") return;
        if (restored === "keep") return setAttr.call(this, attrName, incoming);

        if (n === "src") {
          const decided = decideUrl(incoming, this);
          if (decided === null) {
            this.dataset.bhPendingSrc = incoming;
            pending.add(this);
            return setAttr.call(this, attrName, "about:blank");
          }
          clearPending(this, "src");
          if (decided !== incoming) rememberResolvedOriginal(this, incoming);
          return setAttr.call(this, attrName, decided);
        }

        if (!ready || !opts) {
          this.dataset.bhPendingSrcset = incoming;
          pending.add(this);
          return setAttr.call(this, attrName, "");
        }
        clearPending(this, "srcset");
        if (!opts.enabled) return setAttr.call(this, attrName, incoming);
        return setAttr.call(this, attrName, rewriteSrcset(incoming, this));
      } catch (error) {
        const protectedPictureSource =
          this.parentElement?.tagName === "PICTURE" && (n === "src" || n === "srcset");
        if (ready && opts?.enabled && protectedPictureSource) {
          clearPending(this, n);
          if (n === "src") return setAttr.call(this, attrName, "about:blank");
          return setAttr.call(this, attrName, "");
        }
        throw error;
      }
    }

    return setAttr.call(this, attrName, value);
  };

  // ── MutationObserver for image preload links ───────────────────────────────
  // The HTML parser sets attributes natively, bypassing our JS patches. Watch
  // for inserted links and rel/as/type/href/imagesrcset changes.
  preloadObserver = new MutationObserver(mutations => {
    if (destroyed) return;
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n instanceof HTMLLinkElement) processPreloadLink(n);
          if (n.querySelectorAll) {
            n.querySelectorAll('link[rel~="preload" i]').forEach(processPreloadLink);
          }
        });
      } else if (m.target instanceof HTMLLinkElement) {
        // The attribute filter is document-wide (<a href>, <input type>, ...);
        // only <link> records can matter.
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
    attributeFilter: ["href", "rel", "as", "type", "imagesrcset"]
  });

  // Free the outgoing page immediately on normal navigation. Skip persisted
  // pageshow/bfcache restores so back/forward keeps working.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });

})();
