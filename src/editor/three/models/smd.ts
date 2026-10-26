import * as THREE from "three"
import type { PadDef } from "../../../model/types"
import type { ModelContext } from "./index"
import { Builder, SEAT, bezier, block, dateCode, gullWingLead, lathe, profileXZ, slab, type P2 } from "./kit"
import { parseValue } from "../../../lib/values"
import { LED_COLORS, icName, resistorCode, shortCode } from "./values"

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Seed for date codes: identical parts share one, like parts from one reel. */
export const reelSeed = (ctx: ModelContext) => `${ctx.part.id}:${mpnOf(ctx)}`

export const mpnOf = (ctx: ModelContext) => ctx.component.props.mpn || ctx.part.mpn || ""

// ---------- two-terminal helpers ----------

interface Axis {
  cx: number
  cy: number
  angle: number
  /** Centre-to-centre pad distance. */
  gap: number
  /** Pad size along / across the axis. */
  padLen: number
  padW: number
}

/** Axis from pad 1 to pad 2; models are built with pad 1 at -x and pad 2 at +x. */
export function twoPadAxis(pads: PadDef[]): Axis {
  const a = pads.find((p) => p.pin === "1") ?? pads[0]
  const b = pads.find((p) => p !== a && p.pin === "2") ?? pads.find((p) => p !== a) ?? a
  const dx = b.x - a.x
  const dy = b.y - a.y
  const along = Math.abs(dx) >= Math.abs(dy)
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    angle: Math.atan2(dy, dx),
    gap: Math.hypot(dx, dy),
    padLen: along ? a.width : a.height,
    padW: along ? a.height : a.width,
  }
}

/** Concave solder fillet from the pad up an end face at x = face (outward along +x when sign = 1). */
function fillet(b: Builder, face: number, sign: 1 | -1, reach: number, height: number, width: number) {
  const fl = clamp(reach, 0.04, 0.34)
  const pts: P2[] = [
    [face - 0.02, SEAT],
    [face + fl, SEAT],
    ...bezier([face + fl, SEAT], [face + fl * 0.3, SEAT + 0.015], [face + 0.02, SEAT + height * 0.45], [face, SEAT + height], 14),
  ]
  const g = profileXZ(sign === 1 ? pts : pts.map(([x, z]) => [-x, z] as P2), width)
  b.add("solder", g)
}

// ---------- chips ----------

interface ChipSize {
  l: number
  w: number
  /** Resistor and capacitor heights. */
  hr: number
  hc: number
  term: number
}

const CHIP: Record<string, ChipSize> = {
  "0201": { l: 0.6, w: 0.3, hr: 0.23, hc: 0.3, term: 0.15 },
  "0402": { l: 1.0, w: 0.5, hr: 0.35, hc: 0.5, term: 0.25 },
  "0603": { l: 1.6, w: 0.8, hr: 0.45, hc: 0.8, term: 0.3 },
  "0805": { l: 2.0, w: 1.25, hr: 0.5, hc: 0.85, term: 0.4 },
  "1206": { l: 3.2, w: 1.6, hr: 0.55, hc: 1.0, term: 0.5 },
  "1210": { l: 3.2, w: 2.5, hr: 0.55, hc: 1.25, term: 0.5 },
  "2010": { l: 5.0, w: 2.5, hr: 0.6, hc: 1.3, term: 0.6 },
  "2512": { l: 6.3, w: 3.2, hr: 0.6, hc: 1.5, term: 0.6 },
}

export const isChip = (fp: string) => fp in CHIP

export type ChipRole = "resistor" | "capacitor" | "inductor" | "led" | "diode"

export interface ChipOptions {
  /** Body size; the footprint's own entry in the table when absent. */
  size?: ChipSize
  /** What the chip is; read from the library part when absent. */
  role?: ChipRole
  /** For an LED or a diode: the marked cathode end is pad 1 (at -x), as on KiCad's and suppliers' lands, rather than pad 2 (+x), as on the library's. */
  cathodeFirst?: boolean
}

/**
 * Body size for a chip of this length and width in millimetres (`1.6, 0.8` for an 0603): the
 * table's entry when the size is a standard one, else the nearest by length scaled to the width.
 */
