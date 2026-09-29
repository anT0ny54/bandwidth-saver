// Bandwidth Guardian — service worker
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
// Keep in sync with defaults.js if either file changes.
const DEFAULTS = {
  enabled:         true,
  proxyBase:       "https://wsrv.nl/",
  quality:         40,
  grayscale:       true,
  maxWidth:        1280,
  excludeDomains:  "google.com gstatic.com",
};

// Rule 1 is no longer added, but we still remove it on every refresh so any
// leftover rule from a previous version of the extension is cleaned up.
const RULE_ID_REDIRECT = 1;  // legacy — removed, never re-added
const RULE_ID_CSP      = 2;  // strips CSP headers so proxy images can load
const ALL_RULE_IDS     = [RULE_ID_REDIRECT, RULE_ID_CSP];

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
  chrome.storage.sync.get(DEFAULTS, function(d) {
    d.proxyBase = WSRV_PROXY;
    chrome.storage.sync.set(d, function() {
      mirrorToLocal();
      refreshRules();
      updateIcon();
    });
  });
});

chrome.runtime.onStartup.addListener(function() {
  mirrorToLocal();
  refreshRules();
  updateIcon();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes) {
    refreshRules();
    updateIcon();
  }
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
    chrome.action.setIcon({ path }).catch?.(() => {});
  });
}

// ── Stats via webRequest response headers ─────────────────────────────────────
// Reads content-length from proxy responses to track delivered proxy bytes.
// Non-blocking — only observes, never delays requests.
function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return false;
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  if (!h) return false;
  const n = parseInt(h.value, 10);
  return isNaN(n) ? false : n;
}

if (chrome.webRequest && !chrome.webRequest.onCompleted.hasListener(onProxyCompleted)) {
  chrome.webRequest.onCompleted.addListener(
    onProxyCompleted,
    { urls: ["https://wsrv.nl/*"], types: ["image"] },
    ["responseHeaders"]
  );
}

let pendingStats = { filesProcessed: 0, bytesProcessed: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;

function flushStats() {
  if (statsFlushInProgress || !pendingStats.filesProcessed) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0 };
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0 } },
    d => {
      const s = d.stats || { filesProcessed: 0, bytesProcessed: 0 };
      delete s.bytesSaved; // retire the old unused stats field from prior versions.
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
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

function onProxyCompleted({ url, responseHeaders, fromCache }) {
  if (fromCache || !url.startsWith("https://wsrv.nl/")) return;

  // wsrv.nl does not expose the old Bandwidth Hero x-bytes-saved /
  // x-original-size headers. Track the actual processed image bytes delivered
  // to the browser instead, which is the bandwidth figure we can verify.
  const bytesReceived = getHeaderInt(responseHeaders, "content-length");
  if (bytesReceived === false) return;

  pendingStats.filesProcessed += 1;
  pendingStats.bytesProcessed += bytesReceived;
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
      condition: { resourceTypes: ["main_frame", "sub_frame"] }
    }];

    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: addRules }, done);
  });
}

