import type { Box } from "./geometry"

// Things by the cells of a grid their boxes cover, so what is near a box is found without going through all of them: the PCB view picking under
// the pointer on every move (`editor/pcb/hitIndex.ts`), and the checks finding the copper near a hole or the edges of a pour near a pad (`model/pcb.ts`).

/** Something whose box covers more cells than this is kept in a list of its own, tried on every ask, rather than in each cell (a long track). */
const MAX_CELLS = 64

/** Ids (an index in the caller's own list) by the cells of a grid `cell` mm wide. */
export class CellGrid {
  private cells = new Map<number, number[]>()
  private wide: number[] = []
  constructor(private cell = 4) {}
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + cy + 32768
  }
  add(id: number, b: Box) {
    const x0 = Math.floor(b.minX / this.cell)
    const x1 = Math.floor(b.maxX / this.cell)
    const y0 = Math.floor(b.minY / this.cell)
    const y1 = Math.floor(b.maxY / this.cell)
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
  /** Whether `visit` says yes to an id whose box may meet `b`, asking until one does (an id may be asked more than once). */
  some(b: Box, visit: (id: number) => boolean): boolean {
    if (this.wide.some(visit)) return true
    for (let cx = Math.floor(b.minX / this.cell); cx <= Math.floor(b.maxX / this.cell); cx++) {
      for (let cy = Math.floor(b.minY / this.cell); cy <= Math.floor(b.maxY / this.cell); cy++) {
        if (this.cells.get(this.key(cx, cy))?.some(visit)) return true
      }
    }
    return false
  }
  /** The ids whose boxes may meet `b`, in ascending order, each once. */
  near(b: Box): number[] {
    const out: number[] = []
    this.some(b, (id) => {
      out.push(id)
      return false
    })
    out.sort((x, y) => x - y)
    let n = 0
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i]
    out.length = n
    return out
  }
}
