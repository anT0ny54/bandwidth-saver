// Bandwidth Guardian — shared defaults
// Single source of truth. service-worker.js, options.js, popup.js import this.
// content.js and prehook.js inline a copy (search "KEEP IN SYNC").
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   Normal quality preset: 60

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "https://wsrv.nl/",
  quality:        60,    // Normal preset
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       768,  // HD preset; 0 = no limit
  excludeDomains: "google.com gstatic.com",
};
