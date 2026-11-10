// Bandwidth Saver — content script
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
//  Image interception is split across two execution worlds:
//
//  Layer 1 — prehook.js (document_start, synchronous, MAIN world)
//    Patches native image/link DOM properties and setAttribute BEFORE page
//    JavaScript runs. It cannot use chrome.* APIs.
//
//  Layer 2 — THIS FILE (document_start, isolated world)
//    Reads settings from extension storage, publishes a JSON-only settings
//    event to the MAIN world, and handles parser-created/dynamic DOM resources.
//    Catches three categories that prehook cannot:
//
//    A) HTML-parsed <img src="..."> attributes — the browser's C++ HTML parser
//       sets src natively, bypassing our JS property-setter patch. By the time
//       this script's storage callback fires (~5–50ms), the browser may have
//       already started fetching the original image. Rewriting src here causes
//       the browser to cancel the in-flight original request and fetch from the
//       proxy instead. A tiny amount of the original image's bytes may already
//       be in flight — this is unavoidable in MV3 (webRequestBlocking was
//       removed). The alternative (DNR redirect) cannot URL-encode the captured
//       URL, producing malformed proxy requests for any URL with query params.
//
//    B) Lazy-load data attributes (data-src, data-lazy-src…) — rewritten so
//       that when a lazy-loader later does img.src = img.dataset.src, prehook
//       receives the proxy URL and the browser never fetches the original.
//
//    C) Inline CSS background-image — rewritten via el.style.backgroundImage.
//       Best-effort: stylesheet-defined backgrounds may already be loading.
//
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  // Fixed image proxy used by Bandwidth Saver.
  const WSRV_PROXY = "https://wsrv.nl/";
  const SETTINGS_EVENT = "__BANDWIDTH_SAVER_SETTINGS__";
  // Minimal fallback used only when the local settings mirror is unavailable.
  // KEEP IN SYNC with defaults.js, prehook.js and service-worker.js.
  const DEFAULTS = {
    enabled: true, saveData: true, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: "", fallbackToOrigin: true
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  let opts = null;
  let proxyConfig = null;
  // Clamped once per applyOpts(); devicePixelRatio only changes on zoom or
  // monitor moves, so it must not be re-computed on every uncached URL build.
  let dpr = 1;
  let destroyed = false;      // set on real navigation away from this document
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  // Keep each lazy attribute's own original value. A picture <source> can be
  // repurposed as a media source, in which case every rewritten data-* URL must
  // be restored independently without guessing which attribute was active.
  const originalLazyAttributes = new WeakMap();
  const doneBg = new WeakSet();
  // style attribute value right after our own background rewrite, so the
  // mutation record that write triggers is not re-parsed.
  const ownStyle = new WeakMap();
  const ORIGINAL_SRC_ATTR = "data-bw-original-src";
  const ORIGINAL_SRCSET_ATTR = "data-bw-original-srcset";
  const ORIGINAL_DATA_SRCSET_ATTR = "data-bw-original-data-srcset";
  const RESTORED_ATTR = "data-bw-restored";
  const RESTORED_SRC_ATTR = "data-bw-restored-src";
  const RESTORED_SRCSET_ATTR = "data-bw-restored-srcset";
  const FAILED_PROXY_SRC_ATTR = "data-bw-failed-proxy-src";
  const FAILED_PROXY_SRCSET_ATTR = "data-bw-failed-proxy-srcset";
  const ORIGINAL_PRELOAD_HREF_ATTR = "data-bw-original-preload-href";
  const APPLIED_PRELOAD_HREF_ATTR = "data-bw-applied-preload-href";
  const ORIGINAL_PRELOAD_IMAGESRCSET_ATTR = "data-bw-original-preload-imagesrcset";
  const APPLIED_PRELOAD_IMAGESRCSET_ATTR = "data-bw-applied-preload-imagesrcset";
  // Shared pattern for inline background-image url(...) tokens; safe to reuse
  // (String.replace always starts global regexes from index 0 and resets
  // lastIndex afterwards).
  const BG_URL_RE = /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi;
  // Cheap pre-test: only a style value containing url( can carry a background
  // image that rewriteBg() would change.
  const STYLE_URL_HINT_RE = /url\(/i;
  // Written by prehook.js (MAIN world) while preload href/imagesrcset values
  // are parked; the isolated layer also clears these stashes on restore.
  const PENDING_PRELOAD_HREF_ATTR = "data-bh-preload-href";
  const PENDING_PRELOAD_IMAGESRCSET_ATTR = "data-bh-preload-imagesrcset";
  let excludedDomains = new Set();
  // Single source of truth: derive from WSRV_PROXY so a proxy change only
  // ever needs one edit.
  const proxyHost = new URL(WSRV_PROXY).hostname;
  // location.hostname is always ASCII-lowercase per the WHATWG URL spec.
  const pageHost = location.hostname;
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  const lazyAttrSet = new Set(LAZY_ATTRS);
  // Cache the last srcset transformation per element. Dynamic sites often
  // write the same srcset repeatedly while hydrating/re-rendering.
  let srcsetCache = new WeakMap();
  let dataSrcsetCache = new WeakMap();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  // Parse once: callers keep the returned URL object and reuse it for
  // shouldSkip(), buildProxyUrl(u.href) and rememberOriginal() — the string
  // form is never re-parsed.
  const resolveImage = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved : null;
  };

  // Conservative URL-only skips. Never inspect/load the original image just
  // to determine its dimensions. This pattern targets obvious tiny assets
  // without guessing at normal content images.
  const TINY_DIM_RE = /(?:[?&](?:w|width|h|height)=)(?:[0-9]|[12][0-9]|3[0-2])(?:[&#]|$)/i;
  const isTiny = u => TINY_DIM_RE.test(u);

  function domainSet(text) {
    return new Set(
      String(text || "").split(/[,\s]+/)
        .map(s => s.toLowerCase()).filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""))
        .filter(Boolean)
    );
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

  function shouldSkip(u) {
    if (!opts?.enabled) return true;

    // Fast string exits. These checks run for every candidate image.
    // Keep them conservative so valid image URLs are never skipped accidentally.
    if (pageExcluded) return true;

    // Already proxied (hostname check covers scheme/case/port variations).
    if (u.hostname === proxyHost) return true; // URL.hostname is already lowercase
    const href = u.href;
    if (/favicon/i.test(href)) return true;
    if (/\.(?:ico|svg)(?:[?#]|$)/i.test(href)) return true;
    if (isTiny(href)) return true;   // TINY_DIM_RE is already case-insensitive

    // Excluded image host, including subdomains.
    if (excludedHost(u.hostname)) return true;

    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
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

  function applyOpts(next) {
    const wasEnabled = !!opts?.enabled;
    updateProxyConfig(next);
    dpr = Math.min(2, Math.max(1, Number(globalThis.devicePixelRatio) || 1));
    srcsetCache = new WeakMap();
    dataSrcsetCache = new WeakMap();
    proxyUrlCache.clear();
    excludedDomains = domainSet(opts.excludeDomains);
    pageExcluded = excludedHost(pageHost);
    if (!wasEnabled && opts.enabled) scheduleInitialRewrite();
  }

  function publishSettings() {
    if (destroyed || !opts) return;
    document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
      detail: JSON.stringify(opts)
    }));
  }

  // saveData is header-only state (DNR rules 3 and 4, owned by the service worker);
  // neither this layer nor the MAIN world reads it, so a Save-Data-only
  // change must not invalidate the proxy URL and srcset caches.
  // KEEP IN SYNC with prehook.js.
  const domainKey = text => Array.from(domainSet(text)).sort().join(" ");
  const sameOpts = (a, b) => !!a && !!b &&
    a.enabled === b.enabled &&
    a.quality === b.quality &&
    a.grayscale === b.grayscale &&
    a.maxWidth === b.maxWidth &&
    a.fallbackToOrigin === b.fallbackToOrigin &&
    domainKey(a.excludeDomains) === domainKey(b.excludeDomains);

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

  // Spec-style srcset parser (KEEP IN SYNC with prehook.js): commas inside a URL
  // (e.g. Cloudinary "w_400,h_300") belong to the URL, not the candidate list.
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

  function rememberOriginal(el, src, srcset) {
    if (!opts?.fallbackToOrigin || !el || el.nodeType !== 1) return;
    if (src && el.getAttribute(ORIGINAL_SRC_ATTR) !== src) el.setAttribute(ORIGINAL_SRC_ATTR, src);
    if (srcset && el.getAttribute(ORIGINAL_SRCSET_ATTR) !== srcset) el.setAttribute(ORIGINAL_SRCSET_ATTR, srcset);
  }

  function containsProxyUrl(value, isSrcset = false) {
    if (!value) return false;
    const candidates = isSrcset ? parseSrcset(value).map(item => item.url) : [value];
    return candidates.some(candidate => resolveImage(candidate)?.hostname === proxyHost);
  }

  // True when a current srcset is the proxied form of a saved original. This
  // lets a lazy-loader's srcset copy keep its own fallback before a subsequent
  // data-srcset reassignment replaces that attribute's separate original.
  function proxySrcsetMatchesOriginal(proxyValue, originalValue) {
    if (!containsProxyUrl(proxyValue, true) || !originalValue) return false;
    const proxies = parseSrcset(proxyValue);
    const originals = parseSrcset(originalValue);
    if (!proxies.length || proxies.length !== originals.length) return false;
    return proxies.every((candidate, index) => {
      if (candidate.desc !== originals[index].desc) return false;
      const current = resolveImage(candidate.url);
      const original = resolveImage(originals[index].url);
      if (!current || !original) return false;
      if (current.hostname === proxyHost) {
        const sourceUrl = current.searchParams.get("url");
        const source = sourceUrl ? resolveImage(sourceUrl) : null;
        return !!source && source.href === original.href;
      }
      return current.href === original.href;
    });
  }

  function rememberLazyAttribute(el, name, value) {
    let originals = originalLazyAttributes.get(el);
    if (!originals) {
      originals = new Map();
      originalLazyAttributes.set(el, originals);
    }
    originals.set(name, value);
  }

  function restoreLazyAttributes(el) {
    const originals = originalLazyAttributes.get(el);
    if (!originals) return;
    for (const [name, original] of originals) {
      const current = el.getAttribute(name);
      // A newer non-proxy value belongs to the page and must not be replaced.
      if (containsProxyUrl(current)) setIfChanged(el, name, current, original);
    }
    originalLazyAttributes.delete(el);
  }

  // Original-source metadata belongs to the currently assigned source, not to
  // every URL that has ever occupied the element. The srcset and data-srcset
  // originals are tracked independently; src metadata remains while the
  // current src or a supported lazy src attribute still carries a proxy URL.
  function clearStaleOriginal(el, isSrcset) {
    if (!el || el.nodeType !== 1) return;
    const originalAttr = isSrcset ? ORIGINAL_SRCSET_ATTR : ORIGINAL_SRC_ATTR;
    const currentAttr = isSrcset ? "srcset" : "src";
    const lazyValue = !isSrcset &&
      LAZY_ATTRS.some(attr => containsProxyUrl(el.getAttribute(attr)));
    if (containsProxyUrl(el.getAttribute(currentAttr), isSrcset) || lazyValue) return;
    el.removeAttribute(originalAttr);
    if (!isSrcset) {
      const originals = originalLazyAttributes.get(el);
      if (originals) {
        for (const name of originals.keys()) {
          if (!containsProxyUrl(el.getAttribute(name))) originals.delete(name);
        }
        if (!originals.size) originalLazyAttributes.delete(el);
      }
    }
  }

  function restoreOriginalImage(el) {
    if (!opts?.fallbackToOrigin || !el || el.nodeType !== 1) return false;
    // Decide eligibility before touching any state: an element that cannot
    // be restored must not be left marked data-bw-restored or in the done
    // sets (only IMG/SOURCE can carry the saved original attributes).
    if (el.tagName !== "IMG" && el.tagName !== "SOURCE") return false;

    // An <img> inside <picture> may be loading a candidate from a sibling
    // <source>, so the failed proxy URL and saved original can live on that
    // source rather than on the <img>. Restore every direct source candidate
    // first; this also works when the <img> itself has no src/srcset fallback.
    if (el.tagName === "IMG" && el.parentElement?.tagName === "PICTURE") {
      for (const sibling of el.parentElement.children) {
        if (sibling.tagName === "SOURCE") restoreOriginalImage(sibling);
      }
    }

    if (el.getAttribute(RESTORED_ATTR) === "1") return false;

    // Restore an attribute only while that exact attribute still contains a
    // proxy URL. currentSrc can refer to a <picture> sibling or a stale
    // candidate, so it must not authorize replacing a newer src/srcset value.
    const currentSrc = el.getAttribute("src") || "";
    const currentSrcset = el.getAttribute("srcset") || "";
    const currentDataSrcset = el.getAttribute("data-srcset") || "";
    const failedProxySrc = containsProxyUrl(currentSrc);
    const failedProxySrcset = containsProxyUrl(currentSrcset, true);
    const failedProxyDataSrcset = containsProxyUrl(currentDataSrcset, true);
    const lazyOriginals = originalLazyAttributes.get(el);
    const hasLazyFallback = !!lazyOriginals &&
      Array.from(lazyOriginals.keys()).some(name => containsProxyUrl(el.getAttribute(name)));
    if (!failedProxySrc && !failedProxySrcset && !failedProxyDataSrcset && !hasLazyFallback) {
      return false;
    }

    const originalSrc = el.getAttribute(ORIGINAL_SRC_ATTR);
    const originalSrcset = el.getAttribute(ORIGINAL_SRCSET_ATTR);
    const originalDataSrcset = el.getAttribute(ORIGINAL_DATA_SRCSET_ATTR);
    const src = failedProxySrc ? originalSrc : null;
    // A lazy-loader may have copied the proxied data-srcset into srcset. In
    // that case its saved original is the correct srcset fallback, but only
    // when srcset itself still contains a proxy URL.
    const srcset = failedProxySrcset ? (originalSrcset || originalDataSrcset) : null;
    // Never overwrite a newer, non-proxy data-srcset merely because srcset
    // still needs restoration from the saved lazy fallback.
    const dataSrcset = failedProxyDataSrcset ? originalDataSrcset : null;
    if (!src && !srcset && !dataSrcset && !hasLazyFallback) return false;

    // Retain enough context to ignore an immediate retry of the same failed
    // proxy URL without permanently disabling this DOM element if a page later
    // reuses the element for a different image.
    el.setAttribute(RESTORED_ATTR, "1");
    if (src) el.setAttribute(RESTORED_SRC_ATTR, src);
    else el.removeAttribute(RESTORED_SRC_ATTR);
    if (srcset) el.setAttribute(RESTORED_SRCSET_ATTR, srcset);
    else el.removeAttribute(RESTORED_SRCSET_ATTR);

    if (failedProxySrc) {
      const failedSrcUrl = resolveImage(currentSrc);
      if (failedSrcUrl) el.setAttribute(FAILED_PROXY_SRC_ATTR, failedSrcUrl.href);
      else el.removeAttribute(FAILED_PROXY_SRC_ATTR);
    } else {
      el.removeAttribute(FAILED_PROXY_SRC_ATTR);
    }
    if (failedProxySrcset) {
      el.setAttribute(FAILED_PROXY_SRCSET_ATTR, currentSrcset);
    } else {
      el.removeAttribute(FAILED_PROXY_SRCSET_ATTR);
    }

    restoreLazyAttributes(el);
    doneImg.add(el);
    doneLazy.add(el);

    // IMG and SOURCE restore identically (tagName was validated above).
    if (srcset) el.setAttribute("srcset", srcset);
    if (dataSrcset) el.setAttribute("data-srcset", dataSrcset);
    if (src) el.setAttribute("src", src);
    el.removeAttribute(ORIGINAL_SRC_ATTR);
    el.removeAttribute(ORIGINAL_SRCSET_ATTR);
    el.removeAttribute(ORIGINAL_DATA_SRCSET_ATTR);
    return true;
  }

  document.addEventListener("error", event => {
    const t = event.target;
    if (t && (t.tagName === "IMG" || t.tagName === "SOURCE")) restoreOriginalImage(t);
  }, true);

  // Rewrites a srcset string; cached per element. A rewritten value maps to itself
  // so the mutation our own write triggers is a cache hit, not a re-parse.
  function rewriteSrcsetValue(ss, el, cache, remember = true) {
    const cached = cache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    let touched = false;
    const parts = parseSrcset(ss).map(({ url, desc }) => {
      const u = resolveImage(url);
      if (!u || shouldSkip(u)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(u.href) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    if (touched && remember) rememberOriginal(el, null, ss);
    cache.set(el, { input: ss, output });
    return output;
  }

  // Writes an attribute only when the value actually differs. A same-value
  // setAttribute() still queues a mutation record, and for a mixed srcset
  // (e.g. "icon.svg 1x, photo.jpg 2x", where one candidate is skipped) the
  // mutation filter re-queues the element, so an unconditional write made
  // content.js re-trigger itself on every macrotask forever.
  function setIfChanged(el, name, current, next) {
    if (next !== current) el.setAttribute(name, next);
  }

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.

  function rewriteImg(el) {
    if (!el || doneImg.has(el)) return;
    // Only <img>/<source> are image candidates. Generic elements reach here via
    // the data-*/style selectors; returning early keeps them out of doneImg.
    if (el.tagName !== "IMG" && el.tagName !== "SOURCE") return;
    if (el.getAttribute(RESTORED_ATTR) === "1") return; // failed proxy: keep the restored original
    if (!opts?.enabled) return;

    // Force lazy loading on <img> elements that don't specify it. The HTML
    // parser sets the loading attribute natively, bypassing prehook's
    // HTMLImageElement.prototype.loading patch, so layer 2 handles it here.
    if (el.tagName === "IMG" && !pageExcluded && !el.hasAttribute("loading")) {
      el.setAttribute("loading", "lazy");
    }

    if (el.tagName === "IMG" ||
        (el.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE")) {
      // src — <img> and <picture><source> are handled identically. Parser-
      // created values bypass prehook's property patches, and this isolated
      // world has its own DOM wrappers, so the MAIN-world hooks never run for
      // this write. Media <source> elements never reach here.
      const src = el.getAttribute("src");
      const u = src ? resolveImage(src) : null;
      if (u && !shouldSkip(u)) {
        rememberOriginal(el, u.href, null);
        el.setAttribute("src", buildProxyUrl(u.href));
      } else {
        clearStaleOriginal(el, false);
      }

      // srcset — the cache short-circuits re-parsing, and setIfChanged()
      // avoids rewriting an identical value.
      const ss = el.getAttribute("srcset");
      if (ss) {
        const rewritten = rewriteSrcsetValue(ss, el, srcsetCache);
        setIfChanged(el, "srcset", ss, rewritten);
        if (rewritten === ss) clearStaleOriginal(el, true);
      } else {
        clearStaleOriginal(el, true);
      }
    }

    // Mark done even when nothing was rewriteable (parity with rewriteBg):
    // skipped/absent URLs can't become eligible without a mutation, and every
    // real change path deletes the element from doneImg before reprocessing.
    doneImg.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Strict image-only mode: only IMG/SOURCE lazy attributes are rewritten.
  // Generic data-src/data-url attributes are intentionally left untouched
  // because their payload can be video, audio, documents, pages, scripts,
  // embeds, navigation URLs, or other non-image resources.
  // Lazy attributes such as data-lazy / data-echo are often boolean-style flags
  // ("true", "1", "lazy"). A relative URL resolves any bare word to a bogus
  // https://host/true, which would then be proxied and corrupt the flag. A real
  // image URL or path always contains a slash or a dot.
  const LAZY_URL_HINT_RE = /[/.]/;
  const NON_IMAGE_EXT_RE = /\.(?:mp4|webm|m3u8|mpd|mp3|ogg|wav|js|mjs|css|json|html?|pdf|zip|woff2?|ttf)$/i;

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (el.getAttribute(RESTORED_ATTR) === "1") return; // failed proxy: keep the restored original
    if (!opts?.enabled) return;

    // STRICT IMAGE-ONLY: data-src/data-url/etc. are ambiguous on generic
    // elements and are also used for iframe/video/script/navigation URLs.
    // Only proxy lazy attributes when the element is an actual image source
    // element. CSS background images are handled separately by rewriteBg().
    if (el.tagName !== "IMG" && el.tagName !== "SOURCE") return;
    // A <source> outside <picture> is a media (video/audio) source, not an
    // image candidate — never proxy its lazy attributes (parity with the
    // src/srcset hooks in prehook.js, which are PICTURE-restricted).
    if (el.tagName === "SOURCE" && el.parentElement?.tagName !== "PICTURE") {
      doneLazy.add(el);
      return;
    }

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    // Clear a previous lazy source when the page has replaced it. Runs once per
    // element instead of inside the per-attribute loop (the call is idempotent),
    // and running it even when no attribute is currently rewriteable also purges
    // stale fallback metadata that no longer belongs to any assigned source.
    clearStaleOriginal(el, false);
    for (const attr of Array.from(el.attributes)) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      const u = val && LAZY_URL_HINT_RE.test(val) ? resolveImage(val) : null;
      // Inspect the path, not the full URL: a query value such as
      // `?callback=viewer.js` must not make a real image look like a script.
      if (!u || NON_IMAGE_EXT_RE.test(u.pathname) || shouldSkip(u)) continue;
      // LAZY_ATTRS never contains a srcset attribute (data-srcset is handled
      // separately below), so only the original src is remembered here.
      rememberLazyAttribute(el, attr.name, val);
      if (!el.getAttribute(ORIGINAL_SRC_ATTR)) rememberOriginal(el, u.href, null);
      el.setAttribute(attr.name, buildProxyUrl(u.href));
    }

    // data-srcset — same per-element cache as normal srcset.
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      // A lazy loader may have copied the current proxied data-srcset into
      // srcset. Preserve that candidate's original separately before a newer
      // data-srcset assignment replaces ORIGINAL_DATA_SRCSET_ATTR.
      const previousDataSrcset = el.getAttribute(ORIGINAL_DATA_SRCSET_ATTR);
      const currentSrcset = el.getAttribute("srcset");
      if (previousDataSrcset && !el.getAttribute(ORIGINAL_SRCSET_ATTR) &&
          proxySrcsetMatchesOriginal(currentSrcset, previousDataSrcset)) {
        el.setAttribute(ORIGINAL_SRCSET_ATTR, previousDataSrcset);
      }

      // data-srcset has its own fallback: it must not overwrite the saved
      // original for a real srcset attribute on the same element.
      const rewritten = rewriteSrcsetValue(dss, el, dataSrcsetCache, false);
      if (rewritten !== dss) {
        if (el.getAttribute(ORIGINAL_DATA_SRCSET_ATTR) !== dss) {
          el.setAttribute(ORIGINAL_DATA_SRCSET_ATTR, dss);
        }
        setIfChanged(el, "data-srcset", dss, rewritten);
      } else if (!containsProxyUrl(dss, true) &&
                 !containsProxyUrl(el.getAttribute("srcset"), true)) {
        el.removeAttribute(ORIGINAL_DATA_SRCSET_ATTR);
      }
    }

    // Same re-arm as rewriteImg: nothing rewriteable right now still marks
    // the element done; a later attribute change arrives as a mutation that
    // deletes it from doneLazy first.
    doneLazy.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || doneBg.has(el)) return;
    if (el.getAttribute(RESTORED_ATTR) === "1") return; // failed proxy: keep the restored original
    if (!opts?.enabled) return;
    // No style attribute means no inline background (every el.style write
    // reflects into the attribute), so skip creating a style declaration for
    // the many <img>/<link>/lazy elements that never have one.
    // Mark done even without a background-image: elements matched by the
    // [style*='url(' i] selector can carry url(...) in non-background
    // properties (cursor, border-image, list-style). Without this they were
    // re-parsed on every mutation batch for the life of the page. A later
    // style change arrives as a mutation that deletes the element from
    // doneBg before reprocessing, so marking it done here is safe.
    const bg = el.hasAttribute("style") ? el.style?.backgroundImage : "";
    if (!bg) { doneBg.add(el); return; }

    // Rewrite every HTTP(S) url(...) token while preserving gradients, CSS
    // variables, quoted URLs, and non-HTTP resources.
    let touched = false;
    const output = bg.replace(BG_URL_RE, (full, quote, quoted, bare) => {
      const raw = String(quote ? quoted : bare || "").trim();
      // Fragment-only URLs refer to an in-document SVG/CSS resource, not a
      // remotely fetchable image; resolving them against document.baseURI
      // would otherwise proxy the page itself.
      const u = raw && !raw.startsWith("#") ? resolveImage(raw) : null;
      if (!u || shouldSkip(u)) return full;
      touched = true;
      return `url("${buildProxyUrl(u.href)}")`;
    });
    if (touched) {
      el.style.backgroundImage = output;
      ownStyle.set(el, el.getAttribute("style"));
    }
    // Re-mark done either way so unrelated later style mutations don't re-run
    // the regex on every batch. A real change to background-image arrives as a
    // new mutation, which deletes the element from doneBg before reprocessing.
    doneBg.add(el);
  }

  // ── D) Image preload rewriting ─────────────────────────────────────────────
  // Parser-created preload links bypass prehook's JS patches. Rewrite both the
  // href and responsive imagesrcset candidate URLs so preloaded bytes use the
  // proxy instead of the original full-resolution sources. Keep originals so
  // this layer can restore them if a link is repurposed before prehook sees it.
  function restorePreloadHref(el) {
    // Fall back to the MAIN-world pending stash (prehook.js parks a preload's
    // original href in data-bh-preload-href while href="about:blank"), so a
    // parked link can never be left pointing at about:blank by this layer.
    const original = el.getAttribute(ORIGINAL_PRELOAD_HREF_ATTR) ||
      el.getAttribute(PENDING_PRELOAD_HREF_ATTR);
    if (original) {
      const current = el.getAttribute("href") || "";
      const applied = el.getAttribute(APPLIED_PRELOAD_HREF_ATTR);
      // Do not overwrite a newer URL deliberately assigned by the page.
      if (current === "about:blank" || (applied && current === applied)) {
        el.setAttribute("href", original);
      }
    }
    el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
    el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
    el.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
  }

  function restorePreloadImagesrcset(el) {
    const original = el.getAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR) ||
      el.getAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
    if (original) {
      const current = el.getAttribute("imagesrcset") || "";
      const applied = el.getAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      // The empty value is the MAIN-world parking placeholder. Otherwise only
      // replace the exact value that this extension wrote, preserving page edits.
      // An absent attribute is an explicit page removal, not our empty
      // parking placeholder. Require the attribute to still exist before
      // restoring so a simultaneous rel/type change cannot resurrect it.
      if (el.hasAttribute("imagesrcset") &&
          (current === "" || (applied && current === applied))) {
        el.setAttribute("imagesrcset", original);
      }
    }
    el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
    el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
    el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
  }

  function rewritePreload(el) {
    if (!el || el.tagName !== "LINK") return;

    // Settings not loaded yet: prehook.js may have parked either preload URL.
    // Do NOT restore while settings are unknown; that would restart an
    // unoptimized full-resolution request.
    if (!opts) return;

    const as = String(el.getAttribute("as") || "").toLowerCase();
    const type = String(el.getAttribute("type") || "");
    const isImagePreload = /(?:^|\s)preload(?:\s|$)/i.test(el.rel || "") &&
      (as === "image" || (!as && /^image\//i.test(type)));

    if (!isImagePreload || !opts.enabled) {
      restorePreloadHref(el);
      restorePreloadImagesrcset(el);
      return;
    }

    // `href` and responsive `imagesrcset` are independent preload sources.
    // Some responsive hints provide only imagesrcset, with no href at all.
    const href = el.getAttribute("href");
    if (href === null) {
      el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
      el.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
    } else {
      const original = el.getAttribute(ORIGINAL_PRELOAD_HREF_ATTR) ||
        el.getAttribute(PENDING_PRELOAD_HREF_ATTR) || href;
      const u = original ? resolveImage(original) : null;
      if (!u || shouldSkip(u)) {
        restorePreloadHref(el);
      } else {
        const proxy = buildProxyUrl(u.href);
        if (proxy !== original) {
          el.setAttribute(ORIGINAL_PRELOAD_HREF_ATTR, original);
          el.setAttribute(APPLIED_PRELOAD_HREF_ATTR, proxy);
        } else {
          el.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
          el.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
        }
        el.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
        if (href !== proxy) el.setAttribute("href", proxy);
      }
    }

    const imagesrcset = el.getAttribute("imagesrcset");
    if (imagesrcset === null) {
      el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
    } else {
      const original = el.getAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR) ||
        el.getAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR) || imagesrcset;
      const rewritten = rewriteSrcsetValue(original, el, srcsetCache, false);
      if (rewritten !== original) {
        el.setAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR, original);
        el.setAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR, rewritten);
      } else {
        el.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
        el.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
      }
      el.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
      if (imagesrcset !== rewritten) el.setAttribute("imagesrcset", rewritten);
    }
  }

  // Include all <source> nodes so one moved out of <picture> can have any
  // saved proxy src/srcset restored before it becomes a media source. Sources
  // outside <picture> are lifecycle-checked only, never rewritten as images.
  // Generic data-* lazy attributes remain excluded from the candidate scan.
  const CANDIDATE_SELECTOR = ["img", "source", "[style*='url(' i]", 'link[rel~="preload" i]'].join(",");

  // True when an attribute value still holds at least one rewriteable image URL.
  // srcset-style values are inspected candidate by candidate: resolving the whole
  // string as one URL only ever tested the FIRST candidate, so a list such as
  // "logo.svg 1x, photo.jpg 2x" was ignored after an attribute mutation. Our own
  // proxy writes yield only skipped (wsrv) candidates, so they still return false.
  function hasRewriteableUrl(value, isSrcset, lazy = false) {
    if (!value) return false;
    if (!isSrcset) {
      if (lazy && !LAZY_URL_HINT_RE.test(value)) return false;
      const u = resolveImage(value);
      return !!u && !shouldSkip(u);
    }
    return parseSrcset(value).some(({ url }) => {
      const u = resolveImage(url);
      return !!u && !shouldSkip(u);
    });
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function restorePictureSourceForMedia(el) {
    if (!el || el.tagName !== "SOURCE" || el.parentElement?.tagName === "PICTURE") return;
    // A picture source may be repurposed as a video/audio source after it was
    // proxied. Restore only values that still point at our proxy; never replace
    // a newer URL deliberately assigned by the page. Fallback metadata is
    // present when the default origin-fallback setting is enabled.
    const originalSrc = el.getAttribute(ORIGINAL_SRC_ATTR);
    const originalSrcset = el.getAttribute(ORIGINAL_SRCSET_ATTR);
    const originalDataSrcset = el.getAttribute(ORIGINAL_DATA_SRCSET_ATTR);
    const currentSrc = el.getAttribute("src");
    const currentSrcset = el.getAttribute("srcset");
    const currentDataSrcset = el.getAttribute("data-srcset");
    if (originalSrc && containsProxyUrl(currentSrc)) {
      setIfChanged(el, "src", currentSrc, originalSrc);
    }
    if (containsProxyUrl(currentSrcset, true)) {
      // Some lazy loaders copy the already-proxied data-srcset into srcset.
      // Its original is still usable even when no independent srcset marker
      // exists, because the prehook correctly skipped the proxy URL itself.
      const srcsetFallback = originalSrcset || originalDataSrcset;
      if (srcsetFallback) setIfChanged(el, "srcset", currentSrcset, srcsetFallback);
    }
    if (originalDataSrcset && containsProxyUrl(currentDataSrcset, true)) {
      setIfChanged(el, "data-srcset", currentDataSrcset, originalDataSrcset);
    }
    restoreLazyAttributes(el);
    el.removeAttribute(ORIGINAL_SRC_ATTR);
    el.removeAttribute(ORIGINAL_SRCSET_ATTR);
    el.removeAttribute(ORIGINAL_DATA_SRCSET_ATTR);
  }

  function processCandidate(el) {
    if (el?.tagName === "SOURCE" && el.parentElement?.tagName !== "PICTURE") {
      restorePictureSourceForMedia(el);
      return;
    }
    const imageElement = el?.tagName === "IMG" || el?.tagName === "SOURCE";
    if (imageElement) {
      rewriteImg(el);
      rewriteLazy(el);
    }
    rewriteBg(el);
    rewritePreload(el);
  }

  function processInsertedCandidate(el) {
    if (el?.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE") {
      // A source can be moved from <video>/<audio> or a detached container
      // into <picture>. Its tag is unchanged, but its eligibility is different.
      doneImg.delete(el);
      doneLazy.delete(el);
    }
    processCandidate(el);
  }

  function rewriteAll(force = false) {
    if (destroyed) return;
    const candidates = document.querySelectorAll(CANDIDATE_SELECTOR);
    candidates.forEach(el => {
      if (force) {
        // A full reconciliation scan must be able to repair missed mutation
        // records, not just revisit elements already marked as processed.
        doneImg.delete(el);
        doneLazy.delete(el);
        doneBg.delete(el);
      }
      processCandidate(el);
    });
  }

  // Several publishers can request a reconciliation scan in the same task
  // (the defaults failsafe plus the delayed storage snapshot that supersedes
  // it, or a disabled→enabled transition followed by the initial publish).
  // Coalesce them: one queued scan per task. The flag resets when the
  // macrotask fires, so a later snapshot in a different task still schedules
  // its own scan with the newer settings.
  let initialRewriteQueued = false;
  function scheduleInitialRewrite() {
    if (destroyed || initialRewriteQueued) return;
    initialRewriteQueued = true;
    // Yield once before a full-page scan so navigation/rendering is not blocked
    // behind querySelectorAll plus attribute writes on huge documents.
    setTimeout(() => {
      initialRewriteQueued = false;
      if (destroyed) return;
      rewriteAll(true);
    }, 0);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  // Batch synchronous DOM churn into one macrotask. This prevents repeated
  // scans while still yielding to Chrome's navigation/rendering work.
  let pendingMutations = [];
  let mutationFlushQueued = false;

  function processMutations(mutations) {
    const addedRoots = [];
    const imageTargets = new Set();
    const lazyTargets = new Set();
    const bgTargets = new Set();
    const preloadTargets = new Set();

    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) addedRoots.push(n);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if ((m.attributeName === "src" || m.attributeName === "srcset") &&
            (t.tagName === "IMG" ||
             (t.tagName === "SOURCE" && t.parentElement?.tagName === "PICTURE"))) {
          // A restored element's original URL must not be re-proxied.
          if (t.getAttribute(RESTORED_ATTR) === "1") continue;
          const isSrcset = m.attributeName === "srcset";
          const value = t.getAttribute(m.attributeName);
          // Ignore mutations produced by our own proxy writes. Reprocessing a
          // wsrv/excluded value only creates more observer work. When a page
          // replaces a proxied source with a skipped/removed URL, discard only
          // that attribute's stale fallback metadata.
          if (hasRewriteableUrl(value, isSrcset)) {
            doneImg.delete(t);
            imageTargets.add(t);
          } else {
            clearStaleOriginal(t, isSrcset);
          }
        } else if (m.attributeName === "style") {
          // Our own rewrite already produced this exact style value.
          if (ownStyle.get(t) === t.getAttribute("style")) continue;
          doneBg.delete(t);
          bgTargets.add(t);
        } else if ((t.tagName === "IMG" ||
                     (t.tagName === "SOURCE" && t.parentElement?.tagName === "PICTURE")) &&
                   (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset")) {
          // Restored originals must not be re-proxied; keep them marked done.
          if (t.getAttribute(RESTORED_ATTR) === "1") continue;
          // Ignore records produced by our own proxy writes — same guard the
          // src/srcset branch applies above.
          if (hasRewriteableUrl(t.getAttribute(m.attributeName), m.attributeName === "data-srcset",
                                m.attributeName !== "data-srcset")) {
            doneLazy.delete(t);
            lazyTargets.add(t);
          } else if (m.attributeName === "data-srcset") {
            // Keep the saved lazy fallback while either attribute still carries
            // the proxy URL it belongs to; discard it after both move away.
            if (!containsProxyUrl(t.getAttribute("data-srcset"), true) &&
                !containsProxyUrl(t.getAttribute("srcset"), true)) {
              t.removeAttribute(ORIGINAL_DATA_SRCSET_ATTR);
            }
          } else {
            const originals = originalLazyAttributes.get(t);
            if (originals && !containsProxyUrl(t.getAttribute(m.attributeName))) {
              originals.delete(m.attributeName);
              if (!originals.size) originalLazyAttributes.delete(t);
            }
            clearStaleOriginal(t, false);
          }
        } else if (t.tagName === "LINK" &&
                   (m.attributeName === "href" || m.attributeName === "rel" ||
                    m.attributeName === "as" || m.attributeName === "type" ||
                    m.attributeName === "imagesrcset")) {
          preloadTargets.add(t);
        }
      }
    }

    // The parser reports every node of a streamed subtree as an added root of
    // its parent, so a nested root would be re-queried once per ancestor
    // (quadratic on deep pages). An ancestor root's querySelectorAll already
    // covers every candidate below it, so nested roots are skipped.
    const rootSet = addedRoots.length > 1 ? new Set(addedRoots) : null;
    for (const root of addedRoots) {
      if (rootSet) {
        let covered = false;
        for (let p = root.parentElement; p; p = p.parentElement) {
          if (rootSet.has(p)) { covered = true; break; }
        }
        if (covered) continue;
      }
      processInsertedCandidate(root);
      root.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(processInsertedCandidate);
    }
    imageTargets.forEach(rewriteImg);
    lazyTargets.forEach(rewriteLazy);
    bgTargets.forEach(rewriteBg);
    preloadTargets.forEach(rewritePreload);
  }

  const MUTATION_RECORD_LIMIT = 2000;
  let mutationOverflowed = false;

  function queueMutationFlush(mutations) {
    if (destroyed) return;
    // Single pass over the batch. Pending-state cleanup must run for every
    // attribute record (even ones the queue filter drops), so it stays inline
    // with queue admission instead of a second loop over the same records.
    // Keep a strict memory bound: if records are dropped, reconcile the current
    // DOM after the bounded batch so missed attribute changes/additions are not
    // silently left unprocessed. After overflow the pass keeps cleaning later
    // records but queues nothing more (the reconcile covers dropped records).
    for (const m of mutations) {
      if (m.type === "attributes") {
        const target = m.target;
        const name = m.attributeName;
        if (!target) continue;
        if ((name === "src" || name === "srcset" || name === "loading") &&
            !target.hasAttribute(name)) {
          target.removeAttribute(`data-bh-pending-${name}`);
        }
        if (target.tagName === "LINK" && !target.hasAttribute(name)) {
          if (name === "href") {
            target.removeAttribute(ORIGINAL_PRELOAD_HREF_ATTR);
            target.removeAttribute(APPLIED_PRELOAD_HREF_ATTR);
            target.removeAttribute(PENDING_PRELOAD_HREF_ATTR);
          } else if (name === "imagesrcset") {
            target.removeAttribute(ORIGINAL_PRELOAD_IMAGESRCSET_ATTR);
            target.removeAttribute(APPLIED_PRELOAD_IMAGESRCSET_ATTR);
            target.removeAttribute(PENDING_PRELOAD_IMAGESRCSET_ATTR);
          }
        }
        if (name === "loading") continue;
        // The observer's attribute filter is document-wide, so drop records that
        // processMutations() would ignore anyway (e.g. <a href>, <script src>,
        // <iframe src>, <video src> churn) before they consume the bounded queue
        // and force early overflow reconciles. href/rel/as/type only matter on
        // <link>; src/srcset and lazy data-* only on <img>/<source>.
        if (name === "style") {
          // Inline style churn (animations) is the largest mutation source on
          // modern pages. rewriteBg() only ever acts on a url(...) present in
          // the CURRENT value, so every other style record is dropped here
          // instead of overflowing the bounded queue into a full-document
          // reconcile.
          if (!STYLE_URL_HINT_RE.test(target.getAttribute("style") || "")) continue;
        } else {
          const tag = target.tagName;
          const linkAttr = name === "href" || name === "rel" ||
            name === "as" || name === "type" || name === "imagesrcset";
          const imageTarget = tag === "IMG" ||
            (tag === "SOURCE" && target.parentElement?.tagName === "PICTURE");
          if (linkAttr ? tag !== "LINK" : !imageTarget) continue;
        }
      }
      if (pendingMutations.length >= MUTATION_RECORD_LIMIT) {
        mutationOverflowed = true;
        continue;
      }
      pendingMutations.push(m);
    }
    if (mutationFlushQueued) return;
    // Attribute changes such as `loading` removals can be fully handled by
    // the synchronous pending-state cleanup above. Avoid queuing an empty
    // macrotask when every record in this batch was filtered out.
    if (!pendingMutations.length && !mutationOverflowed) return;
    mutationFlushQueued = true;
    const flush = () => {
      mutationFlushQueued = false;
      if (destroyed) return;
      const batch = pendingMutations;
      const needsReconcile = mutationOverflowed;
      pendingMutations = [];
      mutationOverflowed = false;
      processMutations(batch);
      if (needsReconcile) {
        // Yield again before the potentially large full-page scan so overflow
        // recovery does not extend the mutation-flush task unnecessarily.
        setTimeout(() => {
          if (!destroyed) rewriteAll(true);
        }, 0);
      }
    };
    // Use a macrotask, not a microtask. Microtask chains can starve Chrome's
    // navigation commit when a page keeps mutating during click-to-navigation.
    setTimeout(flush, 0);
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    // `mo` is assigned above and stop() is only reachable from the pagehide
    // listener registered after it; disconnect() cannot throw per spec
    // (parity with the prehook.js stop() cleanup).
    mo.disconnect();
    pendingMutations = [];
    mutationOverflowed = false;
  }

  // stop() can only run via the pagehide listener registered after the full
  // IIFE body evaluates, so `const` is safe here (no TDZ window).
  const mo = new MutationObserver(queueMutationFlush);

  mo.observe(document, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", "loading", ...LAZY_ATTRS, "data-srcset", "href", "rel", "as", "type", "imagesrcset"]
  });

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  // A late storage callback must not overwrite settings delivered by a newer
  // onChanged event. The generation also invalidates the initial local read
  // when a sync/local change arrives before that read completes.
  let settingsReadGeneration = 0;

  function applyInitialSettings(next) {
    // If the 800 ms failsafe already published DEFAULTS, a late storage snapshot
    // can carry the real quality/width/exclusion values. Parser-created images
    // processed with the failsafe config must be reconciled once that snapshot
    // arrives; merely publishing the settings leaves those URLs unchanged.
    const hadFailsafe = !!opts;
    applyOpts(next);
    publishSettings();
    if (hadFailsafe) scheduleInitialRewrite();
  }

  function readSyncSettings() {
    const generation = ++settingsReadGeneration;
    try {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed || generation !== settingsReadGeneration) return;
        const error = chrome.runtime.lastError?.message || "";
        if (error || !synced || typeof synced !== "object") return;
        applyInitialSettings(synced);
        // Write the fallback mirror so later pages can take the fast path.
        try { chrome.storage.local.set({ bhOpts: opts }); } catch {}
      });
    } catch {}
  }

  // Register the failsafe before issuing the storage read. If the storage API
  // throws synchronously, a callback-only failsafe registered after this call
  // would never run and MAIN-world images parked on about:blank would strand.
  setTimeout(() => {
    if (destroyed || opts) return;
    try { applyOpts(DEFAULTS); publishSettings(); } catch {}
  }, 800);

  const initialSettingsRead = ++settingsReadGeneration;
  try {
    chrome.storage.local.get({ bhOpts: null }, d => {
      if (destroyed || initialSettingsRead !== settingsReadGeneration) return;
      const error = chrome.runtime.lastError?.message || "";
      if (!error && d?.bhOpts) {
        applyInitialSettings(d.bhOpts);
      } else {
        readSyncSettings();
      }
    });
  } catch {
    readSyncSettings();
  }

  // If neither storage area answers (storage.sync unsupported, or a runtime
  // error on both reads), prehook.js images parked on about:blank while
  // waiting for settings would stay blank forever. The failsafe registered
  // above publishes the shared defaults after a short delay.

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (destroyed) return;
    if (area === "local" && changes.bhOpts) {
      // Invalidate in-flight reads even when this is an echo of our own
      // fallback mirror write; an older sync snapshot must never win later.
      settingsReadGeneration++;
      const next = { ...DEFAULTS, ...(changes.bhOpts.newValue || {}) };
      if (sameOpts(next, opts)) {
        if (opts) opts.saveData = !!next.saveData;
        return;
      }
      applyOpts(next);
      publishSettings();
    } else if (area === "sync") {
      if (!opts) {
        readSyncSettings();
        return;
      }
      settingsReadGeneration++;
      const next = { ...opts };
      for (const [key, change] of Object.entries(changes)) {
        next[key] = change.newValue ?? DEFAULTS[key];
      }
      if (!sameOpts(next, opts)) {
        applyOpts(next);
        publishSettings();
      } else {
        // Save-Data is consumed by DNR only and must not invalidate image caches.
        opts.saveData = !!next.saveData;
      }
      // Keep the fast mirror current on forks where the service worker may be
      // asleep; the local change echo is ignored by the sameOpts check above.
      // Write the normalized snapshot, never the raw sync values.
      try { chrome.storage.local.set({ bhOpts: opts }); } catch {}
    }
  });

  // On a real navigation, disconnect immediately so the outgoing page cannot
  // keep scheduling image-rewrite work while Chrome is trying to commit the
  // next URL. Persisted bfcache pages are left connected.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
