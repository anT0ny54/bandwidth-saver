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
//  strips CSP response headers while image compression is enabled. Rules 3 and 4
//  add Save-Data whenever its own setting is on, independently of compression.
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
const RULE_ID_SAVEDATA  = 3;  // sends Save-Data: on to compatible subresource/frame requests
const RULE_ID_SAVEDATA_DOC = 4; // same header for top-level navigations (see doRefreshRules)
const ALL_RULE_IDS     = [RULE_ID_REDIRECT, RULE_ID_CSP, RULE_ID_SAVEDATA, RULE_ID_SAVEDATA_DOC];

// Stable serialization (sorted object keys). Used to decide whether a settings
// mirror or a DNR ruleset actually changed before writing it again.
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + canonicalJson(value[k]))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing        = false;
let pendingRefresh    = false;
let refreshGeneration = 0;
let mirroring         = false;
let pendingMirror     = false;
let mirrorGeneration  = 0;

function refreshRules() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  const generation = ++refreshGeneration;
  let settled = false;
  const finish = function() {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshRules();
    }
  };
  // Mirrors the settings-mirror guard: some Chromium forks silently drop a
  // storage/DNR callback instead of reporting lastError. Without a watchdog
  // that dropped callback wedges every later rules refresh behind refreshing=true.
  const watchdog = setTimeout(function() {
    // Invalidate a storage callback that arrives after this timeout even when
    // no newer refresh has started yet. A subsequent refresh will get a fresh
    // generation from refreshRules().
    if (generation === refreshGeneration) refreshGeneration++;
    console.warn("[Bandwidth Saver] DNR rule refresh timed out; releasing refresh guard.");
    finish();
  }, 5000);
  try {
    doRefreshRules(finish, generation);
  } catch (error) {
    console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", error);
    finish();
  }
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// Content scripts read from storage.local (key "bhOpts") rather than
// storage.sync. Local reads take ~5 ms vs ~30-80 ms for sync — every ms saved
// here is a window where the browser might start fetching an original image
// before prehook can intercept it. The service worker keeps bhOpts current.
function mirrorToLocal() {
  if (mirroring) { pendingMirror = true; return; }
  mirroring = true;
  const generation = ++mirrorGeneration;
  let settled = false;
  const finish = function() {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    mirroring = false;
    if (pendingMirror) {
      pendingMirror = false;
      mirrorToLocal();
    }
  };
  // Watchdog: if the sync read never invokes its callback (some forks drop
  // it instead of reporting an error), release the guard so later settings
  // changes are not stuck behind a dead lock forever.
  const watchdog = setTimeout(function() {
    // Invalidate a sync-read callback that arrives after this timeout so a
    // stale snapshot cannot overwrite a newer local mirror (parity with the
    // refreshRules watchdog).
    if (generation === mirrorGeneration) mirrorGeneration++;
    console.warn("[Bandwidth Saver] Settings mirror timed out; releasing mirror guard.");
    finish();
  }, 5000);
  try {
    chrome.storage.sync.get(DEFAULTS, opts => {
      // A callback can arrive after the watchdog released this operation and
      // a newer mirror has started. Never let that older snapshot overwrite it.
      if (settled || generation !== mirrorGeneration) return;
      try {
        const error = chrome.runtime.lastError?.message || "";
        if (error || !opts || typeof opts !== "object") {
          if (error) console.warn("[Bandwidth Saver] Failed to read settings for mirror:", error);
          // Keep any existing mirror on read failure. Content scripts have
          // their own sync fallback and defaults failsafe for a fresh install.
          finish();
          return;
        }
        // The service worker wakes often (every proxied image response is a
        // webRequest event). Skip the write, and the storage.onChanged
        // broadcast it causes in every open tab, when nothing changed.
        chrome.storage.local.get({ bhOpts: null }, function(current) {
          if (settled || generation !== mirrorGeneration) return;
          const readError = chrome.runtime.lastError?.message || "";
          if (!readError && current && canonicalJson(current.bhOpts) === canonicalJson(opts)) {
            finish();
            return;
          }
          chrome.storage.local.set({ bhOpts: opts }, function() {
            // A write callback can arrive after its watchdog and a newer mirror
            // have completed. Re-read sync so a late old write cannot be final.
            if (settled || generation !== mirrorGeneration) {
              mirrorToLocal();
              return;
            }
            finish();
          });
        });
      } catch {
        finish();
      }
    });
  } catch {
    // A synchronous throw (e.g. storage.sync unavailable) must not leave the
    // mirror guard stuck true forever.
    finish();
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  // Top-level mirrorToLocal() already seeded the local mirror on this worker
  // start, and writing the missing sync keys fires storage.onChanged below,
  // which re-mirrors and refreshes the rules — no extra mirror pass is needed.
  // Only seed keys that are genuinely missing: get(null) returns actually-stored
  // keys only, whereas get(DEFAULTS) pre-fills defaults so "missing" could never
  // be detected. Guarded like every other storage call.
  try {
    chrome.storage.sync.get(null, function(all) {
      if (chrome.runtime.lastError) {
        console.warn("[Bandwidth Saver] Failed to read settings during install:", chrome.runtime.lastError.message);
        return;
      }
      const stored = all || {};
      const missing = {};
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in stored)) missing[k] = DEFAULTS[k];
      }
      if (!Object.keys(missing).length) return;
      try {
        chrome.storage.sync.set(missing, function() { void chrome.runtime.lastError; });
      } catch {}
    });
  } catch {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes || "excludeDomains" in changes || "saveData" in changes) refreshRules();
  // A removed key (newValue undefined) means the default applies, not "off".
  if ("enabled" in changes) updateIcon(!!(changes.enabled.newValue ?? DEFAULTS.enabled));
});

