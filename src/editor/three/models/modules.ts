import * as THREE from "three"
import type { PadDef } from "../../../model/types"
import type { ModelContext } from "./index"
import {
  Builder,
  SEAT,
  block,
  circleHole,
  dateCode,
  gullWingLead,
  lathe,
  profileXZ,
  rectPath,
  roundedRectShape,
  slab,
  solderJoint,
  squarePin,
  thicken,
  type P2,
} from "./kit"

// Plug-in modules: boards that sit on their own headers above the main board.

const TAIL = 1.2
const padR = (p: PadDef) => Math.min(p.width, p.height) / 2

function discShape(x: number, y: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  s.absarc(x, y, r, 0, Math.PI * 2, false)
  return s
}

/** Plated annular ring standing proud of a board face whose surface is at z. */
function padRing(b: Builder, x: number, y: number, z: number, rOut: number, rIn: number, square = false) {
  const s = square ? roundedRectShape(x, y, rOut * 2, rOut * 2, 0.1) : discShape(x, y, rOut)
  s.holes.push(circleHole(x, y, rIn))
  b.add("tin", slab(s, z, z + 0.035, 0, 20))
}

/** Solder cone around a pin poking up through a board whose top is at z. */
function topFillet(b: Builder, x: number, y: number, z: number, rPad: number, rLead: number) {
  const g = lathe(
    [
      [rPad * 0.94, z],
      [rPad * 0.78, z + 0.05],
      [rLead * 1.75, z + 0.2],
      [rLead * 1.25, z + 0.45],
      [rLead * 1.04, z + 0.68],
    ],
    20,
  )
  g.translate(x, y, 0)
  b.add("solder", g)
}

/** One header position: plastic spacer between z0 and z1, square pin from below the main board to pinTop. */
function headerPin(b: Builder, p: PadDef, boardT: number, z0: number, z1: number, pinTop: number) {
  b.add("plasticBlack", block(p.x, p.y, 2.5, 2.5, z0, z1, 0.12, 0.18))
  squarePin(b, "gold", p.x, p.y, -boardT - TAIL, pinTop, 0.64)
  solderJoint(b, p.x, p.y, boardT, padR(p), 0.36)
}

// ---------- small parts for module carriers (built at the origin, z = 0 on the carrier) ----------

function chipPart(kind: string, L: number, W: number, H: number): Builder {
  const b = new Builder()
  const term = Math.min(0.5, L * 0.22)
  const z0 = SEAT + 0.01
  let termH = H + 0.02
  if (kind === "r") {
    b.box("ceramic", 0, 0, z0, L - 0.04, W - 0.01, H - 0.02, 0.02)
    b.box("resistorCoat", 0, 0, z0 + H - 0.07, L - 2 * term + 0.06, W - 0.03, 0.07, 0.015)
    termH = H + 0.005
  } else if (kind.startsWith("led:")) {
    const color = kind.slice(4)
    const base = H * 0.45
    b.box("white", 0, 0, z0, L - 0.02, W, base, 0.03)
    b.box(`glow:${color}`, 0, 0, z0 + base - 0.01, L * 0.62, W * 0.94, H - base, 0.06)
    termH = base
  } else {
    b.box("mlcc", 0, 0, z0, L - 0.02, W, H, Math.min(0.07, W * 0.08))
  }
  for (const s of [-1, 1]) b.box("tin", s * (L / 2 - term / 2 + 0.005), 0, z0 - 0.012, term + 0.012, W + 0.02, termH, 0.03)
  return b
}

function sot23(): Builder {
  const b = new Builder()
  const z0 = 0.05
  b.add("epoxy", block(0, 0, 2.9, 1.3, z0, z0 + 0.95, 0.08, 0.1))
  for (const [x, side] of [[-0.95, -1], [0.95, -1], [0, 1]] as const) {
    const g = gullWingLead(0.63, 1.2, z0 + 0.3, 0.12, 0.4)
    g.rotateZ(side > 0 ? Math.PI / 2 : -Math.PI / 2)
    g.translate(x, 0, 0)
    b.add("tin", g)
  }
  return b
}

function sot223(lines: string[]): Builder {
  const b = new Builder()
  const z0 = 0.06
  const H = 1.6
  b.add("epoxy", block(0, 0, 6.5, 3.5, z0, z0 + H, 0.12, 0.15))
  for (const x of [-2.3, 0, 2.3]) {
    const g = gullWingLead(1.73, 3.2, z0 + 0.5, 0.26, 0.72)
    g.rotateZ(-Math.PI / 2)
    g.translate(x, 0, 0)
    b.add("tin", g)
  }
  const tab = gullWingLead(1.73, 3.2, z0 + 0.5, 0.26, 3.0)
  tab.rotateZ(Math.PI / 2)
  b.add("tin", tab)
  b.mark({ lines, x: 0, y: 0, z: z0 + H + 0.004, width: 5.0, height: 2.0, color: "#a9a9ae", weight: 600 })
  return b
}

function qfn(size: number, perSide: number, pitch: number, lines: string[]): Builder {
  const b = new Builder()
  const H = 0.9
  const half = size / 2
  b.add("epoxy", block(0, 0, size, size, SEAT + 0.02, SEAT + H, 0.06, 0.05))
  for (let i = 0; i < perSide; i++) {
    const u = (i - (perSide - 1) / 2) * pitch
    for (const s of [-1, 1]) {
      b.box("tin", s * (half - 0.2), u, SEAT, 0.42, 0.25, 0.2)
      b.box("tin", u, s * (half - 0.2), SEAT, 0.25, 0.42, 0.2)
    }
  }
  const dot = new THREE.CircleGeometry(0.28, 18)
  dot.translate(-half + 0.75, half - 0.75, SEAT + H + 0.002)
  b.add("epoxyGloss", dot)
  b.mark({ lines, x: 0.2, y: -0.2, z: SEAT + H + 0.004, width: size * 0.78, height: size * 0.42, color: "#a3a3a8", weight: 600 })
  return b
}

