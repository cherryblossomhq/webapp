import { pointSegmentDistance, round } from "../lib/geometry"
import type { AutorouteResult, NarrowSpan, OpenConnection } from "../model/autoroute"
import { findPart } from "../model/library"
import { pointPadDistance, type CopperItem, type PcbAnalysis } from "../model/pcb"
import type { WorldPad } from "../model/instances"
import type { Project, Vec2 } from "../model/types"

// What route_pcb and run_checks say of the connections a routing left open and of the stretches it laid narrower than their net's width:
// each by the pins at its ends and where it is. They used to give counts only ("2 connection(s) could not be routed", "VBUS (1 at 0.25 mm,
// not 0.4 mm)", "PCB: 1 unrouted"), so on a user's USB-C bridge Sakura spent an evening of turns moving capacitors 0.1 mm at a time without
// ever learning which connection was open or which stretch of VBUS was thin: it said "I haven't found which net it is" forty times.

const mm = (v: number) => String(round(v, 2))
const at = (p: Vec2) => `(${mm(p.x)}, ${mm(p.y)})`

/** A pad as a pin the tools take: `REF.PAD`, with the pin's name after it when it says more than the number ("U1.3 (VDD5)"). */
export function padName(project: Project, pad: WorldPad): string {
  const c = project.components.find((x) => x.id === pad.componentId)
  const number = pad.padNumber ?? pad.pin ?? "?"
  const name = c && pad.pin ? findPart(c.partId)?.pins.find((p) => p.number === pad.pin)?.name : undefined
  const label = `${c?.ref ?? "?"}.${number}`
  return name && name !== number && !/^[~\d]*$/.test(name) ? `${label} (${name})` : label
}

/**
 * The copper item at a point of a ratsnest line or a routed connection: a pad first, then a via, then a track, of the net when it is
 * known (parts moved onto each other have pads of two nets at one point), else of any.
 */
function itemAt(analysis: PcbAnalysis, p: Vec2, netId?: string | null): CopperItem | undefined {
  const netOf = (it: CopperItem) => (it.kind === "pad" ? it.netId : analysis.islandNet.get(analysis.island.get(it.id) ?? -1))
  const rank = (it: CopperItem): number => {
    const own = !netId || netOf(it) === netId ? 0 : 3
    if (it.kind === "pad") return pointPadDistance(p, it.pad) === 0 ? own : -1
    if (it.kind === "via") return Math.hypot(p.x - it.at.x, p.y - it.at.y) <= it.diameter / 2 + 1e-6 ? own + 1 : -1
    if (it.kind === "segment") return pointSegmentDistance(p, it.a, it.b) <= it.width / 2 + 1e-6 ? own + 2 : -1
    return -1
  }
  let best: CopperItem | undefined
  let bestRank = Infinity
  for (const it of analysis.items) {
    const r = rank(it)
    if (r < 0 || r >= bestRank) continue
    best = it
    bestRank = r
    if (r === 0) break
  }
  return best
}

/**
 * One end of a connection, as a pin where it is a pad, else as the copper it is on and the nearest pad that copper joins
 * ("the copper of J1.A6 (D+) at (3, 1.4)"), so it can be given to draw_trace or found on the board.
 */
export function endName(project: Project, analysis: PcbAnalysis, p: Vec2, netId?: string | null): { name: string; pin: string | null } {
  const it = itemAt(analysis, p, netId)
  if (it?.kind === "pad") return { name: padName(project, it.pad), pin: padName(project, it.pad).split(" ")[0] }
  const root = it ? analysis.island.get(it.id) : undefined
  let near: WorldPad | null = null
  let d = Infinity
  if (root !== undefined) {
    for (const x of analysis.items) {
      if (x.kind !== "pad" || analysis.island.get(x.id) !== root) continue
      const dd = Math.hypot(x.pad.x - p.x, x.pad.y - p.y)
      if (dd < d) {
        d = dd
        near = x.pad
      }
    }
  }
  if (!near) return { name: `copper at ${at(p)}`, pin: null }
  return { name: `the copper of ${padName(project, near)} at ${at(p)}`, pin: padName(project, near).split(" ")[0] }
}

/** The open connections, one each: net, the two ends, where. */
export function openList(project: Project, analysis: PcbAnalysis, open: Pick<OpenConnection, "net" | "netId" | "a" | "b">[], limit = 12): string {
  const rows = open.slice(0, limit).map((o) => {
    const a = endName(project, analysis, o.a, o.netId)
    const b = endName(project, analysis, o.b, o.netId)
    // Two pieces of the net's copper that meet at a point without joining (a track ending on a pad of another layer) have one name.
    if (a.name === b.name) return `${o.net}: ${a.name}, where two pieces of its copper meet without joining`
    const where = a.name.includes(" at (") || b.name.includes(" at (") ? "" : `, ${at(o.a)} to ${at(o.b)}`
    return `${o.net}: ${a.name} to ${b.name}${where}`
  })
  if (open.length > limit) rows.push(`and ${open.length - limit} more`)
  return rows.join("; ")
}

/** Where each net went narrower: how much of which connection, between which points, on which layer. */
export function narrowList(project: Project, analysis: PcbAnalysis, narrowed: NonNullable<AutorouteResult["narrowed"]>, limit = 8): string {
  const rows: string[] = []
  for (const n of narrowed) {
    for (const sp of n.spans.slice(0, limit)) rows.push(`${n.net} (${mm(n.width)} mm) ${spanText(project, analysis, sp)}`)
    if (n.spans.length > limit) rows.push(`${n.net}: and ${n.spans.length - limit} more`)
  }
  return rows.join("; ")
}

function spanText(project: Project, analysis: PcbAnalysis, sp: NarrowSpan): string {
  const a = endName(project, analysis, sp.a).name
  const b = endName(project, analysis, sp.b).name
  const whole = sp.length >= sp.total - 0.05
  return `${mm(sp.width)} mm for ${whole ? "all" : `${mm(sp.length)} mm`} of the ${mm(sp.total)} mm from ${a} to ${b}, between ${at(sp.from)} and ${at(sp.to)} on ${sp.layer}`
}

/** The pins a connection could be drawn between with draw_trace, when both ends are pads: `from "C3.1" to "U1.3"`. */
export function drawHint(project: Project, analysis: PcbAnalysis, ends: { a: Vec2; b: Vec2 } | undefined): string {
  if (!ends) return ""
  const a = endName(project, analysis, ends.a).pin
  const b = endName(project, analysis, ends.b).pin
  return a && b && a !== b ? ` (from "${a}" to "${b}")` : ""
}
