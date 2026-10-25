import { DEFAULT_CLASS_DESCRIPTION, DEFAULT_CLASS_NAME } from "../../netClasses"
import type { DefaultNetClass, DesignRules, DiffPairSize, NetClass, ViaSize } from "../../types"
import { decodeNetName } from "./read"
import type { ImportReport } from "./report"
import type { KicadBoard, LegacyNetClass } from "./types"

// X10: the net classes and the design rules beyond the plain ones of a KiCad 4 or 5 board (KiCad 6 and later keep theirs in the project
// file, which the board does not carry). Everything the board says about them is written into `DesignRules`, or the import is refused
// by `lose` when the model cannot hold it exactly:
//
//   net_class Default        the rules' clearance, track width, via size and drill (`build.ts`); here its description when it has one of
//                            its own, its micro via size when it is not KiCad's default, its differential pair
//   net_class (any other)    a `NetClass` with every field of the block explicit (a KiCad 5 class stands alone: it does not follow Default),
//                            the micro via size only where it differs from Default's, and its nets
//   setup>user_via           `viaSizes`; setup>user_diff_pair `diffPairSizes`
//   setup>solder_mask_min_width, pad_to_paste_clearance_ratio, max_error, clearance_min, allow_soldermask_bridges_in_footprints
//                            `maskMinWidth`, `pasteRatio`, `maxError`, `minClearance`, `maskBridgesInParts`, each only when it is not KiCad's default
//   setup>through_hole_min and via_min_drill, when both are there and differ: `minDrill` and `minViaDrill`

/** KiCad's own micro via size (`DEFAULT_UVIASDIA` and `DEFAULT_UVIASDRILL`): a class that has it says nothing. */
export const KICAD_UVIA_DIAMETER = 0.3
export const KICAD_UVIA_DRILL = 0.1
/** What KiCad's `max_error` is when the file does not say (`ARC_HIGH_DEF`). */
export const KICAD_MAX_ERROR = 0.005

const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0

export interface X10Rules extends Partial<DesignRules> {
  /** How many members of net classes name no net of the board (they are kept by name). */
  unknownMembers?: number
}

/**
 * The X10 part of the rules, for `build.ts` to merge into the rules it made from the Default class and `setup`.
 * `labelText` maps a net's raw name in the file to the label the project gives it, which is how a net is found in the project.
 */