function sod123(): Builder {
  const b = new Builder()
  const z0 = 0.05
  const H = 1.1
  b.add("epoxy", block(0, 0, 2.7, 1.6, z0, H, 0.1, 0.12))
  for (const s of [-1, 1]) {
    const g = gullWingLead(1.33, 1.85, z0 + 0.3, 0.12, 0.6)
    if (s < 0) g.rotateZ(Math.PI)
    b.add("tin", g)
  }
  b.box("sleeveStripe", 0.9, 0, H - 0.004, 0.32, 1.42, 0.012)
  return b
}

/** Micro-B receptacle, port facing +y, centred on the origin. */
export function microUsb(): Builder {
  const b = new Builder()
  const D = 5.0
  const outer: P2[] = [
    [-2.9, 0.02],
    [2.9, 0.02],
    [3.75, 0.87],
    [3.75, 2.62],
    [-3.75, 2.62],
    [-3.75, 0.87],
  ]
  const inner: P2[] = [
    [-2.74, 0.27],
    [2.74, 0.27],
    [3.5, 1.03],
    [3.5, 2.37],
    [-3.5, 2.37],
    [-3.5, 1.03],
  ]
  b.add("steel", profileXZ(outer, D, [inner]))
  b.add("steel", profileXZ(outer, 0.2).translate(0, -D / 2 + 0.1, 0))
  // Dark cavity behind the opening with the contact tongue in front of it.
  const cavityLen = D - 1.4
  b.add("hole", profileXZ(inner, cavityLen).translate(0, -D / 2 + cavityLen / 2, 0))
  b.box("plasticBlack", 0, D / 2 - 1.1, 1.25, 5.0, 0.9, 0.55, 0.05)
  for (let i = 0; i < 5; i++) b.box("gold", (i - 2) * 0.65, D / 2 - 1.1, 1.22, 0.3, 0.8, 0.04)
  // Latch windows on top, side ground tabs and the signal legs at the back.
  for (const s of [-1, 1]) {
    b.box("hole", s * 1.55, 0.9, 2.61, 0.55, 1.1, 0.02)
    b.box("steel", s * 3.86, -0.6, 0, 0.18, 1.6, 1.3)
    b.box("tin", s * 4.05, -0.6, SEAT, 0.6, 1.6, 0.1)
  }
  for (let i = 0; i < 5; i++) b.box("tin", (i - 2) * 0.65, -D / 2 - 0.35, SEAT, 0.32, 0.8, 0.1)
  return b
}

/** Small SMD tact switch (DevKit EN / BOOT). */
function smallTact(): Builder {
  const b = new Builder()
  const w = 4.2
  const l = 3.2
  b.add("plasticBlack", block(0, 0, w - 0.1, l - 0.1, 0.05, 0.85, 0.15, 0.08))
  const cover = roundedRectShape(0, 0, w, l, 0.18)
  cover.holes.push(rectPath(0, 0, 2.2, 1.6))
  b.add("steel", slab(cover, 0.85, 0.98, 0, 8))
  b.add("plasticBlack", block(0, 0, 1.9, 1.35, 0.8, 1.5, 0.3, 0.14))
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      b.box("tin", sx * (w / 2 + 0.25), sy * 1.0, SEAT, 0.6, 0.45, 0.12)
      b.box("steel", sx * (w / 2 + 0.03), sy * 1.0, SEAT, 0.12, 0.45, 0.95)
    }
  return b
}

const place = (into: Builder, part: Builder, x: number, y: number, rot = 0) => into.merge(part.transform(x, y, rot))

// ---------- ESP32 WROOM module ----------

export interface WroomSpec {
  /** Module name on the can, and the small print under it. */
  name: string
  fine: string[]
  /** Castellations as [x, y, rotation] in the module's frame; the WROOM-32's 14 + 10 + 14 when absent. */
  castles?: [number, number, number][]
}

/** One castellated pad on a module edge, facing +x: plated half-hole and the solder fillet below it. */
function castellation(thickness: number): Builder {
  const g = new Builder()
  g.box("gold", -0.42, 0, thickness - 0.01, 0.85, 0.82, 0.04)
  g.box("gold", 0.01, 0, 0, 0.06, 0.82, thickness)
  g.add("solder", profileXZ([[-0.02, SEAT], [0.5, SEAT], [0.03, thickness * 0.8]], 0.78))
  return g
}

/**
 * ESP32 WROOM-style module, 18 x 25.5 x 0.8 mm, with the shield can over the RF section and the
 * meandered PCB antenna. Built with the antenna end on y = 0 and the module running to y = 25.5,
 * centred on x = 0 with its underside at z = 0; the can's print reads with the antenna end at the top.
 */