// ── Extension icon ────────────────────────────────────────────────────────────
const ICON_PATH_ON  = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
const ICON_PATH_OFF = { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
let iconGeneration = 0;

// Startup sequence. Runs AFTER the icon-path constants exist: updateIcon()'s
// synchronous fallback reads them, and a fork where chrome.storage.sync.get
// throws synchronously must not hit a temporal-dead-zone ReferenceError.
mirrorToLocal();
refreshRules();
updateIcon();

function updateIcon(enabled) {
  const generation = ++iconGeneration;
  const apply = on => {
    if (generation !== iconGeneration) return;
    const path = on ? ICON_PATH_ON : ICON_PATH_OFF;
    // Some Chromium forks throw synchronously instead of returning a rejected
    // promise — catch both so a broken setIcon can never kill worker startup.
    try {
      const r = chrome.action.setIcon({ path });
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {}
  };
  // Callers that already know the value (storage.onChanged) skip the extra
  // storage.sync read; the startup call passes nothing and still reads sync.
  if (typeof enabled === "boolean") { apply(enabled); return; }
  try {
    chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
      if (generation !== iconGeneration) return;
      if (chrome.runtime.lastError) {
        console.warn("[Bandwidth Saver] Failed to read enabled state for icon:", chrome.runtime.lastError.message);
        return;
      }
      const value = d && typeof d.enabled === "boolean" ? d.enabled : DEFAULTS.enabled;
      apply(value);
    });
  } catch {
    apply(DEFAULTS.enabled);
  }
}

// ── Stats via webRequest response headers ─────────────────────────────────────
// Reads content-length from proxy responses to track delivered proxy bytes.
// Non-blocking — only observes, never delays requests.
// Reused for the rare binaryValue header delivery; TextDecoder is stateless
// for single-shot decodes, so one shared instance is safe.
const headerDecoder = new TextDecoder();

function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return null;
  const target = String(name).toLowerCase();
  const h = headers.find(h => String(h.name).toLowerCase() === target);
  if (!h) return null;
  let value = h.value;
  // Some deliveries carry the header only as raw bytes (binaryValue) with no
  // string value; decode those instead of silently dropping the response.
  if (typeof value !== "string" && h.binaryValue) {
    try {
      value = headerDecoder.decode(new Uint8Array(h.binaryValue));
    } catch {
      return null;
    }
  }
  if (typeof value !== "string") return null;
  value = value.trim();
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

