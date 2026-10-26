import { boardColors, boardFinish, mountingHoles, SURFACE_FINISHES } from "../model/board"
import { viasInSmdPads, type CopperItem } from "../model/pcb"
import { boardStackup, copperThickness, formatLength } from "../model/rules"
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
    `  Size              ${mm(b.width)} x ${mm(b.height)}${b.cornerRadius > 0 ? `, ${mm(b.cornerRadius)} corner radius` : ""}`,
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
    `  Hole to hole      ${mm(r.holeClearance)}`,
    `  Copper to edge    ${mm(r.edgeClearance)}`,
    `  Mask expansion    ${mm(r.maskExpansion)}`,
    "",
    "STACKUP",
    ...boardStackup(b).map((l) => `  ${l.name.padEnd(20)}${l.material.padEnd(16)}${l.thickness === null ? "" : mm(l.thickness)}`),
    "",
    "FILES",
    ...files.map((f) => `  ${f}`),
  ]
  return lines.join("\n") + "\n"
}