export function chipSizeFor(l: number, w: number): ChipSize {
  let best = CHIP["0603"]
  let bestD = Infinity
  for (const s of Object.values(CHIP)) {
    const d = Math.abs(s.l - l) + Math.abs(s.w - w)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  if (bestD < 0.15) return best
  const k = Math.sqrt((l * w) / (best.l * best.w))
  return { l, w, hr: clamp(best.hr * k, 0.2, 0.8), hc: clamp(best.hc * k, 0.25, 2.2), term: clamp(l * 0.19, 0.12, 0.8) }
}

export function chip(ctx: ModelContext, opts: ChipOptions = {}): Builder {
  const s = opts.size ?? CHIP[ctx.footprint]
  const ax = twoPadAxis(ctx.pads)
  const b = new Builder()
  const L = s.l
  const W = s.w
  const z0 = SEAT + 0.015
  const reach = (ax.gap / 2 + ax.padLen / 2 - L / 2) * 0.6
  const id = ctx.part.id
  const role: ChipRole = opts.role ?? (id === "resistor" ? "resistor" : id === "led" ? "led" : id === "inductor" ? "inductor" : "capacitor")

  if (role === "resistor") {
    const h = s.hr
    b.box("ceramic", 0, 0, z0, L - 0.04, W - 0.01, h - 0.02, 0.02)
    b.box("resistorCoat", 0, 0, z0 + h - 0.06, L - 2 * s.term + 0.08, W - 0.03, 0.07, 0.015)
    for (const sign of [-1, 1] as const) {
      b.box("tin", sign * (L / 2 - s.term / 2 + 0.005), 0, z0 - 0.012, s.term + 0.01, W + 0.02, h + 0.014, 0.035)
      fillet(b, L / 2 + 0.005, sign, reach, h * 0.6, W * 0.92)
    }
    const code = L >= 1.5 ? resistorCode(ctx.component.props.resistance) : null
    if (code)
      b.mark({ lines: [code], x: 0, y: 0, z: z0 + h + 0.012, width: L - 2 * s.term - 0.12, height: W * 0.72, color: "#ecebe6", weight: 500 })
  } else if (role === "led") {
    const color = LED_COLORS[(ctx.component.props.color ?? "").trim().toLowerCase()] ?? ctx.part.body3d?.color ?? "#ff3b30"
    const h = s.hc
    const base = h * 0.42
    b.box("white", 0, 0, z0, L - 0.02, W, base, 0.03)
    b.box(`glow:${color}`, 0, 0, z0 + base - 0.01, L * 0.66, W * 0.94, h - base, Math.min(0.08, W * 0.08))
    b.box(`die:${color}`, 0, 0, z0 + base, Math.min(0.32, L * 0.16), Math.min(0.32, W * 0.3), 0.06)
    for (const sign of [-1, 1] as const) {
      b.box("tin", sign * (L / 2 - s.term * 0.45), 0, z0 - 0.012, s.term * 0.9, W * 0.72, base + 0.01, 0.02)
      fillet(b, L / 2, sign, reach, base * 0.7, W * 0.65)
    }
    // Green cathode tick on the top of the base, at the K end.
    b.box("paint:#2fa34a:0.6", (opts.cathodeFirst ? -1 : 1) * (L / 2 - s.term - 0.12), 0, z0 + base - 0.004, 0.08, W * 0.5, 0.01)
  } else {
    const body = role === "inductor" ? "ferrite" : role === "diode" ? "epoxy" : "mlcc"
    const h = s.hc
    b.box(body, 0, 0, z0, L - 0.02, W, h, Math.min(0.07, W * 0.08))
    for (const sign of [-1, 1] as const) {
      b.box("tin", sign * (L / 2 - s.term / 2 + 0.005), 0, z0 - 0.012, s.term + 0.012, W + 0.025, h + 0.025, Math.min(0.07, W * 0.08))
      fillet(b, L / 2 + 0.005, sign, reach, h * 0.45, W * 0.92)
    }
    if (role === "diode") b.box("sleeveStripe", (opts.cathodeFirst ? -1 : 1) * (L / 2 - s.term - 0.16), 0, z0 + h - 0.004, 0.1, W - 0.1, 0.012)
  }
  return b.transform(ax.cx, ax.cy, ax.angle)
}

// ---------- polarised SMD capacitors ----------

/** "100uF" -> "100", "4.7uF" -> "4.7", "0.47uF" -> "0.47". */
function microfarads(raw: string | undefined): string | null {
  const f = parseValue(raw)
  if (f === null || f <= 0) return null
  const uf = f * 1e6
  return String(Number(uf.toPrecision(uf >= 100 ? 3 : 2)))
}

/** EIA picofarad code: 10uF -> "106", 4.7uF -> "475". */
function capCode(raw: string | undefined): string | null {
  const f = parseValue(raw)
  if (f === null || f <= 0) return null
  const pf = f * 1e12
  if (pf < 10) return null
  let exp = Math.floor(Math.log10(pf)) - 1
  let digits = Math.round(pf / 10 ** exp)
  if (digits >= 100) {
    digits = Math.round(digits / 10)
    exp++
  }
  return `${digits}${exp}`
}

const voltsText = (raw: string | undefined) => {
  const v = raw?.trim().toUpperCase()
  return v ? (v.endsWith("V") ? v : `${v}V`) : null
}

/**
 * SMD aluminium electrolytic ("cap_elec_8x10.5"): black seat plate with the + corners chamfered,
 * bare can with the black - band and value printed on top, cross vent and flat terminals.
 */
export function smdElectrolytic(ctx: ModelContext): Builder {
  const ax = twoPadAxis(ctx.pads)
  const b = new Builder()
  const m = ctx.footprint.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/)
  const d = m ? Number(m[1]) : 8
  const h = m ? Number(m[2]) : (ctx.part.body3d?.height ?? 10.5)
  const r = d / 2
  const A = d + 0.3
  const half = A / 2
  const tT = 0.15
  const baseTop = Math.min(1.3, h * 0.12)

  // Flat terminals out from under the seat plate along the pads.
  const outer = ax.gap / 2 + ax.padLen / 2
  const tip = Math.min(outer - 0.25, half + 0.6)
  const inner = Math.max(0.6, half - 2.4)
  const tw = Math.min(1.1, ax.padW * 0.45)
  for (const sign of [-1, 1] as const) {
    b.box("tin", sign * (inner + tip) / 2, 0, SEAT, tip - inner, tw, tT, 0.03)
    fillet(b, tip, sign, (outer - tip) * 0.6, tT * 0.9, tw * 0.95)
  }

  // Seat plate: square with the two + (pin 1, -x) corners chamfered.
  const cut = A * 0.16
  const seat = new THREE.Shape()
  seat.moveTo(-half + cut, -half)
  seat.lineTo(half, -half)
  seat.lineTo(half, half)
  seat.lineTo(-half + cut, half)
  seat.lineTo(-half, half - cut)
  seat.lineTo(-half, -half + cut)
  seat.closePath()
  b.add("plasticBlack", slab(seat, SEAT + tT, baseTop, 0.1, 4))

  // Can with the sealing groove near the bottom and a rolled top edge.
  const z0 = baseTop - 0.1
  b.add(
    "alu",
    lathe(
      [
        [0, z0],
        [r - 0.4, z0],
        [r - 0.08, z0 + 0.12],
        [r, z0 + 0.4],
        [r, z0 + 0.9],
        [r - 0.18, z0 + 1.06],
        [r - 0.18, z0 + 1.2],
        [r, z0 + 1.38],
        [r, h - 0.42],
        [r - 0.06, h - 0.18],
        [r - 0.22, h - 0.04],
        [r - 0.45, h],
        [0, h],
      ],
      64,
    ),
  )
  // Cross vent, then the printed - band and value over it.
  const vr = Math.min(r - 0.9, 2.6)
  b.box("vent", 0, 0, h - 0.008, vr * 2, 0.15, 0.01)
  b.box("vent", 0, 0, h - 0.008, 0.15, vr * 2, 0.01)
  const rr = r - 0.5
  const sx = r * 0.36
  const th = Math.acos(sx / rr)
  const band = new THREE.Shape()
  band.moveTo(sx, -rr * Math.sin(th))
  band.absarc(0, 0, rr, -th, th, false)
  band.closePath()
  const bandG = new THREE.ShapeGeometry(band, 24)
  bandG.translate(0, 0, h + 0.004)
  b.add("paint:#121214:0.42", bandG)
  const lines = [microfarads(ctx.component.props.capacitance), voltsText(ctx.component.props.voltage)].filter((l): l is string => !!l)
  if (lines.length)
    b.mark({ lines, x: (-rr + sx) / 2 - 0.1, y: 0, z: h + 0.007, width: rr * 1.15, height: (rr + sx) * 0.62, rotZ: -Math.PI / 2, color: "#151517", weight: 700 })
  return b.transform(ax.cx, ax.cy, ax.angle)
}

