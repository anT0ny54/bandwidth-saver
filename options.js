import { DEFAULTS } from "./defaults.js";

const $ = id => document.getElementById(id);

const enabledEl      = $("enabled");
const grayscaleEl    = $("grayscale");
const excludeEl      = $("excludeDomains");
const saveBtn        = $("save");
const resetAllBtn    = $("resetAll");
const resetStatsBtn  = $("resetStats");
const statImagesEl   = $("statImages");
const statBytesEl    = $("statBytes");
const toastEl        = $("toast");
const customQualityEl = $("customQuality");
const customWidthEl   = $("customWidth");

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets   = Array.from(document.querySelectorAll("#widthPresets  .preset"));

const QUALITY_PRESETS = [20, 40, 80];
const WIDTH_PRESETS   = [1280, 1920, 0];

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
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(2) + " KB";
  return n + " B";
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// Quality presets: highlight the button whose value matches, or none for custom.
function setQualityUI(q) {
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
  const [d, s] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ stats: { filesProcessed: 0, bytesProcessed: 0 } })
  ]);
  enabledEl.checked   = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  excludeEl.value     = d.excludeDomains || "";
  setQualityUI(d.quality  ?? DEFAULTS.quality);
  setWidthUI(d.maxWidth ?? DEFAULTS.maxWidth);

  const st = s.stats || {};
  statImagesEl.textContent = (st.filesProcessed || 0).toLocaleString();
  statBytesEl.textContent  = fmtBytes(st.bytesProcessed);
}
load();

// ── Quality preset buttons ────────────────────────────────────────────────────

qualityPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    qualityPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customQualityEl.value = ""; // preset takes priority; clear custom
  });
});

// Custom quality input — deselects all presets when user types a value.
customQualityEl.addEventListener("input", () => {
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach(b => b.classList.remove("active"));
  } else if (customQualityEl.value === "") {
    // Restore nearest preset highlight when field is cleared
    setQualityUI(DEFAULTS.quality);
  }
});

// ── Max-width preset buttons ──────────────────────────────────────────────────

widthPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    widthPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customWidthEl.value = "";
  });
});

customWidthEl.addEventListener("input", () => {
  const v = parseInt(customWidthEl.value, 10);
  if (!isNaN(v) && v >= 0) {
    widthPresets.forEach(b => b.classList.remove("active"));
  } else if (customWidthEl.value === "") {
    setWidthUI(DEFAULTS.maxWidth);
  }
});

// ── Auto-save: enable + grayscale ────────────────────────────────────────────
// These two feel like instant switches; everything else uses the Save button.

enabledEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: !!enabledEl.checked });
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: !!grayscaleEl.checked });
  showToast("Reload the page to apply", "warn");
});

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  await chrome.storage.sync.set({
    proxyBase:      "https://wsrv.nl/",
    quality:        readQuality(),
    maxWidth:       readWidth(),
    excludeDomains: (excludeEl.value || "").trim(),
  });

  showToast("Saved", "ok");
}

// ── Reset ─────────────────────────────────────────────────────────────────────

async function resetAll() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  showToast("Reset to defaults");
}

async function resetStats() {
  await chrome.storage.local.set({ stats: { filesProcessed: 0, bytesProcessed: 0 } });
  await load();
  showToast("Stats cleared");
}

// ── Event wiring ──────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);


[excludeEl, customQualityEl, customWidthEl].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
});
