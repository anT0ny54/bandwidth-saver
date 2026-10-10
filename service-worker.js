// Bandwidth Saver — service worker
//
// ══ WHY DNR RULE 1 (image redirect) WAS REMOVED ══════════════════════════════
//
//  Chrome's DNR regexSubstitution inserts the captured URL RAW — there is no
//  way to call encodeURIComponent on it. So for any image URL that contains
//  query parameters the substitution produces a malformed proxy URL:
//
//    Original URL:  https://tvguide.com/img/photo.jpg?auto=webp&width=1092
//    DNR cannot safely encode the captured source URL for its replacement.
//
//  Fix: image src rewriting is now done entirely in content scripts (content.js
//  and prehook.js) which CAN call encodeURIComponent. This is the only correct
//  approach in MV3.
//
//  DNR Rule 2 (CSP header stripping) is kept — it does not need URL encoding.
//
// ══════════════════════════════════════════════════════════════════════════════

// Fixed image proxy. Image requests are rewritten to this URL by content/prehook.
const WSRV_PROXY = "https://wsrv.nl/";

// Kiwi/Cromite do not support ES module service workers ("type": "module"),
// so DEFAULTS is inlined here rather than imported from defaults.js.
// KEEP IN SYNC with defaults.js, prehook.js and content.js.
const DEFAULTS = {
  enabled:         true,
  saveData:        true,
  proxyBase:       WSRV_PROXY,
  quality:         60,
  grayscale:       true,
  maxWidth:        768,
  excludeDomains:  "",
  fallbackToOrigin: true,
};

// Rule 1 is no longer added, but we still remove it on every refresh so any
// leftover rule from a previous version of the extension is cleaned up.
const RULE_ID_REDIRECT = 1;  // legacy — removed, never re-added
const RULE_ID_CSP      = 2;  // strips CSP headers so proxy images can load
const RULE_ID_SAVEDATA  = 3;  // sends Save-Data: on to compatible web requests
const ALL_RULE_IDS     = [RULE_ID_REDIRECT, RULE_ID_CSP, RULE_ID_SAVEDATA];

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing     = false;
let pendingRefresh = false;

function refreshRules() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  doRefreshRules(function() {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshRules();
    }
  });
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// Content scripts read from storage.local (key "bhOpts") rather than
// storage.sync. Local reads take ~5 ms vs ~30-80 ms for sync — every ms saved
// here is a window where the browser might start fetching an original image
// before prehook can intercept it. The service worker keeps bhOpts current.
function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, opts => {
    opts.proxyBase = WSRV_PROXY;
    chrome.storage.local.set({ bhOpts: opts });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  // Top-level mirrorToLocal()/refreshRules()/updateIcon() already ran on this
  // same worker start; only seed missing sync keys here, don't redo the work.
  chrome.storage.sync.get(DEFAULTS, function(d) {
    d.proxyBase = WSRV_PROXY;
    chrome.storage.sync.set(d, function() {
      mirrorToLocal(); // seed the local mirror for content scripts
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes || "excludeDomains" in changes || "saveData" in changes) refreshRules();
  if ("enabled" in changes) updateIcon();
});

mirrorToLocal();
refreshRules();
updateIcon();

// ── Extension icon ────────────────────────────────────────────────────────────
function updateIcon() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
    const on = d.enabled;
    const path = on
      ? { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" }
      : { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
    Promise.resolve(chrome.action.setIcon({ path })).catch(() => {});
  });
}

// ── Stats via webRequest response headers ─────────────────────────────────────
// Reads content-length from proxy responses to track delivered proxy bytes.
// Non-blocking — only observes, never delays requests.
function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return null;
  const target = String(name).toLowerCase();
  const h = headers.find(h => String(h.name).toLowerCase() === target);
  const n = h ? Number.parseInt(h.value, 10) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

if (chrome.webRequest) {
  chrome.webRequest.onCompleted.addListener(
    onProxyCompleted,
    { urls: ["https://wsrv.nl/*"], types: ["image"] },
    ["responseHeaders"]
  );
}

let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;

function flushStats() {
  if (statsFlushInProgress || !pendingStats.filesProcessed) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    d => {
      const s = d.stats || { filesProcessed: 0, bytesProcessed: 0 };
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
      s.bytesSaved = (s.bytesSaved || 0) + delta.bytesSaved;
      chrome.storage.local.set({ stats: s }, () => {
        statsFlushInProgress = false;
        if (pendingStats.filesProcessed) scheduleStatsFlush();
      });
    }
  );
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    flushStats();
  }, 750);
}

function onProxyCompleted({ url, responseHeaders, fromCache, statusCode }) {
  if (fromCache || !url.startsWith("https://wsrv.nl/")) return;
  if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) return;

  // Content-Length is the processed image delivered to the requester;
  // X-Upstream-Response-Length is the source image received by wsrv.nl.
  // Count delivered bytes whenever available. Savings are only measurable
  // when both headers exist, and may be negative if processing increases size.
  const bytesReceived = getHeaderInt(responseHeaders, "content-length");
  if (bytesReceived === null) return;

  const upstreamBytes = getHeaderInt(responseHeaders, "x-upstream-response-length");
  pendingStats.filesProcessed += 1;
  pendingStats.bytesProcessed += bytesReceived;
  if (upstreamBytes !== null) pendingStats.bytesSaved += upstreamBytes - bytesReceived;
  scheduleStatsFlush();
}

// ── DNR rules ─────────────────────────────────────────────────────────────────
// Only Rule 2 (CSP stripping) is active. Rule 1 (redirect) is intentionally
// not added — see top-of-file explanation.
//
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

function doRefreshRules(done) {
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    var removeRuleIds = ALL_RULE_IDS;

    if (!opts.enabled) {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds }, done);
      return;
    }

    // Excluded sites are never proxied, so they keep their own CSP. DNR rejects the
    // whole update on an invalid domain, so only well-formed hostnames are passed.
    var excluded = String(opts.excludeDomains || "").split(/[,\s]+/)
      .map(function(s) { return s.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); })
      .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
    var condition = { resourceTypes: ["main_frame", "sub_frame"] };
    if (excluded.length) condition.excludedRequestDomains = Array.from(new Set(excluded));

    // Rule 2: Strip CSP headers so proxy-domain images aren't blocked by the page.
    var addRules = [{
      id: RULE_ID_CSP,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "content-security-policy",             operation: "remove" },
          { header: "content-security-policy-report-only", operation: "remove" }
        ]
      },
      condition: condition
    }];

    // Rule 3: Replaces the old MV2 webRequestBlocking implementation.
    // DNR can safely set the request header in MV3 without blocking JavaScript.
    if (opts.saveData) {
      // IMPORTANT: urlFilter uses DNR's filter syntax, not a JavaScript
      // regular expression. "^https?://" therefore does NOT mean "start of
      // an http(s) URL" and the old rule never matched normal requests.
      // Use regexFilter for an actual beginning-of-URL expression.
      var saveDataCondition = {
        regexFilter: "^https?://"
      };
      if (excluded.length) {
        saveDataCondition.excludedRequestDomains = Array.from(new Set(excluded));
      }

      addRules.push({
        id: RULE_ID_SAVEDATA,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Save-Data", operation: "set", value: "on" }
          ]
        },
        condition: saveDataCondition
      });
    }

    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: removeRuleIds, addRules: addRules },
      function() {
        if (chrome.runtime.lastError) {
          console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", chrome.runtime.lastError.message);
        }
        done();
      }
    );
  });
}

