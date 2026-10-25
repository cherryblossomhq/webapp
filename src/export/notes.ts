import { boardColors, boardFinish, mountingHoles, SURFACE_FINISHES } from "../model/board"
import { boardAreaMm2, describeOutline } from "../model/outline"
import { viasInSmdPads, type CopperItem } from "../model/pcb"
import { inBom, inPositionFile } from "../model/partFlags"
import { boardStackup, copperThickness, formatLength } from "../model/rules"
import { worldShapes } from "../model/shapeItems"
import { worldTexts } from "../model/texts"
import type { Project } from "../model/types"
import { drillHoles, npthHoles } from "./excellon"

/** Mask and silkscreen colours fabs list, to name the nearest one beside the exact hex code. */
const COLOR_NAMES: [string, string][] = [
  ["Green", "#1f6b3a"],
  ["Red", "#a3202a"],
  ["Yellow", "#d9b21f"],
  ["Blue", "#1b4f8c"],
  ["White", "#eceae4"],
  ["Black", "#16161a"],
  ["Purple", "#4a2a6e"],
]

const rgb = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorName(hex: string): string {
  const [r, g, b] = rgb(hex)
  let best = COLOR_NAMES[0]
  let bestD = Infinity
  for (const entry of COLOR_NAMES) {
    const [r2, g2, b2] = rgb(entry[1])
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2
    if (d < bestD) [best, bestD] = [entry, d]
  }
  return `${best[0]} (${hex.toLowerCase()})`
}

const mm = (v: number) => formatLength(v, "mm", true)

/**
 * Plain-text notes for the fab: the board spec an order form asks for, the smallest features
 * actually on the board, the rules it was checked against, and the project's properties.
 */
export function fabricationNotes(project: Project, files: string[], items: CopperItem[]): string {
  const b = project.board
  const r = project.rules
  const colors = boardColors(b)
  const weight = b.copperWeight ?? 1
  const holes = [...drillHoles(project), ...npthHoles(project)]
  const smallestHole = holes.length ? Math.min(...holes.map((h) => h.diameter)) : null
  const smallestTrace = project.traces.length ? Math.min(...project.traces.map((t) => t.width)) : null
  // Filling and capping costs extra, so ask for it only when a via really sits in a pad.
  const inPad = viasInSmdPads(project, items).length
  const lines = [
    `${project.name}`,
    "Fabrication notes from Cherry Blossom",
    "",
    ...(project.properties ?? []).map((p) => `${p.key}: ${p.value}`),
    ...(project.properties?.length ? [""] : []),
    "BOARD",
    `  Size              ${mm(b.width)} x ${mm(b.height)}${b.outline ? ` bounding box; outline of its own (${describeOutline(b)}), area ${(boardAreaMm2(b) / 100).toFixed(2)} cm2` : b.cornerRadius > 0 ? `, ${mm(b.cornerRadius)} corner radius` : ""}`,
    "  Layers            2",
    `  Thickness         ${mm(b.thickness)}`,
    "  Material          FR-4",
    `  Copper            ${weight} oz (${Math.round(copperThickness(weight) * 1000)} µm) outer layers`,
    `  Surface finish    ${SURFACE_FINISHES.find((f) => f.value === boardFinish(b))?.label}`,
    `  Solder mask       ${colorName(colors.mask)}, both sides`,
    `  Silkscreen        ${colorName(colors.silk)}, both sides`,
    `  Vias              ${project.vias.length}, ${r.tentVias ? "tented" : "not tented"}${inPad ? `, ${inPad} in SMD pads: fill and cap` : ""}`,
    `  Mounting holes    ${mountingHoles(b).length || "none"}`,
    "",
    "SMALLEST FEATURES ON THE BOARD",
    `  Trace width       ${smallestTrace === null ? "no traces" : mm(smallestTrace)}`,
    `  Drill             ${smallestHole === null ? "no holes" : mm(smallestHole)}`,
    "",
    "CHECKED AGAINST",
    `  Trace / space     ${mm(r.minTraceWidth)} / ${mm(r.clearance)}`,
    `  Drill             ${mm(r.minDrill)} minimum, ${mm(r.minAnnularRing)} annular ring`,
    ...(r.minViaDiameter !== undefined ? [`  Via diameter      ${mm(r.minViaDiameter)} minimum`] : []),
    `  Hole to hole      ${mm(r.holeClearance)}`,
    `  Copper to edge    ${mm(r.edgeClearance)}`,
    `  Mask expansion    ${mm(r.maskExpansion)}`,
    "",
    "STACKUP",
    ...boardStackup(b).map((l) => `  ${l.name.padEnd(20)}${l.material.padEnd(16)}${l.thickness === null ? "" : mm(l.thickness)}`),
    "",
    ...assemblyNotes(project),
    ...drawingNotes(project),
    ...textNotes(project),
    "FILES",
    ...files.map((f) => `  ${f}`),
  ]
  return lines.join("\n") + "\n"
}

