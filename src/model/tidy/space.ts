import type { Box } from "../../lib/geometry"

// What Tidy has drawn so far, in grid units (one is the schematic's 0.1 grid), so that every new
// part, wire, label and power port can be checked against everything already there before it is
// drawn. Nothing is ever drawn over something else: a candidate that would touch what is there is
// refused, and a cheaper one looked for.
//
// Boxes (symbol bodies, text, labels, ports, the marks on unused pins) sit in a coarse hash.
// Wires are kept as the grid nodes and edges they run through, so a crossing is a shared node.

/** A grid node as one number. */
export const nodeKey = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768)
export const nodeX = (k: number) => Math.floor(k / 65536) - 32768
export const nodeY = (k: number) => (k % 65536) - 32768

export type ItemKind =
  /** A symbol's drawing. */
  | "body"
  /** A designator, value or port name. */
  | "text"
  /** A power or ground port's drawing. */
  | "port"
  | "label"
  /** The end of a pin, where only its own net may touch. */
  | "tip"
  /** The grid point in front of a pin, kept for the wire or label of its own net. */
  | "exit"
  /** A no-connect cross or the ring on an unconnected pin. */
  | "mark"
  /** Room kept for a net's label until the net is finished. */
  | "slot"

export interface Item {
  id: number
  box: Box
  kind: ItemKind
  /** The net a tip, exit, label, port or slot belongs to. */
  net: string | null
  /** Items of one owner (a part with its text) may overlap each other. */
  owner: string
}

export interface WireNode {
  net: string
  /** Wire ends at this node. */
  ends: number
  /** Wires passing straight through it, horizontally and vertically. */
  through: number
}

const CELL = 10
const cellKey = (cx: number, cy: number) => cx * 100003 + cy

/**
 * Boxes overlap with more than `gap` between them counted as apart. Exactly `gap` apart is apart,
 * whichever box is asked about first, whatever the rounding.
 */
export const boxesTouch = (a: Box, b: Box, gap = 0) =>
  a.minX - b.maxX < gap - 1e-6 && b.minX - a.maxX < gap - 1e-6 && a.minY - b.maxY < gap - 1e-6 && b.minY - a.maxY < gap - 1e-6

export const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

export const pointIn = (x: number, y: number, b: Box, eps = 1e-6) => x > b.minX - eps && x < b.maxX + eps && y > b.minY - eps && y < b.maxY + eps

export class Space {
  private items = new Map<number, Item>()
  private cells = new Map<number, Set<number>>()
  private seq = 1
  /** Wire nodes by key. Two nets never share one. */
  readonly nodes = new Map<number, WireNode>()
  /** Horizontal wire edges from the keyed node to the one on its right, by net. */
  readonly hEdges = new Map<number, string>()
  /** Vertical wire edges from the keyed node to the one above it, by net. */
  readonly vEdges = new Map<number, string>()
  private journal: (() => void)[] = []

  /** A point to roll back to. */
  mark() {
    return this.journal.length
  }

  rollback(to: number) {
    while (this.journal.length > to) this.journal.pop()!()
  }

  /** Forget the undo history, keeping what is drawn. */
  commit() {
    this.journal = []
  }

