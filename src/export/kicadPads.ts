import { normalizeAngle, round } from "../lib/geometry"
import { computeConnectivity, pinKey } from "../model/connectivity"
import { componentFootprint, padLayerDef, pcbPads, type WorldPad } from "../model/instances"
import { flipLayer, kicadLayerName } from "../model/stack"
import { hasPadFeatures } from "../model/padGeom"
import { padFaces } from "../model/padFaces"
import { flipShapeLayer } from "../model/shapeLayers"
import { shapePaths } from "../model/shapes"
import { onBoard } from "../model/partFlags"
import type { BoardShape, ComponentInstance, CopperLayer, PadDef, PadSides, Project, Vec2 } from "../model/types"
import { localFrame, polygonItems, ringItems } from "./kicadShapes"

// The pads of a part that has X7 features, written into the board file the converter made, exactly as KiCad has them: the shape (rectangle,
// rounded or chamfered rectangle, oval, circle, custom pad), its size and turn, the hole (round or oval, with its offset), the layers, the
// margins, clearance and pour settings, its number and net. The converter has no place for most of that (it writes every pad as a rectangle,
// a circle or an oval and a hole with no offset in a footprint's frame), so every pad of such a part is written here and the converter's
// are taken out; a part with none is left as the converter wrote it.
//
// A footprint is written as the converter does: its position and angle `A` on the page, its pads in its own frame (`localFrame`), the file's
// state for a part on the bottom being the flipped one. The land's vectors (a drawing of a custom pad, a drill's offset, the chamfered
// corners) are the library's, y up; KiCad stores them in the pad's frame, y down, and for a part on the bottom flipped (`PAD::Flip`, pad.cpp
// 10.0.0 `:1442`): a vector (x, y) is (x, -y) for a part on top and (x, y) on the bottom, the pad's turn is `A + turn` on top and
// `A - turn + 180` on the bottom (the pad is in the file's frame where the editor mirrored it: the editor's turn is the file's footprint
// angle plus half a turn, `landPad`), and the chamfered corners swap top for bottom there.
//
// The tokens are the ones KiCad 9's parser reads in a pad (`parsePAD`, pcb_io_kicad_sexpr_parser.cpp 9.0.0 `:5100-5480`).

