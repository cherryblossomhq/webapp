// The census's rules for which extensions of the model a board needs (docs/kicad-import.md, 5 and
// 8.2), shared by `slices.mjs` (the pass-rate table) and the importer's corpus test, which compares
// its own reading of every board against these.

const CAP = 900 * 1024

export const has = (b, re) => Object.keys(b.nodes).some((k) => re.test(k.replace(/^module/, "footprint")))
const flag = (b, name) => (b.pads.flags[name] ?? 0) > 0
/** The extensions a board needs, with the reason for each. */
export function needs(b) {
  const n = new Map()
  const need = (x, why) => n.has(x) || n.set(x, why)
  if (b.copperLayersDeclared > 2 || b.undeclaredCopperLayers.length) need("X1", "more than two copper layers, or copper on a layer the table lacks")
  // An outline that still does not close after the repair (merge overlapping and collinear pieces, drop
  // pieces shorter than 0.1 mm, join ends within 0.1 mm), or none at all, is imported with the outline
  // extension (the founder's decision after the first plan, which refused them), so it needs X2. The one
  // refusal for good is a project that measures over the 900 KiB limit with `serializeProject`
  // (`estJsonBytes` stands in for that measurement here).
  if (b.outline.status !== "closed") need("X2", `outline: ${b.outline.status}`)
  else if (!b.outline.representable) need("X2", `outline is ${b.outline.shape}${b.outline.cutouts ? " with cutouts" : ""}`)
  if (b.estJsonBytes > CAP) need("REFUSED", "over the 900 KiB project limit")
  if (b.zones.total > 0) need("X3", "has zones (a board-sized pour with the board's own settings would map today, but whether the settings equal the defaults is not checked)")
  if (b.zones.teardrop || has(b, /^general>legacy_teardrops/)) need("X3", "teardrops")
  if (b.tracks.arcs > 0) need("X4", "arc tracks")
  if (Object.keys(b.tracks.viaKinds).some((k) => ["blind", "micro", "buried", "through-but-partial-span", "padstack-node"].includes(k)) || has(b, /^via>(free|tenting|remove_unused_layers|keep_end_layers|padstack)/)) need("X5", "via spans or via stacks")
  if (b.fps.angle.other > 0 || b.fps.transformed) need("X6", "a footprint off a quarter turn")
  const anyShape = (suffix) => Object.keys(b.pads.byShape).some((k) => k.endsWith(suffix))
  if (flag(b, "non-quarter-angle") || anyShape(":roundrect") || anyShape(":custom") || flag(b, "chamfer") || b.pads.drill["round+offset"] || b.pads.drill["oval+offset"] || flag(b, "smd-on-the-other-side-of-its-footprint") || flag(b, "no-copper-layer") || ["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_gap", "thermal_width", "thermal_bridge_width", "padstack", "remove_unused_layers"].some((f) => flag(b, f)) || has(b, /^footprint>(clearance|solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|zone_connect)$/) || has(b, /^footprint>pad>property/)) need("X7", "rotated, rounded or custom pads, offset holes, pads on the other side, per-pad margins")
  const shapeGfx = Object.keys(b.gfx).some((k) => /^(board|fp):(line|arc|circle|rect|poly|curve)@/.test(k) && !k.endsWith("@edge"))
  if (shapeGfx || b.fps.padless > 0 || has(b, /^target/)) need("X8", "graphics beyond the editor's silk polylines, or footprints with no pads")
  if (b.fps.total > 0 || has(b, /^gr_text/)) need("X9", "reference and value text of every footprint, board text")
  if (b.nets.classes > 1) need("X10", "net classes beyond Default")
  if (has(b, /^(footprint>)?dimension$/)) need("X11", "dimensions")
  if (has(b, /^(footprint>)?group$/)) need("X12", "groups")
  if (b.tracks.segments + b.tracks.vias > 0) need("X13", "tracks and vias carry a net in the file")
  if (has(b, /^image$/)) need("X14", "reference image")
  if (Object.keys(b.fps.attr).some((a) => !["smd", "through_hole", "(none)"].includes(a)) || has(b, /^footprint>(net_tie_pad_groups|jumper_pad_groups|duplicate_pad_numbers_are_jumpers)/)) need("X15", "footprint flags or net ties")
  if (has(b, /render_cache$/) || has(b, /^(footprint>)?embedded_fonts$/)) need("X19", "TrueType text outlines or embedded fonts")
  if (has(b, /^(footprint>)?zone>placement$/) || has(b, /^footprint>component_classes$/)) need("X20", "placement rule areas or component classes")
  if (has(b, /^generated$/) || has(b, /^footprint>pad>(die_length|die_delay)$/)) need("X21", "tuning patterns or pad lengths")
  if (has(b, /^via>(capping|covering|plugging|filling|backdrill|tertiary_drill)/) || has(b, /^footprint>pad>(backdrill|tertiary_drill|front_post_machining|back_post_machining)/)) need("X22", "via protection or backdrill")
  if (has(b, /^(variants|footprint>variant|footprint>units|footprint>point)/)) need("X23", "variants, units or points")
  return n
}

