import { DEFAULTS } from "./defaults.js";

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

const PRESETS = [45, 60, 80];

// Full settings state. Storage change events only carry the changed keys, so they
// must be merged into this — merging into DEFAULTS reset unchanged keys (e.g. a
// disabled extension appeared enabled after toggling grayscale).
let state = { ...DEFAULTS };
let currentHost  = "";
let currentIsWeb = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => s.replace(/^https?:\/\//, "").split("/")[0]);
}

function findExcludedDomain(host, domains) {
  return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || "";
}

function nearestPreset(q) {
  return PRESETS.reduce((best, v) =>
    Math.abs(v - q) < Math.abs(best - q) ? v : best, PRESETS[0]);
}

function setActivePreset(q) {
  const match = nearestPreset(q);
  presetBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === match));
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
  state = await chrome.storage.sync.get(DEFAULTS);
  applyUI(state);
  loadSiteUI(state);
}
load();

// ── Enable toggle ─────────────────────────────────────────────────────────────

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  await chrome.storage.sync.set({ enabled });
  updateEnabledUI(enabled);
});

// ── Grayscale ─────────────────────────────────────────────────────────────────
// Grayscale is applied server-side by the proxy (filt=greyscale). Images already on
// the page can't change without a reload.

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: grayscaleEl.checked });
  showNudge();
});

// ── Quality presets ───────────────────────────────────────────────────────────

presetBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const quality = Number(btn.dataset.q);
    presetBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    await chrome.storage.sync.set({ quality });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.reload(tab.id);
    } catch {}
    window.close();
  });
});

// ── Reload current tab ────────────────────────────────────────────────────────

reloadBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.reload(tab.id);
  } catch {}
  window.close();
});

// ── Site card ─────────────────────────────────────────────────────────────────

async function loadSiteUI(d) {
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

  currentIsWeb = parsed.protocol === "http:" || parsed.protocol === "https:";
  currentHost  = parsed.hostname.toLowerCase();

  if (!currentIsWeb) {
    siteNameEl.textContent = parsed.protocol.replace(":", "") + " page";
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not a web page";
    excludeBtn.disabled = true;
    return;
  }

  siteNameEl.textContent = currentHost;
  excludeBtn.disabled = false;

  const excluded = parseDomains(d.excludeDomains);
  if (findExcludedDomain(currentHost, excluded)) {
    sitePillEl.textContent = "Excluded";
    sitePillEl.className   = "site-pill excluded";
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
  const d    = await chrome.storage.sync.get(DEFAULTS);
  const list = new Set(parseDomains(d.excludeDomains));
  const excludedDomain = findExcludedDomain(currentHost, Array.from(list));
  if (excludedDomain) list.delete(excludedDomain);
  else list.add(currentHost);
  await chrome.storage.sync.set({ excludeDomains: Array.from(list).join(" ") });
  showNudge(); // page must reload for the change to take effect
});

// ── Open settings page ────────────────────────────────────────────────────────
// chrome.runtime.openOptionsPage() breaks on Kiwi/Cromite (popup opens as tab).
// tabs.create() works everywhere.

settingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
    .catch(() => chrome.runtime.openOptionsPage?.());
});

// ── Sync with changes made on the settings page ───────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  // Apply directly from the change payload — no redundant storage re-read.
  for (const [k, v] of Object.entries(changes)) state[k] = v.newValue ?? DEFAULTS[k];
  applyUI(state);
  if ("excludeDomains" in changes || "enabled" in changes) loadSiteUI(state);
});