export function wroomModule(spec: WroomSpec): Builder {
  const k = new Builder()
  const cx = 0
  const mW = 18
  const mL = 25.5
  const mT = 0.8
  const mY0 = 0
  const mY1 = mL
  k.add("pcbModule", block(cx, (mY0 + mY1) / 2, mW, mL, 0, mT, 0.25, 0.04))
  const canW = 17.0
  const canL = 17.6
  const canH = 2.35
  const canY1 = mY1 - 0.55
  const canY0 = canY1 - canL
  const canCy = (canY0 + canY1) / 2
  k.add("shield", block(cx, canCy, canW, canL, mT, mT + canH, 0.35, 0.16))
  const canTop = mT + canH + 0.004
  k.mark({ lines: ["ESPRESSIF"], x: cx, y: canCy - 5.4, z: canTop, width: 7.2, height: 1.3, rotZ: Math.PI, color: "#3a3d43", weight: 700 })
  k.mark({ lines: [spec.name], x: cx, y: canCy - 3.0, z: canTop, width: 13.4, height: 2.1, rotZ: Math.PI, color: "#3a3d43", weight: 700 })
  k.mark({
    lines: spec.fine,
    x: cx,
    y: canCy + 1.4,
    z: canTop,
    width: 12.4,
    height: 2.2,
    rotZ: Math.PI,
    color: "#3a3d43",
    weight: 500,
  })

  // Castellated pads: 14 down each long side and 10 across the end unless the footprint says otherwise.
  const castles: [number, number, number][] = spec.castles ?? [
    ...Array.from({ length: 14 }, (_, i): [number, number, number][] => [
      [cx - mW / 2, canCy + (i - 6.5) * 1.27, Math.PI],
      [cx + mW / 2, canCy + (i - 6.5) * 1.27, 0],
    ]).flat(),
    ...Array.from({ length: 10 }, (_, i): [number, number, number] => [cx + (i - 4.5) * 1.27, mY1, Math.PI / 2]),
  ]
  for (const [x, y, rot] of castles) place(k, castellation(mT), x, y, rot)

  // Meandered inverted-F antenna under the mask.
  const ys = mY0 + 1.0
  const ye = canY0 - 1.4
  const ant: P2[] = [
    [cx - 7.4, canY0 - 0.5],
    [cx - 7.4, ys],
  ]
  let yCur = ys
  for (let i = 1; i <= 10; i++) {
    const x = cx - 7.4 + i * 1.25
    ant.push([x, yCur])
    yCur = yCur === ys ? ye : ys
    ant.push([x, yCur])
  }
  const antShape = new THREE.Shape(thicken(ant, 0.42).map(([x, y]) => new THREE.Vector2(x, y)))
  k.add("maskCopper", slab(antShape, mT - 0.01, mT + 0.025, 0, 4))
  k.box("maskCopper", cx + 6.9, (ys + canY0) / 2, mT - 0.01, 0.42, canY0 - ys, 0.035)
  return k
}

// ---------- ESP32 DevKit V1 ----------

/**
 * DOIT ESP32 DevKit V1 plugged in on its two 1x15 headers: black carrier on header spacers,
 * ESP-WROOM-32 with its shield can and PCB antenna at -y, micro-USB, EN/BOOT buttons and the
 * regulator / USB-UART at the +y end.
 */