// A fork whose storage.local never answers would otherwise retry the same
// failed batch every 750 ms forever, logging a warning on every pass. Cap
// consecutive flush failures; the counter resets on the next successful write
// and is untouched by the reset flow (which discards the batch by design).
const MAX_STATS_FLUSH_FAILURES = 3;
let statsFlushFailures = 0;
let pendingStats = emptyStats();
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
  let settled = false;

  // Watchdog: forks that silently drop storage callbacks would otherwise leave
  // the flush guard stuck true forever, discarding every later observation.
  // finish(delta) preserves the batch for a later retry via retryDelta.
  const watchdog = setTimeout(function() {
    console.warn("[Bandwidth Saver] Stats flush timed out; releasing flush guard.");
    finish(delta);
  }, 5000);

  const finish = function(retryDelta) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    statsFlushInProgress = false;

    if (retryDelta) {
      // Preserve observations when the write fails outside a reset so a later
      // flush can retry instead of silently dropping the batch — but only up
      // to MAX_STATS_FLUSH_FAILURES consecutive attempts, after which the batch
      // is dropped with one warning instead of retrying every 750 ms forever.
      // During a reset the batch is discarded by design and must not count.
      if (!statsResetPending) {
        statsFlushFailures++;
        if (statsFlushFailures < MAX_STATS_FLUSH_FAILURES) {
          pendingStats.filesProcessed += retryDelta.filesProcessed;
          pendingStats.bytesProcessed += retryDelta.bytesProcessed;
          pendingStats.bytesSaved += retryDelta.bytesSaved;
        } else {
          console.warn("[Bandwidth Saver] Stats batch dropped after " +
            MAX_STATS_FLUSH_FAILURES + " failed flush attempts.");
          statsFlushFailures = 0;
        }
      }
    } else {
      statsFlushFailures = 0;
    }

    if (statsResetPending) {
      startStatsReset();
    } else if (pendingStats.filesProcessed) {
      scheduleStatsFlush();
    }
  };

  const persist = function(d) {
    // The watchdog already returned this batch to pendingStats; writing it
    // now as well would count the same observations twice.
    if (settled) return;
    try {
      // A failed read must not fall through to a write: persisting just this
      // delta over an unread total would wipe the accumulated statistics.
      const readError = chrome.runtime.lastError?.message || "";
      if (readError || !d) {
        console.warn("[Bandwidth Saver] Failed to read stats:", readError || "no data");
        finish(delta);
        return;
      }
      // Older or corrupted storage may contain missing fields, non-finite
      // values, or even a primitive/array instead of the expected object.
      // Normalize the complete record before adding this batch so no bad value
      // can poison future totals or silently discard writes to a primitive.
      const stored = d.stats && typeof d.stats === "object" && !Array.isArray(d.stats)
        ? d.stats : {};
      const finite = value => {
        if (typeof value !== "number" && typeof value !== "string") return 0;
        if (typeof value === "string" && value.trim() === "") return 0;
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
      };
      const s = {
        filesProcessed: Math.max(0, Math.trunc(finite(stored.filesProcessed))),
        bytesProcessed: Math.max(0, finite(stored.bytesProcessed)),
        bytesSaved: finite(stored.bytesSaved)
      };
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
      s.bytesSaved += delta.bytesSaved;
      chrome.storage.local.set({ stats: s }, () => {
        const error = chrome.runtime.lastError?.message || "";
        if (error) console.warn("[Bandwidth Saver] Failed to flush stats:", error);
        finish(error ? delta : null);
      });
    } catch (error) {
      console.warn("[Bandwidth Saver] Failed to flush stats:", error);
      finish(delta);
    }
  };

  try {
    chrome.storage.local.get({ stats: emptyStats() }, persist);
  } catch (error) {
    console.warn("[Bandwidth Saver] Failed to flush stats:", error);
    finish(delta);
  }
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
  let settled = false;

  // Watchdog: same dropped-callback fork case as the flush path — release the
  // guard and report failure instead of wedging every later reset request.
  const watchdog = setTimeout(function() {
    console.warn("[Bandwidth Saver] Stats reset timed out; releasing reset guard.");
    finish("timed out");
  }, 5000);

  const finish = function(error) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
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
  };

  try {
    chrome.storage.local.set({ stats: emptyStats() }, () => {
      const error = chrome.runtime.lastError?.message || "";
      if (error) console.warn("[Bandwidth Saver] Failed to reset stats:", error);
      finish(error);
    });
  } catch (error) {
    console.warn("[Bandwidth Saver] Failed to reset stats:", error);
    finish(String(error?.message || error));
  }
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
  statsResetResponders.push(sendResponse);
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
// Rules 3 and 4 (Save-Data) follow their own setting, even when compression is disabled.
//
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