/** EIA 3528 (case B) moulded tantalum: amber body, anode band at pin 1 (+, -x), J-folded terminations. */
export function tantalum(ctx: ModelContext): Builder {
  const ax = twoPadAxis(ctx.pads)
  const b = new Builder()
  const L = 3.5
  const W = 2.8
  const H = ctx.part.body3d?.height ?? 1.9
  const tT = 0.1
  const termW = Math.min(2.2, ax.padW * 0.9)
  const color = ctx.part.body3d?.color ?? "#d9a43a"
  const face = L / 2 - 0.06
  b.add(`gloss:${color}:0.55`, block(0, 0, face * 2, W, SEAT + tT, H, 0.12, 0.2))
  const outer = ax.gap / 2 + ax.padLen / 2
  for (const sign of [-1, 1] as const) {
    // Strap down the end face, folded under the body.
    b.box("tin", sign * (face + tT / 2 - 0.01), 0, SEAT, tT, termW, Math.min(1.05, H * 0.55), 0.02)
    b.box("tin", sign * (face - 0.4), 0, SEAT, 0.8, termW, tT, 0.02)
    fillet(b, face + tT - 0.01, sign, (outer - face - tT) * 0.7, Math.min(0.55, H * 0.3), termW * 0.96)
  }
  // Anode band on the + end, value code beside it.
  b.box("paint:#6b3a12:0.55", -face + 0.62, 0, H - 0.006, 0.5, W - 0.5, 0.012)
  const lines = [capCode(ctx.component.props.capacitance), voltsText(ctx.component.props.voltage)].filter((l): l is string => !!l)
  if (lines.length) b.mark({ lines, x: 0.35, y: 0, z: H + 0.008, width: 1.9, height: 1.55, color: "#4a3014", weight: 700 })
  return b.transform(ax.cx, ax.cy, ax.angle)
}

// ---------- molded diodes ----------

interface DiodeSize {
  l: number
  w: number
  h: number
  style: "gull" | "j"
  leadW: number
  t: number
  tip: number
}