export function esp32DevKit(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const c = ctx.courtyard
  const X0 = c.minX + 0.25
  const X1 = c.maxX - 0.25
  const Y0 = c.minY + 0.25
  const Y1 = c.maxY - 0.25
  const cx = (X0 + X1) / 2
  const spacer = 2.5
  const pcbT = 1.6
  const top = spacer + pcbT

  const carrier = roundedRectShape(cx, (Y0 + Y1) / 2, X1 - X0, Y1 - Y0, 0.9)
  // The DevKit's own mounting holes sit over the footprint's non-plated holes.
  for (const h of ctx.holes ?? []) carrier.holes.push(circleHole(h.x, h.y, (h.holeDiameter ?? h.width) / 2))
  b.add("pcbBlack", slab(carrier, spacer, top, 0.1, 8))
  for (const p of ctx.pads) {
    headerPin(b, p, t, 0, spacer, top + 1.2)
    padRing(b, p.x, p.y, top, 0.85, 0.4, p.pin === "1")
    topFillet(b, p.x, p.y, top + 0.035, 0.8, 0.34)
  }

  // Everything below is on the carrier, built with z = 0 on its top face.
  const k = new Builder()

  // Pin names in two columns inside the header rows, reading with the USB end down like the real board.
  const names = new Map(ctx.part.pins.map((p) => [p.number, p.name] as const))
  for (const side of [-1, 1]) {
    const col = ctx.pads.filter((p) => Math.sign(p.x - cx) === side).sort((a, b) => a.y - b.y)
    if (col.length < 2) continue
    const pitch = Math.abs(col[1].y - col[0].y)
    const midY = (col[0].y + col[col.length - 1].y) / 2
    k.mark({
      lines: col.map((p) => (p.pin && names.get(p.pin)) || p.pin || ""),
      x: col[0].x - side * 2.4,
      y: midY,
      z: 0.006,
      width: 2.3,
      height: pitch * (col.length + 0.35),
      rotZ: Math.PI,
      color: "#e9e7e1",
      weight: 600,
    })
  }

  // ESP-WROOM-32 at the -y end, its antenna at the board edge.
  const mY1 = Y0 + 25.5
  place(k, wroomModule({ name: "ESP-WROOM-32", fine: ["FCC ID: 2AC7Z-ESPWROOM32", `R 211-161007  ${dateCode(ctx.component.ref)}`] }), cx, Y0)

  // USB end: micro-B overhanging the edge, BOOT and EN either side.
  place(k, microUsb(), cx, Y1 - 1.7)
  place(k, smallTact(), cx - 7.4, Y1 - 3.0)
  place(k, smallTact(), cx + 7.4, Y1 - 3.0)
  k.mark({ lines: ["BOOT"], x: cx - 7.4, y: Y1 - 5.35, z: 0.006, width: 3.0, height: 1.0, rotZ: Math.PI, color: "#e9e7e1", weight: 600 })
  k.mark({ lines: ["EN"], x: cx + 7.4, y: Y1 - 5.35, z: 0.006, width: 1.6, height: 1.0, rotZ: Math.PI, color: "#e9e7e1", weight: 600 })

  // Regulator, USB-UART bridge, auto-reset transistors, diode, LEDs and passives.
  place(k, sot223(["AMS1117", "3.3  " + dateCode(`${ctx.component.ref}:ldo`)]), cx + 5.6, mY1 + 6.4, -Math.PI / 2)
  place(k, qfn(5, 7, 0.5, ["CP2102", "GMR " + dateCode(`${ctx.component.ref}:uart`)]), cx - 4.2, mY1 + 7.4, 0)
  place(k, sot23(), cx - 7.4, mY1 + 12.8, Math.PI / 2)
  place(k, sot23(), cx - 7.4, mY1 + 16.4, Math.PI / 2)
  place(k, sod123(), cx + 5.0, mY1 + 19.3, 0)
  const passives: [string, number, number, number, number, number, number][] = [
    // kind, L, W, H, x, y, rot (x/y relative to the module's end edge)
    ["c", 2.0, 1.25, 0.85, 1.1, 3.6, Math.PI / 2],
    ["c", 2.0, 1.25, 0.85, 1.1, 9.2, Math.PI / 2],
    ["c", 1.0, 0.5, 0.5, -7.4, 6.8, Math.PI / 2],
    ["c", 1.0, 0.5, 0.5, -7.4, 8.4, Math.PI / 2],
    ["r", 1.0, 0.5, 0.35, -4.9, 4.2, 0],
    ["r", 1.0, 0.5, 0.35, -3.3, 4.2, 0],
    ["c", 1.6, 0.8, 0.8, -4.2, 11.3, 0],
    ["r", 1.6, 0.8, 0.45, -4.6, 13.6, Math.PI / 2],
    ["r", 1.6, 0.8, 0.45, -4.6, 16.0, Math.PI / 2],
    ["r", 1.6, 0.8, 0.45, -2.4, 13.6, Math.PI / 2],
    ["c", 1.6, 0.8, 0.8, -2.4, 16.0, Math.PI / 2],
    ["r", 1.6, 0.8, 0.45, -3.0, 19.3, 0],
    ["c", 1.6, 0.8, 0.8, 1.6, 17.6, 0],
    ["r", 1.6, 0.8, 0.45, 6.6, 1.5, 0],
    ["r", 1.6, 0.8, 0.45, -6.6, 1.5, 0],
    ["led:#2f6bff", 1.6, 0.8, 0.7, -1.8, 1.5, 0],
    ["led:#ff2b1f", 1.6, 0.8, 0.7, 1.8, 1.5, 0],
  ]
  for (const [kind, L, W, H, x, y, rot] of passives) place(k, chipPart(kind, L, W, H), cx + x, mY1 + y, rot)
  k.mark({ lines: ["ESP32 DEVKIT V1"], x: cx + 3.6, y: mY1 + 13.9, z: 0.006, width: 8.6, height: 1.25, rotZ: Math.PI, color: "#e9e7e1", weight: 700 })

  b.merge(k.transform(0, 0, 0, top))
  return b
}

// ---------- 0.96" OLED ----------

/**
 * 0.96" SSD1306 module standing on its 1x4 header: blue PCB with four mounting holes, glass
 * panel with polariser and active area, driver ledge and the amber flex folded round the edge.
 */
