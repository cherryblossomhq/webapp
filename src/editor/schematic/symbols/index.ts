// Chip-like tag classification.
//
// Since the schematic became read-only (@tscircuit/schematic-viewer owns all
// glyph rendering now), the only thing the app still needs from this module is
// "should this element be treated as a chip?" — used by the PCB canvas, the
// Properties panel, and circuitStore to branch on pin-count / footprint logic.
// The old symbol-resolution registry (resolveSymbol / TAG_TO_BASE_SYMBOL /
// specialVariant) went away with the custom SchematicCanvas renderer.

// Tags that count as chip-like (DIP-style parts with labeled pins) regardless
// of pin count.
const CHIP_LIKE_TAGS = new Set([
  "chip",
  "ic",
  "opamp",
  "regulator",
  "mcu",
  "pinheader",
  "connector",
]);

export function isChipLike(elementTag: string): boolean {
  if (CHIP_LIKE_TAGS.has(elementTag)) return true;
  // Capitalized first letter = imported React component (e.g. ESP32S3).
  return /^[A-Z]/.test(elementTag);
}
