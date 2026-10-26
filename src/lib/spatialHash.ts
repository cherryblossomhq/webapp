import type { Box } from "./geometry"

/** Cells a sheet or a board is never wider than, in cell units; far more than any drawing needs. */
const CELL_STRIDE = 1_000_003

/** Items bucketed by the cells their boxes touch, so a lookup only meets what is nearby. */
export class SpatialHash<T> {
  // A cell is a pair of whole numbers; one number names it, which is much cheaper to make and look up than a string.
  private cells = new Map<number, T[]>()

  constructor(private readonly size = 1) {}

  private span(b: Box) {
    const e = 1e-6
    return {
      x0: Math.floor((b.minX - e) / this.size),
      x1: Math.floor((b.maxX + e) / this.size),
      y0: Math.floor((b.minY - e) / this.size),
      y1: Math.floor((b.maxY + e) / this.size),
    }
  }

  insert(item: T, b: Box) {
    const { x0, x1, y0, y1 } = this.span(b)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x * CELL_STRIDE + y
        const list = this.cells.get(key)
        if (list) list.push(item)
        else this.cells.set(key, [item])
      }
    }
  }

  /** Everything whose box touches a cell that `b` touches; callers still test the exact shape. */
  query(b: Box): T[] {
    const { x0, x1, y0, y1 } = this.span(b)
    const out = new Set<T>()
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) for (const item of this.cells.get(x * CELL_STRIDE + y) ?? []) out.add(item)
    }
    return [...out]
  }
}

export const pointBox = (p: { x: number; y: number }, pad = 0): Box => ({
  minX: p.x - pad,
  maxX: p.x + pad,
  minY: p.y - pad,
  maxY: p.y + pad,
})
