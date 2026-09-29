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
    enabled: true, proxyBase: WSRV_PROXY, quality: 40, grayscale: true,
    maxWidth: 1920, excludeDomains: "google.com gstatic.com", isWebpSupported: false
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
  const done = new WeakSet(); // elements already processed — no double-rewrites
  let excludedDomains = new Set();
  let proxyHost = "wsrv.nl";
  const pageHost = location.hostname.toLowerCase();
  const lazyAttrSet = new Set(LAZY_ATTRS);
  // Cache the last srcset transformation per element. Dynamic sites often
  // write the same srcset repeatedly while hydrating/re-rendering.
  const srcsetCache = new WeakMap();
  const dataSrcsetCache = new WeakMap();
  const LAZY_SELECTOR = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = u => { try { return new URL(u); } catch { return null; } };
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
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
    );
  }

  function shouldSkip(url) {
    if (!opts?.enabled || !opts?.proxyBase || !isHttp(url)) return true;

    // Fast exits before URL parsing. These checks run for every candidate image.
    // Keep them conservative so valid image URLs are never skipped accidentally.
    if (excludedDomains.has(pageHost)) return true;
    const lower = url.toLowerCase();
    if (proxyHost && lower.startsWith("https://" + proxyHost + "/")) return true;
    if (lower.includes("favicon")) return true;
    if (lower.endsWith(".ico") || lower.includes(".ico?") || lower.includes(".ico#") ||
        lower.endsWith(".svg") || lower.includes(".svg?") || lower.includes(".svg#")) return true;
    if (isTinyOrTracking(lower)) return true;
    if (TRACKING_PATTERNS.some(p => p.test(url))) return true;

    const u = safeURL(url);
    if (!u) return true;

    // Already proxied (handles non-https/case variations safely).
    if (proxyHost && u.hostname.toLowerCase() === proxyHost) return true;

    // Excluded image host. Cached because this runs for every image.
    const host = u.hostname.toLowerCase();
    if (excludedDomains.has(host)) return true;

    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
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

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  const nativeImgSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;

  function rewriteImg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // src
      const src = el.getAttribute("src");
      if (src && isHttp(src) && !shouldSkip(src)) {
        // Use native src setter to avoid triggering prehook's patch again
        nativeImgSrcSetter?.call(el, buildProxyUrl(src));
        rewrote = true;
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
            if (!isHttp(url) || shouldSkip(url)) continue;
            parts[i] = buildProxyUrl(url) + (m[2] || "");
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

    if (rewrote) done.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Rewrites data-src etc. so lazy-loaders pass proxy URLs to prehook.
  function rewriteLazy(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    for (const attr of el.attributes) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      if (!val || !isHttp(val) || shouldSkip(val)) continue;
      el.setAttribute(attr.name, buildProxyUrl(val));
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
          if (!isHttp(url) || shouldSkip(url)) continue;
          parts[i] = buildProxyUrl(url) + (m[2] || "");
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

    if (rewrote) done.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    const bg = el.style?.backgroundImage;
    if (!bg || !bg.startsWith("url(")) return;
    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    if (!raw || !isHttp(raw) || shouldSkip(raw)) return;
    el.style.backgroundImage = `url("${buildProxyUrl(raw)}")`;
    done.add(el);
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function rewriteAll() {
    // Images and picture sources
    document.querySelectorAll("img, picture source").forEach(rewriteImg);

    // Lazy-loaded images
    document.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);

    // Inline backgrounds only need to scan elements that actually have a style
    // attribute. The MutationObserver handles dynamically changed styles.
    document.querySelectorAll("[style*='background']").forEach(rewriteBg);
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
          n.querySelectorAll?.("[style*='background']").forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            done.delete(t); // allow re-rewrite when src changes
            rewriteImg(t);
          }
        } else if (m.attributeName === "style") {
          done.delete(t);
          rewriteBg(t);
        } else if (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset") {
          done.delete(t);
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

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      updateProxyConfig({ ...d.bhOpts, proxyBase: WSRV_PROXY });
      excludedDomains = domainSet(opts.excludeDomains);
      proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
      if (opts.enabled && opts.proxyBase) {
        injectPreconnect(opts.proxyBase);
        rewriteAll();
      }
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        excludedDomains = domainSet(opts.excludeDomains);
        proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
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
      excludedDomains = domainSet(opts.excludeDomains);
      proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
    } else if (area === "sync") {
      // Rebuild opts from the sync change and also refresh the local mirror
      chrome.storage.sync.get(DEFAULTS, synced => {
        updateProxyConfig({ ...synced, proxyBase: WSRV_PROXY });
        excludedDomains = domainSet(opts.excludeDomains);
        proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "wsrv.nl";
        chrome.storage.local.set({ bhOpts: opts });
      });
    }
  });
})();
