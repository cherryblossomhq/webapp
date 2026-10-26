import * as THREE from "three"
import type { PadDef } from "../../../model/types"
import type { ModelContext } from "./index"
import { Builder, SEAT, block } from "./kit"
import { clamp, mpnOf, sizeOnXY, type BodySize } from "./smd"
import { icName } from "./values"

// Bodies for packages the library has no model of, built from a package's own size (when its name
// gave one) and from the pads, so one builder draws a whole family.

/** Bounds and centre of the pads' copper. */
function padBox(pads: PadDef[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pads) {
    minX = Math.min(minX, p.x - p.width / 2)
    maxX = Math.max(maxX, p.x + p.width / 2)
    minY = Math.min(minY, p.y - p.height / 2)
    maxY = Math.max(maxY, p.y + p.height / 2)
  }
  return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY }
}

/** Smallest centre-to-centre distance between pads along either axis, ignoring pads in line. */
function gridPitch(pads: PadDef[]): number {
  const gaps = (vals: number[]) => {
    const u = [...new Set(vals.map((v) => Math.round(v * 100)))].sort((a, b) => a - b)
    let g = Infinity
    for (let i = 1; i < u.length; i++) g = Math.min(g, (u[i] - u[i - 1]) / 100)
    return g
  }
  const g = Math.min(gaps(pads.map((p) => p.x)), gaps(pads.map((p) => p.y)))
  return Number.isFinite(g) ? g : 1
}

// ---------- ball grid, chip-scale and land grid packages ----------

/**
 * BGA, CSP and LGA: a flat body with its pads under it. A BGA shows its solder balls round the
 * foot; an LGA has none to show.
 */
export function gridPackage(ctx: ModelContext, size?: BodySize, balls = true): Builder {
  const b = new Builder()
  const pads = ctx.pads
  const box = padBox(pads)
  const pitch = gridPitch(pads)
  let [bw, bl] = size ? sizeOnXY(size, box.w >= box.h) : [box.w + pitch, box.h + pitch]
  if (!size && !balls) {
    // An LGA's pads reach out past the body, so the copper's extent is too big. Two columns of
    // pads sit on the body's edges (the body is twice their distance from the middle); a grid
    // runs half a pitch past its outer pads.
    const extent = (vals: number[], mid: number) => {
      const distinct = new Set(vals.map((v) => Math.round(v * 100)))
      return distinct.size <= 2 ? 2 * Math.max(...vals.map((v) => Math.abs(v - mid))) : Math.max(...vals) - Math.min(...vals) + pitch
    }
    bw = Math.min(bw, extent(pads.map((p) => p.x), box.cx))
    bl = Math.min(bl, extent(pads.map((p) => p.y), box.cy))
  }
  const ballH = balls ? clamp(pitch * 0.55, 0.15, 0.5) : 0.04
  const z0 = SEAT + ballH * 0.85
  const H = size?.h ?? clamp(Math.min(bw, bl) * 0.16 + ballH, 0.5, 1.5)
  b.add("epoxy", block(box.cx, box.cy, bw, bl, z0, z0 + H, Math.min(0.15, Math.min(bw, bl) * 0.05), Math.min(0.12, H * 0.2)))
  if (balls) {
    for (const p of pads) {
      const r = clamp(Math.min(p.width, p.height) * 0.5, 0.08, ballH * 0.62)
      const g = new THREE.SphereGeometry(r, 8, 6)
      g.translate(p.x, p.y, SEAT + r * 0.95)
      b.add("solder", g)
    }
  } else {
    for (const p of pads) b.box("tin", clamp(p.x, box.cx - bw / 2 + 0.1, box.cx + bw / 2 - 0.1), clamp(p.y, box.cy - bl / 2 + 0.1, box.cy + bl / 2 - 0.1), SEAT, 0.2, 0.2, ballH + 0.02)
  }
  const pin1 = pads.find((p) => p.pin === "1" || p.pin === "A1")
  const top = z0 + H
  if (pin1) {
    const dot = new THREE.CircleGeometry(clamp(Math.min(bw, bl) * 0.05, 0.1, 0.3), 16)
    const sx = Math.sign(Math.round((pin1.x - box.cx) * 100)) || -1
    const sy = Math.sign(Math.round((pin1.y - box.cy) * 100)) || 1
    dot.translate(box.cx + sx * (bw / 2 - Math.min(0.45, bw * 0.16)), box.cy + sy * (bl / 2 - Math.min(0.45, bl * 0.16)), top + 0.002)
    b.add("epoxyGloss", dot)
  }
  const mpn = mpnOf(ctx)
  if (mpn && Math.min(bw, bl) >= 1.4) b.mark({ lines: [icName(mpn)], x: box.cx, y: box.cy, z: top + 0.004, width: bw * 0.7, height: Math.min(bl * 0.3, bw * 0.3), rotZ: bw >= bl ? 0 : -Math.PI / 2, color: "#a3a3a8", weight: 600 })
  return b
}
