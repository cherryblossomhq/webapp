import * as THREE from "three"
import type { PadDef } from "../../../model/types"
import type { ModelContext } from "./index"
import {
  Builder,
  bezier,
  block,
  dateCode,
  lathe,
  profileXZ,
  slab,
  solderJoint,
  stadiumShape,
  thicken,
  wire,
  type P2,
} from "./kit"
import { mpnOf, padLayout, reelSeed, twoPadAxis } from "./smd"
import { crystalText, icName, resistorBands } from "./values"

/** How far through-hole leads poke out below the board. */
const TAIL = 1.2

const padR = (p: PadDef) => Math.min(p.width, p.height) / 2

// ---------- DIP ----------

export function dip(ctx: ModelContext): Builder | null {
  const layout = padLayout(ctx.pads)
  if (!layout || layout.kind !== "dual-x") return null
  const b = new Builder()
  const t = ctx.boardThickness
  const side = layout.sides[0]
  const X = side.X
  const B = X - 0.635
  const rowHalf = Math.max(...layout.sides.map((s) => s.rowHalf))
  const halfLen = rowHalf + 0.95
  const z0 = 0.5
  const z1 = 3.8
  const exitZ = z0 + 1.15
  b.add("epoxy", block(0, 0, B * 2, halfLen * 2, z0, z1, 0.25, 0.22))

  const strip = 0.25
  for (const s of layout.sides) {
    const sign = s.key === "+x" ? 1 : -1
    for (const p of s.pads) {
      // Shoulder: out of the body side, bent down outside the row line.
      const path: P2[] = [[B - 0.3, exitZ], [X - 0.3, exitZ], ...bezier([X - 0.3, exitZ], [X - 0.05, exitZ], [X, exitZ - 0.1], [X, exitZ - 0.35], 6), [X, 0.75]]
      const shoulder = profileXZ(thicken(path, strip), 1.25)
      if (sign < 0) shoulder.rotateZ(Math.PI)
      shoulder.translate(0, p.y - layout.cy, 0)
      b.add("tin", shoulder)
      const px = sign * X
      const py = p.y - layout.cy
      // Taper from the wide shoulder to the narrow tail.
      const taper = profileXZ([[-0.625, 0.82], [-0.25, 0.42], [0.25, 0.42], [0.625, 0.82]], strip)
      taper.rotateZ(Math.PI / 2)
      taper.translate(px, py, 0)
      b.add("tin", taper)
      b.box("tin", px, py, -t - TAIL, strip, 0.5, t + TAIL + 0.5)
    }
  }
  b.transform(layout.cx, layout.cy, 0)
  for (const p of ctx.pads) solderJoint(b, p.x, p.y, t, padR(p), 0.3)

  // Notch at the pin-1 end and a pin-1 dot.
  const pin1 = ctx.pads.find((p) => p.pin === "1")
  const end = pin1 && pin1.y < layout.cy ? -1 : 1
  const notch = new THREE.CircleGeometry(0.75, 24, end > 0 ? Math.PI : 0, Math.PI)
  notch.translate(layout.cx, layout.cy + end * halfLen, z1 + 0.002)
  b.add("epoxyGloss", notch)
  if (pin1) {
    const dot = new THREE.CircleGeometry(0.42, 20)
    dot.translate(layout.cx + Math.sign(pin1.x - layout.cx) * (B - 0.85), pin1.y - end * 0.35, z1 + 0.002)
    b.add("epoxyGloss", dot)
  }
  const mpn = mpnOf(ctx)
  if (mpn)
    b.mark({
      lines: [icName(mpn), dateCode(reelSeed(ctx))],
      x: layout.cx,
      y: layout.cy,
      z: z1 + 0.004,
      width: halfLen * 2 * 0.7,
      height: B * 2 * 0.36,
      rotZ: -Math.PI / 2,
      color: "#a9a9ae",
      weight: 600,
    })
  return b
}

// ---------- TO-220 / TO-92 ----------

