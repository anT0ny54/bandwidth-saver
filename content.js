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
    enabled: true, proxyBase: WSRV_PROXY, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: ""
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Tracking pixel URL patterns (ported from original shouldCompress.js)
  // Catches tracking pixels by URL pattern, regardless of domain.
  // KEEP IN SYNC with TRACKING_RE in prehook.js. Combined into one regex so each
  // candidate URL is tested once instead of running 13 separate patterns.
  const TRACKING_RE = new RegExp([
    "pagead",
    "(?:pixel|cleardot)\\.*\\.(?:gif|jpg|jpeg)",
    "google\\.(?:[a-z.]+)\\/(?:ads|generate_204|.*\\/log204)+",
    "google-analytics\\.(?:[a-z.]+)\\/(?:r|collect)+",
    "youtube\\.(?:[a-z.]+)\\/(?:api|ptracking|player_204|live_204)+",
    "doubleclick\\.(?:[a-z.]+)\\/(?:pcs|pixel|r)+",
    "googlesyndication\\.(?:[a-z.]+)\\/ddm",
    "pixel\\.facebook\\.(?:[a-z.]+)",
    "facebook\\.(?:[a-z.]+)\\/(?:impression\\.php|tr)+",
    "ad\\.bitmedia\\.io",
    "yahoo\\.(?:[a-z.]+)\\/pixel",
    "criteo\\.net\\/img",
    "ad\\.doubleclick\\.net"
  ].join("|"), "i");


  let opts = null;
  let proxyConfig = null;
  let destroyed = false;      // set on real navigation away from this document
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBg = new WeakSet();
  let excludedDomains = new Set();
  const proxyHost = "wsrv.nl"; // proxy is fixed (WSRV_PROXY)
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  const lazyAttrSet = new Set(LAZY_ATTRS);
  // Cache the last srcset transformation per element. Dynamic sites often
  // write the same srcset repeatedly while hydrating/re-rendering.
  let srcsetCache = new WeakMap();
  let dataSrcsetCache = new WeakMap();
  const LAZY_SELECTOR = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  const isHttp  = u => /^https?:\/\//i.test(u);

  // Conservative URL-only skips. Never inspect/load the original image just
  // to determine its dimensions. These patterns target tracking pixels and
  // obvious tiny assets without guessing at normal content images.
  const TINY_URL_RE = /(?:^|[._\/-])(1x1|2x2|pixel|spacer|tracking)(?:[._\/-]|$)/i;
  const TINY_DIM_RE = /(?:[?&](?:w|width|h|height)=)(?:[0-9]|[12][0-9]|3[0-2])(?:[&#]|$)/i;
  const isTinyOrTracking = u => TINY_URL_RE.test(u) || TINY_DIM_RE.test(u);

  function domainSet(text) {
    return new Set(
      String(text || "").split(/[,\s]+/)
        .map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
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

  function shouldSkip(url) {
    if (!opts?.enabled || !opts?.proxyBase) return true;

    const absolute = resolveHttp(url);
    if (!absolute) return true;

    // Fast exits before URL parsing. These checks run for every candidate image.
    // Keep them conservative so valid image URLs are never skipped accidentally.
    if (pageExcluded) return true;
    const lower = absolute.toLowerCase();
    if (lower.startsWith("https://" + proxyHost + "/")) return true;
    if (lower.includes("favicon")) return true;
    if (lower.endsWith(".ico") || lower.includes(".ico?") || lower.includes(".ico#") ||
        lower.endsWith(".svg") || lower.includes(".svg?") || lower.includes(".svg#")) return true;
    if (isTinyOrTracking(lower)) return true;
    if (TRACKING_RE.test(absolute)) return true;

    const u = safeURL(absolute);
    if (!u) return true;

    // Already proxied (handles non-https/case variations safely).
    if (u.hostname.toLowerCase() === proxyHost) return true;

    // Excluded image host, including subdomains.
    const host = u.hostname.toLowerCase();
    if (excludedHost(host)) return true;

    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
  function updateProxyConfig(next) {
    opts = next;
    const base = WSRV_PROXY;
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
  }

  function applyOpts(next) {
    updateProxyConfig({ ...next, proxyBase: WSRV_PROXY });
    srcsetCache = new WeakMap();
    dataSrcsetCache = new WeakMap();
    proxyUrlCache.clear();
    excludedDomains = domainSet(opts.excludeDomains);
    pageExcluded = excludedHost(pageHost);
  }

  function publishSettings() {
    if (destroyed || !opts) return;
    document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
      detail: JSON.stringify({ ...opts, proxyBase: WSRV_PROXY })
    }));
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
    parts.push("maxage=1d", "page=-1", "n=-1", "default=1", "output=webp");

    const result = base + sep + parts.join("&");
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

  // Rewrites a srcset string; cached per element. A rewritten value maps to itself
  // so the mutation our own write triggers is a cache hit, not a re-parse.
  function rewriteSrcsetValue(ss, el, cache) {
    const cached = cache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    let touched = false;
    const parts = parseSrcset(ss).map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      if (!absolute || shouldSkip(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    cache.set(el, { input: ss, output });
    return output;
  }

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  const nativeImgSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;

  function rewriteImg(el) {
    if (!el || doneImg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    // Force lazy loading on <img> elements that don't specify it. The HTML
    // parser sets the loading attribute natively, bypassing prehook's
    // HTMLImageElement.prototype.loading patch, so layer 2 handles it here.
    if (el.tagName === "IMG" && !el.hasAttribute("loading")) {
      el.setAttribute("loading", "lazy");
    }

    let rewrote = false;

    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // src
      if (el.tagName === "IMG") {
        const src = el.getAttribute("src");
        const absoluteSrc = src ? resolveHttp(src) : null;
        if (absoluteSrc && !shouldSkip(absoluteSrc) && nativeImgSrcSetter) {
          const proxy = buildProxyUrl(absoluteSrc);
          // Use the native setter so this isolated-world rewrite cannot recurse
          // through the MAIN-world prehook.
          nativeImgSrcSetter.call(el, proxy);
          rewrote = true;
        }
      }

      // srcset — cache the last value for this element.
      const ss = el.getAttribute("srcset");
      if (ss) {
        const output = rewriteSrcsetValue(ss, el, srcsetCache);
        if (output !== ss) {
          el.setAttribute("srcset", output);
          rewrote = true;
        }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Strict image-only mode: only IMG/SOURCE lazy attributes are rewritten.
  // Generic data-src/data-url attributes are intentionally left untouched
  // because their payload can be video, audio, documents, pages, scripts,
  // embeds, navigation URLs, or other non-image resources.
  const NON_IMAGE_EXT_RE = /\.(?:mp4|webm|m3u8|mpd|mp3|ogg|wav|js|mjs|css|json|html?|php|pdf|zip|woff2?|ttf)(?:[?#]|$)/i;

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    // STRICT IMAGE-ONLY: data-src/data-url/etc. are ambiguous on generic
    // elements and are also used for iframe/video/script/navigation URLs.
    // Only proxy lazy attributes when the element is an actual image source
    // element. CSS background images are handled separately by rewriteBg().
    if (el.tagName !== "IMG" && el.tagName !== "SOURCE") return;

    let rewrote = false;

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    for (const attr of el.attributes) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      const absolute = val ? resolveHttp(val) : null;
      if (!absolute || NON_IMAGE_EXT_RE.test(absolute) || shouldSkip(absolute)) continue;
      el.setAttribute(attr.name, buildProxyUrl(absolute));
      rewrote = true;
    }

    // data-srcset — same per-element cache as normal srcset.
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      const output = rewriteSrcsetValue(dss, el, dataSrcsetCache);
      if (output !== dss) {
        el.setAttribute("data-srcset", output);
        rewrote = true;
      }
    }

    if (rewrote) doneLazy.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || doneBg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    const bg = el.style?.backgroundImage;
    if (!bg) return;

    // Rewrite every HTTP(S) url(...) token while preserving gradients, CSS
    // variables, quoted URLs, and non-HTTP resources.
    const urlRe = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
    let touched = false;
    const output = bg.replace(urlRe, (full, quote, quoted, bare) => {
      const raw = String(quote ? quoted : bare || "").trim();
      const absolute = raw ? resolveHttp(raw) : null;
      if (!absolute || shouldSkip(absolute)) return full;
      touched = true;
      return `url("${buildProxyUrl(absolute)}")`;
    });
    if (!touched || output === bg) return;
    el.style.backgroundImage = output;
    doneBg.add(el);
  }

  // ── D) <link rel="preload" as="image"> rewriting ──────────────────────────
  // Parser-created preload links bypass prehook's JS patches. Rewrite the href
  // to the proxy URL so the preloaded bytes are compressed instead of the
  // original full-resolution image.
  function rewritePreload(el) {
    if (!el || el.tagName !== "LINK") return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    if (!/(?:^|\s)preload(?:\s|$)/i.test(el.rel || "")) return;
    if (String(el.getAttribute("as") || "").toLowerCase() !== "image" &&
        !/^image\//i.test(el.getAttribute("type") || "")) return;

    const href = el.getAttribute("href");
    const absolute = href ? resolveHttp(href) : null;
    if (!absolute || shouldSkip(absolute)) return;
    el.setAttribute("href", buildProxyUrl(absolute));
  }

  const CANDIDATE_SELECTOR = ["img", "source", LAZY_SELECTOR, "[style*='url(' i]", 'link[rel~="preload"]'].join(",");

  // ── Full-page scan ────────────────────────────────────────────────────────
  function processCandidate(el) {
    rewriteImg(el);
    rewriteLazy(el);
    rewriteBg(el);
    rewritePreload(el);
  }

  function rewriteAll() {
    if (destroyed) return;
    document.querySelectorAll(CANDIDATE_SELECTOR).forEach(processCandidate);
  }

  function scheduleInitialRewrite() {
    if (destroyed) return;
    // Yield once before a full-page scan so navigation/rendering is not blocked
    // behind querySelectorAll plus attribute writes on huge documents.
    setTimeout(() => {
      if (destroyed) return;
      rewriteAll();
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
            (t.tagName === "IMG" || t.tagName === "SOURCE")) {
          // Ignore mutations produced by our own proxy writes. Reprocessing a
          // wsrv/excluded value only creates more observer work.
          const cur = t.getAttribute(m.attributeName);
          const abs = cur ? resolveHttp(cur) : null;
          if (abs && !shouldSkip(abs)) {
            doneImg.delete(t);
            imageTargets.add(t);
          }
        } else if (m.attributeName === "style") {
          doneBg.delete(t);
          bgTargets.add(t);
        } else if (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset") {
          doneLazy.delete(t);
          lazyTargets.add(t);
        } else if (m.target.tagName === "LINK" &&
                   (m.attributeName === "href" || m.attributeName === "rel" || m.attributeName === "as")) {
          preloadTargets.add(t);
        }
      }
    }

    for (const root of addedRoots) {
      processCandidate(root);
      root.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(processCandidate);
    }
    imageTargets.forEach(rewriteImg);
    lazyTargets.forEach(rewriteLazy);
    bgTargets.forEach(rewriteBg);
    preloadTargets.forEach(rewritePreload);
  }

  const MUTATION_RECORD_LIMIT = 2000;

  function queueMutationFlush(mutations) {
    if (destroyed) return;
    // Bound memory during pathological DOM churn. A bounded loss here is safer
    // than an unbounded array that can pin the main thread until navigation.
    for (const m of mutations) {
      pendingMutations.push(m);
      if (pendingMutations.length >= MUTATION_RECORD_LIMIT) break;
    }
    if (mutationFlushQueued) return;
    mutationFlushQueued = true;
    const flush = () => {
      mutationFlushQueued = false;
      if (destroyed) return;
      const batch = pendingMutations;
      pendingMutations = [];
      processMutations(batch);
    };
    // Use a macrotask, not a microtask. Microtask chains can starve Chrome's
    // navigation commit when a page keeps mutating during click-to-navigation.
    setTimeout(flush, 0);
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { mo && mo.disconnect(); } catch {}
    pendingMutations = [];
  }

  let mo = null;
  mo = new MutationObserver(queueMutationFlush);

  mo.observe(document, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset", "href", "rel", "as"]
  });

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (destroyed) return;
    if (d.bhOpts) {
      applyOpts(d.bhOpts);
      publishSettings();
      if (opts.enabled && opts.proxyBase) scheduleInitialRewrite();
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        applyOpts(synced);
        publishSettings();
        // Write mirror so next page load takes the fast path
        chrome.storage.local.set({ bhOpts: opts });
        if (opts.enabled && opts.proxyBase) scheduleInitialRewrite();
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (destroyed) return;
    if (area === "local" && changes.bhOpts) {
      applyOpts(changes.bhOpts.newValue || DEFAULTS);
      publishSettings();
    } else if (area === "sync") {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        const changed = !sameOpts(synced, opts);
        applyOpts(synced);
        publishSettings();
        // The service worker normally refreshes the mirror; only write when it differs.
        if (changed) chrome.storage.local.set({ bhOpts: opts });
      });
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
