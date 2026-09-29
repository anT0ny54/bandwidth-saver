// Bandwidth Guardian — content script
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
//  Image interception is now split across two layers:
//
//  Layer 1 — prehook.js (document_start, synchronous)
//    Patches HTMLImageElement.prototype.src, srcset, setAttribute, and Image()
//    BEFORE the HTML parser runs. Catches all images set via JavaScript.
//    Zero wasted bytes — proxy URL is set before any network request fires.
//
//  Layer 2 — THIS FILE (document_start, async after storage read)
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
  // Fixed image proxy used by Bandwidth Guardian.
  const WSRV_PROXY = "https://wsrv.nl/";
  // Minimal fallback used only when the local settings mirror is unavailable.
  const DEFAULTS = {
    enabled: true, proxyBase: WSRV_PROXY, quality: 60, grayscale: true,
    maxWidth: 768, excludeDomains: "google.com gstatic.com"
  };
  // ──────────────────────────────────────────────────────────────────────────

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Tracking pixel URL patterns (ported from original shouldCompress.js)
  // Catches tracking pixels by URL pattern, regardless of domain.
  const TRACKING_PATTERNS = [
    /pagead/i,
    /(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i,
    /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
    /google-analytics\.([a-z.]+)\/(r|collect)+/i,
    /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
    /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i,
    /googlesyndication\.([a-z.]+)\/ddm/i,
    /pixel\.facebook\.([a-z.]+)/i,
    /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
    /ad\.bitmedia\.io/i,
    /yahoo\.([a-z.]+)\/pixel/i,
    /criteo\.net\/img/i,
    /ad\.doubleclick\.net/i
  ];

  let opts = null;
  let proxyConfig = null;
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBg = new WeakSet();
  let excludedDomains = new Set();
  let proxyHost = "wsrv.nl";
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
    if (proxyHost && lower.startsWith("https://" + proxyHost + "/")) return true;
    if (lower.includes("favicon")) return true;
    if (lower.endsWith(".ico") || lower.includes(".ico?") || lower.includes(".ico#") ||
        lower.endsWith(".svg") || lower.includes(".svg?") || lower.includes(".svg#")) return true;
    if (isTinyOrTracking(lower)) return true;
    if (TRACKING_PATTERNS.some(p => p.test(absolute))) return true;

    const u = safeURL(absolute);
    if (!u) return true;

    // Already proxied (handles non-https/case variations safely).
    if (proxyHost && u.hostname.toLowerCase() === proxyHost) return true;

    // Excluded image host, including subdomains.
    const host = u.hostname.toLowerCase();
    if (excludedHost(host)) return true;

    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
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

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  const nativeImgSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;

  function rewriteImg(el) {
    if (!el || doneImg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // src
      if (el.tagName === "IMG") {
        const src = el.getAttribute("src");
        const absoluteSrc = src ? resolveHttp(src) : null;
        if (absoluteSrc && !shouldSkip(absoluteSrc) && nativeImgSrcSetter) {
          // Use the prehook setter with a proxy URL; it recognizes wsrv.nl and
          // forwards that URL to the browser without wrapping it again.
          nativeImgSrcSetter.call(el, buildProxyUrl(absoluteSrc));
          rewrote = true;
        }
      }

      // srcset — cache the last value for this element.
      const ss = el.getAttribute("srcset");
      if (ss) {
        let rewritten = srcsetCache.get(el);
        if (!rewritten || rewritten.input !== ss) {
          let touched = false;
          const parts = ss.split(",");
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const m = part.trim().match(/^(\S+)(\s.*)?$/);
            if (!m) continue;
            const url = m[1];
            const absolute = resolveHttp(url);
            if (!absolute || shouldSkip(absolute)) continue;
            parts[i] = buildProxyUrl(absolute) + (m[2] || "");
            touched = true;
          }
          rewritten = { input: ss, output: touched ? parts.join(", ") : ss };
          srcsetCache.set(el, rewritten);
        }
        if (rewritten.output !== ss) {
          el.setAttribute("srcset", rewritten.output);
          rewrote = true;
        }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Rewrites data-src etc. so lazy-loaders pass proxy URLs to prehook.
  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    for (const attr of el.attributes) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      const absolute = val ? resolveHttp(val) : null;
      if (!absolute || shouldSkip(absolute)) continue;
      el.setAttribute(attr.name, buildProxyUrl(absolute));
      rewrote = true;
    }

    // data-srcset — same per-element cache as normal srcset.
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      let rewritten = dataSrcsetCache.get(el);
      if (!rewritten || rewritten.input !== dss) {
        let touched = false;
        const parts = dss.split(",");
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const m = part.trim().match(/^(\S+)(\s.*)?$/);
          if (!m) continue;
          const url = m[1];
          const absolute = resolveHttp(url);
          if (!absolute || shouldSkip(absolute)) continue;
          parts[i] = buildProxyUrl(absolute) + (m[2] || "");
          touched = true;
        }
        rewritten = { input: dss, output: touched ? parts.join(", ") : dss };
        dataSrcsetCache.set(el, rewritten);
      }
      if (rewritten.output !== dss) {
        el.setAttribute("data-srcset", rewritten.output);
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
    if (!bg || !bg.startsWith("url(")) return;
    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    const absolute = raw ? resolveHttp(raw) : null;
    if (!absolute || shouldSkip(absolute)) return;
    el.style.backgroundImage = `url("${buildProxyUrl(absolute)}")`;
    doneBg.add(el);
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function rewriteAll() {
    // Images and picture sources
    document.querySelectorAll("img, picture source").forEach(rewriteImg);

    // Lazy-loaded images
    document.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);

    // Inline backgrounds only need to scan elements that actually have a style
    // attribute. The MutationObserver handles dynamically changed styles.
    document.querySelectorAll("[style*='background' i]").forEach(rewriteBg);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  // Catches images added or changed after initial load (infinite scroll, SPAs…)
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          rewriteImg(n);
          rewriteLazy(n);
          rewriteBg(n);
          n.querySelectorAll?.("img, source").forEach(rewriteImg);
          n.querySelectorAll?.(LAZY_SELECTOR).forEach(rewriteLazy);
          n.querySelectorAll?.("[style*='background' i]").forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            doneImg.delete(t); // allow re-rewrite when src/srcset changes
            rewriteImg(t);
          }
        } else if (m.attributeName === "style") {
          doneBg.delete(t);
          rewriteBg(t);
        } else if (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset") {
          doneLazy.delete(t);
          rewriteLazy(t);
        }
      }
    }
  });

  mo.observe(document.documentElement, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"]
  });

  // ── Preconnect to proxy ───────────────────────────────────────────────────
  // Injecting <link rel="preconnect"> opens the TCP+TLS connection to the proxy
  // in parallel with HTML parsing, so the first image request doesn't pay the
  // full handshake cost (~100-300 ms on mobile).
  // dns-prefetch is a lighter fallback for browsers that ignore preconnect.
  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      if (document.querySelector(`link[href="${origin}"]`)) return; // already injected
      const root = document.head || document.documentElement;
      if (!root) return;
      const pc = document.createElement("link");
      pc.rel  = "preconnect";
      pc.href = origin;
      pc.crossOrigin = "anonymous";
      root.prepend(pc);
      const dns = document.createElement("link");
      dns.rel  = "dns-prefetch";
      dns.href = origin;
      root.prepend(dns);
    } catch {}
  }

  // ── MAIN-world prehook settings bridge ───────────────────────────────────
  // prehook.js runs in the page MAIN world and therefore cannot access
  // chrome.storage directly. Send the resolved settings across the page
  // message bridge as soon as they are available and whenever they change.
  function sendPrehookSettings(settings) {
    try {
      window.postMessage({ __bwSaver: true, type: "settings", settings: { ...settings } }, "*");
    } catch {}
  }

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      updateProxyConfig({ ...d.bhOpts, proxyBase: WSRV_PROXY });
      excludedDomains = domainSet(opts.excludeDomains);
      pageExcluded = excludedHost(pageHost);
      proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
      sendPrehookSettings(opts);
      if (opts.enabled && opts.proxyBase) {
        injectPreconnect(opts.proxyBase);
        rewriteAll();
      }
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        srcsetCache = new WeakMap();
        dataSrcsetCache = new WeakMap();
        excludedDomains = domainSet(opts.excludeDomains);
        pageExcluded = excludedHost(pageHost);
        proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
        sendPrehookSettings(opts);
        // Write mirror so next page load takes the fast path
        chrome.storage.local.set({ bhOpts: opts });
        if (opts.enabled && opts.proxyBase) {
          injectPreconnect(opts.proxyBase);
          rewriteAll();
        }
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      updateProxyConfig({ ...(changes.bhOpts.newValue || DEFAULTS), proxyBase: WSRV_PROXY });
      srcsetCache = new WeakMap();
      dataSrcsetCache = new WeakMap();
      excludedDomains = domainSet(opts.excludeDomains);
      pageExcluded = excludedHost(pageHost);
      proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
      sendPrehookSettings(opts);
    } else if (area === "sync") {
      // Rebuild opts from the sync change and also refresh the local mirror
      chrome.storage.sync.get(DEFAULTS, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        srcsetCache = new WeakMap();
        dataSrcsetCache = new WeakMap();
        excludedDomains = domainSet(opts.excludeDomains);
        pageExcluded = excludedHost(pageHost);
        proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
        sendPrehookSettings(opts);
        chrome.storage.local.set({ bhOpts: opts });
      });
    }
  });
})();
