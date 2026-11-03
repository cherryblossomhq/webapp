import { boardColors, boardFinish, mountingHoles, SURFACE_FINISHES } from "../model/board"
import { boardAreaMm2, describeOutline } from "../model/outline"
import { viasInSmdPads, type CopperItem } from "../model/pcb"
import { activeVariant, variantNames } from "../model/variants"
import { inBom, inPositionFile } from "../model/partFlags"
import { resolvedComponents } from "../model/ruleAreas"
import { computeConnectivity } from "../model/connectivity"
import { classIndex, classValuesOfClass as classValuesOf, defaultClassName } from "../model/netClasses"
import { copperCount } from "../model/stack"
import { boardStackup, copperThickness, formatLength } from "../model/rules"
import { worldShapes } from "../model/shapeItems"
import { isDimensionText, textFontState, worldTexts } from "../model/texts"
import type { ClearanceRule, Project } from "../model/types"
import { drillHoles, npthHoles } from "./excellon"
import { outlineWarning } from "./outlineGuard"
import { padMachining, postMachiningComment, protectionWords, viaProtection, viaBackdrills } from "../model/machining"
import { padDieTimes, tuningPatterns } from "../model/netLengths"

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
  const warning = outlineWarning(project)
  const lines = [
    `${project.name}`,
    "Fabrication notes from Cherry Blossom",
    "",
    // An outline a fab cannot cut is plotted as drawn, and said first, where a fab reads it.
    ...(warning ? [`WARNING: ${warning}`, ""] : []),
    ...(project.properties ?? []).map((p) => `${p.key}: ${p.value}`),
    ...(project.properties?.length ? [""] : []),
    "BOARD",
    `  Size              ${mm(b.width)} x ${mm(b.height)}${b.outline ? ` bounding box; outline of its own (${describeOutline(b)}), area ${(boardAreaMm2(b) / 100).toFixed(2)} cm2` : b.cornerRadius > 0 ? `, ${mm(b.cornerRadius)} corner radius` : ""}`,
    `  Layers            ${copperCount(b)}`,
    `  Thickness         ${mm(b.thickness)}`,
    "  Material          FR-4",
    `  Copper            ${weight} oz (${Math.round(copperThickness(weight) * 1000)} µm) outer layers`,
    `  Surface finish    ${SURFACE_FINISHES.find((f) => f.value === boardFinish(b))?.label}`,
    `  Solder mask       ${colorName(colors.mask)}, both sides`,
    `  Silkscreen        ${colorName(colors.silk)}, both sides`,
    `  Vias              ${project.vias.length}${viaKindsNote(project)}, ${tentNote(r)}${inPad ? `, ${inPad} in SMD pads: fill and cap` : ""}`,
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
    ...ruleNotes(project),
    "",
    ...netClassNotes(project),
    ...clearanceRuleNotes(project),
    "STACKUP",
    ...boardStackup(b).map((l) => `  ${l.name.padEnd(20)}${l.material.padEnd(16)}${l.thickness === null ? "" : mm(l.thickness)}`),
    "",
    ...variantNotes(project), ...assemblyNotes(project),
    ...viaProtectionNotes(project),
    ...machiningNotes(project),
    ...lengthNotes(project),
    ...drawingNotes(project),
    ...textNotes(project),
    ...dimensionNotes(project),
    "FILES",
    ...files.map((f) => `  ${f}`),
  ]
  return lines.join("\n") + "\n"
}

/**
 * What a fab needs to know about the rules beyond the plain ones, for a board that has any (one drawn here has none, so its notes read as they did): the
 * smallest via drill, the board's minimum clearance, the mask web the Gerbers were made with, and the paste ratio.
 */
function ruleNotes(project: Project): string[] {
  const r = project.rules
  return [
    ...(r.minViaDrill !== undefined ? [`  Via drill         ${mm(r.minViaDrill)} minimum (through holes: ${mm(r.minDrill)})`] : []),
    ...(r.minClearance !== undefined ? [`  Minimum clearance ${mm(r.minClearance)}: no pair of nets is checked below it`] : []),
    ...(r.maskMinWidth !== undefined ? [`  Mask web          ${mm(r.maskMinWidth)} minimum: mask openings closer than this are merged into one in the mask files`] : []),
    ...(r.pasteRatio !== undefined ? [`  Paste             ${Number((r.pasteRatio * 100).toFixed(4))}% of each pad's size on every side, with the ${mm(r.pasteExpansion)} expansion`] : []),
    ...(r.maxError !== undefined ? [`  Curve accuracy    ${mm(r.maxError)}: the most a polygon may differ from the circle or arc it stands for`] : []),
  ]
}

