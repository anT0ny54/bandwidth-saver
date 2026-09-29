// Bandwidth Saver — MAIN-world prehook (document_start)
//
// No chrome.* APIs are used here because MAIN-world scripts share the page's
// JavaScript environment. The isolated content script supplies live settings
// through window.postMessage(). Conservative defaults are active immediately,
// preventing page-side JS from leaking original image URLs while settings load.
//
// Intercepts synchronously:
//   • new Image() / HTMLImageElement.src / srcset
//   • Element.setAttribute("src" / "srcset")
//   • <picture><source srcset>
//   • HTMLImageElement.loading (preserved; does not trigger a network request)
//   • JS-created <link rel="preload" as="image" href="…">
//   • link href/as/rel and setAttribute mutations
//
// Parser-created <link rel=preload as=image> is also watched, but the HTML
// parser/preload scanner may begin that request before JavaScript can observe
// the element. No MV3 JavaScript hook can synchronously rewrite such a parser
// preload URL before the scanner without a network-level redirect.
(() => {
  "use strict";

  const WSRV_PROXY = "https://wsrv.nl/";
  const defaults = {
    enabled: true,
    proxyBase: WSRV_PROXY,
    quality: 60,
    grayscale: true,
    maxWidth: 768,
    excludeDomains: "google.com gstatic.com"
  };

  let opts = { ...defaults };
  let excludedDomains = new Set();
  let pageExcluded = false;
  let proxyConfig = null;
  const pageHost = location.hostname.toLowerCase();
  const srcsetCache = new WeakMap();

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
  const TINY_URL_RE = /(?:^|[._\/-])(1x1|2x2|pixel|spacer|tracking)(?:[._\/-]|$)/i;
  const TINY_DIM_RE = /(?:[?&](?:w|width|h|height)=)(?:[0-9]|[12][0-9]|3[0-2])(?:[&#]|$)/i;
  const isTinyOrTracking = u => TINY_URL_RE.test(u) || TINY_DIM_RE.test(u);
  const SVG_URL_RE = /\.svg(?:[?#]|$)/i;
  const isWsrvUrl = u => {
    try { return new URL(u).hostname.toLowerCase() === "wsrv.nl"; } catch { return false; }
  };

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

  function updateSettings(next) {
    opts = { ...defaults, ...(next || {}) };
    opts.proxyBase = WSRV_PROXY;
    excludedDomains = toDomainSet(opts.excludeDomains);
    pageExcluded = excludedHost(pageHost);

    const base = String(opts.proxyBase || "").trim();
    if (!base) {
      proxyConfig = null;
      return;
    }
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = {
      base,
      sep: base.includes("?") ? "&" : "?",
      quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0,
      grayscale: !!opts.grayscale
    };
  }

  function buildProxyUrl(orig) {
    if (!proxyConfig || !/^https?:\/\//i.test(orig)) return orig;
    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const parts = ["url=" + encodeURIComponent(orig), "q=" + quality];
    if (maxWidth) parts.push("w=" + maxWidth, "fit=inside", "we=1", "dpr=2");
    if (grayscale) parts.push("filt=greyscale");
    parts.push("maxage=1d", "page=-1", "n=-1", "output=webp");
    return base + sep + parts.join("&");
  }

  function shouldSkip(original) {
    const absolute = resolveHttp(original);
    if (!absolute) return true;
    if (isWsrvUrl(absolute)) return true;
    if (!opts.enabled || !opts.proxyBase || pageExcluded) return true;
    const lower = absolute.toLowerCase();
    if (isTinyOrTracking(lower) || SVG_URL_RE.test(absolute)) return true;
    if (lower.includes("favicon") || lower.endsWith(".ico") ||
        lower.includes(".ico?") || lower.includes(".ico#")) return true;
    const u = safeURL(absolute);
    return !u || excludedHost(u.hostname);
  }

  function decideSrc(value) {
    const absolute = resolveHttp(value);
    if (!absolute || shouldSkip(absolute)) return value;
    return buildProxyUrl(absolute);
  }

  function rewriteSrcset(ss, el) {
    if (!ss || shouldSkip("https://example.invalid/")) {
      // The dummy check above only avoids a second options branch; srcset
      // candidates are evaluated individually below.
    }
    if (!ss || !opts.enabled || !opts.proxyBase || pageExcluded) return ss;
    const cached = el && srcsetCache.get(el);
    if (cached && cached.input === ss) return cached.output;

    const parts = ss.split(",");
    let touched = false;
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) continue;
      const absolute = resolveHttp(m[1]);
      if (!absolute || shouldSkip(absolute)) continue;
      parts[i] = buildProxyUrl(absolute) + (m[2] || "");
      touched = true;
    }
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  // Capture native descriptors/functions before patching.
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const loadingDesc = Object.getOwnPropertyDescriptor(imgProto, "loading");
  const elementSetAttribute = Element.prototype.setAttribute;
  const sourceProto = typeof HTMLSourceElement !== "undefined" ? HTMLSourceElement.prototype : null;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;
  const linkProto = typeof HTMLLinkElement !== "undefined" ? HTMLLinkElement.prototype : null;
  const linkHrefDesc = linkProto ? Object.getOwnPropertyDescriptor(linkProto, "href") : null;
  const linkRelDesc = linkProto ? Object.getOwnPropertyDescriptor(linkProto, "rel") : null;
  const linkAsDesc = linkProto ? Object.getOwnPropertyDescriptor(linkProto, "as") : null;

  const nativeSetSrc = (el, value) => srcDesc?.set?.call(el, value);
  const nativeSetSrcset = (el, value) => srcsetDesc?.set?.call(el, value);
  const nativeSourceSetSrcset = (el, value) => sourceSrcsetDesc?.set?.call(el, value);

  function isImagePreload(link) {
    if (!link || link.tagName !== "LINK") return false;
    const rel = String(link.rel || "").toLowerCase().split(/\s+/);
    const as = String(link.as || "").toLowerCase();
    return rel.includes("preload") && as === "image";
  }

  function rewriteImagePreload(link) {
    if (!isImagePreload(link)) return;
    const href = linkHrefDesc?.get ? linkHrefDesc.get.call(link) : link.getAttribute("href");
    if (!href) return;
    const absolute = resolveHttp(href);
    if (!absolute || shouldSkip(absolute)) return;
    const rewritten = buildProxyUrl(absolute);
    if (rewritten === href) return;
    // Native href setter avoids our setAttribute patch recursively.
    if (linkHrefDesc?.set) linkHrefDesc.set.call(link, rewritten);
    else elementSetAttribute.call(link, "href", rewritten);
  }

  function rewriteLinkAttribute(link, name, value) {
    if (!link || link.tagName !== "LINK") return false;
    const n = String(name).toLowerCase();
    if (n !== "href" && n !== "rel" && n !== "as") return false;

    if (n === "href") {
      const absolute = resolveHttp(String(value));
      if (absolute && isImagePreload(link) && !shouldSkip(absolute)) {
        const rewritten = buildProxyUrl(absolute);
        if (rewritten !== String(value)) {
          if (linkHrefDesc?.set) linkHrefDesc.set.call(link, rewritten);
          else elementSetAttribute.call(link, "href", rewritten);
          return true;
        }
      }
      return false;
    }

    // rel/as changes can turn an existing href into an image preload.
    queueMicrotask(() => rewriteImagePreload(link));
    return false;
  }

  // <img>.src
  if (srcDesc?.set) {
    Object.defineProperty(imgProto, "src", {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get: srcDesc.get,
      set(value) {
        try { nativeSetSrc(this, decideSrc(String(value))); }
        catch { nativeSetSrc(this, value); }
      }
    });
  }

  // <img>.srcset
  if (srcsetDesc?.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try { nativeSetSrcset(this, rewriteSrcset(String(value || ""), this)); }
        catch { nativeSetSrcset(this, value); }
      }
    });
  }

  // <img>.loading is deliberately preserved. Reading/writing it never fetches
  // the image, so forwarding the native descriptor avoids breaking lazy/LCP
  // behavior while still making the property explicitly covered by the hook.
  if (loadingDesc?.set) {
    Object.defineProperty(imgProto, "loading", {
      configurable: true,
      enumerable: loadingDesc.enumerable,
      get: loadingDesc.get,
      set(value) {
        try { loadingDesc.set.call(this, value); } catch { /* native fallback */ }
      }
    });
  }

  // <source>.srcset
  if (sourceProto && sourceSrcsetDesc?.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try { nativeSourceSetSrcset(this, rewriteSrcset(String(value || ""), this)); }
        catch { nativeSourceSetSrcset(this, value); }
      }
    });
  }

  // <link> preload interception for page-JS-created links.
  if (linkProto) {
    if (linkHrefDesc?.set) {
      Object.defineProperty(linkProto, "href", {
        configurable: true,
        enumerable: linkHrefDesc.enumerable,
        get: linkHrefDesc.get,
        set(value) { rewriteLinkAttribute(this, "href", value) || linkHrefDesc.set.call(this, value); }
      });
    }
    if (linkRelDesc?.set) {
      Object.defineProperty(linkProto, "rel", {
        configurable: true,
        enumerable: linkRelDesc.enumerable,
        get: linkRelDesc.get,
        set(value) { linkRelDesc.set.call(this, value); rewriteImagePreload(this); }
      });
    }
    if (linkAsDesc?.set) {
      Object.defineProperty(linkProto, "as", {
        configurable: true,
        enumerable: linkAsDesc.enumerable,
        get: linkAsDesc.get,
        set(value) { linkAsDesc.set.call(this, value); rewriteImagePreload(this); }
      });
    }
  }

  // Attribute-level interception covers setAttribute() and dynamically
  // generated preload links before the browser sees their final URL.
  Element.prototype.setAttribute = function(name, value) {
    try {
      const n = String(name).toLowerCase();
      if (this instanceof HTMLImageElement) {
        if (n === "src") return elementSetAttribute.call(this, "src", decideSrc(String(value)));
        if (n === "srcset") return elementSetAttribute.call(this, "srcset", rewriteSrcset(String(value || ""), this));
      }
      if (typeof HTMLSourceElement !== "undefined" && this instanceof HTMLSourceElement && n === "srcset") {
        return elementSetAttribute.call(this, "srcset", rewriteSrcset(String(value || ""), this));
      }
      if (typeof HTMLLinkElement !== "undefined" && this instanceof HTMLLinkElement) {
        if (n === "href") {
          const absolute = resolveHttp(String(value));
          if (absolute && isImagePreload(this) && !shouldSkip(absolute)) {
            return elementSetAttribute.call(this, "href", buildProxyUrl(absolute));
          }
        }
        const result = elementSetAttribute.call(this, name, value);
        if (n === "rel" || n === "as") rewriteImagePreload(this);
        return result;
      }
    } catch { /* fall through to native */ }
    return elementSetAttribute.call(this, name, value);
  };

  // Covers parser-created elements and property/attribute changes that happen
  // outside the patched setters. It also handles dynamically assigned picture
  // sources and rel/as transitions.
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n instanceof HTMLImageElement) {
            const src = n.getAttribute("src");
            if (src) nativeSetSrc(n, decideSrc(src));
            const ss = n.getAttribute("srcset");
            if (ss) nativeSetSrcset(n, rewriteSrcset(ss, n));
          } else if (typeof HTMLSourceElement !== "undefined" && n instanceof HTMLSourceElement) {
            const ss = n.getAttribute("srcset");
            if (ss) nativeSourceSetSrcset(n, rewriteSrcset(ss, n));
          } else if (typeof HTMLLinkElement !== "undefined" && n instanceof HTMLLinkElement) {
            rewriteImagePreload(n);
          }
          n.querySelectorAll?.("img, source, link").forEach(el => {
            if (el instanceof HTMLImageElement) {
              const src = el.getAttribute("src");
              if (src) nativeSetSrc(el, decideSrc(src));
              const ss = el.getAttribute("srcset");
              if (ss) nativeSetSrcset(el, rewriteSrcset(ss, el));
            } else if (typeof HTMLSourceElement !== "undefined" && el instanceof HTMLSourceElement) {
              const ss = el.getAttribute("srcset");
              if (ss) nativeSourceSetSrcset(el, rewriteSrcset(ss, el));
            } else if (typeof HTMLLinkElement !== "undefined" && el instanceof HTMLLinkElement) {
              rewriteImagePreload(el);
            }
          });
        }
      } else if (m.type === "attributes") {
        const el = m.target;
        if (el instanceof HTMLImageElement && (m.attributeName === "src" || m.attributeName === "srcset")) {
          if (m.attributeName === "src") nativeSetSrc(el, decideSrc(el.getAttribute("src") || ""));
          else nativeSetSrcset(el, rewriteSrcset(el.getAttribute("srcset") || "", el));
        } else if (typeof HTMLSourceElement !== "undefined" && el instanceof HTMLSourceElement && m.attributeName === "srcset") {
          nativeSourceSetSrcset(el, rewriteSrcset(el.getAttribute("srcset") || "", el));
        } else if (typeof HTMLLinkElement !== "undefined" && el instanceof HTMLLinkElement &&
                   (m.attributeName === "href" || m.attributeName === "rel" || m.attributeName === "as")) {
          rewriteImagePreload(el);
        }
      }
    }
  });

  function startObserver() {
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "href", "rel", "as"]
      });
    } else {
      document.addEventListener("DOMContentLoaded", () => startObserver(), { once: true });
    }
  }
  startObserver();

  // Settings bridge from the isolated content script. Page JS can technically
  // send the same event, but the values only affect compression behavior; they
  // do not grant extension privileges or expose extension storage.
  window.addEventListener("message", event => {
    if (event.source !== window || !event.data || event.data.__bwSaver !== true) return;
    if (event.data.type !== "settings") return;
    updateSettings(event.data.settings);
  });

  // Signal readiness so the isolated bridge can immediately send its settings
  // once it has read chrome.storage.
  try { window.postMessage({ __bwSaver: true, type: "prehook-ready" }, "*"); } catch {}

  updateSettings(defaults);
})();