export function oled096(ctx: ModelContext): Builder {
  const b = new Builder()
  const t = ctx.boardThickness
  const c = ctx.courtyard
  const X = (c.maxX - c.minX) / 2 - 0.25
  const Yt = c.maxY - 0.25
  const Yb = c.minY + 0.25
  const cx = (c.maxX + c.minX) / 2
  const cy = (Yt + Yb) / 2
  const pcbT = 1.2
  const spacer = 2.5
  // Header soldered straight into the board: the module rests on the header's plastic spacer.
  const zP = spacer
  const zT = zP + pcbT
  const pcbKey = `gloss:${ctx.part.body3d?.color ?? "#1f4fa3"}:0.42`

  const shape = roundedRectShape(cx, cy, 2 * X, Yt - Yb, 0.5)
  const hx = X - 2.0
  const holes: P2[] = [
    [cx - hx, Yt - 2.15],
    [cx + hx, Yt - 2.15],
    [cx - hx, Yb + 2.15],
    [cx + hx, Yb + 2.15],
  ]
  for (const [x, y] of holes) shape.holes.push(circleHole(x, y, 1.0))
  b.add(pcbKey, slab(shape, zP, zT, 0.08, 20))
  for (const [x, y] of holes) {
    padRing(b, x, y, zT, 1.55, 1.0)
    padRing(b, x, y, zP - 0.035, 1.55, 1.0)
  }

  // Header soldered to the module, long tails down through the main board.
  const names = new Map(ctx.part.pins.map((p) => [p.number, p.name] as const))
  for (const p of ctx.pads) {
    headerPin(b, p, t, zP - spacer, zP, zT + 1.1)
    padRing(b, p.x, p.y, zT, 0.8, 0.4, p.pin === "1")
    topFillet(b, p.x, p.y, zT + 0.035, 0.75, 0.34)
    b.mark({ lines: [(p.pin && names.get(p.pin)) || p.pin || ""], x: p.x, y: p.y - 1.55, z: zT + 0.006, width: 2.3, height: 0.9, color: "#eef0f4", weight: 600 })
  }

  // Glass: bottom plate with the driver ledge, top plate, polariser and active area.
  const gW = 26.7
  const gH = 19.26
  const gTop = Yt - 4.7
  const gBot = gTop - gH
  const ledge = 3.7
  const g0 = zT + 0.1
  const g1 = g0 + 0.55
  const g2 = g1 + 0.6
  b.box("plasticBlack", cx, (gTop + gBot) / 2, zT, gW - 1.2, gH - 1.2, 0.1)
  b.add("oledLedge", block(cx, (gTop + gBot) / 2, gW, gH, g0, g1, 0.1, 0.05))
  const upperCy = gTop - (gH - ledge) / 2
  b.add("oledGlass", block(cx, upperCy, gW, gH - ledge, g1 - 0.005, g2, 0.08, 0.05))
  b.add("oledPolarizer", block(cx, upperCy + 0.15, gW - 1.4, gH - ledge - 1.5, g2 - 0.005, g2 + 0.11, 0.05, 0.03))
  b.box("oledActive", cx, upperCy + 0.45, g2 + 0.105, 21.74, 10.86, 0.008)
  // Driver IC on the ledge.
  b.box("epoxyGloss", cx, gBot + 2.35, g1 - 0.005, 15.5, 0.85, 0.22, 0.03)

  // Flex: bonded on the ledge, out over the edge, curled round and back under the PCB.
  const zL = g1 + 0.06
  const zB = zP - 0.07
  const zMid = (zL + zB) / 2
  const R = (zL - zB) / 2
  const yE = Yb - 0.15
  const path: P2[] = [
    [gBot + 1.1, zL],
    [gBot - 0.1, zL],
    [yE, zL],
  ]
  for (let i = 1; i <= 18; i++) {
    const a = Math.PI / 2 + (i / 18) * Math.PI
    path.push([yE + R * Math.cos(a), zMid + R * Math.sin(a)])
  }
  path.push([yE + 4.5, zB])
  const flexW = 12.5
  const strip = (key: string, x: number, w: number, th: number) => {
    const g = profileXZ(thicken(path, th), w)
    g.rotateZ(Math.PI / 2)
    g.translate(x, 0, 0)
    b.add(key, g)
  }
  strip("flex", cx, flexW, 0.1)
  // Copper traces showing through the polyimide.
  for (let i = 0; i < 14; i++) strip("flexTrace", cx + (i - 6.5) * 0.78, 0.24, 0.112)

  // A few parts on the back of the module (visible under it).
  const under: [string, number, number, number, number][] = [
    ["mlcc", -7.5, -9, 1.6, 0.8],
    ["mlcc", -7.5, -11.5, 1.6, 0.8],
    ["resistorCoat", -4.5, -9, 1.6, 0.8],
    ["resistorCoat", -4.5, -11.5, 1.6, 0.8],
    ["epoxy", 5.5, -10, 2.9, 1.3],
    ["mlcc", 8.5, -10, 2.0, 1.25],
    ["mlcc", 2, -15, 2.0, 1.25],
  ]
  for (const [key, x, y, L, W] of under) {
    const h = key === "epoxy" ? 1.0 : key === "mlcc" ? 0.8 : 0.45
    b.box(key, cx + x, y, zP - 0.035 - h, L - 0.2, W, h, 0.04)
    if (key !== "epoxy") for (const s of [-1, 1]) b.box("tin", cx + x + s * (L / 2 - 0.2), y, zP - 0.035 - h - 0.01, 0.4, W + 0.02, h + 0.01, 0.03)
  }
  return b
}

// ---------- shared pieces for the other boards ----------

/** Stadium cross-section in the XZ plane, w wide and h tall, standing on z0. */
function stadiumXZ(w: number, h: number, z0: number, seg = 10): P2[] {
  const r = h / 2
  const half = w / 2 - r
  const pts: P2[] = []
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (i / seg) * Math.PI
    pts.push([half + r * Math.cos(a), z0 + r + r * Math.sin(a)])
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i / seg) * Math.PI
    pts.push([-half + r * Math.cos(a), z0 + r + r * Math.sin(a)])
  }
  return pts
}

/**
 * USB Type-C receptacle shell, 8.94 x 3.26 mm, `length` deep, port facing -y and centred on the
 * origin, standing on z = 0: dark cavity behind the opening and the contact tongue inside it.
 */
export function usbCReceptacle(length = 7.35): Builder {
  const b = new Builder()
  const W = 8.94
  const H = 3.26
  const wall = 0.25
  const outer = stadiumXZ(W, H, 0)
  const inner = stadiumXZ(W - 2 * wall, H - 2 * wall, wall)
  b.add("steel", profileXZ(outer, length, [inner]))
  b.add("steel", profileXZ(outer, 0.2).translate(0, length / 2 - 0.1, 0))
  const cavity = length - 0.5
  b.add("hole", profileXZ(inner, cavity).translate(0, cavity / 2 - length / 2 + 0.5, 0))
  b.box("plasticBlack", 0, 0.6, H / 2 - 0.35, 6.7, length - 1.6, 0.7, 0.08)
  for (let i = 0; i < 12; i++) b.box("gold", (i - 5.5) * 0.5, -0.4, H / 2 + 0.34, 0.25, length - 3.2, 0.03)
  return b
}