const mm6 = (n: number) => String(round(n, 6) || 0)
const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
const quote = (text: string) => `"${text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** KiCad's rotation of a vector (counter-clockwise on screen, y down). */
function turnVec(v: Vec2, deg: number): Vec2 {
  if (!deg) return v
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c }
}

const FACE = { top: "F", bottom: "B" } as const

/** KiCad's layer names for a pad's sides of one kind, as the file writes them (`*.Cu` for both). */
function layerNames(sides: PadSides, kind: "Cu" | "Mask" | "Paste" | "SilkS", partBottom: boolean): string[] {
  if (sides === "none") return []
  if (sides === "both") return [`*.${kind}`]
  const top = sides === "top" !== partBottom
  return [`${top ? FACE.top : FACE.bottom}.${kind}`]
}

/** The primitives of a custom pad as KiCad's `primitives` node holds them, in the pad's stored frame. */
function primitiveBlock(shape: BoardShape, map: (v: Vec2) => Vec2, exact = false): string | null {
  const width = mm6(shape.width)
  const fill = `(fill ${shape.fill ? "yes" : "no"})`
  const p = (v: Vec2) => map(v)
  switch (shape.type) {
    case "line":
      return `(gr_line (start ${xy(p(shape.a))}) (end ${xy(p(shape.b))}) (width ${width}))`
    case "arc":
      return `(gr_arc (start ${xy(p(shape.start))}) (mid ${xy(p(shape.mid))}) (end ${xy(p(shape.end))}) (width ${width}))`
    case "circle":
      return `(gr_circle (center ${xy(p(shape.c))}) (end ${xy(p({ x: shape.c.x + shape.r, y: shape.c.y }))}) (width ${width}) ${fill})`
    case "rect": {
      if (shape.radius && shape.radius > 0) return polyOf(shape, p, width, fill)
      return `(gr_rect (start ${xy(p(shape.a))}) (end ${xy(p(shape.b))}) (width ${width}) ${fill})`
    }
    case "curve":
      return `(gr_curve (pts (xy ${xy(p(shape.p0))}) (xy ${xy(p(shape.c1))}) (xy ${xy(p(shape.c2))}) (xy ${xy(p(shape.p1))})) (width ${width}))`
    case "polygon":
      if (exact && !shape.holes?.length) return `(gr_poly (pts ${polygonItems(shape.pts.map((q) => ({ ...q, ...p(q), ...(q.mid ? { mid: p(q.mid) } : {}) }))).join(" ")}) (width ${width}) ${fill})`
      return polyOf(shape, p, width, fill)
    default:
      return null
  }
}

/** A polygon (or a rounded rectangle) as a `gr_poly`, its corners and arcs in the stored frame. */
function polyOf(shape: BoardShape, map: (v: Vec2) => Vec2, width: string, fill: string): string | null {
  const path = shapePaths(shape)[0]
  if (!path) return null
  const mapped = path.segs.map((s) => {
    switch (s.kind) {
      case "line":
        return { ...s, a: map(s.a), b: map(s.b) }
      case "arc":
        return { ...s, start: map(s.start), mid: map(s.mid), end: map(s.end) }
      default:
        return s
    }
  })
  return `(gr_poly (pts ${ringItems({ closed: true, segs: mapped }).join(" ")}) (width ${width}) ${fill})`
}

/** One pad of a part, as KiCad's pad node. */
/** What the native board writer (`kicadBoard.ts`) says about a pad that the converter's path does not: where the hole is in the footprint's file frame, exactly, and the part's pin function and type. */
export interface PadWriteOptions {
  /** X1: the board's number of copper layers, which names the inner layers of a pad and the layers of its pad stack (two when absent). */
  copperCount?: number
  /** A custom pad's polygons are written with their corners in the order the land has them. */
  exact?: boolean
  at?: Vec2
  pinfunction?: string
  pintype?: string
  /** A polygon pad that is KiCad's trapezoid, with the pad's own frame (place, turn in the file, size and delta): written as the trapezoid it was. */
  trapezoid?: Trapezoid
}

/** What KiCad stores of a trapezoid pad: its place, its turn within the footprint, its size and its `rect_delta`, in the footprint's file frame. */
export interface Trapezoid {
  at: Vec2
  /** With a hole: where the copper's centre is from the hole, in the pad's own frame (the drill's `offset`), and whether a slot runs along the pad's y (the drill is written tall). */
  offset?: Vec2
  slotAcross?: boolean
  turn: number
  w: number
  h: number
  dx: number
  dy: number
}

/**
 * The trapezoid a quadrilateral is, in the footprint's file frame (y down), when it is what KiCad's `TransformTrapezoidToPolygon` makes of a size, a delta and
 * a turn (the corners are `(-hx-dy/2, hy+dx/2)`, `(-hx+dy/2, -hy-dx/2)`, `(hx-dy/2, -hy+dx/2)` and `(hx+dy/2, hy-dx/2)` turned about the centre); null
 * for any other four points. The centre is their mean, the turn comes from the sum of the two long sides, the rest from the corners turned back.
 */
export function trapezoidOf(q: Vec2[]): Trapezoid | null {
  if (q.length !== 4) return null
  const at = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 }
  const v = q.map((p) => ({ x: p.x - at.x, y: p.y - at.y }))
  // (C3 - C0 + C2 - C1) / 2 = (2 hx, 0), turned.
  const t = { x: (v[3].x - v[0].x + v[2].x - v[1].x) / 2, y: (v[3].y - v[0].y + v[2].y - v[1].y) / 2 }
  const hx = Math.hypot(t.x, t.y) / 2
  if (hx < 1e-9) return null
  const turn = (Math.atan2(-t.y, t.x) * 180) / Math.PI
  const c = v.map((p) => turnVec(p, -turn))
  const ddy = -(c[0].x + c[2].x) / 2
  const ddx = (c[0].y + c[2].y) / 2
  const hy = (c[0].y - c[1].y) / 2 - ddx
  const want = [
    { x: -hx - ddy, y: hy + ddx },
    { x: -hx + ddy, y: -hy - ddx },
    { x: hx - ddy, y: -hy + ddx },
    { x: hx + ddy, y: hy - ddx },
  ]
  if (hy <= 0 || want.some((p, i) => Math.abs(p.x - c[i].x) > 5e-7 || Math.abs(p.y - c[i].y) > 5e-7)) return null
  return { at, turn, w: 2 * hx, h: 2 * hy, dx: 2 * ddx, dy: 2 * ddy }
}

export function writePad(def: PadDef, world: WorldPad | null, c: ComponentInstance, frame: (p: Vec2) => Vec2, footprintAngle: number, net: { code: number; name: string } | null, uuid: string, opts?: PadWriteOptions): string {
  const bottom = c.pcb.side === "bottom"
  const own = def.rot ?? 0
  const fixed = def.shape === "polygon" && !def.custom
  // The pad's own frame: the land's vectors as KiCad stores them (y down, the library's flipped on the bottom), turned by the part of the pad's turn the frame is to carry.
  const slot = def.holeDiameter !== undefined && def.slotLength !== undefined && def.slotLength > def.holeDiameter + 1e-9
  const slotAxis = def.holeAxis ?? (def.width >= def.height ? 0 : 90)
  // A slot runs along x of the pad's frame in KiCad; for a pad whose frame is not its own (a polygon) the frame is turned to it.
  const extra = slot && fixed ? slotAxis : slot && slotAxis % 90 !== 0 ? slotAxis : 0
  const store = (v: Vec2): Vec2 => turnVec({ x: v.x, y: bottom ? v.y : -v.y }, -extra)
  const trap = fixed ? opts?.trapezoid : undefined
  // A trapezoid's turn is the file's own: the footprint's angle (the editor's less half a turn on the bottom) and the pad's turn within it.
  const angle = trap ? normalizeAngle((bottom ? footprintAngle - 180 : footprintAngle) + trap.turn) : normalizeAngle((bottom ? footprintAngle - own + 180 : footprintAngle + own) + extra)
  const at = trap ? trap.at : (opts?.at ?? frame(world!.hole ?? world!))
  const type = def.plated === false ? "np_thru_hole" : def.holeDiameter !== undefined ? "thru_hole" : "smd"
  const lines: string[] = []
  // The pad as one layer has it (X1): its shape and size, and what goes with them. The pad's frame is the file's, shared by every layer, so a drawing that is in the land's frame (a polygon pad's corners) is turned into it.
  const toPadFrame = (v: Vec2, d: PadDef): Vec2 => (d.shape === "polygon" && !d.custom && own !== 0 ? turnVec({ x: v.x, y: bottom ? v.y : -v.y }, -((bottom ? -own : own) + extra)) : store(v))
  const shapeParts = (d: PadDef, t: Trapezoid | undefined): { shape: string; size: string; extras: string[] } => {
    const dFixed = d.shape === "polygon" && !d.custom
    const w = d.width
    const h = d.height
    let shape: string
    let size = `${mm6(w)} ${mm6(h)}`
    const extras: string[] = []
    const sv = (v: Vec2) => toPadFrame(v, d)
    if (t) {
      shape = "trapezoid"
      size = `${mm6(t.w)} ${mm6(t.h)}`
      extras.push(`(rect_delta ${mm6(t.dx)} ${mm6(t.dy)})`)
    } else if (d.custom || dFixed) {
      shape = "custom"
      size = dFixed ? "0.001 0.001" : `${mm6(w)} ${mm6(d.custom!.anchor === "circle" ? w : h)}`
      const anchor = d.custom?.anchor ?? "circle"
      const hull = d.custom?.hull ? " (clearance convexhull)" : ""
      extras.push(`(options (anchor ${anchor})${hull})`)
      const centre = { x: d.x, y: d.y }
      const prims: string[] = []
      if (dFixed) {
        // A polygon pad: a tiny anchor at its centre and the outline as a filled polygon, with the vectors of the land's frame.
        const pts = (d.points ?? []).map((q) => sv({ x: q.x - centre.x, y: q.y - centre.y }))
        prims.push(`(gr_poly (pts ${pts.map((q) => `(xy ${xy(q)})`).join(" ")}) (width 0) (fill yes))`)
      } else {
        for (const sh of d.custom!.shapes) {
          const b = primitiveBlock(sh, sv, opts?.exact)
          if (b) prims.push(b)
        }
        for (const sh of d.custom!.proxy ?? []) {
          const b = primitiveBlock(sh, sv, opts?.exact)
          if (b) prims.push(b.replace(/^\(gr_line/, "(gr_vector").replace(/^\(gr_rect/, "(gr_bbox").replace(/ \(width [^)]*\)/, " (width 0)"))
        }
      }
      if (prims.length) extras.push(`(primitives ${prims.join(" ")})`)
    } else if (d.shape === "circle") {
      shape = "circle"
      size = `${mm6(w)} ${mm6(w)}`
    } else if (d.shape === "pill") shape = "oval"
    else if (d.round || d.chamfer) {
      shape = "roundrect"
      extras.push(`(roundrect_rratio ${mm6(d.round ?? 0)})`)
      if (d.chamfer) {
        // The flip swapped top and bottom.
        const k = d.chamfer.corners
        const stored = bottom ? (k & 1 ? 8 : 0) | (k & 2 ? 4 : 0) | (k & 4 ? 2 : 0) | (k & 8 ? 1 : 0) : k
        const names = [stored & 1 ? "top_left" : "", stored & 2 ? "top_right" : "", stored & 8 ? "bottom_left" : "", stored & 4 ? "bottom_right" : ""].filter(Boolean)
        extras.push(`(chamfer_ratio ${mm6(d.chamfer.ratio)})`, `(chamfer ${names.join(" ")})`)
      }
    } else shape = "rect"
    return { shape, size, extras }
  }
  // X1: the pad stack. The file's front layer is the top-level shape: the part's own side, or on the bottom its far side (`PadStack`).
  const stackLayers = def.stack?.layers
  const count = opts?.copperCount ?? 2
  const variantFor = (own: CopperLayer | "inner"): PadDef => {
    const v = stackLayers?.[own as CopperLayer]
    return v ? padLayerDef(def, v) : def
  }
  const frontDef: PadDef = def.stack && bottom ? variantFor("bottom") : def
  const frontTrap = frontDef === def ? trap : undefined
  const front = shapeParts(frontDef, frontTrap)
  let { shape, size } = front
  const extras = front.extras
  // The number the file gives the pad: its own when the land keeps one.
  const number = def.number !== undefined ? def.number : (def.pin ?? "")
  lines.push(`(pad ${quote(number)} ${type} ${shape}`)
  lines.push(`  (at ${xy(at)}${angle ? ` ${mm6(angle)}` : ""})`)
  lines.push(`  (size ${size})`)
  if (def.holeDiameter !== undefined) {
    const off = def.holeOffset && (def.holeOffset.x !== 0 || def.holeOffset.y !== 0) ? def.holeOffset : null
    // KiCad's offset moves the copper from the hole: the opposite of where the land has the hole from the copper.
    const o = trap ? (trap.offset ?? null) : off ? store({ x: -off.x, y: -off.y }) : null
    // KiCad reads the two sizes as x then y of the pad's frame, so a slot across that frame (not turned into it above) is written tall.
    const across = trap ? trap.slotAcross === true : slot && extra === 0 && (((slotAxis % 180) + 180) % 180) === 90
    const drill = !slot ? mm6(def.holeDiameter) : across ? `oval ${mm6(def.holeDiameter)} ${mm6(def.slotLength!)}` : `oval ${mm6(def.slotLength!)} ${mm6(def.holeDiameter)}`
    lines.push(`  (drill ${drill}${o ? ` (offset ${xy(o)})` : ""})`)
  }
  const faces = padFaces(def)
  // Inner copper (X1): a through-hole pad with copper on both sides has every inner layer as `*.Cu` says, so only a pad that says otherwise names them.
  const innerNames = (): string[] => {
    const given = def.layers?.inner
    if (!given) return []
    return given.map((l) => kicadLayerName(bottom ? flipLayer(l, count) : l)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))
  }
  const copperNames = def.layers?.inner && faces.copper === "both" ? [kicadLayerName("top"), ...innerNames(), kicadLayerName("bottom")] : [...layerNames(faces.copper, "Cu", bottom), ...innerNames()]
  const names = [...copperNames, ...layerNames(faces.mask, "Mask", bottom), ...layerNames(faces.paste, "Paste", bottom), ...layerNames(faces.silk, "SilkS", bottom), ...(def.layers?.other ?? []).map((n) => (bottom ? flipShapeLayer(n) : n))]
  lines.push(`  (layers ${names.map(quote).join(" ")})`)
  for (const e of extras) lines.push(`  ${e}`)
  if (def.maskMargin !== undefined) lines.push(`  (solder_mask_margin ${mm6(def.maskMargin)})`)
  if (def.pasteMargin !== undefined) lines.push(`  (solder_paste_margin ${mm6(def.pasteMargin)})`)
  if (def.pasteRatio !== undefined) lines.push(`  (solder_paste_margin_ratio ${mm6(def.pasteRatio)})`)
  if (def.clearance !== undefined) lines.push(`  (clearance ${mm6(def.clearance)})`)
  if (def.zoneConnect !== undefined) lines.push(`  (zone_connect ${{ none: 0, thermal: 1, solid: 2, tht: 3 }[def.zoneConnect]})`)
  if (def.thermalWidth !== undefined) lines.push(`  (thermal_bridge_width ${mm6(def.thermalWidth)})`)
  if (def.thermalGap !== undefined) lines.push(`  (thermal_gap ${mm6(def.thermalGap)})`)
  if (def.thermalAngle !== undefined) lines.push(`  (thermal_bridge_angle ${mm6(def.thermalAngle)})`)
  if (net) lines.push(`  (net ${net.code} ${quote(net.name)})`)
  if (opts?.pinfunction !== undefined) lines.push(`  (pinfunction ${quote(opts.pinfunction)})`)
  if (opts?.pintype !== undefined) lines.push(`  (pintype ${quote(opts.pintype)})`)
  if (def.property) lines.push(`  (property pad_prop_${def.property})`)
  if (def.unused) lines.push("  (remove_unused_layers yes)", `  (keep_end_layers ${def.unused === "keepEnds" ? "yes" : "no"})`)
  if (def.tent) {
    // KiCad 9 says a pad's tenting in words, for both sides: a side that is not named is not tented. The file's front is the part's far side on the bottom.
    const f = (bottom ? def.tent.bottom : def.tent.top) === true
    const b = (bottom ? def.tent.top : def.tent.bottom) === true
    lines.push(`  (tenting${f ? " front" : ""}${b ? " back" : ""}${!f && !b ? " none" : ""})`)
  }
  lines.push(`  (uuid ${uuid})`)
  if (def.stack) {
    const centreOf = (d: PadDef): Vec2 => ({ x: d.x, y: d.y })
    const hole = { x: def.x - (def.holeOffset?.x ?? 0), y: def.y - (def.holeOffset?.y ?? 0) }
    void hole
    const layerBlock = (name: string, d: PadDef, v: NonNullable<PadDef["stack"]>["layers"][CopperLayer]): string[] => {
      const parts = shapeParts(d, undefined)
      const out = [`(layer ${quote(name)}`, `  (shape ${parts.shape})`, `  (size ${parts.size})`]
      // A layer whose copper is not centred where the pad's is has an offset from the hole, in the pad's frame.
      const dc = centreOf(d)
      const bc = centreOf(def)
      if (Math.abs(dc.x - bc.x) > 1e-9 || Math.abs(dc.y - bc.y) > 1e-9) out.push(`  (offset ${xy(store({ x: dc.x - bc.x, y: dc.y - bc.y }))})`)
      for (const e of parts.extras) out.push(`  ${e}`)
      if (v?.thermalAngle !== undefined) out.push(`  (thermal_bridge_angle ${mm6(v.thermalAngle)})`)
      if (v?.thermalGap !== undefined) out.push(`  (thermal_gap ${mm6(v.thermalGap)})`)
      if (v?.thermalWidth !== undefined) out.push(`  (thermal_bridge_width ${mm6(v.thermalWidth)})`)
      if (v?.clearance !== undefined) out.push(`  (clearance ${mm6(v.clearance)})`)
      if (v?.zoneConnect !== undefined) out.push(`  (zone_connect ${{ none: 0, thermal: 1, solid: 2, tht: 3 }[v.zoneConnect]})`)
      out.push(")")
      return out
    }
    const entry = (own: CopperLayer | "inner", fileName: string): string[] => layerBlock(fileName, variantFor(own), stackLayers?.[own as CopperLayer])
    const body: string[] = []
    if (def.stack.mode === "front_inner_back") {
      body.push("(mode front_inner_back)", ...entry("inner", "Inner"), ...entry(bottom ? "top" : "bottom", "B.Cu"))
    } else {
      body.push("(mode custom)")
      for (let k = 1; k < count; k++) {
        const board: CopperLayer = k === count - 1 ? "bottom" : (`in${k}` as CopperLayer)
        const own: CopperLayer = bottom ? flipLayer(board, count) : board
        body.push(...layerBlock(kicadLayerName(board), variantFor(own), stackLayers?.[own]))
      }
    }
    lines.push("  (padstack", ...body.map((l) => `    ${l}`), "  )")
  }
  lines.push(")")
  return lines.map((l) => `    ${l}`).join("\n")
}

export interface KicadPadsResult {
  text: string
  notes: string[]
}

/** Whether any placed part of the project has a pad that needs writing here. */
export const hasPadWork = (project: Project) => project.components.some((c) => onBoard(c) && c.pcb.placed && (componentFootprint(c)?.pads.some(hasPadFeatures) ?? false))

/**
 * The board file with the pads of every part that has X7 features written as KiCad has them (each such part's pads, all of them, in the order
 * of its land), found by reference.
 */
export function applyPads(pcb: string, project: Project): KicadPadsResult {
  if (!hasPadWork(project)) return { text: pcb, notes: [] }
  const sch = computeConnectivity(project)
  const netName = new Map(sch.nets.map((n) => [n.id, n.name]))
  const nets = new Map<string, number>()
  for (const m of pcb.matchAll(/\n {2}\(net (\d+) "((?:[^"\\]|\\.)*)"\)/g)) nets.set(m[2].replace(/\\(.)/g, "$1"), Number(m[1]))
  const added: string[] = []
  let next = Math.max(0, ...nets.values()) + 1
  const code = (name: string) => {
    let n = nets.get(name)
    if (n === undefined) {
      n = next++
      nets.set(name, n)
      added.push(`\n  (net ${n} ${quote(name)})`)
    }
    return n
  }
  let serial = 0
  const uuid = () => `00000000-0000-4000-b000-${(++serial).toString(16).padStart(12, "0")}`
  const byRef = new Map(project.components.filter((c) => onBoard(c) && c.pcb.placed).map((c) => [c.ref, c]))
  let text = pcb.replace(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const c = ref === undefined ? undefined : byRef.get(ref)
    const fp = c ? componentFootprint(c) : null
    if (!c || !fp || !fp.pads.some(hasPadFeatures)) return block
    const A = Number(block.match(/\n {4}\(at \S+ \S+(?: (\S+))?\)/)?.[1] ?? 0)
    const world = pcbPads(c)
    // The converter's frame for this footprint: a point of the board less the footprint's place, y flipped, turned back by its angle.
    const frame = localFrame(c)
    const written = fp.pads.map((def, i) => {
      const w = world[i]
      const netId = def.pin ? sch.pinNet.get(pinKey(c.id, def.pin)) : undefined
      const name = netId ? netName.get(netId) : undefined
      return writePad(def, w, c, frame, A, name ? { code: code(name), name } : null, uuid())
    })
    // The converter's pads out, ours in at the first one's place.
    let first = true
    const body = block.replace(/\n {4}\(pad\b[\s\S]*?\n {4}\)(?=\n)/g, () => {
      if (!first) return ""
      first = false
      return `\n${written.join("\n")}`
    })
    return first ? body.replace(/\n {2}\)$/, () => `\n${written.join("\n")}\n  )`) : body
  })
  if (added.length) {
    const nets2 = [...text.matchAll(/\n {2}\(net \d+ "(?:[^"\\]|\\.)*"\)/g)]
    const last = nets2[nets2.length - 1]
    if (last) text = `${text.slice(0, last.index + last[0].length)}${added.join("")}${text.slice(last.index + last[0].length)}`
  }
  return {
    text,
    notes: ["The pads of a part that has a rounded or chamfered corner, a custom shape, a hole off its centre, a turn of its own, its own layers or margins, or a number that is not its pin's are written as KiCad has them (shape, size, turn, hole, layers, margins, clearance, pour connection and number). The pad types KiCad calls connector pads are written as surface-mount pads with the layers they have."],
  }
}