/**
 * The pads of a TO-220 or TO-92 in the frame the bodies are drawn in, which has the leads in a row
 * along x and the body behind them on +y. A land whose pads run along y (a supplier's) is turned a
 * quarter so the body still sits behind the row, on the side the courtyard's middle is; `finish`
 * turns what was drawn back to the land.
 */
function alongRow(ctx: ModelContext): { pads: PadDef[]; finish: (b: Builder) => Builder } {
  const xs = ctx.pads.map((p) => p.x)
  const ys = ctx.pads.map((p) => p.y)
  if (Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)) return { pads: ctx.pads, finish: (b) => b }
  const cx = xs.reduce((a, v) => a + v, 0) / xs.length
  const cy = ys.reduce((a, v) => a + v, 0) / ys.length
  const c = ctx.courtyard
  // +y of the drawing goes to -x for a quarter turn one way and +x for the other.
  const turn = (c.minX + c.maxX) / 2 > cx ? -Math.PI / 2 : Math.PI / 2
  const cos = Math.cos(-turn)
  const sin = Math.sin(-turn)
  const pads = ctx.pads.map((p) => ({ ...p, x: (p.x - cx) * cos - (p.y - cy) * sin, y: (p.x - cx) * sin + (p.y - cy) * cos }))
  return { pads, finish: (b) => b.transform(cx, cy, turn) }
}

/** `isolated`: a fully isolated TO-220F, plastic all the way up with no metal tab. */
export function to220(ctx: ModelContext, isolated = false): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const row = alongRow(ctx)
  const pads = row.pads
  const cx = pads.reduce((s, p) => s + p.x, 0) / pads.length
  const ly = pads.reduce((s, p) => s + p.y, 0) / pads.length
  // Body face 1.25 mm in front of the lead row; the 1.27 mm tab ends 3.15 mm behind it.
  const yFront = ly - 1.25
  const yTab = ly + 1.88
  const yBack = ly + 3.15
  const z0 = 3.2
  const zTop = z0 + 9.0
  // Plastic body in front of the tab (all the way back when there is no tab).
  b.add("epoxy", isolated ? block(cx, (yFront + yBack) / 2, 10.0, yBack - yFront, z0, zTop, 0.2, 0.25) : block(cx, (yFront + yTab) / 2, 10.0, yTab - yFront, z0, zTop, 0.2, 0.25))
  // Metal tab: covers the back and rises above the body, with the mounting hole.
  const tabTop = z0 + 15.4
  const holeZ = tabTop - 2.8
  const hole: P2[] = []
  for (let i = 0; i < 28; i++) {
    const a = -(i / 28) * Math.PI * 2
    hole.push([Math.cos(a) * 1.85, holeZ + Math.sin(a) * 1.85])
  }
  const tab = profileXZ(
    [
      [-5.0, z0],
      [5.0, z0],
      [5.0, holeZ - 0.6],
      [4.6, holeZ],
      [5.0, holeZ + 0.6],
      [5.0, tabTop],
      [-5.0, tabTop],
      [-5.0, holeZ + 0.6],
      [-4.6, holeZ],
      [-5.0, holeZ - 0.6],
    ],
    yBack - yTab,
    [hole],
  )
  tab.translate(cx, (yTab + yBack) / 2, 0)
  b.add(isolated ? "epoxy" : "brushed", tab)
  for (const p of pads) {
    b.box("tin", p.x, p.y, 1.6, 1.3, 0.5, z0 - 1.6 + 0.1)
    b.box("tin", p.x, p.y, -t - TAIL, 0.8, 0.5, t + TAIL + 1.7)
    solderJoint(b, p.x, p.y, t, padR(p), 0.4)
  }
  const mpn = mpnOf(ctx)
  if (mpn)
    b.mark({
      lines: [icName(mpn), `CT ${dateCode(reelSeed(ctx))}`],
      x: cx,
      y: yFront - 0.004,
      z: z0 + 5.2,
      width: 6.6,
      height: 2.5,
      face: "front",
      color: "#a9a9ae",
      weight: 600,
    })
  return row.finish(b)
}

