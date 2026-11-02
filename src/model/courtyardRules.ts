import { readKicadRules } from "./kicad/project/dru"
import { pcbPads } from "./instances"
import { padBox } from "./padDistance"
import { pointInRings } from "./shapes"
import type { ComponentInstance, Project, Vec2 } from "./types"

// The custom rules (`.kicad_dru`) that let parts' courtyards overlap near a part: KiCad's `courtyard_clearance` constraint with a min below zero,
// under a condition that names a part's courtyard, as a board with a module over other parts writes them (CERN's Macbeth: "Allow Overlap J20" for the
// parts under its Kria module). KiCad's courtyard check reports no overlap such a rule applies to (`DRC_TEST_PROVIDER_COURTYARD_CLEARANCE`). Only that
// shape of rule is read here; the rest of a rules file is still not applied (board slice X10).

type Side = "top" | "bottom"

interface Allowance {
  /** The parts the condition names, by reference (KiCad's `*` and `?` wildcards). */
  ref: RegExp
  /** Which of the named part's courtyards the condition reads. */
  courtyards: Side[]
  /** The sides the rule is checked on: both when it names no layer. */
  sides: Side[]
}

/** A part's courtyard rings on each side, as the overlap check draws them. */
export type CourtyardsOf = (c: ComponentInstance) => { top: Vec2[][]; bottom: Vec2[][] } | null

// `A.insideCourtyard('J20')`, and KiCad 7's `intersectsCourtyard` with its Front and Back forms (KiCad 7 made `insideCourtyard` a name for it).
const CONDITION = /^\s*[AB]\.(?:inside|intersects)(Front|Back)?Courtyard\(\s*(['"])([^'"]+)\2\s*\)\s*$/

/** A length of a rule (`-1mm`, `0.5`, `40mil`) in millimetres; a bare number is millimetres, as KiCad reads one. */
export function ruleLength(v: string): number | null {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(mm|mil|in|um)?\s*$/i.exec(v)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? "mm").toLowerCase()
  return unit === "mm" ? n : unit === "mil" ? n * 0.0254 : unit === "in" ? n * 25.4 : n / 1000
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)

/** The sides a rule's layers name: a front layer the top, a back one the bottom, `outer` both. A layer may be named as the board's layer table names it (`L1_TOP.Cu` for F.Cu). */
function sidesOf(project: Project, layers: string[]): Side[] {
  if (!layers.length) return ["top", "bottom"]
  const rows = project.kicad?.layers ?? []
  const sides = new Set<Side>()
  for (const l of layers) {
    const name = rows.find((r) => r.name === l || r.user === l)?.name ?? l
    if (name === "outer") {
      sides.add("top")
      sides.add("bottom")
    } else if (name.startsWith("F.")) sides.add("top")
    else if (name.startsWith("B.")) sides.add("bottom")
  }
  return [...sides]
}

function allowancesOf(project: Project): Allowance[] {
  const text = project.kicad?.dru
  if (!text) return []
  let rules
  try {
    rules = readKicadRules(text).rules.rules
  } catch {
    return []
  }
  const out: Allowance[] = []
  for (const r of rules) {
    const c = r.constraints.find((x) => x.type === "courtyard_clearance")
    const min = c?.min != null ? ruleLength(c.min) : null
    if (min === null || min >= 0) continue
    const m = CONDITION.exec(r.condition ?? "")
    if (!m) continue
    const sides = sidesOf(project, r.layers)
    if (!sides.length) continue
    out.push({ ref: glob(m[3]), courtyards: m[1] === "Front" ? ["top"] : m[1] === "Back" ? ["bottom"] : ["top", "bottom"], sides })
  }
  return out
}

/**
 * Whether the board's custom rules let two parts' courtyards overlap on a side, or null when it has no such rule. A rule applies when either part has a pad
 * on that side touching the courtyard the condition names (KiCad tests the part's copper on the layer the check is made on against it, and reads the
 * condition with each part as A).
 */
export function courtyardAllowance(project: Project, parts: readonly ComponentInstance[], courtyards: CourtyardsOf, copperCount: number): ((a: ComponentInstance, b: ComponentInstance, side: Side) => boolean) | null {
  const allowances = allowancesOf(project)
  if (!allowances.length) return null
  const named = allowances.map((a) => parts.flatMap((p) => (a.ref.test(p.ref) ? [courtyards(p)].flatMap((cy) => (cy ? a.courtyards.map((s) => cy[s]).filter((r) => r.length) : [])) : [])))
  const touches = new Map<string, boolean>()
  const inside = (c: ComponentInstance, i: number, side: Side) => {
    const key = `${c.id}|${i}|${side}`
    let hit = touches.get(key)
    if (hit === undefined) {
      const pads = pcbPads(c, copperCount).filter((p) => p.layers.includes(side))
      hit = pads.some((p) => {
        const b = padBox(p)
        const points = [{ x: p.x, y: p.y }, { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]
        return named[i].some((rings) => points.some((q) => pointInRings(q, rings)))
      })
      touches.set(key, hit)
    }
    return hit
  }
  return (a, b, side) => allowances.some((al, i) => al.sides.includes(side) && (inside(a, i, side) || inside(b, i, side)))
}
