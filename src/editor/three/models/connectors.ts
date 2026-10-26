import * as THREE from "three"
import type { PadDef } from "../../../model/types"
import type { ModelContext } from "./index"
import { Builder, SEAT, block, circleHole, gullWingLead, lathe, profileXZ, rectPath, roundedRectShape, slab, solderJoint, squarePin, type P2 } from "./kit"
import { microUsb, usbCReceptacle } from "./modules"

const TAIL = 1.2
const padR = (p: PadDef) => Math.min(p.width, p.height) / 2

/** Pitch between neighbouring pads, defaulting to 2.54 mm. */
function pitchOf(pads: PadDef[]): number {
  let best = Infinity
  for (let i = 0; i < pads.length; i++)
    for (let j = i + 1; j < pads.length; j++) best = Math.min(best, Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y))
  return Number.isFinite(best) ? best : 2.54
}

/** True when the pads run along x (one row) rather than y. */
const rowAlongX = (pads: PadDef[]) => {
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  return Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
}

function bounds(pads: PadDef[]) {
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// ---------- pin headers and sockets ----------

export function pinHeader(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const pitch = Math.min(pitchOf(ctx.pads), 2.54)
  const spacer = pitch * 0.985
  const plastic = Math.min(ctx.part.body3d?.height ?? 2.5, 3)
  const pinTop = plastic + 5.9
  for (const p of ctx.pads) {
    b.add("plasticBlack", block(p.x, p.y, spacer, spacer, 0, plastic, 0.12, 0.18))
    squarePin(b, "gold", p.x, p.y, -t - 2.6, pinTop, 0.64)
    solderJoint(b, p.x, p.y, t, padR(p), 0.36)
  }
  return b
}

export function socket(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const pitch = Math.min(pitchOf(ctx.pads), 2.54)
  const h = ctx.part.body3d?.height ?? 8.5
  const along = rowAlongX(ctx.pads)
  const bb = bounds(ctx.pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const len = (along ? bb.maxX - bb.minX : bb.maxY - bb.minY) + pitch
  const wid = (along ? bb.maxY - bb.minY : bb.maxX - bb.minX) + pitch
  const body = roundedRectShape(cx, cy, along ? len : wid, along ? wid : len, 0.15)
  b.add("plasticBlack", slab(body, 0, h, 0.15, 6))
  for (const p of ctx.pads) {
    // Square entry with a chamfered lead-in, dark inside.
    b.box("hole", p.x, p.y, h - 1.6, 1.0, 1.0, 1.605)
    const funnel = new THREE.CylinderGeometry(0.95, 0.72, 0.25, 4, 1, true)
    funnel.rotateY(Math.PI / 4)
    funnel.rotateX(Math.PI / 2)
    funnel.translate(p.x, p.y, h - 0.12)
    b.add("plasticBlack", funnel)
    b.box("gold", p.x, p.y, h - 1.6 + 0.01, 0.5, 0.18, 0.4)
    squarePin(b, "gold", p.x, p.y, -t - 2.6, 0.4, 0.5)
    solderJoint(b, p.x, p.y, t, padR(p), 0.3)
  }
  // Separation grooves between positions.
  const n = ctx.pads.length
  if (n > 1) {
    const sorted = [...ctx.pads].sort((p, q) => (along ? p.x - q.x : p.y - q.y))
    for (let i = 1; i < sorted.length; i++) {
      const mx = (sorted[i - 1].x + sorted[i].x) / 2
      const my = (sorted[i - 1].y + sorted[i].y) / 2
      if (along) b.box("hole", mx, cy, h - 0.25, 0.06, wid + 0.01, 0.26)
      else b.box("hole", cx, my, h - 0.25, wid + 0.01, 0.06, 0.26)
    }
  }
  return b
}

// ---------- screw terminal ----------

export function screwTerminal(ctx: ModelContext): Builder {
  const t = ctx.boardThickness
  const pads = ctx.pads
  const pitch = pitchOf(pads)
  const along = rowAlongX(pads)
  const bb = bounds(pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const c = ctx.courtyard
  // Courtyard extent across the row in the local frame below (+y = back, away from the wires).
  const [lo, hi] = along ? [c.minY - cy, c.maxY - cy] : [cx - c.maxX, cx - c.minX]
  // Library terminal blocks have the real body 0.5 mm inside their courtyard, off-centre with the
  // screws over the pins; footprinter rows get a generic body centred on the pins.
  const exact = /^terminal_block/.test(ctx.footprint)
  const depth = exact ? hi - lo - 1 : Math.max(6.5, hi - lo + 0.9)
  const mid = exact ? (lo + hi) / 2 : 0
  const H = Math.min(ctx.part.body3d?.height ?? 10, depth * 1.25)
  // Cross-section in (depth, z): entry face at -depth/2, sloped back.
  const prof: P2[] = [
    [-depth / 2, 0],
    [depth / 2, 0],
    [depth / 2, H * 0.62],
    [depth / 2 - depth * 0.3, H],
    [-depth / 2 + 0.5, H],
    [-depth / 2, H - 0.5],
  ]
  const screwY = exact ? 0 : -depth * 0.05
  const width = pitch - 0.08
  const local = new Builder()
  for (const p of pads) {
    const u = along ? p.x - cx : p.y - cy
    const g = profileXZ(prof, width, [], 0.22)
    g.rotateZ(Math.PI / 2)
    g.translate(u, mid, 0)
    local.add("terminalGreen", g)
    // Screw head flush with the top, ringed by the dark gap of its well, with a cross slot.
    const well = new THREE.RingGeometry(1.3, 1.72, 32)
    well.translate(u, screwY, H + 0.004)
    local.add("hole", well)
    local.add("nickel", lathe([[1.32, H - 0.3], [1.32, H - 0.02], [1.15, H + 0.1], [0, H + 0.14]], 28).translate(u, screwY, 0))
    local.box("hole", u, screwY, H + 0.02, 2.2, 0.32, 0.14)
    local.box("hole", u, screwY, H + 0.02, 0.32, 2.2, 0.14)
    // Wire entry on the front face with the clamp cage visible inside.
    const front = mid - depth / 2
    local.box("hole", u, front + 0.25, 1.5, 3.3, 0.52, 3.0)
    local.box("nickel", u, front + 0.02, 1.5, 3.0, 0.08, 0.55)
    local.box("nickel", u, front + 0.02, 4.0, 3.0, 0.08, 0.35)
  }
  // The local frame has the pole row along x and the wire entries facing -y.
  const built = local.transform(cx, cy, along ? 0 : Math.PI / 2)
  for (const p of pads) {
    squarePin(built, "tin", p.x, p.y, -t - TAIL, 0.6, 0.9)
    solderJoint(built, p.x, p.y, t, padR(p), 0.5)
  }
  return built
}

// ---------- JST PH ----------

/** `series` where a package's name says it (EH's housing is shallower than XH's at the same pitch); else read from the pitch. */
export function jst(ctx: ModelContext, series?: "ph" | "xh" | "eh"): Builder {
  const t = ctx.boardThickness
  const pads = ctx.pads
  const along = rowAlongX(pads)
  const bb = bounds(pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const c = ctx.courtyard
  const span = along ? bb.maxX - bb.minX : bb.maxY - bb.minY
  // PH (2.0 mm) and the wider XH (2.5 mm) housings.
  const kind = series ?? (pitchOf(pads) > 2.2 ? "xh" : "ph")
  const xh = kind !== "ph"
  const len = span + (xh ? 4.9 : 3.9)
  // Housing sits towards the courtyard's deeper side.
  const cMid = along ? (c.minY + c.maxY) / 2 : (c.minX + c.maxX) / 2
  const off = (along ? cMid - cy : cMid - cx) || -0.55
  const depth = kind === "eh" ? 3.8 : xh ? 5.75 : 4.5
  const floor = 1.6
  const H = ctx.part.body3d?.height ?? (kind === "xh" ? 7.0 : 6.0)
  const wall = 0.55
  const local = new Builder()
  local.add("cream", block(0, off, len, depth, 0, floor, 0.2, 0.12))
  const ring = roundedRectShape(0, off, len, depth, 0.25)
  const cavity = new THREE.Path()
  const ix = len / 2 - wall
  const iy0 = off - depth / 2 + wall * 0.9
  const iy1 = off + depth / 2 - wall
  cavity.moveTo(-ix, iy0)
  cavity.lineTo(-ix, iy1)
  cavity.lineTo(ix, iy1)
  cavity.lineTo(ix, iy0)
  // Polarising slots in the front wall.
  for (const sx of [ix - 0.9, -ix + 1.6]) {
    cavity.lineTo(sx, iy0)
    cavity.lineTo(sx, iy0 - 0.35)
    cavity.lineTo(sx - 0.7, iy0 - 0.35)
    cavity.lineTo(sx - 0.7, iy0)
  }
  cavity.closePath()
  ring.holes.push(cavity)
  local.add("cream", slab(ring, floor - 0.01, H, 0.1, 6))
  // Latch bumps on the outside of the back wall.
  local.box("cream", -len / 4, off + depth / 2, H - 2.2, 1.0, 0.35, 1.2, 0.08)
  local.box("cream", len / 4, off + depth / 2, H - 2.2, 1.0, 0.35, 1.2, 0.08)
  local.transform(cx, cy, along ? 0 : Math.PI / 2)
  for (const p of pads) {
    squarePin(local, "gold", p.x, p.y, floor - 0.2, H - 0.9, 0.64)
    squarePin(local, "tin", p.x, p.y, -t - TAIL, 0.4, 0.64)
    solderJoint(local, p.x, p.y, t, padR(p), 0.36)
  }
  return local
}

// ---------- tactile switch ----------

export function tactile(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const pads = ctx.pads
  const bb = bounds(pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const S = 6.0
  const baseTop = 3.3
  const plate = 0.25
  const top = Math.max(4.3, (ctx.part.body3d?.height ?? 3.5) + 1.5)
  b.add("plasticBlack", block(cx, cy, S, S, 0.15, baseTop, 0.2, 0.12))
  b.box("steel", cx, cy, baseTop, S, S, plate, 0.05)
  // Cover tabs folded down the sides.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) b.box("steel", cx + sx * (S / 2 + 0.06), cy + sy * 1.7, 1.4, 0.14, 1.3, baseTop - 1.4 + plate)
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const g = new THREE.CircleGeometry(0.32, 16)
      g.translate(cx + sx * 2.15, cy + sy * 2.15, baseTop + plate + 0.002)
      b.add("hole", g)
    }
  // Round actuator with a softened top edge.
  b.add(
    "plasticBlack",
    lathe(
      [
        [1.95, baseTop + plate - 0.02],
        [1.95, baseTop + plate + 0.25],
        [1.75, baseTop + plate + 0.3],
        [1.75, top - 0.18],
        [1.6, top],
        [0, top],
      ],
      36,
    ).translate(cx, cy, 0),
  )
  for (const p of pads) {
    const sy = Math.sign(p.y - cy) || 1
    b.box("tin", p.x, cy + sy * (S / 2 - 0.1), 0.55, 0.7, Math.abs(p.y - cy) - S / 2 + 0.45, 0.25)
    b.box("tin", p.x, p.y, -t - TAIL, 0.7, 0.3, t + TAIL + 0.8)
    solderJoint(b, p.x, p.y, t, padR(p), 0.35)
  }
  return b
}

/** C&K TL3342-style 5.2 mm SMD tact switch: black base, steel cover, round plunger, four gull-wing legs. */
export function tl3342(ctx: ModelContext): Builder {
  const b = new Builder()
  const bb = bounds(ctx.pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const S = 5.2
  const base = 1.05
  const plate = 0.15
  const top = Math.max(2.0, ctx.part.body3d?.height ?? 2.5)
  // Octagonal moulded base under a square cover with clipped corners.
  const oct = (half: number, cut: number) => {
    const s = new THREE.Shape()
    s.moveTo(-half + cut, -half)
    s.lineTo(half - cut, -half)
    s.lineTo(half, -half + cut)
    s.lineTo(half, half - cut)
    s.lineTo(half - cut, half)
    s.lineTo(-half + cut, half)
    s.lineTo(-half, half - cut)
    s.lineTo(-half, -half + cut)
    s.closePath()
    return s
  }
  b.add("plasticBlack", slab(oct(S / 2 - 0.05, 0.9), 0.05, base, 0.08, 4))
  const cover = oct(S / 2, 0.45)
  cover.holes.push(circleHole(0, 0, 1.55))
  b.add("steel", slab(cover, base, base + plate, 0, 28))
  // Cover tabs folded down the sides between the legs.
  for (const sy of [-1, 1]) b.box("steel", 0, sy * (S / 2 + 0.02), 0.3, 1.7, 0.12, base + plate - 0.3)
  for (const sx of [-1, 1]) b.box("steel", sx * (S / 2 + 0.02), 0, 0.3, 0.12, 1.3, base + plate - 0.3)
  // Black collar and the plunger.
  b.add("plasticBlack", lathe([[1.55, base], [1.55, base + plate + 0.12], [1.45, base + plate + 0.2], [1.3, base + plate + 0.2]], 32))
  b.add(
    "actuatorTan",
    lathe(
      [
        [1.28, base + plate],
        [1.28, top - 0.22],
        [1.2, top - 0.06],
        [1.02, top],
        [0, top + 0.03],
      ],
      36,
    ),
  )
  b.transform(cx, cy, 0)
  for (const p of ctx.pads) {
    const sx = Math.sign(p.x - cx) || 1
    const tip = Math.abs(p.x - cx) + p.width / 2 - 0.12
    const g = gullWingLead(S / 2 - 0.1, tip, 0.42, 0.15, Math.min(0.75, p.height * 0.75))
    if (sx < 0) g.rotateZ(Math.PI)
    g.translate(cx, p.y, 0)
    b.add("tin", g)
  }
  return b
}

/** E-Switch EG1218-style SPDT slide switch: nickel shell over a black base, slider on top, three flat pins. */
export function slideSwitch(ctx: ModelContext): Builder {
  const t = ctx.boardThickness
  const pads = ctx.pads
  const along = rowAlongX(pads)
  const bb = bounds(pads)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const c = ctx.courtyard
  const L = Math.max(6, (along ? c.maxX - c.minX : c.maxY - c.minY) - 0.5)
  const W = Math.max(3, (along ? c.maxY - c.minY : c.maxX - c.minX) - 0.7)
  const H = 3.8
  const top = Math.max(H + 1.2, ctx.part.body3d?.height ?? 5.5)
  const b = new Builder()
  b.add("plasticBlack", block(0, 0, L - 0.3, W - 0.15, 0, 1.0, 0.2, 0.1))
  b.add("plasticBlack", block(0, 0, L - 0.5, W - 0.35, 0.9, H - 0.45, 0.2, 0.05))
  // Shell: wrap-around walls and a top plate with the slider slot.
  const ring = roundedRectShape(0, 0, L, W, 0.22)
  ring.holes.push(rectPath(0, 0, L - 0.36, W - 0.36))
  b.add("nickel", slab(ring, 0.85, H - 0.2, 0, 6))
  const lid = roundedRectShape(0, 0, L, W, 0.22)
  const slot = L * 0.44
  lid.holes.push(rectPath(0, 0, slot, 1.7))
  b.add("nickel", slab(lid, H - 0.25, H, 0.06, 6))
  // Crimp tabs folded under the base.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) b.box("nickel", sx * (L / 2 - 1.0), sy * (W / 2 + 0.03), 0.2, 1.0, 0.1, 0.75)
  // Slider lever at one end of its travel, with grip ridges.
  const lx = -slot / 2 + 1.05
  b.add("plasticBlack", block(lx, 0, 1.9, 1.45, H - 0.6, top, 0.2, 0.14))
  for (const dx of [-0.5, 0, 0.5]) b.box("plasticBlack", lx + dx, 0, top - 0.02, 0.16, 1.3, 0.1, 0.04)
  b.transform(cx, cy, along ? 0 : Math.PI / 2)
  for (const p of pads) {
    b.box("tin", p.x, p.y, -t - TAIL, along ? 0.75 : 0.35, along ? 0.35 : 0.75, t + TAIL + 0.9)
    solderJoint(b, p.x, p.y, t, padR(p), 0.38)
  }
  return b
}

// ---------- fallback ----------

export function generic(ctx: ModelContext): Builder {
  const b = new Builder()
  const c = ctx.courtyard
  const w = Math.max(0.3, (c.maxX - c.minX) * 0.82)
  const h = Math.max(0.3, (c.maxY - c.minY) * 0.82)
  const height = ctx.part.body3d?.height ?? 1
  const color = ctx.part.body3d?.color ?? "#1d1d20"
  const tht = ctx.pads.some((p) => p.holeDiameter)
  const z0 = tht ? 0.3 : SEAT + 0.05
  const c3 = new THREE.Color(color)
  const dark = 0.2126 * c3.r + 0.7152 * c3.g + 0.0722 * c3.b < 0.04
  b.add(dark ? "epoxy" : `gloss:${color}:0.5`, block((c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2, w, h, z0, z0 + height, Math.min(0.3, Math.min(w, h) * 0.1), Math.min(0.2, height * 0.12)))
  for (const p of ctx.pads) {
    if (p.holeDiameter) {
      b.cyl("tin", p.x, p.y, -ctx.boardThickness - TAIL, z0 + 0.2, Math.min(0.35, p.holeDiameter * 0.4), 10)
      solderJoint(b, p.x, p.y, ctx.boardThickness, padR(p), Math.min(0.35, p.holeDiameter * 0.4))
    } else {
      b.box("tin", p.x, p.y, SEAT, p.width * 0.7, p.height * 0.7, 0.12, 0.03)
    }
  }
  return b
}

// ---------- shared ----------

/** Cylinder along y from y0 to y1, centred on (x, z). */
function cylY(b: Builder, key: string, x: number, z: number, y0: number, y1: number, r: number, seg = 28) {
  const g = new THREE.CylinderGeometry(r, r, Math.abs(y1 - y0), seg)
  g.translate(x, (y0 + y1) / 2, z)
  b.add(key, g)
}

/** Through-hole lead: a square pin from below the board up into the part, soldered. */
function thtLead(b: Builder, p: PadDef, t: number, top: number, side = 0.64) {
  squarePin(b, "tin", p.x, p.y, -t - TAIL, top, side)
  solderJoint(b, p.x, p.y, t, padR(p), side * 0.56)
}

/** Flat metal tab through a slotted hole, aligned with the slot. */
function slotTab(b: Builder, p: PadDef, t: number, top: number) {
  const along = p.width >= p.height
  const len = Math.max(0.3, (p.slotLength ?? p.holeDiameter ?? 0.6) - 0.25)
  const thick = Math.max(0.2, (p.holeDiameter ?? 0.6) - 0.25)
  b.box("steel", p.x, p.y, -t - 0.8, along ? len : thick, along ? thick : len, t + 0.8 + top)
  solderJoint(b, p.x, p.y, t, padR(p), Math.min(len, thick) / 2 + 0.1)
}

// ---------- USB ----------

/** USB-C receptacle on its footprint: shell from the front face (-y) back over the signal pads, tabs through the slots. */
export function usbC(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const front = -2.6
  const L = 7.35
  b.merge(usbCReceptacle(L).transform(0, front + L / 2, 0, SEAT))
  for (const p of ctx.pads) {
    if (p.slotLength) slotTab(b, p, t, 1.0)
    else if (!p.holeDiameter) b.box("tin", p.x, p.y + 0.15, SEAT, p.width * 0.7, p.height * 0.7, 0.12)
  }
  return b
}

/** Micro-USB B receptacle on its footprint, port facing -y over the board edge. */
export function microUsbB(): Builder {
  return new Builder().merge(microUsb().transform(0, -2.85, Math.PI))
}

/**
 * 5.5 x 2.1 mm barrel jack: black housing with the round socket in its -y face and the centre pin
 * inside, lugs through the slotted holes.
 */
export function barrelJack(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const c = ctx.courtyard
  const y0 = c.minY
  const y1 = c.maxY - 0.75
  const H = ctx.part.body3d?.height ?? 11
  b.add("plasticBlack", block(0, (y0 + y1) / 2, 9, y1 - y0, 0, H, 0.4, 0.3))
  // Socket: a dark bore in the front face, the sleeve contact round it and the pin in the middle.
  const zc = 6.5
  cylY(b, "hole", 0, zc, y0 - 0.02, y0 + 9.5, 3.2, 36)
  cylY(b, "nickel", 0, zc, y0 + 9.4, y0 + 9.6, 3.25, 36)
  cylY(b, "nickel", 0, zc, y0 + 2.2, y0 + 9.5, 1.0, 20)
  const ring = new THREE.RingGeometry(3.2, 3.9, 36)
  ring.rotateX(Math.PI / 2)
  ring.translate(0, y0 - 0.01, zc)
  b.add("plasticBlack", ring)
  for (const p of ctx.pads) if (p.slotLength) slotTab(b, p, t, 1.2)
  return b
}

// ---------- microSD ----------

/** microSD push-push socket: stamped steel cover with the card slot in its -y face. */
export function microSd(ctx: ModelContext): Builder {
  const b = new Builder()
  const x0 = -5.9
  const x1 = 7.35
  const y0 = -15.7
  const y1 = 0.9
  const H = ctx.part.body3d?.height ?? 1.8
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  b.add("plasticBlack", block(cx, cy, x1 - x0 - 0.3, y1 - y0 - 0.3, SEAT, SEAT + H - 0.2, 0.1, 0.05))
  b.add("steel", block(cx, cy, x1 - x0, y1 - y0, SEAT + H - 0.22, SEAT + H, 0.3, 0.04))
  // Embossed panel and the slot the card goes into.
  b.add("brushed", block(cx, cy - 1, x1 - x0 - 3, y1 - y0 - 6, SEAT + H - 0.02, SEAT + H + 0.05, 0.4, 0.03))
  b.box("hole", 0.4, y0 - 0.01, SEAT + 0.35, 11.2, 0.6, 1.0)
  for (const p of ctx.pads) b.box("tin", p.x, p.y, SEAT, Math.min(p.width, 0.6), p.height * 0.8, 0.12)
  return b
}

// ---------- coin cell ----------

/** CR2032 retainer: the cell in a black ring, a steel clip across it soldered to the two side tabs. */
export function coinCell(): Builder {
  const b = new Builder()
  b.add(
    "plasticBlack",
    lathe(
      [
        [10.25, SEAT],
        [11.1, SEAT],
        [11.1, 3.2],
        [10.25, 3.2],
      ],
      64,
    ),
  )
  b.add(
    "steel",
    lathe(
      [
        [0, SEAT + 0.3],
        [9.9, SEAT + 0.3],
        [10, SEAT + 0.5],
        [10, SEAT + 3.3],
        [9.6, SEAT + 3.5],
        [0, SEAT + 3.5],
      ],
      64,
    ),
  )
  b.mark({ lines: ["CR2032", "3V"], x: 0, y: -5.4, z: SEAT + 3.51, width: 7, height: 3, color: "#6b7078", weight: 700 })
  // The clip: a strap over the cell, down to a foot on each tab.
  const zTop = SEAT + 3.9
  b.box("steel", 0, 0, zTop, 22, 5, 0.25, 0.05)
  for (const s of [-1, 1]) {
    b.box("steel", s * 11.5, 0, SEAT, 0.25, 5, zTop + 0.25, 0.03)
    b.box("steel", s * 12.75, 0, SEAT, 2.5, 5, 0.25, 0.05)
  }
  b.mark({ lines: ["+"], x: 0, y: 0, z: zTop + 0.26, width: 2, height: 2, color: "#55595f", weight: 800 })
  return b
}

// ---------- relay ----------

/** Sugar-cube relay: blue sealed case with its ratings printed on top, square pins through the board. */
export function relay(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const c = ctx.courtyard
  const x0 = c.minX + 0.25
  const x1 = c.maxX - 0.25
  const y0 = c.minY + 0.25
  const y1 = c.maxY - 0.25
  const H = ctx.part.body3d?.height ?? 15.3
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  b.add(`gloss:${ctx.part.body3d?.color ?? "#2457b8"}:0.32`, block(cx, cy, x1 - x0, y1 - y0, 0.3, H, 0.5, 0.35))
  b.mark({
    lines: ["SONGLE", "SRD-05VDC-SL-C", "10A 250VAC  10A 30VDC", "10A 125VAC  10A 28VDC"],
    x: cx,
    y: cy,
    z: H + 0.004,
    width: x1 - x0 - 3,
    height: y1 - y0 - 4,
    color: "#e9edf5",
    weight: 600,
  })
  for (const p of ctx.pads) thtLead(b, p, t, 1.0, 0.8)
  return b
}

// ---------- buzzer ----------

/** 12 mm buzzer: black can with the sound hole on top. */
export function buzzer(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const H = ctx.part.body3d?.height ?? 9.5
  b.add(
    "plasticBlack",
    lathe(
      [
        [0, 0.4],
        [5.9, 0.4],
        [6.0, 0.6],
        [6.0, H - 0.4],
        [5.6, H],
        [1.2, H],
        [1.1, H - 0.6],
        [0, H - 0.6],
      ],
      48,
    ),
  )
  b.mark({ lines: ["+"], x: -3.6, y: 2.6, z: H + 0.004, width: 1.6, height: 1.6, color: "#d8d8dc", weight: 800 })
  for (const p of ctx.pads) thtLead(b, p, t, 0.6, 0.5)
  return b
}

// ---------- WS2812B ----------

/** WS2812B: white 5 x 5 mm PLCC frame with a clear window over the driver and the three LED dies. */
export function ws2812b(ctx: ModelContext): Builder {
  const b = new Builder()
  const H = ctx.part.body3d?.height ?? 1.6
  const frame = roundedRectShape(0, 0, 5, 5, 0.15)
  frame.holes.push(circleHole(0, 0, 1.9))
  b.add("white", slab(frame, SEAT + 0.05, SEAT + H, 0.05, 32))
  b.add("white", block(0, 0, 5, 5, SEAT + 0.05, SEAT + 0.6, 0.15, 0.03))
  b.box("epoxy", -0.45, 0.1, SEAT + 0.6, 0.8, 0.8, 0.12)
  for (const [x, y, c] of [
    [0.5, 0.6, "#ff2b1f"],
    [0.6, -0.1, "#33d16a"],
    [0.4, -0.7, "#2f6bff"],
  ] as const)
    b.box(`paint:${c}:0.4`, x, y, SEAT + 0.6, 0.3, 0.3, 0.1)
  b.cyl("glassOrange", 0, 0, SEAT + 0.6, SEAT + H - 0.08, 1.9, 32)
  // Notch on the pin 1 corner.
  b.box("hole", -2.35, 2.35, SEAT + H - 0.02, 0.5, 0.5, 0.03)
  for (const p of ctx.pads) b.box("tin", p.x + Math.sign(p.x) * 0.1, p.y, SEAT, 1.0, 0.8, 0.3, 0.05)
  return b
}

// ---------- JST SH (Qwiic) ----------

/** JST SH side-entry header: cream housing with the cable opening at -y and two mounting tabs. */
export function jstSh(ctx: ModelContext): Builder {
  const b = new Builder()
  const H = ctx.part.body3d?.height ?? 2.9
  const signal = ctx.pads.filter((p) => p.width < 1)
  const tabs = ctx.pads.filter((p) => p.width >= 1)
  const yBack = Math.max(...signal.map((p) => p.y)) - 0.6
  const yFront = Math.min(...tabs.map((p) => p.y)) - 1.0
  const w = 4.4
  b.add("cream", block(0, (yBack + yFront) / 2, w, yBack - yFront, SEAT, SEAT + H, 0.15, 0.08))
  b.box("hole", 0, yFront - 0.01, SEAT + 0.6, w - 0.8, 2.0, H - 1.1)
  for (const p of signal) b.box("tin", p.x, p.y - 0.2, SEAT, 0.32, p.height * 0.9, 0.15)
  for (const p of tabs) b.box("tin", p.x, p.y, SEAT, p.width * 0.75, p.height * 0.75, 1.2)
  return b
}

// ---------- pluggable terminal header ----------

/** Right-angle header for a screw plug: green shroud open to the front (-y), pins bent forward inside it. */
export function pluggableHeader(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const c = ctx.courtyard
  const x0 = c.minX + 0.6
  const x1 = c.maxX - 0.4
  const y0 = c.minY + 0.4
  const y1 = c.maxY - 0.6
  const H = ctx.part.body3d?.height ?? 6.6
  const cx = (x0 + x1) / 2
  b.add("terminalGreen", block(cx, (y0 + y1) / 2, x1 - x0, y1 - y0, 0, H, 0.2, 0.12))
  // The plug's mouth: a dark pocket across the front face, ribs between positions.
  const depth = (y1 - y0) * 0.72
  b.box("hole", cx, y0 + depth / 2 - 0.01, 1.0, x1 - x0 - 1.0, depth, H - 2.0)
  const sorted = [...ctx.pads].sort((p, q) => p.x - q.x)
  for (let i = 1; i < sorted.length; i++) b.box("terminalGreen", (sorted[i - 1].x + sorted[i].x) / 2, y0 + depth / 2, 1.0, 0.5, depth, H - 2.0)
  for (const p of ctx.pads) {
    thtLead(b, p, t, H / 2, 0.64)
    b.box("gold", p.x, (y0 + p.y) / 2 + 0.4, H / 2 - 0.32, 0.64, p.y - y0 - 0.8, 0.64)
  }
  return b
}

// ---------- DIP socket ----------

/** Turned-pin DIP socket: black frame open in the middle, a gold-lined contact at each position. */
export function dipSocket(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const bb = bounds(ctx.pads)
  const H = ctx.part.body3d?.height ?? 4.2
  const w = bb.maxX - bb.minX + 2.5
  const l = bb.maxY - bb.minY + 2.6
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  const frame = roundedRectShape(cx, cy, w, l, 0.2)
  frame.holes.push(rectPath(cx, cy, Math.max(1, w - 5.2), l - 4.4))
  b.add("plasticBlack", slab(frame, 0.2, H, 0.12, 6))
  // Pin 1 notch in the end wall.
  b.box("hole", cx, bb.maxY + 1.1, H - 0.6, 1.6, 0.6, 0.62)
  for (const p of ctx.pads) {
    b.add("gold", lathe([[0.42, H - 1.6], [0.42, H + 0.02], [0.78, H + 0.02], [0.78, H + 0.12], [0.55, H + 0.12]], 20).translate(p.x, p.y, 0))
    b.cyl("hole", p.x, p.y, H - 1.5, H + 0.03, 0.4, 16)
    thtLead(b, p, t, 0.6, 0.5)
  }
  return b
}
