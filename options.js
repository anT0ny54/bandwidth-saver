import { DEFAULTS, parseDomains } from "./defaults.js";

const $ = id => document.getElementById(id);

const enabledEl      = $("enabled");
const grayscaleEl    = $("grayscale");
const saveDataEl      = $("saveData");
const excludeEl      = $("excludeDomains");
const saveBtn        = $("save");
const resetAllBtn    = $("resetAll");
const resetStatsBtn  = $("resetStats");
const statImagesEl   = $("statImages");
const statBytesEl    = $("statBytes");
const statSavedEl    = $("statSaved");
const toastEl        = $("toast");
const versionEl       = $("extensionVersion");
const customQualityEl = $("customQuality");
const customWidthEl   = $("customWidth");

const EMPTY_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets   = Array.from(document.querySelectorAll("#widthPresets .preset"));

// Single source of truth for preset values: derive them from the buttons'
// data-q / data-w attributes so the markup can never drift from the JS.
const QUALITY_PRESETS = qualityPresets.map(b => Number(b.dataset.q));
const WIDTH_PRESETS   = widthPresets.map(b => Number(b.dataset.w));
// Last values loaded from storage, used to restore preset highlights when a
// custom input is cleared (previously this wrongly restored DEFAULTS).
let savedQuality = DEFAULTS.quality;
let savedWidth   = DEFAULTS.maxWidth;
let initialLoadPending = true;
const initialSyncOverrides = Object.create(null);
let initialStatsChanged = false;

if (versionEl) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = "") {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = ["toast", "show", type].filter(Boolean).join(" ");
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, type === "err" ? 3500 : 1800);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  n = Number(n) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1 << 30) return sign + (abs / (1 << 30)).toFixed(2) + " GB";
  if (abs >= 1 << 20) return sign + (abs / (1 << 20)).toFixed(2) + " MB";
  if (abs >= 1 << 10) return sign + (abs / (1 << 10)).toFixed(2) + " KB";
  return sign + abs + " B";
}

function storedNumber(value) {
  if (typeof value === "string" && value.trim() === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function normalizeQuality(value) {
  const n = storedNumber(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : DEFAULTS.quality;
}

function normalizeWidth(value) {
  const n = storedNumber(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULTS.maxWidth;
}

function applySettings(d) {
  enabledEl.checked    = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  saveDataEl.checked   = !!d.saveData;
  excludeEl.value      = d.excludeDomains || "";
  savedQuality = normalizeQuality(d.quality ?? DEFAULTS.quality);
  savedWidth   = normalizeWidth(d.maxWidth ?? DEFAULTS.maxWidth);
  setQualityUI(savedQuality);
  setWidthUI(savedWidth);
}

function renderStats(stats = {}) {
  const files = Number(stats.filesProcessed) || 0;
  statImagesEl.textContent = files.toLocaleString();
  statBytesEl.textContent  = fmtBytes(stats.bytesProcessed);
  statSavedEl.textContent  = fmtBytes(stats.bytesSaved);
}

async function reloadCurrentPage() {
  const isHttpUrl = url => /^https?:\/\//i.test(String(url || ""));
  try {
    // Single query covers both the fast path (active tab) and the fallback
    // (most recently accessed HTTP(S) tab), halving the round-trips.
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find(t => t.active);
    if (active?.id != null && isHttpUrl(active.url)) {
      await chrome.tabs.reload(active.id);
      return;
    }

    // When settings are opened in a new tab, the settings tab itself is active.
    // Prefer the most recently accessed HTTP(S) tab in the same window.
    const page = tabs
      .filter(tab => tab.id != null && isHttpUrl(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id) await chrome.tabs.reload(page.id);
  } catch {}
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// Quality presets: highlight the button whose value matches, or none for custom.
function setQualityUI(q) {
  q = Number(q);
  qualityPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === q));
  // Keep custom field in sync
  if (!QUALITY_PRESETS.includes(q)) {
    customQualityEl.value = q;
  } else {
    customQualityEl.value = "";
  }
}

// Width presets: same pattern.
function setWidthUI(w) {
  w = Number(w);
  widthPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.w) === w));
  if (!WIDTH_PRESETS.includes(w)) {
    customWidthEl.value = w;
  } else {
    customWidthEl.value = "";
  }
}

// Read the currently selected quality value (preset or custom).
function readQuality() {
  const custom = parseInt(customQualityEl.value, 10);
  if (!isNaN(custom) && custom >= 1 && custom <= 100) return custom;
  const active = qualityPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : DEFAULTS.quality;
}

// Read the currently selected width value (preset or custom).
function readWidth() {
  const custom = parseInt(customWidthEl.value, 10);
  if (!isNaN(custom) && custom >= 0) return custom;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w) : DEFAULTS.maxWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  let d, s;
  try {
    [d, s] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ stats: EMPTY_STATS })
    ]);
  } catch {
    // A rejected storage read must not leave the settings page stuck on
    // placeholders — fall back to the shared defaults and empty statistics
    // (same hardening as the popup's load()).
    d = { ...DEFAULTS };
    s = { stats: EMPTY_STATS };
  }
  applySettings({ ...DEFAULTS, ...(d || {}), ...initialSyncOverrides });
  if (!initialStatsChanged) renderStats(s?.stats || EMPTY_STATS);
  initialLoadPending = false;
}
load();

