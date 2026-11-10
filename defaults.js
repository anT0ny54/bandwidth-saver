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

// Normalizes an exclusion list (space/comma/whitespace separated) into bare
// lowercase hostnames: optional scheme, path, and leading/trailing dots are
// stripped. Shared by popup.js and options.js.
export function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(s => s.toLowerCase()).filter(Boolean)
    .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

// Reloads the web page the user is working on. The active tab wins when it is
// an HTTP(S) page. With fallbackToRecent (used by the settings tab, which is
// itself the active tab after opening from the popup) the most recently
// accessed HTTP(S) tab in the same window is reloaded instead. Errors are
// swallowed: a failed reload only means the user reloads by hand.
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
    const page = tabs
      .filter(tab => tab.id != null && isHttpUrl(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id != null) await chrome.tabs.reload(page.id);
  } catch {}
}