// `finish` is idempotent (see refreshRules), so it can be called from every
// exit path without a second guard here.
function doRefreshRules(finish, generation) {
  try {
    chrome.storage.sync.get(DEFAULTS, function(rawOpts) {
      // A delayed read must not apply an obsolete ruleset after the watchdog
      // has allowed a newer refresh to run.
      if (generation !== refreshGeneration) { finish(); return; }
      const storageError = chrome.runtime.lastError?.message || "";
      if (storageError) {
        console.warn("[Bandwidth Saver] Failed to read settings for DNR rules:", storageError);
        finish();
        return;
      }
      // One guard around rule-building AND the updateDynamicRules call: a
      // synchronous throw in either path must still reach finish() (the
      // async callback below completes via its own finally block).
      try {
        const opts = { ...DEFAULTS, ...(rawOpts || {}) };

        // Excluded sites are never proxied, so they keep their own CSP. DNR rejects the
        // whole update on an invalid domain, so only well-formed hostnames are passed.
        const excluded = String(opts.excludeDomains || "").split(/[,\s]+/)
          .map(function(s) { return s.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""); })
          .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
        const excludedDomainList = Array.from(new Set(excluded));
        const cspCondition = { resourceTypes: ["main_frame", "sub_frame"] };
        if (excludedDomainList.length) {
          // CSP follows the document/frame URL because content scripts decide by
          // pageHost. A non-excluded frame or popup opened from an excluded site
          // is still processed there, so preserving CSP by initiator would break
          // its proxied images.
          cspCondition.excludedRequestDomains = excludedDomainList;
        }

        const addRules = [];

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
            condition: cspCondition
          });
        }

        // Rules 3 and 4: Save-Data. This replaces the old MV2 webRequestBlocking
        // implementation; DNR sets the request header in MV3 without blocking JavaScript.
        if (opts.saveData) {
          // IMPORTANT: urlFilter uses DNR's filter syntax, not a JavaScript
          // regular expression. "^https?://" therefore does NOT mean "start of
          // an http(s) URL" and the old rule never matched normal requests.
          // Use regexFilter for an actual beginning-of-URL expression.
          //
          // Save-Data is a document-wide client hint, so it must reach every
          // request type. A rule without resourceTypes matches all types EXCEPT
          // main_frame, and the top-level navigation is exactly the request a
          // server uses to choose a lower-data page. Rule 3 therefore covers
          // everything else and rule 4 covers main_frame, with no hard-coded
          // type list that a future or unsupported type name could invalidate.
          const saveDataAction = () => ({
            type: "modifyHeaders",
            requestHeaders: [{ header: "Save-Data", operation: "set", value: "on" }]
          });
          const saveDataCondition = { regexFilter: "^https?://" };
          const saveDataDocCondition = { regexFilter: "^https?://", resourceTypes: ["main_frame"] };
          if (excludedDomainList.length) {
            saveDataCondition.excludedRequestDomains = excludedDomainList;
            saveDataCondition.excludedInitiatorDomains = excludedDomainList;
            saveDataDocCondition.excludedRequestDomains = excludedDomainList;
            saveDataDocCondition.excludedInitiatorDomains = excludedDomainList;
          }

          addRules.push({ id: RULE_ID_SAVEDATA, priority: 2, action: saveDataAction(), condition: saveDataCondition });
          addRules.push({ id: RULE_ID_SAVEDATA_DOC, priority: 2, action: saveDataAction(), condition: saveDataDocCondition });
        }

        applyDynamicRules(addRules, finish, generation);
      } catch (error) {
        console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", error);
        finish();
      }
    });
  } catch (error) {
    console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", error);
    finish();
  }
}

// Releases a refresh whose result arrived after its watchdog or a newer refresh.
// Capture `refreshing` BEFORE finish(): finish() resets the shared guard, so a
// check afterwards could never detect a newer refresh already in flight. When a
// newer refresh is running, its ruleset supersedes this one; reschedule only
// when nothing else will.
function releaseStaleRefresh(finish) {
  const superseded = refreshing;
  finish();
  if (!superseded) refreshRules();
}

// Writes the ruleset only when it differs from the one DNR already holds. The
// worker re-runs this on every wake, and an identical rebuild is wasted work.
function applyDynamicRules(addRules, finish, generation) {
  const sortById = rules => rules.slice().sort((a, b) => a.id - b.id);
  chrome.declarativeNetRequest.getDynamicRules(function(current) {
    if (generation !== refreshGeneration) { releaseStaleRefresh(finish); return; }
    const readError = chrome.runtime.lastError?.message || "";
    if (!readError && Array.isArray(current) &&
        canonicalJson(sortById(current)) === canonicalJson(sortById(addRules))) {
      finish();
      return;
    }
    writeDynamicRules(addRules, finish, generation);
  });
}

function writeDynamicRules(addRules, finish, generation) {
  try {
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: ALL_RULE_IDS, addRules: addRules },
      function() {
        if (generation !== refreshGeneration) {
          // The request reached DNR after its watchdog expired or a newer
          // refresh started. Release this guard before scheduling the fresh
          // refresh; finish() is idempotent, so this is safe either way.
          releaseStaleRefresh(finish);
          return;
        }
        try {
          if (chrome.runtime.lastError) {
            console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", chrome.runtime.lastError.message);
          }
        } finally {
          finish();
        }
      }
    );
  } catch (error) {
    console.warn("[Bandwidth Saver] Failed to refresh DNR rules:", error);
    finish();
  }
}