// Keep the page synchronized with changes made in the popup, reset flows, or
// service-worker statistics flushes while this tab remains open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    for (const [key, change] of Object.entries(changes)) {
      const value = change.newValue ?? DEFAULTS[key];
      if (initialLoadPending) initialSyncOverrides[key] = value;
    }
    if ("enabled" in changes) {
      enabledEl.checked = !!(changes.enabled.newValue ?? DEFAULTS.enabled);
    }
    if ("grayscale" in changes) {
      grayscaleEl.checked = !!(changes.grayscale.newValue ?? DEFAULTS.grayscale);
    }
    if ("saveData" in changes) {
      saveDataEl.checked = !!(changes.saveData.newValue ?? DEFAULTS.saveData);
    }
    if ("excludeDomains" in changes) {
      excludeEl.value = String(changes.excludeDomains.newValue ?? DEFAULTS.excludeDomains);
    }
    if ("quality" in changes) {
      savedQuality = normalizeQuality(changes.quality.newValue ?? DEFAULTS.quality);
      setQualityUI(savedQuality);
    }
    if ("maxWidth" in changes) {
      savedWidth = normalizeWidth(changes.maxWidth.newValue ?? DEFAULTS.maxWidth);
      setWidthUI(savedWidth);
    }
  } else if (area === "local" && changes.stats) {
    if (initialLoadPending) initialStatsChanged = true;
    renderStats(changes.stats.newValue || {});
  }
});

// ── Quality preset buttons ────────────────────────────────────────────────────

qualityPresets.forEach(btn => {
  btn.addEventListener("click", () => setQualityUI(Number(btn.dataset.q)));
});

// Custom quality input — deselects all presets when user types a value.
customQualityEl.addEventListener("input", () => {
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach(b => b.classList.remove("active"));
  } else if (customQualityEl.value === "") {
    // Restore the saved value's highlight when field is cleared
    setQualityUI(savedQuality);
  }
});

// ── Max-width preset buttons ──────────────────────────────────────────────────

widthPresets.forEach(btn => {
  btn.addEventListener("click", () => setWidthUI(Number(btn.dataset.w)));
});

customWidthEl.addEventListener("input", () => {
  const v = parseInt(customWidthEl.value, 10);
  if (!isNaN(v) && v >= 0) {
    widthPresets.forEach(b => b.classList.remove("active"));
  } else if (customWidthEl.value === "") {
    setWidthUI(savedWidth);
  }
});

// ── Auto-save: enable + grayscale ────────────────────────────────────────────
// These two feel like instant switches; everything else uses the Save button.

