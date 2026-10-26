/**
 * `@cherryblossom/editor/supplier`: what the website's parts API shares with the editor, so the
 * server labelling a supplier's pins and the copilot comparing a pin map against them read names
 * the same way. Pure functions with no DOM, store or footprinter in their imports: the server
 * bundles this and nothing else from the editor.
 */
export { canonicalPin, couldBe, isPlaceholderName, isRail, pinRole } from "./roles"
export { comparePins, numberRange, pinMapText, type DrawnPin, type PinComparison, type PinFinding } from "./pinmap"
export { compareLands, describeLand, exposedPads, summarizeLand, type LandComparison, type LandPad, type LandSummary } from "./land"
export { isUserUploadId, mpnWord, partNumberKey, relateName, type NameMatch } from "./partNumber"
export { KICAD_MODEL_ID, KICAD_MODEL_PATH } from "./kicadModel"