export function to92(ctx: ModelContext): Builder {
  const b = new Builder()
  const row = alongRow(ctx)
  const pads = row.pads
  const cx = pads.reduce((s, p) => s + p.x, 0) / pads.length
  const cy = pads.reduce((s, p) => s + p.y, 0) / pads.length
  const shape = new THREE.Shape()
  shape.moveTo(cx - 2.25, cy - 0.6)
  shape.lineTo(cx + 2.25, cy - 0.6)
  shape.absarc(cx, cy - 0.6, 2.25, 0, Math.PI, false)
  b.add("epoxy", slab(shape, 2.6, 7.4, 0.15, 20))
  for (const p of pads) {
    b.box("tin", p.x, p.y, -ctx.boardThickness - TAIL, 0.45, 0.4, ctx.boardThickness + TAIL + 2.8)
    solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.25)
  }
  const mpn = mpnOf(ctx)
  if (mpn) b.mark({ lines: [icName(mpn).slice(0, 7)], x: cx, y: cy - 0.605, z: 5.4, width: 3.8, height: 1.4, face: "front", color: "#a9a9ae", weight: 600 })
  return row.finish(b)
}

// ---------- HC-49 crystal ----------

export function hc49(ctx: ModelContext): Builder {
  const b = new Builder()
  const ax = twoPadAxis(ctx.pads)
  b.add("nickel", slab(stadiumShape(0, 0, 11.3, 4.9), 0.15, 0.55, 0.12, 20))
  b.add("brushed", slab(stadiumShape(0, 0, 10.9, 4.6), 0.5, 3.6, 0.42, 24))
  for (const sign of [-1, 1]) b.cyl("tin", sign * (ax.gap / 2), 0, -ctx.boardThickness - TAIL, 0.3, 0.22, 10)
  b.mark({
    lines: [crystalText(ctx.component.props.frequency), dateCode(reelSeed(ctx))],
    x: 0,
    y: 0,
    z: 3.605,
    width: 6.4,
    height: 2.6,
    color: "#2c2c30",
    weight: 600,
  })
  b.transform(ax.cx, ax.cy, ax.angle)
  for (const p of ctx.pads) solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.22)
  return b
}

// ---------- capacitors ----------

/** Aluminium electrolytic can: sleeve with a negative stripe, stamped vent and two leads. */
export function electrolytic(ctx: ModelContext, diameter?: number, height?: number): Builder {
  const b = new Builder()
  const ax = twoPadAxis(ctx.pads)
  const c = ctx.courtyard
  const d = diameter ?? Math.max(4, Math.min(c.maxY - c.minY, c.maxX - c.minX) - 0.7)
  const r = d / 2
  const h = Math.min(height ?? ctx.part.body3d?.height ?? d * 2, d * 2.4)
  const z0 = 0.3
  const sleeve = ctx.part.body3d?.color ?? "#1d3a6e"
  const sleeveKey = `gloss:${sleeve}:0.38`
  b.add(
    sleeveKey,
    lathe(
      [
        [0.0, z0],
        [r - 0.3, z0],
        [r, z0 + 0.3],
        [r, z0 + 0.9],
        [r - 0.22, z0 + 1.1],
        [r, z0 + 1.3],
        [r, h - 0.45],
        [r - 0.08, h - 0.18],
        [r - 0.3, h - 0.02],
        [r - 0.55, h],
        [r - 0.62, h - 0.04],
      ],
      48,
    ),
  )
  // Aluminium top, slightly recessed, with the vent score.
  b.add("brushed", lathe([[r - 0.64, h - 0.2], [r - 0.6, h - 0.06], [0, h - 0.06]], 40))
  const vent = Math.min(r - 0.8, 2.4)
  if (d >= 6) {
    // "K" vent on larger cans.
    b.box("vent", 0, 0, h - 0.06, 0.14, vent * 2, 0.02)
    for (const a of [Math.PI / 6, -Math.PI / 6]) {
      const g = new THREE.BoxGeometry(vent * 1.05, 0.14, 0.02)
      g.translate(vent * 0.5, 0, 0)
      g.rotateZ(a)
      g.translate(0, 0, h - 0.05)
      b.add("vent", g)
    }
  } else {
    b.box("vent", 0, 0, h - 0.06, vent * 2, 0.14, 0.02)
    b.box("vent", 0, 0, h - 0.06, 0.14, vent * 2, 0.02)
  }
  // Negative stripe on the side of pin 2 (+x in the canonical frame).
  const span = Math.PI * 0.34
  b.add("sleeveStripe", lathe([[r + 0.006, z0 + 1.4], [r + 0.006, h - 0.5]], 16, Math.PI / 2 - span / 2, span))
  for (let z = z0 + 2; z < h - 1.2; z += 2.2) b.box(sleeveKey, r + 0.01, 0, z, 0.03, Math.min(1.1, r * 0.45), 0.28)
  for (const sign of [-1, 1]) b.cyl("tin", sign * (ax.gap / 2), 0, -ctx.boardThickness - TAIL, z0 + 0.1, 0.25, 10)
  b.transform(ax.cx, ax.cy, ax.angle)
  for (const p of ctx.pads) solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.25)
  return b
}