const DIODES: [RegExp, DiodeSize][] = [
  [/^sod(123|123f|123fl|123w)/, { l: 2.7, w: 1.6, h: 1.1, style: "gull", leadW: 0.6, t: 0.12, tip: 1.85 }],
  [/^sod(323|323f|323fl|323w|110)/, { l: 1.7, w: 1.25, h: 0.95, style: "gull", leadW: 0.32, t: 0.12, tip: 1.25 }],
  [/^sod(523|723|923|882)/, { l: 1.2, w: 0.8, h: 0.6, style: "gull", leadW: 0.28, t: 0.1, tip: 0.8 }],
  [/^sod128/, { l: 3.8, w: 2.5, h: 1.0, style: "j", leadW: 1.4, t: 0.15, tip: 0 }],
  [/^smbf?$/, { l: 4.3, w: 3.6, h: 2.2, style: "j", leadW: 2.0, t: 0.2, tip: 0 }],
  [/^smc$/, { l: 6.9, w: 5.9, h: 2.2, style: "j", leadW: 3.0, t: 0.2, tip: 0 }],
  [/^smf$/, { l: 2.8, w: 1.8, h: 0.98, style: "j", leadW: 1.0, t: 0.15, tip: 0 }],
  [/^sma$/, { l: 4.3, w: 2.6, h: 2.1, style: "j", leadW: 1.4, t: 0.18, tip: 0 }],
]

export const diodeSize = (fp: string) => DIODES.find(([re]) => re.test(fp))?.[1] ?? null

/** `cathodeFirst`: the cathode is pad 1 (KiCad's lands) rather than pad 2 (the library's). */
export function moldedDiode(ctx: ModelContext, s: DiodeSize, cathodeFirst = false): Builder {
  const ax = twoPadAxis(ctx.pads)
  const b = new Builder()
  const { l: L, w: W, h: H } = s
  const outer = ax.gap / 2 + ax.padLen / 2
  const z0 = s.style === "j" ? SEAT + s.t : 0.05
  b.add("epoxy", block(0, 0, L, W, z0, H, Math.min(0.12, W * 0.08), Math.min(0.14, H * 0.12)))

  for (const sign of [-1, 1] as const) {
    if (s.style === "gull") {
      const tip = clamp(s.tip, L / 2 + 0.25, outer - 0.05)
      const g = gullWingLead(L / 2 - 0.02, tip, z0 + (H - z0) * 0.28, s.t, s.leadW)
      if (sign < 0) g.rotateZ(Math.PI)
      b.add("tin", g)
    } else {
      // J-bend: strap down the end face, folded under the body.
      b.box("tin", sign * (L / 2 + s.t / 2 - 0.01), 0, SEAT, s.t, s.leadW, Math.min(H * 0.5, 1.1))
      b.box("tin", sign * (L / 2 - 0.45 + s.t / 2), 0, SEAT, 0.9 + s.t, s.leadW, s.t)
      fillet(b, L / 2 + s.t - 0.01, sign, (outer - L / 2 - s.t) * 0.6, Math.min(H * 0.3, 0.6), s.leadW * 0.95)
    }
  }
  // Cathode band on the K end: pin 2 (+x) on the library's lands, pin 1 (-x) on KiCad's.
  const k = cathodeFirst ? -1 : 1
  b.box("sleeveStripe", k * (L / 2 - L * 0.17), 0, H - 0.004, L * 0.12, W - Math.min(0.2, W * 0.1), 0.012)
  const volts = ctx.component.props.voltage?.trim().replace(/^(\d+)\.(\d+)\s*V$/i, "$1V$2")
  const code = mpnOf(ctx) ? shortCode(mpnOf(ctx), 5) : (volts ?? "").toUpperCase().slice(0, 5)
  if (code && L >= 2.5) b.mark({ lines: [code], x: -k * L * 0.08, y: 0, z: H + 0.006, width: L * 0.56, height: W * 0.42, color: "#a6a6aa", weight: 600 })
  return b.transform(ax.cx, ax.cy, ax.angle)
}

// ---------- gull-wing and no-lead ICs ----------

type SideKey = "+x" | "-x" | "+y" | "-y"

interface Side {
  key: SideKey
  pads: PadDef[]
  /** Outward distance of the pad centres from the body centre. */
  X: number
  /** Pad length along the outward axis and width along the row. */
  L: number
  rowDim: number
  /** Smallest pad pitch on this side (Infinity for a single pad). */
  pitch: number
  /** Half span of pad centres along the row. */
  rowHalf: number
}

interface PadLayout {
  cx: number
  cy: number
  kind: "dual-x" | "dual-y" | "quad"
  sides: Side[]
}

const distinct = (vals: number[]) => new Set(vals.map((v) => Math.round(v * 100))).size