  private cellsOf(b: Box): number[] {
    const out: number[] = []
    const x0 = Math.floor(b.minX / CELL)
    const x1 = Math.floor(b.maxX / CELL)
    const y0 = Math.floor(b.minY / CELL)
    const y1 = Math.floor(b.maxY / CELL)
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) out.push(cellKey(cx, cy))
    return out
  }

  add(box: Box, kind: ItemKind, owner: string, net: string | null = null): number {
    const id = this.seq++
    const item: Item = { id, box, kind, owner, net }
    this.items.set(id, item)
    for (const c of this.cellsOf(box)) {
      let set = this.cells.get(c)
      if (!set) this.cells.set(c, (set = new Set()))
      set.add(id)
    }
    this.journal.push(() => this.drop(id))
    return id
  }

  private drop(id: number) {
    const item = this.items.get(id)
    if (!item) return
    this.items.delete(id)
    for (const c of this.cellsOf(item.box)) this.cells.get(c)?.delete(id)
  }

  remove(id: number) {
    const item = this.items.get(id)
    if (!item) return
    this.drop(id)
    this.journal.push(() => {
      this.items.set(id, item)
      for (const c of this.cellsOf(item.box)) {
        let set = this.cells.get(c)
        if (!set) this.cells.set(c, (set = new Set()))
        set.add(id)
      }
    })
  }

  item(id: number) {
    return this.items.get(id)
  }

  /** Items whose box touches `b`, each once, in the order they were added. */
  query(b: Box): Item[] {
    const seen = new Set<number>()
    for (const c of this.cellsOf(b)) for (const id of this.cells.get(c) ?? []) seen.add(id)
    return [...seen]
      .sort((a, b) => a - b)
      .map((id) => this.items.get(id)!)
      .filter((it) => boxesTouch(it.box, b))
  }

  /** Whether `test` holds for any item whose cell meets the box: a fast check that allocates nothing. */
  some(minX: number, minY: number, maxX: number, maxY: number, test: (it: Item) => boolean): boolean {
    const x0 = Math.floor(minX / CELL)
    const x1 = Math.floor(maxX / CELL)
    const y0 = Math.floor(minY / CELL)
    const y1 = Math.floor(maxY / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(cellKey(cx, cy))
        if (!cell) continue
        for (const id of cell) if (test(this.items.get(id)!)) return true
      }
    }
    return false
  }

  /** Any item touching the point, other than those `skip` lets through. */
  itemAt(x: number, y: number, skip: (it: Item) => boolean): Item | undefined {
    const c = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)))
    if (!c) return undefined
    for (const id of c) {
      const it = this.items.get(id)!
      if (pointIn(x, y, it.box) && !skip(it)) return it
    }
    return undefined
  }

  // ---------- Wires ----------

  /** Draw a wire along grid points, each step one grid unit across or up. */
  addWire(path: [number, number][], net: string) {
    this.applyWire(path, net, 1)
    this.journal.push(() => this.applyWire(path, net, -1))
  }

  /**
   * Take a wire out again, the reverse of `addWire`. Its undo puts it back without a journal entry
   * of its own, so a rollback that runs it leaves the wire drawn, as it was.
   */
  removeWire(path: [number, number][], net: string) {
    this.applyWire(path, net, -1)
    this.journal.push(() => this.applyWire(path, net, 1))
  }

  /** A wire's nodes and edges counted in (`+1`) or out (`-1`). */
  private applyWire(path: [number, number][], net: string, sign: 1 | -1) {
    for (let i = 0; i < path.length; i++) {
      const [x, y] = path[i]
      const k = nodeKey(x, y)
      let n = this.nodes.get(k)
      if (!n) {
        if (sign < 0) throw new Error(`Tidy: no wire to take out at ${x}, ${y}`)
        this.nodes.set(k, (n = { net, ends: 0, through: 0 }))
      }
      if (i === 0 || i === path.length - 1) n.ends += sign
      else n.through += sign
      if (n.ends <= 0 && n.through <= 0) this.nodes.delete(k)
      if (i > 0) {
        const [px, py] = path[i - 1]
        const map = py === y ? this.hEdges : this.vEdges
        const from = py === y ? nodeKey(Math.min(px, x), y) : nodeKey(x, Math.min(py, y))
        if (sign > 0) map.set(from, net)
        else map.delete(from)
      }
    }
  }

  /** Whether a wire of another net than `net` runs through or ends inside `b`. */
  wireIn(b: Box, net: string | null): boolean {
    const x0 = Math.ceil(b.minX - 1e-6)
    const x1 = Math.floor(b.maxX + 1e-6)
    const y0 = Math.ceil(b.minY - 1e-6)
    const y1 = Math.floor(b.maxY + 1e-6)
    // Edges crossing the box between grid lines, then nodes inside it.
    for (let y = y0; y <= y1; y++) {
      for (let x = Math.floor(b.minX) - 1; x <= Math.ceil(b.maxX); x++) {
        const n = this.hEdges.get(nodeKey(x, y))
        if (n !== undefined && n !== net && x < b.maxX && x + 1 > b.minX) return true
      }
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = Math.floor(b.minY) - 1; y <= Math.ceil(b.maxY); y++) {
        const n = this.vEdges.get(nodeKey(x, y))
        if (n !== undefined && n !== net && y < b.maxY && y + 1 > b.minY) return true
      }
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const n = this.nodes.get(nodeKey(x, y))
        if (n && n.net !== net) return true
      }
    }
    return false
  }

  /** Whether any wire, of any net, has a node strictly inside `b`. */
  anyWireInside(b: Box): boolean {
    for (let x = Math.ceil(b.minX + 1e-6); x <= Math.floor(b.maxX - 1e-6); x++) {
      for (let y = Math.ceil(b.minY + 1e-6); y <= Math.floor(b.maxY - 1e-6); y++) {
        if (this.nodes.has(nodeKey(x, y))) return true
      }
    }
    return false
  }

  /** The box around everything drawn. */
  bounds(): Box | null {
    let b: Box | null = null
    for (const it of this.items.values()) {
      if (it.kind === "exit") continue
      b = b
        ? { minX: Math.min(b.minX, it.box.minX), minY: Math.min(b.minY, it.box.minY), maxX: Math.max(b.maxX, it.box.maxX), maxY: Math.max(b.maxY, it.box.maxY) }
        : { ...it.box }
    }
    for (const k of this.nodes.keys()) {
      const x = nodeX(k)
      const y = nodeY(k)
      b = b ? { minX: Math.min(b.minX, x), minY: Math.min(b.minY, y), maxX: Math.max(b.maxX, x), maxY: Math.max(b.maxY, y) } : { minX: x, minY: y, maxX: x, maxY: y }
    }
    return b
  }
}