/** Square-ish SMD crystal or resonator can. */
function crystalCan(w: number, l: number, h: number): Builder {
  const b = new Builder()
  b.add("ceramic", block(0, 0, w, l, SEAT, SEAT + 0.3, 0.1, 0.05))
  b.add("steel", block(0, 0, w - 0.3, l - 0.3, SEAT + 0.28, SEAT + h, 0.15, 0.06))
  return b
}

/** Gull-wing quad flat pack, `size` square, with leads on all four sides. */
function qfp(size: number, perSide: number, pitch: number, lines: string[]): Builder {
  const b = new Builder()
  const z0 = 0.1
  const H = 1.0
  b.add("epoxy", block(0, 0, size, size, z0, z0 + H, 0.15, 0.08))
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < perSide; i++) {
      const g = gullWingLead(size / 2, size / 2 + 1.0, z0 + 0.4, 0.12, 0.22)
      g.translate(0, (i - (perSide - 1) / 2) * pitch, 0)
      g.rotateZ((side * Math.PI) / 2)
      b.add("tin", g)
    }
  }
  const dot = new THREE.CircleGeometry(0.35, 18)
  dot.translate(-size / 2 + 0.9, size / 2 - 0.9, z0 + H + 0.002)
  b.add("epoxyGloss", dot)
  b.mark({ lines, x: 0, y: -0.3, z: z0 + H + 0.004, width: size * 0.8, height: size * 0.45, color: "#a3a3a8", weight: 600 })
  return b
}

/** SOIC body with gull-wing leads on its long sides. */
function soic(pins: number, lines: string[], bodyW = 3.9, pitch = 1.27): Builder {
  const b = new Builder()
  const z0 = 0.1
  const H = 1.45
  const per = pins / 2
  const len = per * pitch + 0.4
  b.add("epoxy", block(0, 0, bodyW, len, z0, z0 + H, 0.1, 0.1))
  for (const side of [-1, 1]) {
    for (let i = 0; i < per; i++) {
      const g = gullWingLead(bodyW / 2, bodyW / 2 + 1.05, z0 + 0.6, 0.2, 0.42)
      if (side < 0) g.rotateZ(Math.PI)
      g.translate(0, (i - (per - 1) / 2) * pitch, 0)
      b.add("tin", g)
    }
  }
  b.mark({ lines, x: 0, y: 0, z: z0 + H + 0.004, width: len * 0.8, height: bodyW * 0.55, rotZ: Math.PI / 2, color: "#a3a3a8", weight: 600 })
  return b
}

interface CarrierSpec {
  /** Board outline in the footprint's frame. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** Material of the board's solder mask. */
  pcb: string
  corner?: number
  /** Print the pin names inside the header rows; rotZ π reads with -y at the top. */
  labels?: { rotZ: number; inset: number }
}

/**
 * A dev board plugged in on its own headers: the board on 2.5 mm spacers with the pins through
 * both boards. Returns the base, a builder for the parts on the board (z = 0 on its top face) and
 * that face's height.
 */
function carrier(ctx: ModelContext, s: CarrierSpec): { b: Builder; k: Builder; top: number } {
  const b = new Builder()
  const t = ctx.boardThickness
  const spacer = 2.5
  const top = spacer + 1.6
  const cx = (s.x0 + s.x1) / 2
  const shape = roundedRectShape(cx, (s.y0 + s.y1) / 2, s.x1 - s.x0, s.y1 - s.y0, s.corner ?? 0.9)
  for (const h of ctx.holes ?? []) shape.holes.push(circleHole(h.x, h.y, (h.holeDiameter ?? h.width) / 2))
  b.add(s.pcb, slab(shape, spacer, top, 0.1, 8))
  for (const p of ctx.pads) {
    headerPin(b, p, t, 0, spacer, top + 1.2)
    padRing(b, p.x, p.y, top, 0.85, 0.4, p.pin === "1")
    topFillet(b, p.x, p.y, top + 0.035, 0.8, 0.34)
  }
  const k = new Builder()
  if (s.labels) {
    const names = new Map(ctx.part.pins.map((p) => [p.number, p.name] as const))
    for (const side of [-1, 1]) {
      const col = ctx.pads.filter((p) => Math.sign(p.x - cx) === side).sort((a, b) => a.y - b.y)
      if (col.length < 2) continue
      const pitch = Math.abs(col[1].y - col[0].y)
      const lines = col.map((p) => ((p.pin && names.get(p.pin)) || p.pin || "").split("/")[0])
      k.mark({
        lines: s.labels.rotZ ? lines : [...lines].reverse(),
        x: col[0].x - side * s.labels.inset,
        y: (col[0].y + col[col.length - 1].y) / 2,
        z: 0.006,
        width: 2.3,
        height: pitch * (col.length + 0.35),
        rotZ: s.labels.rotZ,
        color: "#e9e7e1",
        weight: 600,
      })
    }
  }
  return { b, k, top }
}

const boardKey = (ctx: ModelContext, fallback: string) => `gloss:${ctx.part.body3d?.color ?? fallback}:0.42`

// ---------- Arduino Nano ----------

