import type { Box } from "./geometry"

// Things by the cells of a grid their boxes cover, so what is near a point is found without going through all of them: what the PCB view picks
// under the pointer on every move (`editor/pcb/hitIndex.ts`).

/** The grid's cell, in mm. */
const CELL = 4
/** Something whose box covers more cells than this is kept in a list of its own, tried on every ask, rather than in each cell (a long track). */
const MAX_CELLS = 64

/** Ids (an index in the caller's own list) by grid cell. */
export class CellGrid {
  private cells = new Map<number, number[]>()
  private wide: number[] = []
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + cy + 32768
  }
  add(id: number, b: Box) {
    const x0 = Math.floor(b.minX / CELL)
    const x1 = Math.floor(b.maxX / CELL)
    const y0 = Math.floor(b.minY / CELL)
    const y1 = Math.floor(b.maxY / CELL)
    if (!Number.isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) {
      this.wide.push(id)
      return
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy)
        const list = this.cells.get(k)
        if (list) list.push(id)
        else this.cells.set(k, [id])
      }
    }
  }
  /** The ids whose boxes may meet `b`, in ascending order, each once. */
  near(b: Box): number[] {
    const out: number[] = [...this.wide]
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
      for (let cy = Math.floor(b.minY / CELL); cy <= Math.floor(b.maxY / CELL); cy++) {
        const list = this.cells.get(this.key(cx, cy))
        if (list) for (const id of list) out.push(id)
      }
    }
    out.sort((a, b) => a - b)
    let n = 0
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i]
    out.length = n
    return out
  }
}