/** Dipped ceramic disc capacitor on two straight legs. */
export function ceramicDisc(ctx: ModelContext): Builder {
  const b = new Builder()
  const ax = twoPadAxis(ctx.pads)
  const w = Math.max(3.2, Math.min(ax.gap + 2.4, 6))
  const th = 2.3
  const hh = w * 1.05
  const zc = 2.4 + hh / 2
  const g = new THREE.SphereGeometry(0.5, 32, 20)
  g.scale(w, th, hh)
  g.translate(0, 0, zc)
  b.add("gloss:#d38d24:0.32", g)
  // Drip where the epoxy runs down the legs.
  const drip = new THREE.SphereGeometry(0.5, 20, 12)
  drip.scale(ax.gap + 0.8, th * 0.7, 1.4)
  drip.translate(0, 0, 2.7)
  b.add("gloss:#d38d24:0.32", drip)
  for (const sign of [-1, 1]) b.cyl("tin", sign * (ax.gap / 2), 0, -ctx.boardThickness - TAIL, 3.2, 0.25, 10)
  b.transform(ax.cx, ax.cy, ax.angle)
  for (const p of ctx.pads) solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.25)
  return b
}

// ---------- axial ----------

export function axial(ctx: ModelContext): Builder {
  const b = new Builder()
  const ax = twoPadAxis(ctx.pads)
  const a = ax.gap / 2
  const resistor = ctx.part.id === "resistor"
  const glass = !resistor && ax.gap <= 7.7
  const L = resistor ? Math.min(6.3, ax.gap - 2.6) : glass ? 3.8 : Math.min(5.2, ax.gap - 2.2)
  const R = resistor ? 1.2 : glass ? 0.95 : 1.35
  const zc = R + 0.35

  // Profile along the body axis (u) with radius; resistors get the bulged end caps.
  const prof: P2[] = resistor
    ? [
        [0, -L / 2],
        [R * 0.78, -L / 2],
        [R, -L / 2 + 0.45],
        [R, -L / 2 + 1.1],
        [R * 0.88, -L / 2 + 1.55],
        [R * 0.88, L / 2 - 1.55],
        [R, L / 2 - 1.1],
        [R, L / 2 - 0.45],
        [R * 0.78, L / 2],
        [0, L / 2],
      ]
    : [
        [0, -L / 2],
        [R * 0.8, -L / 2],
        [R, -L / 2 + 0.35],
        [R, L / 2 - 0.35],
        [R * 0.8, L / 2],
        [0, L / 2],
      ]
  const radAt = (u: number) => {
    for (let i = 1; i < prof.length; i++) {
      const [r0, u0] = prof[i - 1]
      const [r1, u1] = prof[i]
      if (u >= u0 && u <= u1 && u1 > u0) return r0 + ((r1 - r0) * (u - u0)) / (u1 - u0)
    }
    return R
  }
  const axisX = (g: THREE.BufferGeometry) => {
    g.rotateY(Math.PI / 2)
    g.translate(0, 0, zc)
    return g
  }
  const bandAt = (key: string, u0: number, u1: number) => {
    const pts: P2[] = []
    for (let i = 0; i <= 6; i++) {
      const u = u0 + ((u1 - u0) * i) / 6
      pts.push([radAt(u) * 1.006 + 0.004, u])
    }
    // lathe() revolves [radius, z]; the axis is turned onto X below.
    const g = new THREE.LatheGeometry(pts.map(([r, u]) => new THREE.Vector2(r, u)), 32)
    g.rotateX(Math.PI / 2)
    b.add(key, axisX(g))
  }
  const body = new THREE.LatheGeometry(prof.map(([r, u]) => new THREE.Vector2(r, u)), 36)
  body.rotateX(Math.PI / 2)

  if (resistor) {
    b.add("gloss:#d8c18f:0.5", axisX(body))
    const bands = resistorBands(ctx.component.props.resistance)
    const pos = [-L / 2 + 0.75, -L / 2 + 1.45, -L / 2 + 2.1, L / 2 - 0.8]
    bands.forEach((color, i) => bandAt(i === 3 || color === "#c49a3a" ? "gold" : `paint:${color}:0.5`, pos[i] - 0.22, pos[i] + 0.22))
  } else if (glass) {
    b.add("glassOrange", axisX(body))
    bandAt("paint:#161616:0.5", L / 2 - 0.95, L / 2 - 0.55)
    // Die slug inside the glass.
    const slug = new THREE.CylinderGeometry(0.42, 0.42, L * 0.55, 12)
    slug.rotateZ(Math.PI / 2)
    slug.translate(0, 0, zc)
    b.add("steel", slug)
  } else {
    b.add("epoxy", axisX(body))
    bandAt("sleeveStripe", L / 2 - 1.05, L / 2 - 0.55)
  }

  for (const sign of [-1, 1]) {
    const pts = [
      new THREE.Vector3(sign * (L / 2 - 0.3), 0, zc),
      new THREE.Vector3(sign * a, 0, zc),
      new THREE.Vector3(sign * a, 0, -ctx.boardThickness - TAIL),
    ]
    b.add("tin", wire(pts, 0.3, 0.7))
  }
  b.transform(ax.cx, ax.cy, ax.angle)
  for (const p of ctx.pads) solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.3)
  return b
}