/** Arduino Nano on its headers: ATmega328P, mini-USB over the -y edge, reset button, resonator and LEDs. */
export function arduinoNano(ctx: ModelContext): Builder {
  const { b, k, top } = carrier(ctx, { x0: -8.89, y0: -21.59, x1: 8.89, y1: 21.59, pcb: boardKey(ctx, "#1e5ea8"), corner: 0.6, labels: { rotZ: 0, inset: 2.3 } })
  place(k, qfp(7, 8, 0.8, ["ATMEGA328P", "AU " + dateCode(`${ctx.component.ref}:mcu`)]), 0, 3.2, Math.PI / 4)
  place(k, microUsb(), 0, -21.59 + 1.9, Math.PI)
  place(k, smallTact(), 0, -9.6)
  place(k, crystalCan(3.2, 1.3, 0.9), 3.4, 9.6, Math.PI / 2)
  const leds = ["#ff2b1f", "#33d16a", "#ffb02e", "#ffb02e"]
  leds.forEach((c, i) => place(k, chipPart(`led:${c}`, 1.6, 0.8, 0.7), -3.4, -13.2 - i * 1.6, 0))
  for (const [x, y] of [
    [-3.6, 9],
    [-3.6, 10.6],
    [3.6, -3.4],
    [3.6, -5],
    [-4.6, -4.6],
  ])
    place(k, chipPart("c", 1.6, 0.8, 0.8), x, y, 0)
  k.mark({ lines: ["NANO"], x: 0, y: 15.8, z: 0.006, width: 4.6, height: 1.4, color: "#e9e7e1", weight: 700 })
  b.merge(k.transform(0, 0, 0, top))
  return b
}

// ---------- ESP32-DevKitC ----------

/**
 * Espressif ESP32-DevKitC on two 1x19 headers: black carrier with the WROOM-32E overhanging the
 * pin 1 end (+y), micro-USB, EN and BOOT at the other end, regulator and USB-UART between.
 */
export function esp32DevKitC(ctx: ModelContext): Builder {
  const { b, k, top } = carrier(ctx, { x0: -13.95, y0: -24.1, x1: 13.95, y1: 24.1, pcb: "pcbBlack", labels: { rotZ: 0, inset: 2.4 } })
  place(k, wroomModule({ name: "ESP32-WROOM-32E", fine: ["FCC ID: 2AC7Z-ESPWROOM32E", `R 211-200301  ${dateCode(ctx.component.ref)}`] }), 0, 30.3, Math.PI)
  place(k, microUsb(), 0, -24.1 + 1.6, Math.PI)
  place(k, smallTact(), -8.4, -21.2)
  place(k, smallTact(), 8.4, -21.2)
  k.mark({ lines: ["EN"], x: -8.4, y: -18.6, z: 0.006, width: 1.6, height: 1, color: "#e9e7e1", weight: 600 })
  k.mark({ lines: ["BOOT"], x: 8.4, y: -18.6, z: 0.006, width: 3, height: 1, color: "#e9e7e1", weight: 600 })
  place(k, sot223(["AMS1117", "3.3  " + dateCode(`${ctx.component.ref}:ldo`)]), 5.4, -10.6, Math.PI / 2)
  place(k, qfn(5, 7, 0.5, ["CP2102N", dateCode(`${ctx.component.ref}:uart`)]), -4.6, -11.2)
  place(k, sot23(), -4.8, -2.4, 0)
  place(k, sot23(), -1.6, -2.4, 0)
  for (const [kind, x, y] of [
    ["c", 1.4, -6.2],
    ["c", 1.4, -15.6],
    ["r", -1.8, -16.4],
    ["r", -5.2, -17],
    ["led:#ff2b1f", 4.6, -17.2],
  ] as const)
    place(k, chipPart(kind, 1.6, 0.8, kind === "r" ? 0.45 : 0.8), x, y, Math.PI / 2)
  k.mark({ lines: ["ESP32-DevKitC"], x: 0, y: 1.2, z: 0.006, width: 10, height: 1.3, color: "#e9e7e1", weight: 700 })
  b.merge(k.transform(0, 0, 0, top))
  return b
}

// ---------- Wemos D1 Mini ----------

/** Wemos D1 Mini on two 1x8 headers: blue board, ESP8266 module can at the antenna end, CH340 and micro-USB. */
export function wemosD1Mini(ctx: ModelContext): Builder {
  const { b, k, top } = carrier(ctx, { x0: -12.7, y0: -17.145, x1: 12.7, y1: 17.145, pcb: boardKey(ctx, "#1d4f9c"), corner: 0.8, labels: { rotZ: 0, inset: 2.3 } })
  // ESP-12 style module: its own black board, a shield can and a meander antenna at the top.
  const mY0 = -2.2
  const mY1 = 17.145
  const mT = 0.8
  k.add("pcbModule", block(0, (mY0 + mY1) / 2, 16, mY1 - mY0, 0, mT, 0.2, 0.04))
  const canY1 = mY1 - 6.4
  k.add("shield", block(0, (mY0 + canY1) / 2 + 0.2, 12, canY1 - mY0 - 1, mT, mT + 2.2, 0.3, 0.14))
  k.mark({ lines: ["ESP8266MOD", "4MB  " + dateCode(ctx.component.ref)], x: 0, y: (mY0 + canY1) / 2, z: mT + 2.2 + 0.004, width: 9, height: 3.4, color: "#3a3d43", weight: 700 })
  const ant: P2[] = [[-6.5, canY1 + 0.6]]
  for (let i = 0; i <= 8; i++) {
    const y = i % 2 ? canY1 + 0.9 : mY1 - 0.9
    ant.push([-6.5 + i * 1.6, y])
    if (i < 8) ant.push([-6.5 + (i + 1) * 1.6, y])
  }
  const antShape = new THREE.Shape(thicken(ant, 0.4).map(([x, y]) => new THREE.Vector2(x, y)))
  k.add("maskCopper", slab(antShape, mT - 0.01, mT + 0.025, 0, 4))
  place(k, microUsb(), 0, -17.145 + 1.9, Math.PI)
  place(k, soic(16, ["CH340G", dateCode(`${ctx.component.ref}:uart`)]), 3.2, -8.6)
  place(k, smallTact(), -8.2, -11.6, Math.PI / 2)
  place(k, sot223(["4A2D", dateCode(`${ctx.component.ref}:ldo`)]), -3.6, -9.4, Math.PI / 2)
  place(k, chipPart("led:#2f6bff", 1.6, 0.8, 0.7), 8.6, -3.6, Math.PI / 2)
  b.merge(k.transform(0, 0, 0, top))
  return b
}

