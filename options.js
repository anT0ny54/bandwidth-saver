import { DEFAULTS, parseDomains, reloadWebTab } from "./defaults.js";

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
const versionEl      = $("extensionVersion");
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

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = "") {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = ["toast", "show", type].filter(Boolean).join(" ");
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, type === "err" ? 3500 : 1800);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function finiteStat(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  if (typeof value === "string" && value.trim() === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmtBytes(value) {
  const n = finiteStat(value);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1 << 30) return sign + (abs / (1 << 30)).toFixed(2) + " GB";
  if (abs >= 1 << 20) return sign + (abs / (1 << 20)).toFixed(2) + " MB";
  if (abs >= 1 << 10) return sign + (abs / (1 << 10)).toFixed(2) + " KB";
  return sign + abs + " B";
}

function storedNumber(value) {
  // Match content.js and prehook.js: booleans, null, and other unexpected
  // storage types are corrupt values, not numeric settings.
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeQuality(value) {
  const n = storedNumber(value);
  return Number.isFinite(n)
    ? Math.max(1, Math.min(100, Math.trunc(n)))
    : DEFAULTS.quality;
}

function normalizeWidth(value) {
  const n = storedNumber(value);
  // Check the untruncated value first: Math.trunc(-0.5) is -0, which
  // compares >= 0 and would otherwise make a negative width look valid.
  return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.trunc(n))
    ? Math.trunc(n)
    : DEFAULTS.maxWidth;
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
  const files = Math.max(0, Math.trunc(finiteStat(stats.filesProcessed)));
  statImagesEl.textContent = files.toLocaleString();
  statBytesEl.textContent  = fmtBytes(stats.bytesProcessed);
  statSavedEl.textContent  = fmtBytes(stats.bytesSaved);
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// Quality presets: highlight the button whose value matches, or none for custom.
// keepTypedValue leaves a custom field alone while the user is editing it, so a
// change that arrives from another page cannot erase their unsaved input.
function setQualityUI(q, { keepTypedValue = false } = {}) {
  q = Number(q);
  qualityPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === q));
  if (keepTypedValue && customQualityEl.value.trim() !== "") return;
  customQualityEl.value = QUALITY_PRESETS.includes(q) ? "" : q;
}

// Width presets: same pattern.
function setWidthUI(w, { keepTypedValue = false } = {}) {
  w = Number(w);
  widthPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.w) === w));
  if (keepTypedValue && customWidthEl.value.trim() !== "") return;
  customWidthEl.value = WIDTH_PRESETS.includes(w) ? "" : w;
}

// Read the currently selected quality value (preset or custom).
function readQuality() {
  const custom = storedNumber(customQualityEl.value);
  if (Number.isSafeInteger(custom) && custom >= 1 && custom <= 100) return custom;
  const active = qualityPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : DEFAULTS.quality;
}

// Read the currently selected width value (preset or custom).
function readWidth() {
  const custom = storedNumber(customWidthEl.value);
  if (Number.isSafeInteger(custom) && custom >= 0) return custom;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w) : DEFAULTS.maxWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

function callStorage(read) {
  try { return Promise.resolve(read()); }
  catch (error) { return Promise.reject(error); }
}

async function load() {
  const [settingsResult, statsResult] = await Promise.allSettled([
    callStorage(() => chrome.storage.sync.get(DEFAULTS)),
    callStorage(() => chrome.storage.local.get({ stats: EMPTY_STATS }))
  ]);
  // Settings and statistics live in different storage areas. A failure in one
  // must not replace a successful read from the other with fallback values.
  const d = settingsResult.status === "fulfilled" ? settingsResult.value : DEFAULTS;
  const s = statsResult.status === "fulfilled" ? statsResult.value : { stats: EMPTY_STATS };
  applySettings({ ...DEFAULTS, ...(d || {}), ...initialSyncOverrides });
  // Only read during this first overlay; clear so stale entries do not
  // linger for the life of the settings tab.
  for (const k of Object.keys(initialSyncOverrides)) delete initialSyncOverrides[k];
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
      setQualityUI(savedQuality, { keepTypedValue: true });
    }
    if ("maxWidth" in changes) {
      savedWidth = normalizeWidth(changes.maxWidth.newValue ?? DEFAULTS.maxWidth);
      setWidthUI(savedWidth, { keepTypedValue: true });
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
  const v = storedNumber(customQualityEl.value);
  if (Number.isSafeInteger(v) && v >= 1 && v <= 100) {
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
  const v = storedNumber(customWidthEl.value);
  if (Number.isSafeInteger(v) && v >= 0) {
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
  await reloadWebTab({ fallbackToRecent: true });
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
  if (cq !== "" && (!/^\d+$/.test(cq) || +cq < 1 || +cq > 100)) {
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
  let current = null;
  try { current = await chrome.storage.sync.get(DEFAULTS); } catch {}
  try {
    await chrome.storage.sync.set({
      quality,
      maxWidth,
      excludeDomains,
    });
  } catch {
    showToast("Couldn't save settings", "err");
    return;
  }

  // Reload whenever a URL-shaping setting changed. If the prior state could not
  // be read, reload conservatively rather than risk leaving the page stale.
  const previousQuality = normalizeQuality(current?.quality ?? DEFAULTS.quality);
  const previousMaxWidth = normalizeWidth(current?.maxWidth ?? DEFAULTS.maxWidth);
  if (!current || quality !== previousQuality ||
      maxWidth !== previousMaxWidth ||
      normalizeDomainsKey(excludeDomains) !== normalizeDomainsKey(current.excludeDomains)) {
    await reloadWebTab({ fallbackToRecent: true });
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
  let current = null;
  try { current = await chrome.storage.sync.get(DEFAULTS); } catch {}
  try {
    await chrome.storage.sync.set(DEFAULTS);
  } catch {
    showToast("Couldn't reset settings", "err");
    return;
  }
  const affectsCurrentPage = !current ||
    !!current.enabled !== DEFAULTS.enabled ||
    normalizeQuality(current.quality ?? DEFAULTS.quality) !== DEFAULTS.quality ||
    normalizeWidth(current.maxWidth ?? DEFAULTS.maxWidth) !== DEFAULTS.maxWidth ||
    normalizeDomainsKey(current.excludeDomains ?? DEFAULTS.excludeDomains) !== normalizeDomainsKey(DEFAULTS.excludeDomains) ||
    !!current.grayscale !== DEFAULTS.grayscale;
  applySettings(DEFAULTS);
  if (affectsCurrentPage) await reloadWebTab({ fallbackToRecent: true });
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


// Enter saves from the single-line fields. The exclusion list is multi-line, so
// there Enter must insert a newline and Ctrl/⌘+Enter saves instead.
[customQualityEl, customWidthEl].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
});
excludeEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
});
