// Bandwidth Guardian — shared defaults
// Single source of truth. service-worker.js, options.js, popup.js import this.
// content.js and prehook.js inline a copy (search "KEEP IN SYNC").
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   compressionLevel: 40 → quality: 40

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "https://wsrv.nl/",
  quality:        40,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       1280,  // 0 = no limit; MV3-specific addition
  excludeDomains: "google.com gstatic.com",
  isWebpSupported: false, // detected at install/startup; used to decide jpeg= param
};