// ---------- Seeed XIAO ESP32-C3 ----------

/** Seeed Studio XIAO ESP32-C3 on headers: black board, shield can, USB-C over the +y edge, BOOT and RESET. */
export function xiaoEsp32c3(ctx: ModelContext): Builder {
  const { b, k, top } = carrier(ctx, { x0: -8.9, y0: -10.5, x1: 8.9, y1: 10.5, pcb: boardKey(ctx, "#1b1c20"), corner: 1.2 })
  k.add("shield", block(0, -2.6, 11.2, 11.8, 0, 1.9, 0.35, 0.12))
  k.mark({ lines: ["XIAO", "ESP32C3"], x: 0, y: -2.6, z: 1.904, width: 8, height: 4, color: "#3a3d43", weight: 700 })
  place(k, usbCReceptacle(7.35), 0, 10.5 + 1.2 - 3.675, Math.PI)
  for (const x of [-6.4, 6.4]) {
    k.box("plasticBlack", x, 6.4, 0, 2.2, 3, 0.7, 0.1)
    k.box("white", x, 6.4, 0.7, 1.1, 1.6, 0.35, 0.1)
  }
  place(k, chipPart("led:#ffb02e", 1, 0.5, 0.5), 5.6, 2.4, 0)
  k.cyl("gold", -5.8, -8.6, 0, 0.9, 1.0, 20)
  b.merge(k.transform(0, 0, 0, top))
  return b
}

// ---------- Raspberry Pi Pico ----------

/**
 * Raspberry Pi Pico soldered flat by its castellations: 1 mm green board, RP2040, flash, crystal,
 * BOOTSEL button and the micro-USB over the +y edge.
 */
export function raspberryPiPico(ctx: ModelContext): Builder {
  const b = new Builder()
  const z0 = SEAT + 0.08
  const T = 1.0
  b.add(boardKey(ctx, "#1d7a46"), slab(roundedRectShape(0, 0, 21, 51, 0.6), z0, z0 + T, 0.06, 8))
  // A castellation over each edge pad, facing out of the nearest edge.
  for (const p of ctx.pads) {
    if (Math.abs(p.x) > 8) place(b, castellation(T), Math.sign(p.x) * 10.5, p.y, p.x > 0 ? 0 : Math.PI)
    else place(b, castellation(T), p.x, -25.5, -Math.PI / 2)
  }
  const k = new Builder()
  place(k, qfn(7, 14, 0.4, ["RP2-B2", "21/32", dateCode(`${ctx.component.ref}:mcu`)]), 0, 1.6)
  place(k, soic(8, ["W25Q16", dateCode(`${ctx.component.ref}:flash`)], 3.9, 1.27), 0, -7.6, Math.PI / 2)
  place(k, crystalCan(2, 1.6, 0.55), -4.6, -3.2)
  place(k, microUsb(), 0, 24.3)
  // BOOTSEL: white plunger in a dark housing.
  k.box("plasticBlack", -6.4, 16.6, 0, 3.4, 2.8, 1.1, 0.12)
  k.box("white", -6.4, 16.6, 1.1, 1.8, 1.4, 0.45, 0.2)
  k.mark({ lines: ["BOOTSEL"], x: -6.4, y: 14.4, z: 0.006, width: 4, height: 0.9, color: "#e9e7e1", weight: 600 })
  place(k, chipPart("led:#33d16a", 1, 0.5, 0.5), -4.6, 20.4, 0)
  // Buck-boost regulator and its inductor near the power pins.
  place(k, soic(8, ["RT6150"], 2.2, 0.65), 5.2, 14.6, 0)
  k.box("ferrite", 5.2, 10.4, 0, 2.5, 2.0, 1.2, 0.1)
  k.mark({ lines: ["Raspberry Pi Pico ©2020"], x: 0, y: -17, z: 0.006, width: 14, height: 1.2, rotZ: Math.PI / 2, color: "#e9e7e1", weight: 600 })
  b.merge(k.transform(0, 0, 0, z0 + T))
  return b
}

// ---------- SMD RF modules ----------

/**
 * A WROOM module soldered flat on its footprint, antenna end at the top of the courtyard (+y).
 * The castellations line up with the footprint's edge pads.
 */
export function smdWroom(ctx: ModelContext, name: string, top: number): Builder {
  const castles: [number, number, number][] = []
  // Module frame: x mirrored, y measured down from the antenna end (the module is turned 180°).
  for (const p of ctx.pads) {
    if (Math.abs(p.x) > 7) castles.push([-Math.sign(p.x) * 9, top - p.y, p.x > 0 ? Math.PI : 0])
    else if (p.y < top - 22) castles.push([-p.x, 25.5, Math.PI / 2])
  }
  const m = wroomModule({ name, fine: ["FCC ID: 2AC7Z-ESP32", dateCode(ctx.component.ref)], castles })
  return new Builder().merge(m.transform(0, top, Math.PI, SEAT + 0.05))
}
