import { DEFAULTS, parseDomains } from "./defaults.js";

const $ = id => document.getElementById(id);

const enabledEl   = $("enabled");
const grayscaleEl = $("grayscale");
const ctrlCard    = $("ctrlCard");
const headerSub   = $("headerSub");
const statusState = $("statusState");
const statusText  = $("statusText");
const nudge       = $("nudge");
const reloadBtn   = $("reloadBtn");
const siteNameEl  = $("siteName");
const sitePillEl  = $("sitePill");
const excludeBtn  = $("excludeBtn");
const settingsBtn = $("settingsBtn");
const presetBtns  = Array.from(document.querySelectorAll("#qualityPresets .preset"));

// Full settings state. Storage change events only carry the changed keys, so they
// must be merged into this — merging into DEFAULTS reset unchanged keys (e.g. a
// disabled extension appeared enabled after toggling grayscale).
let state = { ...DEFAULTS };
let initialLoadPending = true;
const initialSyncOverrides = Object.create(null);
let currentHost  = "";
let currentIsWeb = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

const coversHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function setActivePreset(q) {
  // Custom qualities should not masquerade as the closest built-in preset.
  presetBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === Number(q)));
}

async function reloadActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && /^https?:\/\//i.test(String(tab.url || ""))) {
      await chrome.tabs.reload(tab.id);
    }
  } catch {}
}

function showNudge() {
  nudge.classList.add("show");
}

// ── UI state ──────────────────────────────────────────────────────────────────

function applyUI(d) {
  enabledEl.checked   = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  setActivePreset(d.quality ?? DEFAULTS.quality);
  updateEnabledUI(!!d.enabled);
}

function updateEnabledUI(enabled) {
  // Only the compression-settings card dims — the enable toggle itself is in a
  // separate card above and stays fully interactive at all times.
  ctrlCard.classList.toggle("card-dim", !enabled);
  headerSub.textContent = enabled ? "Active" : "Disabled";
  statusState.classList.toggle("active", enabled);
  statusText.textContent = enabled ? "Compression active" : "Compression disabled";
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  let stored;
  try {
    stored = await chrome.storage.sync.get(DEFAULTS);
  } catch {
    // A rejected storage read must not leave the popup stuck on the
    // "Checking status…" placeholder — fall back to the shared defaults.
    stored = DEFAULTS;
  }
  // A storage.onChanged event can beat this asynchronous read. Overlay those
  // newer values so the older snapshot cannot roll the UI back.
  state = { ...DEFAULTS, ...(stored || {}), ...initialSyncOverrides };
  // The overlay map is only read by this first load; drop it so the stale
  // entries cannot linger for the life of the popup.
  for (const k of Object.keys(initialSyncOverrides)) delete initialSyncOverrides[k];
  initialLoadPending = false;
  applyUI(state);
  detectSite().then(() => renderSiteUI(state));
}
load();

// ── Enable toggle ─────────────────────────────────────────────────────────────

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  try {
    await chrome.storage.sync.set({ enabled });
  } catch {
    enabledEl.checked = !enabled;
    updateEnabledUI(!enabled);
    return;
  }
  updateEnabledUI(enabled);
  await reloadActiveTab();
  window.close();
});

// ── Grayscale ─────────────────────────────────────────────────────────────────
// Grayscale is applied server-side by the proxy (filt=greyscale). Images already on
// the page can't change without a reload.

grayscaleEl.addEventListener("change", async () => {
  const grayscale = grayscaleEl.checked;
  try {
    await chrome.storage.sync.set({ grayscale });
  } catch {
    grayscaleEl.checked = !grayscale;
    return;
  }
  showNudge();
});

// ── Quality presets ───────────────────────────────────────────────────────────

presetBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const quality = Number(btn.dataset.q);
    setActivePreset(quality);
    try {
      await chrome.storage.sync.set({ quality });
    } catch {
      // Revert to the last quality that actually reached storage. Keep state
      // current on success too, so this revert reflects the latest applied
      // preset even when the storage.onChanged echo has not arrived yet.
      setActivePreset(state.quality ?? DEFAULTS.quality);
      return;
    }
    state.quality = quality;
    await reloadActiveTab();
    window.close();
  });
});

// ── Reload current tab ────────────────────────────────────────────────────────

reloadBtn.addEventListener("click", async () => {
  await reloadActiveTab();
  window.close();
});

// ── Site card ─────────────────────────────────────────────────────────────────

// The active tab cannot change while the popup is open, so it is resolved once;
// later exclusion-list changes only re-render the pill/button.
async function detectSite() {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch { return; }

  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    excludeBtn.disabled = true;
    return;
  }

  let parsed;
  try { parsed = new URL(tab.url); }
  catch { siteNameEl.textContent = "Unknown"; excludeBtn.disabled = true; return; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    siteNameEl.textContent = parsed.protocol.replace(":", "") + " page";
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not a web page";
    excludeBtn.disabled = true;
    return;
  }

  currentIsWeb = true;
  currentHost  = parsed.hostname.toLowerCase();
  siteNameEl.textContent = currentHost;
  excludeBtn.disabled = false;
}

function renderSiteUI(d) {
  if (!currentIsWeb) return;
  const excluded = parseDomains(d.excludeDomains);
  if (excluded.some(domain => coversHost(currentHost, domain))) {
    sitePillEl.textContent = "Excluded";
    sitePillEl.style.display = "";
    excludeBtn.textContent = "✕ Remove exclusion";
  } else {
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Exclude this site";
  }
}

// ── Exclude / re-include current site ────────────────────────────────────────

excludeBtn.addEventListener("click", async () => {
  if (!currentIsWeb || !currentHost) return;
  // `state` is kept current by the storage.onChanged listener below, so no
  // redundant storage.sync read is needed here.
  const list = new Set(parseDomains(state.excludeDomains));
  const covering = Array.from(list).filter(domain => coversHost(currentHost, domain));
  // Re-including must drop EVERY entry that covers this host (e.g. both
  // "example.com" and "www.example.com"); removing only the first left the
  // site excluded while the button claimed otherwise.
  if (covering.length) covering.forEach(domain => list.delete(domain));
  else list.add(currentHost);
  const excludeDomains = Array.from(list).join(" ");
  try {
    await chrome.storage.sync.set({ excludeDomains });
  } catch {
    renderSiteUI(state); // storage did not change; restore the current pill/button
    return;
  }
  state.excludeDomains = excludeDomains;
  renderSiteUI(state); // refresh the pill/button immediately
  showNudge(); // page must reload for the change to take effect
});

// ── Open settings page ────────────────────────────────────────────────────────
// chrome.runtime.openOptionsPage() breaks on Kiwi/Cromite (popup opens as tab).
// tabs.create() works everywhere.

settingsBtn.addEventListener("click", () => {
  const fallback = () => {
    try {
      chrome.runtime.openOptionsPage?.(() => {
        // Read lastError inside the callback for older callback-only browsers.
        void chrome.runtime.lastError;
      });
    } catch {}
  };
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }, () => {
      if (chrome.runtime.lastError) fallback();
    });
  } catch {
    fallback();
  }
});

// ── Sync with changes made on the settings page ───────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  // Apply directly from the change payload — no redundant storage re-read.
  for (const [k, v] of Object.entries(changes)) {
    const value = v.newValue ?? DEFAULTS[k];
    state[k] = value;
    if (initialLoadPending) initialSyncOverrides[k] = value;
  }
  applyUI(state);
  if ("excludeDomains" in changes) renderSiteUI(state);
});
