// Bandwidth Saver — shared defaults
// Single source of truth. options.js and popup.js import this.
// content.js, prehook.js and service-worker.js inline a copy (search "KEEP IN SYNC").
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   Normal quality preset: 60

export const DEFAULTS = {
  enabled:          true,
  saveData:         true,   // Send Save-Data: on on web requests
  quality:          60,     // Normal preset
  grayscale:        true,   // matches original convertBw: true — grayscale ON by default
  maxWidth:         768,    // HD preset; 0 = no limit
  excludeDomains:   "",
  fallbackToOrigin: true,   // always restore original URL if the proxied image errors
};

// Reduces one exclusion entry to the bare hostname that page hosts are matched
// against. Optional scheme and path, a leading "*." or dots, and trailing dots
// are dropped. Internationalized names are converted to their ASCII (punycode)
// form, because location.hostname and DNR use that form.
// KEEP IN SYNC across defaults.js, content.js, prehook.js and service-worker.js.
function normalizeDomainToken(token) {
  const host = String(token).toLowerCase()
    .replace(/^https?:\/\//, "").split("/")[0]
    .replace(/^(?:\*\.|\.+)/, "").replace(/\.+$/, "");
  if (!host) return "";
  try { return new URL("http://" + host).hostname.replace(/\.+$/, ""); }
  catch { return host; }
}

// Normalizes an exclusion list (space/comma/whitespace separated) into bare
// lowercase hostnames: optional scheme, path, and leading/trailing dots are
// stripped. Shared by popup.js and options.js.
export function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(normalizeDomainToken)
    .filter(Boolean);
}

// Reloads the web page the user is working on. The active tab wins when it is
// an HTTP(S) page. With fallbackToRecent (used by the settings tab, which is
// itself the active tab after opening from the popup) the most recently
// accessed HTTP(S) tab in the same window is reloaded instead. Chromium added
// Tab.lastAccessed in version 121; on older versions, use the nearest web tab
// by tab-strip index rather than treating every candidate as equally recent.
// Errors are swallowed: a failed reload only means the user reloads by hand.
export async function reloadWebTab({ fallbackToRecent = false } = {}) {
  const isHttpUrl = url => /^https?:\/\//i.test(String(url || ""));
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find(t => t.active);
    if (active?.id != null && isHttpUrl(active.url)) {
      await chrome.tabs.reload(active.id);
      return;
    }
    if (!fallbackToRecent) return;

    const pages = tabs.filter(tab => tab.id != null && isHttpUrl(tab.url));
    // Use timestamps only when the API supplied one for every candidate.
    // A partial set must not silently rank tabs without timestamps last.
    const hasCompleteAccessTimestamps = pages.length > 0 &&
      pages.every(tab => Number.isFinite(tab.lastAccessed));
    pages.sort((a, b) => {
      if (hasCompleteAccessTimestamps && a.lastAccessed !== b.lastAccessed) {
        return b.lastAccessed - a.lastAccessed;
      }

      // Tab.lastAccessed is unavailable before Chrome 121. The settings tab
      // is active in this case, so the closest eligible tab is the best
      // available approximation of the page the user came from. When two
      // tabs are equally close, prefer the tab immediately before settings:
      // options pages are commonly opened next to their source tab.
      if (Number.isInteger(active?.index) && Number.isInteger(a.index) && Number.isInteger(b.index)) {
        const distance = Math.abs(a.index - active.index) - Math.abs(b.index - active.index);
        if (distance) return distance;
      }
      return (Number(a.index) || 0) - (Number(b.index) || 0);
    });

    const page = pages[0];
    if (page?.id != null) await chrome.tabs.reload(page.id);
  } catch {}
}
