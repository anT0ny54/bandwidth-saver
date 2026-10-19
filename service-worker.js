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
//  DNR is kept only for header work, which needs no URL encoding: Rule 2
//  strips CSP response headers while image compression is enabled. Rule 3
//  adds Save-Data whenever its own setting is on, independently of compression.
//
// ══════════════════════════════════════════════════════════════════════════════

// Kiwi/Cromite do not support ES module service workers ("type": "module"),
// so DEFAULTS is inlined here rather than imported from defaults.js.
// KEEP IN SYNC with defaults.js, prehook.js and content.js.
const DEFAULTS = {
  enabled:         true,
  saveData:        true,
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
let mirroring      = false;
let pendingMirror  = false;

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
  if (mirroring) { pendingMirror = true; return; }
  mirroring = true;
  chrome.storage.sync.get(DEFAULTS, opts => {
    chrome.storage.local.set({ bhOpts: opts }, () => {
      mirroring = false;
      if (pendingMirror) {
        pendingMirror = false;
        mirrorToLocal();
      }
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  // Top-level mirrorToLocal()/refreshRules()/updateIcon() already ran on this
  // same worker start; only seed missing sync keys here, don't redo the work.
  chrome.storage.sync.get(DEFAULTS, function(d) {
    chrome.storage.sync.set(d, function() {
      mirrorToLocal(); // seed the local mirror for content scripts
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes || "excludeDomains" in changes || "saveData" in changes) refreshRules();
  if ("enabled" in changes) updateIcon(!!changes.enabled.newValue);
});

mirrorToLocal();
refreshRules();
updateIcon();

// ── Extension icon ────────────────────────────────────────────────────────────
function updateIcon(enabled) {
  const apply = on => {
    const path = on
      ? { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" }
      : { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
    Promise.resolve(chrome.action.setIcon({ path })).catch(() => {});
  };
  // Callers that already know the value (storage.onChanged) skip the extra
  // storage.sync read; the startup call passes nothing and still reads sync.
  if (typeof enabled === "boolean") { apply(enabled); return; }
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => apply(!!d.enabled));
}

// ── Stats via webRequest response headers ─────────────────────────────────────
// Reads content-length from proxy responses to track delivered proxy bytes.
// Non-blocking — only observes, never delays requests.
function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return null;
  const target = String(name).toLowerCase();
  const h = headers.find(h => String(h.name).toLowerCase() === target);
  if (!h || typeof h.value !== "string") return null;
  const value = h.value.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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
let statsResetPending = false;
let statsResetWriteInProgress = false;
let statsResetResponders = [];

function emptyStats() {
  return { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
}

function flushStats() {
  if (statsFlushInProgress || statsResetPending || statsResetWriteInProgress ||
      !pendingStats.filesProcessed) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = emptyStats();
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    d => {
      const s = d.stats || { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
      s.bytesSaved = (s.bytesSaved || 0) + delta.bytesSaved;
      chrome.storage.local.set({ stats: s }, () => {
        statsFlushInProgress = false;
        if (statsResetPending) {
          startStatsReset();
        } else if (pendingStats.filesProcessed) {
          scheduleStatsFlush();
        }
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

function startStatsReset() {
  if (!statsResetPending || statsFlushInProgress || statsResetWriteInProgress) return;
  statsResetPending = false;
  statsResetWriteInProgress = true;
  chrome.storage.local.set({ stats: emptyStats() }, () => {
    const error = chrome.runtime.lastError?.message || "";
    statsResetWriteInProgress = false;

    // A second reset may have arrived while this write was in flight. Complete
    // that reset before acknowledging either request.
    if (statsResetPending) {
      startStatsReset();
      return;
    }

    const responders = statsResetResponders;
    statsResetResponders = [];
    responders.forEach(sendResponse => {
      try { sendResponse({ ok: !error, error }); } catch {}
    });
    if (pendingStats.filesProcessed) scheduleStatsFlush();
  });
}

// Reset both persisted totals and the worker's in-memory batch. Serializing the
// reset after any in-flight flush prevents stale counters from reappearing.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "BW_RESET_STATS") return;

  pendingStats = emptyStats();
  if (statsFlushTimer) {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = null;
  }
  statsResetPending = true;
  if (typeof sendResponse === "function") statsResetResponders.push(sendResponse);
  startStatsReset();
  return true;
});

function onProxyCompleted({ responseHeaders, fromCache, statusCode }) {
  // The listener is registered with { urls: ["https://wsrv.nl/*"] }, so the
  // URL can only ever be a proxy URL — the old prefix check was unreachable.
  if (fromCache) return;
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
// Rule 1 (redirect) is intentionally not added — see top-of-file explanation.
// Rule 2 (CSP stripping) is active only while image compression is enabled.
// Rule 3 (Save-Data) follows its own setting, even when compression is disabled.
//
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

function doRefreshRules(done) {
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    var removeRuleIds = ALL_RULE_IDS;

    // Excluded sites are never proxied, so they keep their own CSP. DNR rejects the
    // whole update on an invalid domain, so only well-formed hostnames are passed.
    var excluded = String(opts.excludeDomains || "").split(/[,\s]+/)
      .map(function(s) { return s.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); })
      .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
    var excludedDomainList = Array.from(new Set(excluded));
    var condition = { resourceTypes: ["main_frame", "sub_frame"] };
    if (excludedDomainList.length) {
      // Request-domain exclusions protect direct navigations; initiator
      // exclusions also preserve CSP for frames opened by excluded sites.
      condition.excludedRequestDomains = excludedDomainList;
      condition.excludedInitiatorDomains = excludedDomainList;
    }

    var addRules = [];

    // Rule 2: Strip CSP only while image URL rewriting is enabled.
    if (opts.enabled) {
      addRules.push({
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
      });
    }

    // Rule 3: Replaces the old MV2 webRequestBlocking implementation.
    // DNR can safely set the request header in MV3 without blocking JavaScript.
    if (opts.saveData) {
      // IMPORTANT: urlFilter uses DNR's filter syntax, not a JavaScript
      // regular expression. "^https?://" therefore does NOT mean "start of
      // an http(s) URL" and the old rule never matched normal requests.
      // Use regexFilter for an actual beginning-of-URL expression.
      // Intentionally matches ALL request types: Save-Data is a document-wide
      // client hint — servers may serve lower-data stylesheets, scripts and
      // fonts as well as images, so restricting resourceTypes would weaken it.
      var saveDataCondition = {
        regexFilter: "^https?://"
      };
      if (excludedDomainList.length) {
        saveDataCondition.excludedRequestDomains = excludedDomainList;
        saveDataCondition.excludedInitiatorDomains = excludedDomainList;
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
