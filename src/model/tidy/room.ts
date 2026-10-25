import { round, type Box } from "../../lib/geometry"
import { componentTextBoxes } from "../blocks"
import { schematicBounds, schematicPins } from "../instances"
import { labelBox } from "../labels"
import { SCH_GRID } from "../symbols"
import type { ComponentInstance, NetLabel, Project, Vec2 } from "../types"
import { labelTurn, portInstance, portShape, VEC, type Dir, type RailKind } from "./shapes"

// Room on a drawn sheet for a label or port Tidy adds outside the blocks it lays out: at a cut a
// one-block tidy made, at a pin of another part left with nothing, or for a net's other name. What
// goes there is held to what the blocks are held to: drawn over nothing, no wire through it, and a
// stub that meets nothing but the point it leaves from, so it joins no other net.

const shrink = (b: Box, d: number): Box => ({ minX: b.minX + d, minY: b.minY + d, maxX: b.maxX - d, maxY: b.maxY - d })
const overlap = (a: Box, b: Box) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
const E = 1e-6

interface Seg {
  a: Vec2
  b: Vec2
}

const segBox = (s: Seg): Box => ({ minX: Math.min(s.a.x, s.b.x), minY: Math.min(s.a.y, s.b.y), maxX: Math.max(s.a.x, s.b.x), maxY: Math.max(s.a.y, s.b.y) })
const same = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < E && Math.abs(p.y - q.y) < E

/** A label or port and the stub it stands on: what `Room.place` found. */
export interface Terminal {
  /** The stub from where it leaves to the terminal, or one point when it stands right there. */
  path: Vec2[]
  label?: NetLabel
  port?: ComponentInstance
}

export class Room {
  private boxes: Box[] = []
  private segs: Seg[] = []
  private pins: Vec2[] = []

  constructor(project: Project) {
    for (const c of project.components) this.addComponent(c)
    for (const l of project.labels) this.boxes.push(shrink(labelBox(l), 0.005))
    for (const w of project.wires) for (let i = 1; i < w.points.length; i++) this.segs.push({ a: w.points[i - 1], b: w.points[i] })
  }

  private addComponent(c: ComponentInstance) {
    this.boxes.push(shrink(schematicBounds(c), 0.025), ...componentTextBoxes(c).map((t) => shrink(t, 0.005)))
    for (const pin of schematicPins(c)) this.pins.push(pin.pos)
  }

  /** Whether a stub along `path`, which may touch what is there only at its first point, and these boxes fit. */
  private fits(path: Vec2[], boxes: Box[]): boolean {
    const own: Seg[] = []
    for (let i = 1; i < path.length; i++) own.push({ a: path[i - 1], b: path[i] })
    for (const b of boxes) {
      const outer = shrink(b, 0.005)
      if (this.boxes.some((o) => overlap(o, outer))) return false
      const inner = shrink(b, 0.012)
      if ([...this.segs, ...own].some((s) => overlap(segBox(s), inner))) return false
    }
    const from = path[0]
    for (const s of own) {
      const sb = segBox(s)
      const grown = { minX: sb.minX - E, minY: sb.minY - E, maxX: sb.maxX + E, maxY: sb.maxY + E }
      if (this.boxes.some((o) => overlap(sb, shrink(o, 0.007)))) return false
      for (const t of this.segs) {
        const tb = segBox(t)
        const lo = { x: Math.max(sb.minX, tb.minX), y: Math.max(sb.minY, tb.minY) }
        const hi = { x: Math.min(sb.maxX, tb.maxX), y: Math.min(sb.maxY, tb.maxY) }
        if (lo.x > hi.x + E || lo.y > hi.y + E) continue
        if (!(same(lo, from) && same(hi, from))) return false
      }
      for (const p of this.pins) if (!same(p, from) && p.x >= grown.minX && p.x <= grown.maxX && p.y >= grown.minY && p.y <= grown.maxY) return false
    }
    return true
  }

  /** What it found takes its room, so the next one goes elsewhere. */
  private take(t: Terminal) {
    for (let i = 1; i < t.path.length; i++) this.segs.push({ a: t.path[i - 1], b: t.path[i] })
    if (t.label) this.boxes.push(shrink(labelBox(t.label), 0.005))
    if (t.port) this.addComponent(t.port)
  }

  /**
   * A label of `name` (a port, on a supply) on a stub out of `from`: for each length in steps of
   * the grid, each way in `dirs`, the first that fits. Null when none does.
   */
  place(from: Vec2, dirs: Dir[], lengths: number[], rail: RailKind | null, name: string, ids: { label: () => string; port: (partId: string) => { id: string; ref: string } }): Terminal | null {
    for (const len of lengths) {
      for (const dir of dirs) {
        const [dx, dy] = VEC[dir]
        const end = { x: round(from.x + dx * len * SCH_GRID), y: round(from.y + dy * len * SCH_GRID) }
        const path = len ? [from, end] : [from]
        const t = terminalAt(path, dir, rail, name)
        if (!this.fits(path, t.boxes)) continue
        const out: Terminal = { path }
        if (t.port) {
          const { id, ref } = ids.port(t.port.partId)
          out.port = { ...t.port, id, ref }
        } else out.label = { ...t.label!, id: ids.label() }
        this.take(out)
        return out
      }
    }
    return null
  }
}

/** The label or port at the end of `path`, running `dir`, and the boxes it draws. */
function terminalAt(path: Vec2[], dir: Dir, rail: RailKind | null, name: string): { boxes: Box[]; label?: NetLabel; port?: ComponentInstance } {
  const at = path[path.length - 1]
  if (!rail) {
    const label: NetLabel = { id: "", name, x: at.x, y: at.y, rot: labelTurn(dir) }
    return { boxes: [labelBox(label)], label }
  }
  const port = portInstance(portShape(rail, name, dir), name, at)
  return { boxes: [schematicBounds(port), ...componentTextBoxes(port)], port }
}
