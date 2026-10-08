// Bandwidth Saver — shared defaults
// Single source of truth. service-worker.js, options.js, popup.js import this.
// content.js, prehook.js and service-worker.js inline a copy (search "KEEP IN SYNC").
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   Normal quality preset: 60

export const DEFAULTS = {
  enabled:        true,
  saveData:       true,   // Send Save-Data: on on web requests
  proxyBase:      "https://wsrv.nl/",
  quality:        60,    // Normal preset
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       768,  // HD preset; 0 = no limit
  excludeDomains: "",
};