enabledEl.addEventListener("change", async () => {
  const enabled = !!enabledEl.checked;
  try {
    await chrome.storage.sync.set({ enabled });
  } catch {
    enabledEl.checked = !enabled;
    showToast("Couldn't update compression", "err");
    return;
  }
  await reloadCurrentPage();
  showToast(enabled ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  const grayscale = !!grayscaleEl.checked;
  try {
    await chrome.storage.sync.set({ grayscale });
  } catch {
    grayscaleEl.checked = !grayscale;
    showToast("Couldn't update grayscale", "err");
    return;
  }
  showToast("Reload the page to apply", "warn");
});

saveDataEl.addEventListener("change", async () => {
  const saveData = !!saveDataEl.checked;
  try {
    await chrome.storage.sync.set({ saveData });
  } catch {
    saveDataEl.checked = !saveData;
    showToast("Couldn't update Save-Data", "err");
    return;
  }
  showToast(saveData ? "Save-Data header enabled" : "Save-Data header disabled", "ok");
});

// ── Save ──────────────────────────────────────────────────────────────────────

// Compare exclusion lists by effect, not spelling: separator style, whitespace,
// casing, duplicates, and entry order don't change which sites are skipped, so
// they must not force a page reload.
const normalizeDomainsKey = text => Array.from(new Set(parseDomains(text))).sort().join(" ");

async function save() {
  // Reject invalid custom values instead of silently falling back to a preset.
  const cq = customQualityEl.value.trim();
  const cw = customWidthEl.value.trim();
  if (cq !== "" && !(/^\d+$/.test(cq) && +cq >= 1 && +cq <= 100)) {
    showToast("Quality must be 1–100", "err");
    return;
  }
  if (cw !== "" && (!/^\d+$/.test(cw) || !Number.isSafeInteger(Number(cw)))) {
    showToast("Width must be a safe whole number (0 or greater)", "err");
    return;
  }
  const quality = readQuality();
  const maxWidth = readWidth();
  const excludeDomains = (excludeEl.value || "").trim();
  let current;
  try {
    current = await chrome.storage.sync.get(DEFAULTS);
    await chrome.storage.sync.set({
      quality,
      maxWidth,
      excludeDomains,
    });
  } catch {
    showToast("Couldn't save settings", "err");
    return;
  }

  // Reload whenever a URL-shaping setting changed (quality, max width, or the
  // exclusion list) — exclusion changes only take effect on a fresh page load.
  const previousQuality = normalizeQuality(current.quality ?? DEFAULTS.quality);
  const previousMaxWidth = normalizeWidth(current.maxWidth ?? DEFAULTS.maxWidth);
  if (quality !== previousQuality ||
      maxWidth !== previousMaxWidth ||
      normalizeDomainsKey(excludeDomains) !== normalizeDomainsKey(current.excludeDomains)) {
    await reloadCurrentPage();
  }

  // Keep the "restore on clear" values and preset highlights in step with storage.
  savedQuality = quality;
  savedWidth   = maxWidth;
  setQualityUI(quality);
  setWidthUI(maxWidth);
  showToast("Saved", "ok");
}

// ── Reset ─────────────────────────────────────────────────────────────────────

async function resetAll() {
  let current;
  try {
    current = await chrome.storage.sync.get(DEFAULTS);
    await chrome.storage.sync.set(DEFAULTS);
  } catch {
    showToast("Couldn't reset settings", "err");
    return;
  }
  const affectsCurrentPage =
    !!current.enabled !== DEFAULTS.enabled ||
    normalizeQuality(current.quality ?? DEFAULTS.quality) !== DEFAULTS.quality ||
    normalizeWidth(current.maxWidth ?? DEFAULTS.maxWidth) !== DEFAULTS.maxWidth ||
    normalizeDomainsKey(current.excludeDomains ?? DEFAULTS.excludeDomains) !== normalizeDomainsKey(DEFAULTS.excludeDomains) ||
    !!current.grayscale !== DEFAULTS.grayscale;
  applySettings(DEFAULTS);
  if (affectsCurrentPage) await reloadCurrentPage();
  showToast("Reset to defaults");
}

async function resetStats() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "BW_RESET_STATS" });
    if (!result?.ok) throw new Error(result?.error || "The service worker could not reset statistics.");
    // Only the statistics changed; a full load() would also overwrite any
    // unsaved edits in the settings form.
    renderStats();
    showToast("Stats cleared");
  } catch {
    showToast("Couldn't reset stats", "err");
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);


[excludeEl, customQualityEl, customWidthEl].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
});