export function importRulesX10(board: KicadBoard, labelText: Map<string, string>, report: ImportReport, lose: (what: string) => void): X10Rules {
  const out: X10Rules = {}
  const { setup, setupWords } = board

  // ---- lists of sizes offered while routing ----
  const vias: ViaSize[] = []
  let badVia = false
  for (const v of board.userVias) {
    if (!positive(v.diameter) || !positive(v.drill)) badVia = true
    else if (!vias.some((x) => x.diameter === v.diameter && x.drill === v.drill)) vias.push({ diameter: v.diameter, drill: v.drill })
  }
  if (badVia) lose("a via size offered while routing (user_via) that is not two positive numbers")
  if (vias.length) out.viaSizes = vias
  const pairs: DiffPairSize[] = []
  let badPair = false
  for (const d of board.userDiffPairs) {
    if (!positive(d.width) || !positive(d.gap) || (d.viaGap !== undefined && !(Number.isFinite(d.viaGap) && d.viaGap >= 0))) badPair = true
    else if (!pairs.some((x) => x.width === d.width && x.gap === d.gap && x.viaGap === d.viaGap)) pairs.push({ width: d.width, gap: d.gap, ...(d.viaGap !== undefined ? { viaGap: d.viaGap } : {}) })
  }
  if (badPair) lose("a differential pair size offered while routing (user_diff_pair) that is not positive numbers")
  if (pairs.length) out.diffPairSizes = pairs

  // ---- rules that change what is checked or plotted ----
  if (positive(setup.clearance_min)) out.minClearance = setup.clearance_min
  if (positive(setup.solder_mask_min_width)) out.maskMinWidth = setup.solder_mask_min_width
  if (setup.pad_to_paste_clearance_ratio !== undefined && Number.isFinite(setup.pad_to_paste_clearance_ratio) && setup.pad_to_paste_clearance_ratio !== 0) {
    // a ratio that would take a pad's whole size and more is not one KiCad's own clamp (half the pad on each side) leaves unchanged
    if (Math.abs(setup.pad_to_paste_clearance_ratio) >= 10) lose("a paste ratio beyond 1000%")
    else out.pasteRatio = setup.pad_to_paste_clearance_ratio
  }
  if (positive(setup.max_error) && Math.abs(setup.max_error - KICAD_MAX_ERROR) > 1e-12) out.maxError = setup.max_error
  if (setupWords.allow_soldermask_bridges_in_footprints === "yes" || setupWords.allow_soldermask_bridges_in_footprints === "true") out.maskBridgesInParts = true
  const { through_hole_min: holeMin, via_min_drill: viaMin } = setup
  if (positive(holeMin) && positive(viaMin) && Math.abs(holeMin - viaMin) > 1e-9) out.minViaDrill = viaMin

  // ---- net classes ----
  const def = board.netClasses.find((c) => c.name === DEFAULT_CLASS_NAME)
  const others = board.netClasses.filter((c) => c !== def)
  // a class this importer cannot take exactly: two of one name (KiCad keeps one), a name with no text, a field the block leaves out or that is no number
  const seen = new Set<string>()
  for (const c of board.netClasses) {
    if (!c.name.trim()) lose("a net class with no name")
    if (seen.has(c.name)) lose(`two net classes named "${c.name}"`)
    seen.add(c.name)
    if (c.missing.length) lose(`the net class "${c.name}" leaves out ${c.missing.join(", ")}`)
    for (const [k, v] of [["clearance", c.clearance], ["trace_width", c.traceWidth], ["via_dia", c.viaDiameter], ["via_drill", c.viaDrill]] as const) {
      if (!c.missing.includes(k) && !(Number.isFinite(v) && (k === "clearance" ? v >= 0 : v > 0))) lose(`the net class "${c.name}" has a ${k} that is not a ${k === "clearance" ? "number of zero or more" : "positive number"}`)
    }
    for (const [k, v] of [["diff_pair_width", c.diffPairWidth], ["diff_pair_gap", c.diffPairGap]] as const) {
      if (v !== undefined && !positive(v)) lose(`the net class "${c.name}" has a ${k} that is not a positive number`)
    }
  }
  const defaults = defaultClassOf(def)
  if (defaults) out.defaultClass = defaults
  const effUvia = { diameter: defaults?.microViaDiameter ?? KICAD_UVIA_DIAMETER, drill: defaults?.microViaDrill ?? KICAD_UVIA_DRILL }

  /** The label a member of a class goes by in the project, or null for a net the project has no label for. */
  const labelOf = (raw: string): string | null => labelText.get(raw) ?? null
  const labels = new Set(labelText.values())
  const claimed = new Map<string, string>()
  let unknown = 0
  const classes: NetClass[] = []
  for (const c of others) {
    const nets: string[] = []
    for (const raw of c.netsRaw) {
      let name = labelOf(raw)
      if (name === null) {
        // The file lists a net that has no pad and no copper, so the project has no label for it. It is kept by its name unless that name is another net's.
        const text = decodeNetName(raw).trim()
        if (!text || labels.has(text)) {
          lose(`the net class "${c.name}" lists the net ${JSON.stringify(raw)}, which has no pad or copper and reads like another net`)
          continue
        }
        name = text
        unknown++
      }
      const other = claimed.get(name)
      if (other !== undefined && other !== c.name) lose(`the net ${JSON.stringify(name)} is listed in the net classes "${other}" and "${c.name}"`)
      claimed.set(name, c.name)
      if (!nets.includes(name)) nets.push(name)
    }
    const cls: NetClass = { name: c.name, nets, clearance: c.clearance, traceWidth: c.traceWidth, viaDiameter: c.viaDiameter, viaDrill: c.viaDrill }
    if (c.description) cls.description = c.description
    // a micro via size that is Default's changes nothing; one that is zero is no size
    if (positive(c.uviaDiameter) && c.uviaDiameter !== effUvia.diameter) cls.microViaDiameter = c.uviaDiameter
    if (positive(c.uviaDrill) && c.uviaDrill !== effUvia.drill) cls.microViaDrill = c.uviaDrill
    if (positive(c.diffPairWidth)) cls.diffPairWidth = c.diffPairWidth
    if (positive(c.diffPairGap)) cls.diffPairGap = c.diffPairGap
    classes.push(cls)
  }
  if (classes.length) out.netClasses = classes
  if (unknown) out.unknownMembers = unknown
  if (unknown) {
    report.entries.push({
      code: "net-class-unknown-nets",
      severity: "note",
      object: `${unknown} net${unknown === 1 ? "" : "s"} in net classes`,
      why: "The file lists these nets in a net class, but no pad or copper is on them, so the project has no such net. The classes keep them by name; they do nothing until a net of that name exists.",
      count: unknown,
    })
  }
  return out
}

/** What the Default class has that the rules do not hold, or null when it has nothing of its own. */
export function defaultClassOf(def: LegacyNetClass | undefined): DefaultNetClass | null {
  if (!def) return null
  const out: DefaultNetClass = {}
  if (def.description && def.description !== DEFAULT_CLASS_DESCRIPTION) out.description = def.description
  if (positive(def.uviaDiameter) && def.uviaDiameter !== KICAD_UVIA_DIAMETER) out.microViaDiameter = def.uviaDiameter
  if (positive(def.uviaDrill) && def.uviaDrill !== KICAD_UVIA_DRILL) out.microViaDrill = def.uviaDrill
  if (positive(def.diffPairWidth)) out.diffPairWidth = def.diffPairWidth
  if (positive(def.diffPairGap)) out.diffPairGap = def.diffPairGap
  return Object.keys(out).length ? out : null
}

/**
 * How many nodes of each path of the net classes say nothing and so are not imported (`carried.ts` counts the rest as written into the project): the
 * Default class when it has nothing of its own, its listed nets, and a micro via size that is KiCad's default (Default class) or Default's (any other).
 */
export function derivedClassNodes(board: KicadBoard): Map<string, number> {
  const out = new Map<string, number>()
  const bump = (path: string, n = 1) => {
    if (n > 0) out.set(path, (out.get(path) ?? 0) + n)
  }
  const def = board.netClasses.find((c) => c.name === DEFAULT_CLASS_NAME)
  const own = defaultClassOf(def)
  const dia = own?.microViaDiameter ?? KICAD_UVIA_DIAMETER
  const drill = own?.microViaDrill ?? KICAD_UVIA_DRILL
  for (const c of board.netClasses) {
    const isDefault = c === def
    if (isDefault) {
      bump("net_class>add_net", c.netsRaw.length)
      if (!own) bump("net_class")
    }
    if (!c.missing.includes("uvia_dia") && !(positive(c.uviaDiameter) && c.uviaDiameter !== (isDefault ? KICAD_UVIA_DIAMETER : dia))) bump("net_class>uvia_dia")
    if (!c.missing.includes("uvia_drill") && !(positive(c.uviaDrill) && c.uviaDrill !== (isDefault ? KICAD_UVIA_DRILL : drill))) bump("net_class>uvia_drill")
  }
  return out
}