// ---------- trimmer potentiometer ----------

export function potentiometer(ctx: ModelContext): Builder {
  const b = new Builder()
  const pads = ctx.pads
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const minX = Math.min(...xs) - 1.1
  const maxX = Math.max(...xs) + 1.1
  const minY = Math.min(...ys) - 1.3
  const maxY = Math.max(...ys) + 1.3
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const h = ctx.part.body3d?.height ?? 5
  const baseTop = h * 0.36
  b.add("potBlue", block(cx, cy, maxX - minX, maxY - minY, 0.35, baseTop, 0.5, 0.18))
  const rr = Math.min(maxX - minX, maxY - minY) / 2 - 0.35
  b.add("potBlue", lathe([[0, baseTop - 0.05], [rr, baseTop - 0.05], [rr, h - 0.6], [rr - 0.25, h - 0.35], [rr * 0.66, h - 0.35]], 40).translate(cx, cy, 0))
  b.add("white", lathe([[rr * 0.68, h - 0.7], [rr * 0.68, h - 0.2], [rr * 0.62, h], [0, h]], 40).translate(cx, cy, 0))
  const slot = rr * 1.1
  b.box("hole", cx, cy, h - 0.25, slot, 0.42, 0.27)
  b.box("hole", cx, cy, h - 0.25, 0.42, slot, 0.27)
  // Wiper pointer moulded into the rotor.
  b.box("white", cx + rr * 0.55, cy, h - 0.5, rr * 0.35, 0.3, 0.5)
  for (const p of pads) {
    b.box("tin", p.x, p.y, -ctx.boardThickness - TAIL, 0.8, 0.3, ctx.boardThickness + TAIL + 0.6)
    solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), 0.35)
  }
  return b
}