export function padLayout(pads: PadDef[]): PadLayout | null {
  if (pads.length < 3) return null
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const dx = distinct(xs)
  const dy = distinct(ys)
  let kind: PadLayout["kind"]
  if (dx === 2 && (dy > 2 || maxX - minX > maxY - minY)) kind = "dual-x"
  else if (dy === 2) kind = "dual-y"
  else kind = "quad"

  const halfX = Math.max(1e-3, (maxX - minX) / 2)
  const halfY = Math.max(1e-3, (maxY - minY) / 2)
  const groups = new Map<SideKey, PadDef[]>()
  for (const p of pads) {
    let key: SideKey
    if (kind === "dual-x") key = p.x > cx ? "+x" : "-x"
    else if (kind === "dual-y") key = p.y > cy ? "+y" : "-y"
    else {
      const ux = Math.abs(p.x - cx) / halfX
      const uy = Math.abs(p.y - cy) / halfY
      key = ux >= uy ? (p.x > cx ? "+x" : "-x") : p.y > cy ? "+y" : "-y"
    }
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const sides: Side[] = []
  for (const [key, list] of groups) {
    const onX = key.endsWith("x")
    const rows = list.map((p) => (onX ? p.y - cy : p.x - cx)).sort((a, b) => a - b)
    let pitch = Infinity
    for (let i = 1; i < rows.length; i++) pitch = Math.min(pitch, rows[i] - rows[i - 1])
    sides.push({
      key,
      pads: list,
      X: Math.max(...list.map((p) => (onX ? Math.abs(p.x - cx) : Math.abs(p.y - cy)))),
      L: Math.max(...list.map((p) => (onX ? p.width : p.height))),
      rowDim: Math.max(...list.map((p) => (onX ? p.height : p.width))),
      pitch,
      rowHalf: (rows[rows.length - 1] - rows[0]) / 2,
    })
  }
  return { cx, cy, kind, sides }
}

export interface GullSpec {
  /** Half the body's width across the lead rows (dual packages). */
  B?: number
  /** Half the body's length along the lead rows (dual packages), when known; else it follows the pads. */
  L?: number
  /** Half the body's side (quad packages), or half its x and y when it isn't square; else it follows the pads. */
  Q?: number | [number, number]
  P: number
  H: number
  standoff: number
  margin: number
  t: number
  wMax: number
  minProj: number
  dimple: number
  mark: "ic" | "code" | "none"
}

export function gullSpec(fp: string, layout: PadLayout): GullSpec | null {
  const maxX = Math.max(...layout.sides.map((s) => s.X))
  if (/^sot223/.test(fp)) return { B: 1.75, P: 1.75, H: 1.6, standoff: 0.06, margin: 0.95, t: 0.26, wMax: 0.75, minProj: 0.6, dimple: 0, mark: "ic" }
  // SOT-416, -523 and -723: 0.8 mm wide, 0.7 to 0.9 tall.
  if (/^sot523/.test(fp)) return { B: 0.4, P: 0.35, H: 0.75, standoff: 0.03, margin: 0.3, t: 0.1, wMax: 0.25, minProj: 0.25, dimple: 0, mark: "code" }
  if (/^sot(323|343|363|563|886|963|723)/.test(fp))
    return { B: 0.625, P: 0.45, H: 0.95, standoff: 0.05, margin: 0.35, t: 0.12, wMax: 0.3, minProj: 0.3, dimple: 0, mark: "code" }
  if (/^sot(?!89)/.test(fp)) return { B: 0.65, P: 0.55, H: 1.0, standoff: 0.05, margin: 0.5, t: 0.13, wMax: 0.42, minProj: 0.35, dimple: 0, mark: "code" }
  if (/^(soic|sop|ms01|so\d)/.test(fp))
    return { B: maxX > 3.4 ? 3.75 : 1.95, P: 1.05, H: 1.45, standoff: 0.12, margin: 0.5, t: 0.2, wMax: 0.42, minProj: 0.45, dimple: 0.3, mark: "ic" }
  if (/^tssop/.test(fp)) return { B: 2.2, P: 1.0, H: 1.0, standoff: 0.08, margin: 0.45, t: 0.15, wMax: 0.3, minProj: 0.4, dimple: 0.25, mark: "ic" }
  if (/^ssop/.test(fp)) return { B: 2.65, P: 1.0, H: 1.75, standoff: 0.1, margin: 0.5, t: 0.15, wMax: 0.32, minProj: 0.4, dimple: 0.3, mark: "ic" }
  if (/^(msop|vssop)/.test(fp)) return { B: 1.5, P: 0.95, H: 0.95, standoff: 0.08, margin: 0.35, t: 0.15, wMax: 0.3, minProj: 0.35, dimple: 0.2, mark: "ic" }
  if (/^(tqfp|lqfp|qfp)/.test(fp))
    return { P: 1.0, H: /^tqfp/.test(fp) ? 1.0 : 1.4, standoff: 0.1, margin: 0, t: 0.15, wMax: 0.37, minProj: 0.6, dimple: 0.5, mark: "ic" }
  // Plain, plastic and metric QFPs, which a name can only say are 2.0 to 3.4 mm tall.
  if (/^pqfp/.test(fp)) return { P: 1.0, H: 2.45, standoff: 0.25, margin: 0, t: 0.15, wMax: 0.4, minProj: 0.6, dimple: 0.5, mark: "ic" }
  // Power packages with a tab: DPAK (TO-252) and D2PAK (TO-263). The tab is the one pad on the far side.
  if (/^to252/.test(fp)) return { B: 2.7, L: 3.1, P: 1.2, H: 2.3, standoff: 0.1, margin: 0.9, t: 0.5, wMax: 0.9, minProj: 0.7, dimple: 0, mark: "ic" }
  if (/^to263/.test(fp)) return { B: 4.6, L: 4.5, P: 1.6, H: 4.4, standoff: 0.15, margin: 0.9, t: 0.6, wMax: 1.0, minProj: 1.0, dimple: 0, mark: "ic" }
  if (/^sot89/.test(fp)) return { B: 1.25, L: 2.25, P: 1.0, H: 1.5, standoff: 0.1, margin: 0.5, t: 0.25, wMax: 0.6, minProj: 0.45, dimple: 0, mark: "code" }
  return null
}

const ANGLE: Record<SideKey, number> = { "+x": 0, "-x": Math.PI, "+y": Math.PI / 2, "-y": -Math.PI / 2 }

export function gullWing(ctx: ModelContext, layout: PadLayout, spec: GullSpec, exposed: PadDef[] = []): Builder {
  const b = new Builder()
  const xs = layout.sides.filter((s) => s.key.endsWith("x"))
  const ys = layout.sides.filter((s) => s.key.endsWith("y"))
  const minPitch = Math.min(...layout.sides.map((s) => s.pitch))
  const pitch = Number.isFinite(minPitch) ? minPitch : 1.27

  const tipFor = (s: Side, B: number) => clamp(B + spec.P, s.X - s.L / 2 + 0.3 * s.L, s.X + s.L / 2 - 0.05)
  const halfFor = (outward: Side[], across: Side[]): number => {
    if (!outward.length) {
      // No leads on this axis: the body spans the rows of the other axis.
      const rowHalf = Math.max(...across.map((s) => s.rowHalf))
      return rowHalf + (spec.margin || pitch * 0.9)
    }
    let B: number
    if (spec.B !== undefined && layout.kind !== "quad") B = spec.B
    else if (layout.kind === "quad") {
      const rowHalf = across.length ? Math.max(...across.map((s) => s.rowHalf)) : 0
      B = Math.max(rowHalf + pitch * 0.9, Math.max(...outward.map((s) => s.X + 0.1 * s.L)) - spec.P)
    } else B = Math.min(...outward.map((s) => s.X - s.L / 2)) - 0.25
    for (const s of outward) B = Math.min(B, tipFor(s, B) - spec.minProj)
    return Math.max(0.3, B)
  }
  let Bx = halfFor(xs, ys)
  let By = halfFor(ys, xs)
  // A size the package's name gave beats the one worked out from the pads.
  if (spec.L && layout.kind === "dual-x") By = spec.L
  else if (spec.L && layout.kind === "dual-y") Bx = spec.L
  else if (spec.Q && layout.kind === "quad") {
    Bx = typeof spec.Q === "number" ? spec.Q : spec.Q[0]
    By = typeof spec.Q === "number" ? spec.Q : spec.Q[1]
  }
  const z0 = spec.standoff
  const z1 = spec.standoff + spec.H
  const exitZ = z0 + spec.H * 0.32

  b.add("epoxy", block(0, 0, Bx * 2, By * 2, z0, z1, Math.min(0.15, Math.min(Bx, By) * 0.1), Math.min(0.16, spec.H * 0.12)))

  for (const s of layout.sides) {
    const onX = s.key.endsWith("x")
    const B = onX ? Bx : By
    const tip = tipFor(s, B)
    const single = s.pads.length === 1
    const w = single && s.rowDim > 2 ? s.rowDim * 0.78 : Math.min(s.rowDim * 0.75, single ? spec.wMax : Math.min(spec.wMax, pitch * 0.55))
    for (const p of s.pads) {
      const g = gullWingLead(B - 0.02, tip, exitZ, spec.t, w)
      g.rotateZ(ANGLE[s.key])
      if (onX) g.translate(0, p.y - layout.cy, 0)
      else g.translate(p.x - layout.cx, 0, 0)
      b.add("tin", g)
    }
  }

  // An exposed pad or a tab pad is a plate under the body, not a lead.
  exposedPlates(b, exposed, layout, Bx, By)

  const pin1 = ctx.pads.find((p) => p.pin === "1")
  if (spec.dimple > 0 && pin1) {
    const r = spec.dimple
    const sx = Math.sign(Math.round((pin1.x - layout.cx) * 100))
    const sy = Math.sign(Math.round((pin1.y - layout.cy) * 100))
    const inset = r * 1.9
    const g = new THREE.CircleGeometry(r, 24)
    g.translate(sx * Math.max(0, Bx - inset), sy * Math.max(0, By - inset), z1 + 0.002)
    b.add("epoxyGloss", g)
  }

  const mpn = mpnOf(ctx)
  const long = layout.kind === "dual-x" ? "y" : "x"
  const along = long === "y" ? By * 2 : Bx * 2
  const across = long === "y" ? Bx * 2 : By * 2
  const rotZ = long === "y" ? -Math.PI / 2 : 0
  if (spec.mark === "ic" && mpn) {
    const lines = [icName(mpn), dateCode(reelSeed(ctx))]
    b.mark({ lines, x: 0, y: 0, z: z1 + 0.004, width: along * (layout.kind === "quad" ? 0.62 : 0.8), height: across * (layout.kind === "quad" ? 0.24 : 0.4), rotZ, color: "#9c9ca1", weight: 600 })
  } else if (spec.mark === "code" && mpn) {
    b.mark({ lines: [shortCode(mpn)], x: 0, y: 0, z: z1 + 0.004, width: along * 0.62, height: across * 0.55, rotZ, color: "#a3a3a8", weight: 600 })
  }
  return b.transform(layout.cx, layout.cy, 0)
}

/**
 * A body's size as a package's name states it: `w` and `l` as the name gives them, `h` its height.
 * KiCad's names give x then y (`xy`); a supplier's the width across the lead rows (`w`) and the
 * length along them (`l`).
 */
export interface BodySize {
  w: number
  l: number
  h?: number
  xy?: boolean
}

/**
 * The body's size across the lead rows and along them, for a dual layout. A name's two numbers
 * don't say which is which: a supplier's give width and length, KiCad's x then y, which is across
 * then along on a package whose pads run along x and the other way round on one whose pads run
 * along y, and a land can be turned from the way its name was drawn. So the pads decide: the
 * length along the rows must reach past the span of the pad centres, and the width across them
 * can't be wider than the lead tips. The name's own order is kept when both readings fit (a SOIC-8's 3.9 and 4.9
 * do) and the reading that fits is taken when only one does.
 */
export function acrossAlong(layout: PadLayout, size: BodySize): { across: number; along: number } {
  const kind = layout.kind
  // The reading a name's order suggests: x then y, on a package whose pads are at the top and bottom, has the second across.
  const named = size.xy && kind === "dual-y" ? { across: size.l, along: size.w } : { across: size.w, along: size.l }
  const swapped = { across: named.along, along: named.across }
  const rowSpan = Math.max(...layout.sides.map((s) => s.rowHalf * 2))
  const tips = 2 * Math.max(...layout.sides.map((s) => s.X + s.L / 2))
  const misfit = (o: { across: number; along: number }) => Math.max(0, rowSpan + 0.1 - o.along) + Math.max(0, o.across - tips - 0.05)
  return misfit(named) <= misfit(swapped) ? named : swapped
}

/**
 * A named size as the body's size on x and y, for the layouts with no rows to read it by (quad
 * packages, grids): KiCad's name gives x then y as written, a supplier's two numbers go with the
 * longer one along the longer span of the pads (`xLonger`).
 */
export function sizeOnXY(size: BodySize, xLonger: boolean): [number, number] {
  if (size.xy) return [size.w, size.l]
  const hi = Math.max(size.w, size.l)
  const lo = Math.min(size.w, size.l)
  return xLonger ? [hi, lo] : [lo, hi]
}

/** The body's size along x and y on this layout. */
function bodyXY(layout: PadLayout, size: BodySize, xLonger: boolean): [number, number] {
  if (layout.kind === "quad") return sizeOnXY(size, xLonger)
  const { across, along } = acrossAlong(layout, size)
  return layout.kind === "dual-x" ? [across, along] : [along, across]
}

/** The exposed pad, or a tab, as a flat plate under a body of half sides Bx and By. */
function exposedPlates(b: Builder, exposed: PadDef[], layout: PadLayout, Bx: number, By: number) {
  for (const p of exposed) {
    const w = Math.min(p.width, Bx * 2 - 0.2)
    const h = Math.min(p.height, By * 2 - 0.2)
    if (w > 0.1 && h > 0.1) b.box("solder", p.x - layout.cx, p.y - layout.cy, SEAT, w, h, 0.03)
  }
}

/**
 * The exposed (thermal) pad of a package apart from its leads: pads the land marks exposed, a big
 * pad in the middle of the others, and whatever shares its number (a paste-split pad). Leads are
 * the pads left, which is what `padLayout` should read; the exposed pad is not a lead.
 */
export function splitExposed(all: PadDef[]): { leads: PadDef[]; exposed: PadDef[] } {
  // A land can stack pads on one spot (a small copper pad under its larger mask or paste opening):
  // they are one pad, the largest of them.
  const stacked = new Map<string, PadDef>()
  for (const p of all) {
    const at = `${p.pin}@${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`
    const have = stacked.get(at)
    if (!have || p.width * p.height > have.width * have.height) stacked.set(at, p)
  }
  // Pads of one number that overlap (a tab drawn as a pad and a bigger pad over it) are one pad too.
  const merged: PadDef[] = []
  for (const p of [...stacked.values()].sort((a, b) => b.width * b.height - a.width * a.height)) {
    const over = merged.some((q) => q.pin === p.pin && p.pin !== null && p.pin !== "" && Math.abs(q.x - p.x) <= (q.width + p.width) / 2 + 0.02 && Math.abs(q.y - p.y) <= (q.height + p.height) / 2 + 0.02)
    if (!over) merged.push(p)
  }
  const pads = all.filter((p) => merged.includes(p))
  if (pads.length < 4) return { leads: pads, exposed: [] }
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const hx = (Math.max(...xs) - Math.min(...xs)) / 2
  const hy = (Math.max(...ys) - Math.min(...ys)) / 2
  const areas = pads.map((p) => p.width * p.height).sort((a, b) => a - b)
  const med = areas[Math.floor(areas.length / 2)]
  const central = (p: PadDef) => Math.abs(p.x - cx) < Math.max(hx * 0.5, 0.01) && Math.abs(p.y - cy) < Math.max(hy * 0.5, 0.01) && p.width * p.height >= 3 * med
  const marked = new Set(pads.filter((p) => p.exposed || central(p)).map((p) => p.pin))
  // Several pads of one number whose copper together sits in the middle are an exposed pad split
  // for the paste stencil (a thermal pad drawn as eight small ones).
  const byPin = new Map<string, PadDef[]>()
  for (const p of pads) if (p.pin) byPin.set(p.pin, [...(byPin.get(p.pin) ?? []), p])
  for (const [pin, group] of byPin) {
    if (group.length < 2) continue
    const total = group.reduce((s, p) => s + p.width * p.height, 0)
    const gx = group.map((p) => p.x)
    const gy = group.map((p) => p.y)
    const inside = group.every((p) => Math.abs(p.x - cx) < Math.max(hx * 0.8, 0.01) && Math.abs(p.y - cy) < Math.max(hy * 0.8, 0.01) + 0.5 * p.height)
    const centred = Math.abs((Math.min(...gx) + Math.max(...gx)) / 2 - cx) < Math.max(hx * 0.3, 0.01) && Math.abs((Math.min(...gy) + Math.max(...gy)) / 2 - cy) < Math.max(hy * 0.3, 0.01)
    // Every piece is among the leads' rows and not at a lead's place, and together they sit in the middle.
    if (inside && centred && total >= 3 * med) marked.add(pin)
  }
  const exposed = pads.filter((p) => (p.pin !== null && p.pin !== "" && marked.has(p.pin)) || p.exposed || central(p))
  // Nothing but an exposed pad left to be a lead is not a package this describes.
  return exposed.length && pads.length - exposed.length >= 2 ? { leads: pads.filter((p) => !exposed.includes(p)), exposed } : { leads: pads, exposed: [] }
}

/** QFN / DFN / SON: flat body over the pads with terminal ends showing at the edges. */
export function noLead(ctx: ModelContext, layout: PadLayout, size?: BodySize, exposed: PadDef[] = []): Builder {
  const b = new Builder()
  const pads = ctx.pads
  const ext = (f: (p: PadDef) => number) => Math.max(...pads.map(f))
  const halfX = ext((p) => Math.abs(p.x - layout.cx) + p.width / 2)
  const halfY = ext((p) => Math.abs(p.y - layout.cy) + p.height / 2)
  let Bx = halfX - 0.05
  let By = halfY - 0.05
  if (size) {
    // The package's own size: across the rows (dual) or the longer side along the longer pad span (quad).
    const [sx, sy] = bodyXY(layout, size, halfX >= halfY)
    Bx = Math.max(sx / 2, 0.2)
    By = Math.max(sy / 2, 0.2)
  }
  const H = size?.h ?? 0.85
  b.add("epoxy", block(0, 0, Bx * 2, By * 2, SEAT + 0.02, SEAT + H, 0.06, 0.05))
  for (const s of layout.sides) {
    const onX = s.key.endsWith("x")
    for (const p of s.pads) {
      const px = p.x - layout.cx
      const py = p.y - layout.cy
      const len = Math.min(s.L * 0.6, 0.5)
      const w = s.rowDim * 0.8
      if (onX) b.box("tin", Math.sign(px) * (Bx - len / 2 + 0.01), py, SEAT, len, w, 0.2)
      else b.box("tin", px, Math.sign(py) * (By - len / 2 + 0.01), SEAT, w, len, 0.2)
    }
  }
  // The exposed pad is a flat plate under the body, seen only from below and at its edges.
  exposedPlates(b, exposed, layout, Bx, By)
  const pin1 = pads.find((p) => p.pin === "1")
  if (pin1) {
    const g = new THREE.CircleGeometry(Math.min(Bx, By) * 0.08, 20)
    g.translate(Math.sign(pin1.x - layout.cx) * Bx * 0.7, Math.sign(pin1.y - layout.cy) * By * 0.7, SEAT + H + 0.002)
    b.add("epoxyGloss", g)
  }
  const mpn = mpnOf(ctx)
  if (mpn) b.mark({ lines: [icName(mpn)], x: 0, y: 0, z: SEAT + H + 0.004, width: Bx * 1.5, height: By * 0.5, color: "#a3a3a8", weight: 600 })
  return b.transform(layout.cx, layout.cy, 0)
}