/** Where the drawings on the board and in its parts went, and which were not plotted: only for a board that has any. */
function drawingNotes(project: Project): string[] {
  const all = worldShapes(project)
  if (!all.length) return []
  const plotted: [string, string, string][] = [
    ["F.Cu", "Top copper", "in the top copper file, after the pours, pads and traces"],
    ["B.Cu", "Bottom copper", "in the bottom copper file, after the pours, pads and traces"],
    ["F.Mask", "Top mask", "as openings in the top solder mask file"],
    ["B.Mask", "Bottom mask", "as openings in the bottom solder mask file"],
    ["F.Paste", "Top paste", "in the top paste file"],
    ["B.Paste", "Bottom paste", "in the bottom paste file"],
    ["F.SilkS", "Top silkscreen", "in the top silkscreen file"],
    ["B.SilkS", "Bottom silkscreen", "in the bottom silkscreen file"],
  ]
  const placed = all.filter((d) => d.placed)
  const count = (layer: string) => placed.filter((d) => d.shape.layer === layer).length
  const lines = plotted.filter(([layer]) => count(layer)).map(([layer, label, where]) => `  ${label.padEnd(18)}${count(layer)}: ${where}`)
  const names = new Set(plotted.map(([layer]) => layer))
  const skipped = new Map<string, number>()
  for (const { shape } of placed) {
    if (names.has(shape.layer)) continue
    const what = shape.layer.endsWith(".Fab") ? "fabrication" : shape.layer.endsWith(".CrtYd") ? "courtyard" : shape.layer.endsWith(".Adhes") ? "adhesive" : "user"
    skipped.set(what, (skipped.get(what) ?? 0) + 1)
  }
  return [
    "DRAWINGS",
    ...lines,
    ...(skipped.size ? [`  Not plotted       ${[...skipped].map(([what, n]) => `${what} ${n}`).join(", ")}: fabrication, courtyard, adhesive and user layers are not in the files, as KiCad does not plot them by default`] : []),
    ...(all.length > placed.length ? [`  Not on the PCB    ${all.length - placed.length}: drawings of parts not placed on the board are left out`] : []),
    "",
  ]
}

/** Where the texts of a board brought in from KiCad went and which were not plotted: only for a board that has any, so a board drawn here reads as it did. */
function textNotes(project: Project): string[] {
  const all = worldTexts(project)
  if (!all.length) return []
  const placed = all.filter((t) => t.placed)
  const drawn = placed.filter((t) => !t.hidden)
  const plotted: [string, string, string][] = [
    ["F.Cu", "Top copper", "in the top copper file, as copper that belongs to no net: pours keep clear of it and the checks treat it as copper"],
    ["B.Cu", "Bottom copper", "in the bottom copper file, as copper that belongs to no net: pours keep clear of it and the checks treat it as copper"],
    ["F.Mask", "Top mask", "as openings in the top solder mask file"],
    ["B.Mask", "Bottom mask", "as openings in the bottom solder mask file"],
    ["F.Paste", "Top paste", "in the top paste file"],
    ["B.Paste", "Bottom paste", "in the bottom paste file"],
    ["F.SilkS", "Top silkscreen", "in the top silkscreen file"],
    ["B.SilkS", "Bottom silkscreen", "in the bottom silkscreen file"],
    ["Edge.Cuts", "Board edge", "in the outline file"],
  ]
  const count = (layer: string) => drawn.filter((t) => t.layer === layer).length
  const lines = plotted.filter(([layer]) => count(layer)).map(([layer, label, where]) => `  ${label.padEnd(18)}${count(layer)}: ${where}`)
  const names = new Set(plotted.map(([layer]) => layer))
  const skipped = new Map<string, number>()
  for (const t of drawn) {
    if (names.has(t.layer)) continue
    const what = t.layer.endsWith(".Fab") ? "fabrication" : t.layer.endsWith(".CrtYd") ? "courtyard" : t.layer.endsWith(".Adhes") ? "adhesive" : "user"
    skipped.set(what, (skipped.get(what) ?? 0) + 1)
  }
  const knockouts = drawn.filter((t) => t.knockout).length
  return [
    "TEXT",
    ...lines,
    ...(knockouts ? [`  Knockout          ${knockouts}: a filled box with the letters left out, plotted as a region`] : []),
    ...(skipped.size ? [`  Not plotted       ${[...skipped].map(([what, n]) => `${what} ${n}`).join(", ")}: fabrication, courtyard, adhesive and user layers are not in the files, as KiCad does not plot them by default`] : []),
    ...(placed.length > drawn.length ? [`  Hidden            ${placed.length - drawn.length}: hidden text is neither drawn nor plotted`] : []),
    ...(all.length > placed.length ? [`  Not on the PCB    ${all.length - placed.length}: text of parts not placed on the board is left out`] : []),
    "",
  ]
}

/** The flags on parts, and what each does to the files: only for a board that has any, so a board drawn here reads as it did. */
function assemblyNotes(project: Project): string[] {
  const flagged = project.components.filter((c) => c.flags)
  if (!flagged.length) return []
  const refs = (pick: (c: Project["components"][number]) => boolean) => {
    const list = flagged.filter(pick).map((c) => c.ref).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return list.length ? list.join(", ") : "none"
  }
  return [
    "PART FLAGS",
    `  Do not populate   ${refs((c) => !!c.flags?.dnp)}: left out of bom.csv and pnp.csv; their solder paste is still in the paste files`,
    `  Not in the BOM    ${refs((c) => !!c.flags?.excludeFromBom)}: left out of bom.csv`,
    `  Not in position   ${refs((c) => !!c.flags?.excludeFromPos)}: left out of pnp.csv`,
    `  Virtual           ${refs((c) => !!c.flags?.virtual)}: left out of bom.csv and pnp.csv`,
    `  Board only        ${refs((c) => !!c.flags?.boardOnly)}: no schematic symbol in KiCad; still in bom.csv unless also not in the BOM`,
    ...(flagged.some((c) => c.flags?.notOnBoard) ? [`  Not on the board  ${refs((c) => !!c.flags?.notOnBoard)}: no footprint on the board, so none in the Gerber, drill and pnp files; still in bom.csv unless also not in the BOM`] : []),
    `  In bom.csv        ${flagged.filter(inBom).length} of the ${flagged.length} flagged parts; in pnp.csv ${flagged.filter(inPositionFile).length}`,
    "",
  ]
}