/**
 * The net classes of a board that has any: the clearance, trace width and via each asks for, and how many nets are in it. Two nets are
 * checked at the larger of their classes' clearances, so the tightest spacing a fab has to make is the smallest class clearance in use.
 */
function netClassNotes(project: Project): string[] {
  const r = project.rules
  const classes = r.netClasses ?? []
  if (!classes.length) return []
  const index = classIndex(r)
  const nets = computeConnectivity(project)
    .nets.filter((n) => n.pins.length > 0)
    .map((n) => n.name)
  const counts = new Map<string, number>()
  for (const n of nets) {
    const name = index.classOf(n)?.name ?? defaultClassName(r)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const row = (name: string, v: { clearance: number; traceWidth: number; viaDiameter: number; viaDrill: number }) =>
    `  ${name.slice(0, 18).padEnd(18)}${mm(v.clearance)} space, ${mm(v.traceWidth)} trace, via ${mm(v.viaDiameter)} / ${mm(v.viaDrill)}; ${counts.get(name) ?? 0} net${counts.get(name) === 1 ? "" : "s"}`
  const all = [index.base, ...classes.map((c) => classValuesOf(r, c.name))]
  return [
    "NET CLASSES",
    ...all.map((v) => row(v.name, v)),
    `  Tightest space    ${mm(Math.min(...all.map((v) => v.clearance)))}: two nets are checked at the larger of their classes' spaces`,
    "",
  ]
}

/** The clearance rules of a board that has any: a pair of nets or a part's pads, each with the space it is held to in place of the classes'. */
function clearanceRuleNotes(project: Project): string[] {
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  // A rule for a part no longer in the project holds nothing; each is the space it is checked at, never below the board's minimum.
  const list = (project.rules.clearanceRules ?? []).filter((r) => r.nets || refOf.has(r.component!))
  if (!list.length) return []
  const space = (r: ClearanceRule) => Math.max(r.clearance, project.rules.minClearance ?? 0)
  // The name is never cut short: a pair of net names is what tells the fab which copper the space is for.
  const rows = list.map((r) => `  ${(r.nets ? `${r.nets[0]} to ${r.nets[1]}` : `${refOf.get(r.component!)} pads`).padEnd(17)} ${mm(space(r))} space${r.nets ? "" : " to every other net"}`)
  return ["CLEARANCE RULES", ...rows, `  Tightest space    ${mm(Math.min(...list.map(space)))}: these replace the classes' spaces where they apply`, ""]
}

/** Where the drawings on the board and in its parts went, and which were not plotted: only for a board that has any. */
function drawingNotes(project: Project): string[] {
  // A dimension's lines are in the DIMENSIONS block, not counted as drawings.
  const all = worldShapes(project).filter((s) => !s.dim)
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

/** Where the dimensions and reference images of a board brought in from KiCad went: only for a board that has any, so a board drawn here reads as it did. */
function dimensionNotes(project: Project): string[] {
  const dims = project.dimensions ?? []
  const images = project.images ?? []
  if (!dims.length && !images.length) return []
  const plotted = new Map([
    ["F.Cu", "top copper"],
    ["B.Cu", "bottom copper"],
    ["F.Mask", "top solder mask"],
    ["B.Mask", "bottom solder mask"],
    ["F.Paste", "top paste"],
    ["B.Paste", "bottom paste"],
    ["F.SilkS", "top silkscreen"],
    ["B.SilkS", "bottom silkscreen"],
    ["Edge.Cuts", "board outline"],
  ])
  const lines: string[] = []
  const by = new Map<string, number>()
  for (const d of dims) by.set(d.layer, (by.get(d.layer) ?? 0) + 1)
  const kept = [...by].filter(([layer]) => plotted.has(layer))
  const skipped = [...by].filter(([layer]) => !plotted.has(layer)).reduce((n, [, c]) => n + c, 0)
  if (dims.length) {
    lines.push("DIMENSIONS")
    for (const [layer, n] of kept) lines.push(`  ${layer.padEnd(18)}${n}: lines and text in the ${plotted.get(layer)} file`)
    if (skipped) lines.push(`  Not plotted       ${skipped}: dimensions on fabrication, courtyard, adhesive and user layers are not in the files, as KiCad does not plot them by default`)
    lines.push("", "")
  }
  if (images.length) {
    lines.push("REFERENCE IMAGES", `  ${images.length} image${images.length > 1 ? "s" : ""} kept for the board and its export; never plotted, as KiCad plots none`, "", "")
  }
  return lines
}

/** Where the texts of a board brought in from KiCad went and which were not plotted: only for a board that has any, so a board drawn here reads as it did. */
function textNotes(project: Project): string[] {
  const all = worldTexts(project).filter((t) => !isDimensionText(t))
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
  const outlined = drawn.filter((t) => textFontState(project, t) === "outline").length
  const stroked = drawn.filter((t) => ["edited", "uncached"].includes(textFontState(project, t) ?? ""))
  const strokeFonts = [...new Set(stroked.map((t) => t.face!))]
  return [
    "TEXT",
    ...lines,
    ...(outlined ? [`  TrueType outlines ${outlined}: plotted as KiCad drew them (the polygons of the board file)`] : []),
    ...(stroked.length ? [`  Stroke font       ${stroked.length}: text in ${strokeFonts.slice(0, 3).join(", ")}${strokeFonts.length > 3 ? " and more" : ""} has no outlines here (none in the file, or edited since), so it is plotted in KiCad's stroke font and its letters are not the font's`] : []),
    ...(knockouts ? [`  Knockout          ${knockouts}: a filled box with the letters left out, plotted as a region`] : []),
    ...(skipped.size ? [`  Not plotted       ${[...skipped].map(([what, n]) => `${what} ${n}`).join(", ")}: fabrication, courtyard, adhesive and user layers are not in the files, as KiCad does not plot them by default`] : []),
    ...(placed.length > drawn.length ? [`  Hidden            ${placed.length - drawn.length}: hidden text is neither drawn nor plotted`] : []),
    ...(all.length > placed.length ? [`  Not on the PCB    ${all.length - placed.length}: text of parts not placed on the board is left out`] : []),
    "",
  ]
}

/** The variant (a schematic's or a board's) the files are made for, when the project has variants: its flags and field values are already on the parts below. */
function variantNotes(project: Project): string[] {
  const active = activeVariant(project)
  if (!project.variants?.list.length) return []
  return ["VARIANT", active === undefined ? `  Variant           none active: the parts as they are (the project has ${variantNames(project).length}: ${variantNames(project).join(", ")})` : `  Variant           ${active}: bom.csv, pnp.csv, the drill and Gerber files are for this variant`, ""]
}

/** The flags on parts, and what each does to the files: only for a board that has any, so a board drawn here reads as it did. */
function assemblyNotes(project: Project): string[] {
  const flagged = resolvedComponents(project).filter((c) => c.flags)
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

/**
 * What a fab is asked to do to the vias beyond tenting (X22, IPC-4761): the vias that are filled, capped, covered or plugged, each combination counted, and the board's own rule. Only for a board that has any, so
 * a board drawn here reads as it did. Which of it is in which file is KiCad's: the Gerber files `-filling-`, `-capping-`, `-covering-` and `-plugging-`.
 */
function viaProtectionNotes(project: Project): string[] {
  const r = project.rules
  const counts = new Map<string, number>()
  for (const v of project.vias) {
    const words = protectionWords(viaProtection(r, v, project.board))
    if (words.length) counts.set(words.join(", "), (counts.get(words.join(", ")) ?? 0) + 1)
  }
  if (!counts.size) return []
  const rule = r.viaProtect ? protectionWords(viaProtection({ ...r, viaProtect: r.viaProtect }, {})) : []
  return [
    "VIA PROTECTION",
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([what, n]) => `  ${`${n} via${n === 1 ? "" : "s"}`.padEnd(18)}${what}`),
    ...(rule.length ? [`  Board rule        ${rule.join(", ")} (for a via that does not say)`] : []),
    "  Files             -filling-, -capping-, -covering- and -plugging- Gerber files (function Other): a flash of each protected via, as KiCad's Gerber drill files have them",
    "  Solder mask       the mask files open or close each via by its tenting only; covering, plugging, filling and capping are not in them, as in KiCad's own plot",
    "",
  ]
}

/**
 * Backdrills and post-machining (X22): every via's and pad's, with the layers it runs between, its size and depth. KiCad's drill files carry a via's (a file of each backdrill span, a comment beside a
 * post-machined hole) and not a pad's, so the pad's are listed here in full. Only for a board that has any.
 */
function machiningNotes(project: Project): string[] {
  const backdrills = viaBackdrills(project)
  const pads = padMachining(project)
  const posts = project.vias.filter((v) => v.post)
  if (!backdrills.length && !pads.length && !posts.length) return []
  const name = (l: string) => (l === "top" ? "F.Cu" : l === "bottom" ? "B.Cu" : `In${l.slice(2)}.Cu`)
  const lines = ["BACKDRILL AND POST-MACHINING"]
  if (backdrills.length) {
    const by = new Map<string, number>()
    for (const h of backdrills) {
      const key = `${h.kind === "tertiary" ? "tertiary drill" : "backdrill"} ${mm(h.size)}, ${name(h.from)} to ${name(h.to)}, stub ${mm(h.stub)}`
      by.set(key, (by.get(key) ?? 0) + 1)
    }
    for (const [what, n] of by) lines.push(`  ${`${n} via${n === 1 ? "" : "s"}`.padEnd(18)}${what}`)
    lines.push("  Files             one backdrill drill file for each span: _Backdrills_Drill_<first>_<last>, and -<layers>-backdrill with a `; backdrill` comment before each hit")
  }
  if (posts.length) {
    const by = new Map<string, number>()
    for (const v of posts) for (const [side, p] of [["front", v.post!.front], ["back", v.post!.back]] as const) if (p) by.set(postMachiningComment(side, p).replace("Post-machining ", ""), (by.get(postMachiningComment(side, p).replace("Post-machining ", "")) ?? 0) + 1)
    for (const [what, n] of by) lines.push(`  ${`${n} via${n === 1 ? "" : "s"}`.padEnd(18)}${what}`)
    lines.push("  Files             a comment before each such hole in the plated drill file")
  }
  for (const p of pads) {
    const bits: string[] = []
    if (p.backdrill) bits.push(`backdrill ${mm(p.backdrill.size)}, ${name(p.backdrill.from)} to ${name(p.backdrill.to)}`)
    if (p.tertiary) bits.push(`tertiary drill ${mm(p.tertiary.size)}, ${name(p.tertiary.from)} to ${name(p.tertiary.to)}`)
    if (p.front) bits.push(postMachiningComment("front", p.front).replace("Post-machining ", ""))
    if (p.back) bits.push(postMachiningComment("back", p.back).replace("Post-machining ", ""))
    lines.push(`  ${`${p.ref} pad ${p.pad}`.padEnd(18)}${bits.join("; ")} (at ${mm(p.x)}, ${mm(p.y)})`)
  }
  if (pads.length) lines.push("  Pads              KiCad's drill files do not carry a pad's backdrill or post-machining (only its ODB++ and IPC-2581 do), so these are given here")
  lines.push("")
  return lines
}

/** Tuning patterns and the lengths inside packages (X21): what was tuned and to what, and which pads add length to their net. Only for a board that has any. */
function lengthNotes(project: Project): string[] {
  const patterns = tuningPatterns(project)
  const dies = padDieTimes(project)
  if (!patterns.length && !dies.length) return []
  const lines = ["TUNING AND LENGTHS"]
  for (const t of patterns) {
    const target = t.target === null ? "no target" : `target ${mm(t.target)}${t.min !== null && t.max !== null ? ` (${mm(t.min)} to ${mm(t.max)})` : ""}`
    lines.push(`  ${(t.name || "Tuning pattern").slice(0, 18).padEnd(18)}${t.layer}, ${target}${t.last ? `, last tuned: ${t.last}` : ""}`)
  }
  if (dies.length) lines.push(`  Package lengths   ${dies.length} pad${dies.length === 1 ? "" : "s"} have a length inside the package (die length${dies.some((d) => d.delay !== undefined) ? " and delay" : ""}), which a net's length counts: ${dies.slice(0, 6).map((d) => `${d.ref} pad ${d.pad} ${mm(d.length)}`).join(", ")}${dies.length > 6 ? ", ..." : ""}`)
  lines.push("")
  return lines
}

/** The vias that are not through vias, in words: `, 3 blind, 2 micro`. */
function viaKindsNote(project: Project): string {
  const count = (k: string) => project.vias.filter((v) => v.kind === k).length
  const parts = (["blind", "buried", "micro"] as const).filter((k) => count(k)).map((k) => `${count(k)} ${k}`)
  return parts.length ? ` (${parts.join(", ")})` : ""
}

/** How the board's rule has vias tented: both sides, neither, or one side. */
function tentNote(r: Project["rules"]): string {
  if (r.tentSides) return `tented on the ${r.tentSides.front ? "front" : "back"} only`
  return r.tentVias ? "tented" : "not tented"
}
