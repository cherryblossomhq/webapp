import { round } from "../../lib/geometry"
import { mountingHoles, ownTexts } from "../../model/board"
import type { SchematicConnectivity } from "../../model/connectivity"
import { isPhysical, pcbPads, pcbSilk, valueText, type WorldPad } from "../../model/instances"
import { findPart } from "../../model/library"
import { onBoard } from "../../model/partFlags"
import type { PcbAnalysis } from "../../model/pcb"
import { resolvedComponents } from "../../model/ruleAreas"
import { worldShapes } from "../../model/shapeItems"
import { arcCircle, flattenPath, shapePaths, type PathSeg, type ShapePath } from "../../model/shapes"
import { placeDesignators, SILK_WIDTH } from "../../model/silk"
import { copperLayers, viaLayers } from "../../model/stack"
import { shownOf, worldTexts } from "../../model/texts"
import type { ComponentInstance, CopperLayer, Project, Vec2, Zone } from "../../model/types"
import { viaTentedOn } from "../../model/viaRules"
import { isRuleArea, zoneLayers, zoneRings, zoneSettings } from "../../model/zones"
import { outlinePaths } from "../kicadBoard"
import { writeCfb, type CfbTree } from "./cfb"
import { Bytes, cp1252, delphiReal, mil, pcbUnits, props, propRecord, real, uniqueId, type PropValue } from "./records"

// A `.PcbDoc`: Altium's board, a compound file with a storage for each kind of object (`Board6`, `Nets6`, `Components6`, `Pads6`, `Tracks6`...), each
// holding a `Header` (the count, a u32) and a `Data` stream. The board, nets, components, classes, polygons and rules are property lists; pads, vias,
// tracks, arcs, fills, texts and regions are binary records, written in the layout Altium 13 and 14 save (a 120-byte pad, a 209-byte via, a 45-byte
// track), which every later Altium reads. The layouts are those KiCad's Altium importer reads (`pcbnew/pcb_io/altium/altium_parser_pcb.cpp`) and
// AltiumSharp writes (Apache 2.0), with the bytes neither names as Altium itself writes them.
//
// Coordinates: Altium's unit is a ten-thousandth of a mil, y up as in the editor. Everything is moved by a whole number of 100 mils so that it is
// positive, and the board's origin (ORIGINX, ORIGINY) is put where the editor's origin is, so Altium shows the coordinates the editor does.

/** Altium's layer numbers. */
export const L = {
  top: 1,
  bottom: 32,
  topOverlay: 33,
  bottomOverlay: 34,
  topPaste: 35,
  bottomPaste: 36,
  topSolder: 37,
  bottomSolder: 38,
  keepOut: 56,
  mech: (n: number) => 56 + n,
  multi: 74,
} as const

/** The Altium layer of a copper layer: the top, the inner layers in order (Mid-Layer 1 is the first), the bottom. */
export const copperLayerNumber = (layer: CopperLayer): number => (layer === "top" ? L.top : layer === "bottom" ? L.bottom : 1 + Number(layer.slice(2)))

/** What the mechanical layers hold, by KiCad's names of the layers they stand for. */
export const MECH_LAYERS: { n: number; name: string; kicad: string[] }[] = [
  { n: 1, name: "Board Outline", kicad: ["Edge.Cuts"] },
  { n: 2, name: "Top Assembly", kicad: ["F.Fab"] },
  { n: 3, name: "Bottom Assembly", kicad: ["B.Fab"] },
  { n: 4, name: "Drawings", kicad: ["Dwgs.User"] },
  { n: 5, name: "Comments", kicad: ["Cmts.User"] },
  { n: 6, name: "Margin", kicad: ["Margin"] },
  { n: 7, name: "Eco1", kicad: ["Eco1.User"] },
  { n: 8, name: "Eco2", kicad: ["Eco2.User"] },
  { n: 9, name: "Top Glue", kicad: ["F.Adhes"] },
  { n: 10, name: "Bottom Glue", kicad: ["B.Adhes"] },
  { n: 11, name: "User 1", kicad: ["User.1"] },
  { n: 12, name: "User 2", kicad: ["User.2"] },
  { n: 13, name: "User 3", kicad: ["User.3"] },
  { n: 14, name: "User 4", kicad: ["User.4"] },
  { n: 15, name: "Top Courtyard", kicad: ["F.CrtYd"] },
  { n: 16, name: "Bottom Courtyard", kicad: ["B.CrtYd"] },
]

/** The Altium layer of a drawing on a KiCad layer (`F.SilkS`, `B.Mask`, `In2.Cu`, `User.7`...), or null for one Altium has no place for. */
export function shapeLayerNumber(layer: string, copper: readonly CopperLayer[]): number | null {
  const fixed: Record<string, number> = {
    "F.Cu": L.top,
    "B.Cu": L.bottom,
    "F.SilkS": L.topOverlay,
    "B.SilkS": L.bottomOverlay,
    "F.Paste": L.topPaste,
    "B.Paste": L.bottomPaste,
    "F.Mask": L.topSolder,
    "B.Mask": L.bottomSolder,
  }
  if (fixed[layer] !== undefined) return fixed[layer]
  const inner = /^In(\d+)\.Cu$/.exec(layer)
  if (inner) return copper.includes(`in${inner[1]}` as CopperLayer) ? 1 + Number(inner[1]) : null
  const mech = MECH_LAYERS.find((m) => m.kicad.includes(layer))
  if (mech) return L.mech(mech.n)
  if (/^User\.\d+$/.test(layer)) return L.mech(14)
  return null
}

/** The redundant layer word Altium 13 and later write at the end of a primitive (KiCad's `layer_v7`). */
function v7Layer(layer: number): number {
  if (layer === 32) return 0x0100ffff
  if (layer >= 1 && layer <= 31) return 0x01000000 + layer
  if (layer >= 39 && layer <= 54) return 0x01010000 + (layer - 38)
  if (layer >= 57 && layer <= 72) return 0x01020000 + (layer - 56)
  const special: Record<number, number> = { 33: 6, 34: 7, 35: 8, 36: 9, 37: 10, 38: 11, 55: 12, 56: 13, 73: 14, 74: 15 }
  return 0x01030000 + (special[layer] ?? 15)
}

/** The layer name a property list uses (`TOP`, `MID3`, `TOPOVERLAY`, `MECHANICAL1`, `MULTILAYER`). */
export function layerName(layer: number): string {
  if (layer === 1) return "TOP"
  if (layer === 32) return "BOTTOM"
  if (layer >= 2 && layer <= 31) return `MID${layer - 1}`
  if (layer >= 57 && layer <= 72) return `MECHANICAL${layer - 56}`
  const named: Record<number, string> = { 33: "TOPOVERLAY", 34: "BOTTOMOVERLAY", 35: "TOPPASTE", 36: "BOTTOMPASTE", 37: "TOPSOLDER", 38: "BOTTOMSOLDER", 55: "DRILLGUIDE", 56: "KEEPOUT", 73: "DRILLDRAWING", 74: "MULTILAYER" }
  return named[layer] ?? "MULTILAYER"
}

const NONE = 0xffff
/** A primitive's flags: saved (0x08) and unlocked (0x04), with tenting on either side. */
const flagsOf = (o: { locked?: boolean; tentTop?: boolean; tentBottom?: boolean; keepout?: boolean } = {}) =>
  0x08 | (o.locked ? 0 : 0x04) | (o.tentTop ? 0x20 : 0) | (o.tentBottom ? 0x40 : 0) | (o.keepout ? 0x200 : 0)

export interface PcbContext {
  project: Project
  sch: SchematicConnectivity
  pcb: PcbAnalysis
  /** The Altium name of each net of the project, by net id. */
  netNames: Map<string, string>
  /** The schematic's unique id path of each component (`\ABCDEFGH`, or `\SHEETSYM\ABCDEFGH` below a sheet symbol), by component id, and the sheet it is on. */
  sources: Map<string, { uniqueId: string; sheet: string; libRef: string; description?: string }>
}

export interface PcbDocResult {
  bytes: Uint8Array
  notes: string[]
  /** What was written, for the export's notes and its tests. */
  counts: { components: number; pads: number; vias: number; tracks: number; arcs: number; texts: number; polygons: number; regions: number; nets: number }
}

/** The board of `ctx.project` as a `.PcbDoc`. */
export function writePcbDoc(ctx: PcbContext): PcbDocResult {
  const { project, pcb } = ctx
  const notes: string[] = []
  const copper = copperLayers(project.board)
  const outline = outlinePaths(project)
  const all = outline.flatMap((p) => flattenPath(p))
  const minX = Math.min(...all.map((p) => p.x), 0)
  const minY = Math.min(...all.map((p) => p.y), 0)
  // The editor's origin in Altium's frame: a whole number of 100 mils that puts the board at least 1000 mils from Altium's own origin.
  const off = { x: Math.ceil((1000 - minX / 0.0254) / 100) * 100 * 0.0254, y: Math.ceil((1000 - minY / 0.0254) / 100) * 100 * 0.0254 }
  const X = (x: number) => pcbUnits(x + off.x)
  const Y = (y: number) => pcbUnits(y + off.y)
  const milX = (x: number) => mil(x + off.x)
  const milY = (y: number) => mil(y + off.y)
  const ids = new Set<string>()

  // ---------- nets ----------
  const netIndex = new Map<string, number>()
  const netList: string[] = []
  const netOf = (name: string | null | undefined): number => {
    if (!name) return NONE
    let i = netIndex.get(name)
    if (i === undefined) {
      i = netList.length
      netList.push(name)
      netIndex.set(name, i)
    }
    return i
  }
  const nameOfId = (id: string | null | undefined) => (id && id !== "short" ? (ctx.netNames.get(id) ?? null) : null)
  const byProjectName = new Map(ctx.sch.nets.map((n) => [n.name, n.id]))
  /** The Altium name of a net the project names (a pour's, a width's, a class member's). */
  const altiumNet = (name: string) => ctx.netNames.get(byProjectName.get(name) ?? "") ?? name
  // Every named net first, in the schematic's order, so the list reads as the project's nets do.
  for (const n of ctx.sch.nets) if (n.pins.length) netOf(ctx.netNames.get(n.id))

  // ---------- components ----------
  const placed = resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c) && isPhysical(findPart(c.partId)))
  const compIndex = new Map(placed.map((c, i) => [c.id, i]))
  const designators = placeDesignators(project)
  const padItems = new Map<string, string | null>()
  for (const it of pcb.items) if (it.kind === "pad") padItems.set(`${it.pad.componentId}|${it.pad.padNumber ?? ""}|${round(it.pad.x, 4)}|${round(it.pad.y, 4)}`, nameOfId(it.netId))

  const components = new Bytes()
  for (const c of placed) {
    const part = findPart(c.partId)
    const src = ctx.sources.get(c.id)
    const top = c.pcb.side !== "bottom"
    const value = valueText(c, part)
    propRecord(
      components,
      props(
        [
          ["SELECTION", false],
          ["LAYER", top ? "TOP" : "BOTTOM"],
          ["LOCKED", false],
          ["POLYGONOUTLINE", false],
          ["USERROUTED", true],
          ["KEEPOUT", false],
          ["PRIMITIVELOCK", true],
          ["X", milX(c.pcb.x)],
          ["Y", milY(c.pcb.y)],
          ["PATTERN", c.footprint ?? part?.footprints[0] ?? c.ref],
          ["NAMEON", true],
          ["COMMENTON", false],
          ["GROUPNUM", 0],
          ["COUNT", 0],
          ["ROTATION", delphiReal(((c.pcb.rot % 360) + 360) % 360)],
          ["HEIGHT", "0mil"],
          ["NAMEAUTOPOSITION", 0],
          ["COMMENTAUTOPOSITION", 0],
          ["UNIONINDEX", 0],
          ["SOURCEDESIGNATOR", c.ref],
          ["SOURCEUNIQUEID", src?.uniqueId],
          ["SOURCEHIERARCHICALPATH", src?.sheet],
          ["SOURCEFOOTPRINTLIBRARY", "Cherry Blossom"],
          ["SOURCECOMPONENTLIBRARY", "Cherry Blossom"],
          ["SOURCELIBREFERENCE", src?.libRef ?? part?.name ?? c.ref],
          ["SOURCEDESCRIPTION", src?.description ?? part?.description ?? value],
          ["FOOTPRINTDESCRIPTION", c.footprint],
          ["UNIQUEID", uniqueId(`pcb:${c.id}`, ids)],
          ["JUMPERSVISIBLE", true],
        ],
        "long",
      ),
    )
  }

  // ---------- pads ----------
  const pads = new Bytes()
  const regions = new Bytes()
  let padCount = 0
  let regionCount = 0
  let customPads = 0
  const count = copper.length
  const writePad = (pad: WorldPad, comp: number, net: number, name: string) => {
    padCount++
    const smd = pad.holeDiameter === undefined
    const side = pad.layers.length === 1 ? pad.layers[0] : null
    const layer = smd ? (side ? copperLayerNumber(side) : L.top) : L.multi
    const hole = pad.hole ?? pad
    // A pad Altium has a shape for: round (a pill when its sides differ), a rectangle and a rounded rectangle, turned by any angle. Any other
    // outline (a polygon, a chamfer, a custom pad) is a pad as small as its hole allows with the copper as a region of the part beside it.
    const custom = pad.shape === "polygon" && !pad.oriented
    let shape = 1
    let w = pad.width
    let h = pad.height
    let rot = 0
    let corner = 0
    if (pad.oriented) {
      w = pad.oriented.width
      h = pad.oriented.height
      rot = pad.oriented.rot
      // A turned pill keeps its own shape (`x7` says what a turned pad of a land was); a turned rectangle is one.
      const own = pad.x7?.def.shape ?? pad.shape
      shape = own === "pill" || own === "circle" ? 1 : 2
      if (pad.oriented.corner) corner = pad.oriented.corner
    } else if (pad.shape === "rect") {
      shape = 2
      if (pad.corner) corner = pad.corner
    } else if (custom) {
      const d = pad.holeDiameter ? pad.holeDiameter + 0.1 : Math.max(0.05, Math.min(pad.width, pad.height) * 0.25)
      w = d
      h = d
    }
    const slot = pad.slotLength !== undefined && pad.holeDiameter !== undefined && pad.slotLength > pad.holeDiameter + 1e-6
    const offset = { x: pad.x - hole.x, y: pad.y - hole.y }
    const offsetSet = Math.abs(offset.x) > 1e-6 || Math.abs(offset.y) > 1e-6
    const roundRect = corner > 0 && shape === 2
    const extended = slot || offsetSet || roundRect
    const maskManual = pad.maskMargin !== undefined
    const pasteManual = pad.pasteMargin !== undefined
    pads.u8(2)
    pads.block((w) => w.u8(Math.min(255, cp1252(name).length)).bytes(cp1252(name).subarray(0, 255)))
    pads.block((w) => w.u8(0))
    pads.block((w) => w.u8(4).bytes(cp1252("|&|0")))
    pads.block((w) => w.u8(0))
    pads.block((r) => {
      r.u8(layer).u16(flagsOf()).u16(net).u16(NONE).u16(comp).u32(0xffffffff)
      r.i32(X(hole.x)).i32(Y(hole.y))
      for (let i = 0; i < 3; i++) r.i32(pcbUnits(w)).i32(pcbUnits(h))
      r.i32(pcbUnits(pad.holeDiameter ?? 0))
      r.u8(shape).u8(shape).u8(shape)
      r.f64(rot)
      r.u8(pad.plated === false ? 0 : 1)
      r.u8(0)
      r.u8(0) // pad mode: simple, one size and shape on every layer
      // 63 to 85: the power plane connection (relief, conductor width, entries, air gap, expansion, clearance), as Altium writes its defaults.
      r.zeros(4)
      r.u8(0).i32(pcbUnits(0.254)).u16(4).i32(pcbUnits(0.254)).i32(pcbUnits(0.508)).i32(pcbUnits(0.254))
      r.i32(pcbUnits(pad.pasteMargin ?? 0))
      r.i32(pcbUnits(pad.maskMargin ?? project.rules.maskExpansion))
      // 94 to 105: which cached values hold, and whether the paste and mask expansions follow the rules (1) or the pad (2), as Altium 14 writes them.
      r.bytes([0, 0, 0, 1, 1, 1, 1])
      r.u8(pasteManual ? 2 : 1).u8(maskManual ? 2 : 1)
      r.bytes([1, 0, 0])
      r.f64(slot ? 0 : 0) // hole rotation (106): a slot's is in the size and shape block
      r.u32(v7Layer(layer))
      r.zeros(2)
    })
    if (!extended) {
      pads.block(() => {})
      return
    }
    pads.block((r) => {
      for (let i = 0; i < 29; i++) r.i32(pcbUnits(w))
      for (let i = 0; i < 29; i++) r.i32(pcbUnits(h))
      for (let i = 0; i < 29; i++) r.u8(shape)
      r.u8(0)
      r.u8(slot ? 2 : 0)
      r.i32(pcbUnits(slot ? pad.slotLength! : 0))
      r.f64(slot ? slotAngle(pad) : 0)
      for (let i = 0; i < 32; i++) r.i32(pcbUnits(offset.x))
      for (let i = 0; i < 32; i++) r.i32(pcbUnits(offset.y))
      r.u8(roundRect ? 1 : 0)
      for (let i = 0; i < 32; i++) r.u8(roundRect ? 9 : shape)
      const pct = roundRect ? Math.max(0, Math.min(100, Math.round((corner / (Math.min(w, h) / 2)) * 100))) : 0
      for (let i = 0; i < 32; i++) r.u8(pct)
    })
    if (custom) {
      customPads++
      const rings = pad.rings ?? (pad.points ? [pad.points] : [])
      for (const l of pad.layers) {
        const cl = copperLayerNumber(l)
        writeRegion(regions, { layer: cl, net, comp, outline: rings[0], holes: rings.slice(1), x: X, y: Y })
        regionCount++
      }
    }
  }

  const padsOf = (c: ComponentInstance) => pcbPads(c, count)
  for (const c of placed) {
    const ci = compIndex.get(c.id)!
    for (const pad of padsOf(c)) {
      const net = pad.plated === false ? null : (padItems.get(`${c.id}|${pad.padNumber ?? ""}|${round(pad.x, 4)}|${round(pad.y, 4)}`) ?? null)
      writePad(pad, ci, netOf(net), pad.padNumber ?? "")
    }
  }
  for (const [i, h] of mountingHoles(project.board).entries()) {
    writePad({ componentId: "#board", pin: null, padNumber: null, shape: "circle", x: h.x, y: h.y, width: h.diameter, height: h.diameter, holeDiameter: h.drill, layers: copper as CopperLayer[] }, NONE, NONE, `MH${i + 1}`)
  }
  if (customPads) notes.push(`${customPads} pad${customPads > 1 ? "s have" : " has"} a shape Altium has no pad for (a polygon or a chamfered corner): each is a small pad at its place with its copper drawn as a region of its part on the same net, which is how Altium makes a custom pad.`)

  // ---------- vias ----------
  const vias = new Bytes()
  let viaCount = 0
  for (const v of project.vias) {
    viaCount++
    const span = viaLayers(project.board, v)
    const from = copperLayerNumber(span[0])
    const to = copperLayerNumber(span[span.length - 1])
    const net = netOf(nameOfId(pcb.viaNet.get(v.id)) ?? (v.net ? altiumNet(v.net) : null))
    const tentTop = viaTentedOn(project.rules, v, "top")
    const tentBottom = viaTentedOn(project.rules, v, "bottom")
    vias.u8(3)
    vias.block((r) => {
      r.u8(L.multi).u16(flagsOf({ locked: v.locked, tentTop, tentBottom })).u16(net).u16(NONE).u16(NONE).u32(0xffffffff)
      r.i32(X(v.x)).i32(Y(v.y))
      r.i32(pcbUnits(v.diameter)).i32(pcbUnits(v.drill))
      r.u8(from).u8(to)
      // 31 to 57: the connection to a plane (relief, air gap, entries, conductor width, expansion, clearance) and the mask, as Altium writes them.
      r.u8(2).i32(pcbUnits(0.254)).u8(4).u8(0).i32(pcbUnits(0.254)).i32(pcbUnits(0.508)).i32(pcbUnits(0.254)).i32(0).i32(pcbUnits(project.rules.maskExpansion))
      r.bytes([0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 2, 1, 1, 0, 0, 0, 0])
      for (let i = 0; i < 32; i++) r.i32(pcbUnits(v.diameter))
      r.u32(v7Layer(L.multi))
      r.zeros(2)
    })
  }
  if (project.vias.some((v) => v.kind)) notes.push("Blind and buried vias keep their first and last layer; Altium's drill pairs for them are to be set in its layer stack manager.")

  // ---------- tracks, arcs, fills ----------
  const tracks = new Bytes()
  const arcs = new Bytes()
  let trackCount = 0
  let arcCount = 0
  const track = (layer: number, a: Vec2, b: Vec2, width: number, o: { net?: number; comp?: number; locked?: boolean; keepout?: boolean } = {}) => {
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 && width <= 0) return
    trackCount++
    tracks.u8(4)
    tracks.block((r) => {
      r.u8(layer).u16(flagsOf({ locked: o.locked, keepout: o.keepout })).u16(o.net ?? NONE).u16(NONE).u16(o.comp ?? NONE).u32(0xffffffff)
      r.i32(X(a.x)).i32(Y(a.y)).i32(X(b.x)).i32(Y(b.y)).i32(pcbUnits(width))
      r.u16(0).u8(0).u32(0).u8(0).u32(v7Layer(layer))
    })
  }
  const arc = (layer: number, start: Vec2, mid: Vec2, end: Vec2, width: number, o: { net?: number; comp?: number; locked?: boolean } = {}) => {
    const circle = arcCircle(start, mid, end)
    if (!circle) {
      track(layer, start, end, width, o)
      return
    }
    // Altium's arcs run counter-clockwise from the start angle to the end angle.
    const deg = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360
    const full = Math.abs(Math.abs(circle.sweep) - 2 * Math.PI) < 1e-9
    let a0 = deg(circle.a0)
    let a1 = deg(circle.a0 + circle.sweep)
    if (circle.sweep < 0) [a0, a1] = [a1, a0]
    if (full) [a0, a1] = [0, 360]
    arcCount++
    arcs.u8(1)
    arcs.block((r) => {
      r.u8(layer).u16(flagsOf({ locked: o.locked })).u16(o.net ?? NONE).u16(NONE).u16(o.comp ?? NONE).u32(0xffffffff)
      r.i32(X(circle.c.x)).i32(Y(circle.c.y)).i32(pcbUnits(circle.r)).f64(round(a0, 9)).f64(round(a1, 9)).i32(pcbUnits(width))
      r.u16(0).u8(0).u32(0).u32(v7Layer(layer))
    })
  }
  const segs = (layer: number, path: ShapePath, width: number, o: { net?: number; comp?: number } = {}) => {
    for (const s of path.segs) seg(layer, s, width, o)
  }
  const seg = (layer: number, s: PathSeg, width: number, o: { net?: number; comp?: number } = {}) => {
    if (s.kind === "line") track(layer, s.a, s.b, width, o)
    else if (s.kind === "arc") arc(layer, s.start, s.mid, s.end, width, o)
    else {
      const pts = flattenPath({ closed: false, segs: [s] })
      for (let i = 0; i + 1 < pts.length; i++) track(layer, pts[i], pts[i + 1], width, o)
    }
  }

  for (const t of project.traces) {
    const layer = copperLayerNumber(t.layer)
    const net = netOf(nameOfId(pcb.traceNet.get(t.id)) ?? (t.net ? altiumNet(t.net) : null))
    if (t.arc && t.points.length === 3) arc(layer, t.points[0], t.points[1], t.points[2], t.width, { net, locked: t.locked })
    else for (let i = 0; i + 1 < t.points.length; i++) track(layer, t.points[i], t.points[i + 1], t.width, { net, locked: t.locked })
  }

  // The parts' silkscreen as the editor draws it, and every drawing of a land or of the board on a layer Altium has.
  const unplacedLayers = new Set<string>()
  for (const c of placed) {
    const ci = compIndex.get(c.id)!
    const layer = c.pcb.side === "bottom" ? L.bottomOverlay : L.topOverlay
    for (const path of pcbSilk(c)) for (let i = 0; i + 1 < path.length; i++) track(layer, path[i], path[i + 1], SILK_WIDTH, { comp: ci })
  }
  for (const ws of worldShapes(project)) {
    if (!ws.placed) continue
    const comp = ws.owner === "#board" ? NONE : (compIndex.get(ws.owner) ?? null)
    if (comp === null) continue
    const shape = ws.shape
    const layer = shapeLayerNumber(shape.layer, copper)
    if (layer === null) {
      unplacedLayers.add(shape.layer)
      continue
    }
    if (shape.layer === "Edge.Cuts" && ws.owner === "#board") continue
    const net = shape.net ? netOf(altiumNet(shape.net)) : NONE
    const paths = shapePaths(shape)
    if (shape.fill && shape.type !== "line" && shape.type !== "arc") {
      const rings = paths.filter((p) => p.closed).map((p) => flattenPath(p))
      if (rings.length) {
        writeRegion(regions, { layer, net, comp, outline: rings[0], holes: rings.slice(1), x: X, y: Y })
        regionCount++
      }
    }
    if (shape.width > 0 || !shape.fill) for (const p of paths) segs(layer, p, Math.max(shape.width, 0), { net, comp })
  }
  if (unplacedLayers.size) notes.push(`Drawings on ${[...unplacedLayers].sort().join(", ")} have no Altium layer and are left out.`)

  // ---------- texts ----------
  const texts = new Bytes()
  const wide = new Bytes()
  let textCount = 0
  const text = (o: { layer: number; at: Vec2; height: number; rot: number; mirror: boolean; stroke: number; content: string; comp: number; designator?: boolean; comment?: boolean }) => {
    const index = textCount++
    texts.u8(5)
    texts.block((r) => {
      r.u8(o.layer).u16(flagsOf()).u16(NONE).u16(NONE).u16(o.comp).u32(0xffffffff)
      r.i32(X(o.at.x)).i32(Y(o.at.y)).i32(pcbUnits(o.height))
      r.u16(1) // the stroke font: Default
      r.f64(round(((o.rot % 360) + 360) % 360, 9))
      r.u8(o.mirror ? 1 : 0)
      r.i32(pcbUnits(o.stroke))
      r.u8(o.comment ? 1 : 0).u8(o.designator ? 1 : 0).u8(0).u8(0).u8(0).u8(0)
      r.bytes(fontName("Arial"))
      r.u8(0).i32(pcbUnits(0.508)).u32(index).u32(0).u8(0).i32(0).i32(0).u8(5).i32(pcbUnits(0.0508))
      r.i32(0).i32(0).i32(pcbUnits(0.508)).i32(pcbUnits(0.508)).i32(0).u8(0).u8(0).u8(0).u8(0)
      r.bytes(fontName("Arial"))
      r.u8(0).u32(v7Layer(o.layer))
    })
    const legacy = cp1252(o.content).subarray(0, 255)
    texts.block((r) => r.u8(legacy.length).bytes(legacy))
    const utf16 = new Uint8Array((o.content.length + 1) * 2)
    for (let i = 0; i < o.content.length; i++) {
      utf16[i * 2] = o.content.charCodeAt(i) & 0xff
      utf16[i * 2 + 1] = o.content.charCodeAt(i) >> 8
    }
    wide.u32(index).u32(utf16.length).bytes(utf16)
  }

  const kicadTexts = new Set(worldTexts(project).filter((t) => t.kind !== "board").map((t) => t.owner))
  for (const c of placed) {
    const ci = compIndex.get(c.id)!
    const bottom = c.pcb.side === "bottom"
    const d = designators.get(c.id)
    if (d && !kicadTexts.has(c.id)) {
      // Altium places a stroke text by the bottom-left corner of its line, before it is turned and mirrored.
      const at = d.rot === 90 ? { x: d.box.maxX - SILK_WIDTH / 2, y: d.box.minY + SILK_WIDTH / 2 } : { x: bottom ? d.box.maxX - SILK_WIDTH / 2 : d.box.minX + SILK_WIDTH / 2, y: d.box.minY + SILK_WIDTH / 2 }
      text({ layer: bottom ? L.bottomOverlay : L.topOverlay, at, height: d.size, rot: d.rot, mirror: bottom, stroke: SILK_WIDTH, content: c.ref, comp: ci, designator: true })
    }
    if (!kicadTexts.has(c.id)) text({ layer: bottom ? L.bottomOverlay : L.topOverlay, at: { x: c.pcb.x, y: c.pcb.y }, height: 1, rot: 0, mirror: bottom, stroke: SILK_WIDTH, content: valueText(c) || (findPart(c.partId)?.name ?? ""), comp: ci, comment: true })
  }
  for (const wt of worldTexts(project)) {
    if (!wt.placed || wt.hidden) continue
    const comp = wt.owner === "#board" ? NONE : (compIndex.get(wt.owner) ?? null)
    if (comp === null) continue
    const layer = shapeLayerNumber(wt.layer, copper)
    if (layer === null) continue
    const content = shownOf(project, wt)
    if (!content) continue
    // KiCad places a text by its justification; Altium by the bottom-left of its line: move the anchor by the text's own width and height.
    const width = content.length * wt.w * 0.9
    const dx = wt.hj === 0 ? -width / 2 : wt.hj === 1 ? -width : 0
    const dy = wt.vj === 0 ? -wt.size / 2 : wt.vj === -1 ? -wt.size : 0
    const a = (wt.drawRot * Math.PI) / 180
    const sx = wt.mirror ? -1 : 1
    const at = { x: wt.x + sx * (dx * Math.cos(a) - dy * Math.sin(a)), y: wt.y + dx * Math.sin(a) + dy * Math.cos(a) }
    text({ layer, at, height: wt.size, rot: wt.drawRot, mirror: wt.mirror, stroke: wt.thickness, content, comp, designator: wt.kind === "reference", comment: wt.kind === "value" })
  }
  for (const t of ownTexts(project)) {
    const layer = t.side === "bottom" ? L.bottomOverlay : L.topOverlay
    text({ layer, at: { x: t.x, y: t.y }, height: t.size, rot: (t as { rot?: number }).rot ?? 0, mirror: t.side === "bottom", stroke: Math.max(0.15, t.size * 0.14), content: t.text, comp: NONE })
  }

  // ---------- pours ----------
  const polygons = new Bytes()
  let polygonCount = 0
  const pourZones = project.zones.filter((z) => !isRuleArea(z) && zoneLayers(z).length)
  const boardRing = flattenPath(outline[0] ?? { closed: true, segs: [] })
  // Altium pours polygons in the order of their pour index, and a later one keeps clear of an earlier one: the editor's higher priority is poured first.
  const pourOrder = new Map([...pourZones].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).map((z, i) => [z.id, i]))
  for (const z of pourZones) {
    const set = zoneSettings(project, z)
    const rings = z.outline ? zoneRings(z) : [boardRing]
    const ring = rings[0]
    if (!ring || ring.length < 3) continue
    const netName = z.net ? altiumNet(z.net) : ""
    const net = netName ? netOf(netName) : NONE
    for (const layer of zoneLayers(z)) {
      const index = polygonCount++
      const pairs: [string, PropValue][] = [
        ["SELECTION", false],
        ["LAYER", layerName(copperLayerNumber(layer))],
        ["LOCKED", !!z.locked],
        ["POLYGONOUTLINE", false],
        ["USERROUTED", true],
        ["KEEPOUT", false],
        ["UNIONINDEX", 0],
        ["PRIMITIVELOCK", true],
        ["POLYGONTYPE", "Polygon"],
        ["POUROVER", true],
        ["REMOVEDEAD", set.islands !== "never"],
        ["GRIDSIZE", mil(0.254)],
        ["TRACKWIDTH", mil(Math.max(0.0254, set.minWidth))],
        ["HATCHSTYLE", z.hatch ? "90Degree" : "Solid"],
        ["USEOCTAGONS", false],
        ["MINPRIMLENGTH", mil(0.0762)],
      ]
      ring.forEach((p, i) => pairs.push([`KIND${i}`, 0], [`VX${i}`, milX(p.x)], [`VY${i}`, milY(p.y)], [`CX${i}`, "0mil"], [`CY${i}`, "0mil"], [`SA${i}`, delphiReal(0)], [`EA${i}`, delphiReal(0)], [`R${i}`, "0mil"]))
      pairs.push(
        ["SHELVED", false],
        ["RESTORELAYER", layerName(copperLayerNumber(layer))],
        ["REMOVEISLANDSBYAREA", typeof set.islands === "number"],
        ["REMOVENECKS", true],
        ["AREATHRESHOLD", typeof set.islands === "number" ? real((set.islands / 0.0254 / 0.0254) * 1e8, 6) : "250000000000.000000"],
        ["ARCRESOLUTION", "0.5mil"],
        ["NECKWIDTHTHRESHOLD", mil(Math.max(0.0254, set.minWidth))],
        ["POUROVERSTYLE", 1],
        ["RESTORENET", netName],
        // Altium writes a polygon's name as the numbers of its characters.
        ["NAME", [...polygonName(z, netName, layer)].map((ch) => ch.charCodeAt(0)).join(",")],
        ["POURINDEX", pourOrder.get(z.id) ?? 0],
        ["IGNOREVIOLATIONS", false],
        ["NET", net === NONE ? undefined : net],
      )
      propRecord(polygons, props(pairs, "long"))
      // The copper the editor filled it with, as the regions of the polygon, so the board shows poured as it is; Altium repours it by its own rules on request.
      for (const fill of pcb.zoneFills) {
        if (fill.zoneId !== z.id || fill.layer !== layer) continue
        for (const poly of fill.polygons) {
          if (!poly[0] || poly[0].length < 3) continue
          writeRegion(regions, { layer: copperLayerNumber(layer), net, comp: NONE, polygon: index, outline: poly[0], holes: poly.slice(1), x: X, y: Y })
          regionCount++
        }
      }
    }
  }
  if (pourZones.length) notes.push("Pours are Altium polygons with their outline, net, layer and priority, filled as Cherry Blossom filled them; repour them in Altium (Tools, Polygon Pours, Repour All) to fill them by its rules.")
  const keepouts = project.zones.filter((z) => isRuleArea(z))
  for (const z of keepouts) {
    const rings = zoneRings(z)
    if (!rings[0]) continue
    for (const layer of zoneLayers(z).length ? zoneLayers(z) : (["top"] as CopperLayer[])) {
      writeRegion(regions, { layer: copperLayerNumber(layer), net: NONE, comp: NONE, outline: rings[0], holes: rings.slice(1), x: X, y: Y, keepout: true })
      regionCount++
    }
  }
  // Holes in the board are board cutouts.
  for (const path of outline.slice(1)) {
    if (!path.closed) continue
    const ring = flattenPath(path)
    if (ring.length < 3) continue
    writeRegion(regions, { layer: L.multi, net: NONE, comp: NONE, outline: ring, holes: [], x: X, y: Y, cutout: true })
    regionCount++
  }

  // ---------- the board ----------
  const board = new Bytes()
  propRecord(board, boardProps(project, outline[0], { milX, milY, off }), 0)

  // ---------- classes and rules ----------
  const classes = new Bytes()
  let classCount = 0
  for (const cls of project.rules.netClasses ?? []) {
    const members = cls.nets.map(altiumNet).filter((n) => netIndex.has(n))
    const pairs: [string, PropValue][] = [
      ["SELECTION", false],
      ["LAYER", "TOP"],
      ["LOCKED", false],
      ["POLYGONOUTLINE", false],
      ["USERROUTED", true],
      ["KEEPOUT", false],
      ["UNIONINDEX", 0],
      ["NAME", cls.name],
      ["KIND", 0],
      ["SUPERCLASS", false],
      ...members.map((m, i): [string, PropValue] => [`M${i}`, m]),
      ["SELECTED", false],
      ["UNIQUEID", uniqueId(`class:${cls.name}`, ids)],
    ]
    propRecord(classes, props(pairs, "long"))
    classCount++
  }
  const { bytes: rules, count: ruleCount } = rulesData(project, ids, pourZones, altiumNet)

  const nets = new Bytes()
  for (const name of netList) {
    propRecord(
      nets,
      props(
        [
          ["SELECTION", false],
          ["LAYER", "TOP"],
          ["LOCKED", false],
          ["POLYGONOUTLINE", false],
          ["USERROUTED", true],
          ["KEEPOUT", false],
          ["UNIONINDEX", 0],
          ["PRIMITIVELOCK", false],
          ["NAME", name],
          ["VISIBLE", true],
          ["COLOR", 65535],
          ["LOOPREMOVAL", true],
          ["OVERRIDECOLORFORDRAW", false],
          ["UNIQUEID", uniqueId(`net:${name}`, ids)],
        ],
        "long",
      ),
    )
  }

  const header = (n: number) => new Bytes().u32(n).done()
  const storage = (n: number, data: Uint8Array): CfbTree => ({ Header: header(n), Data: data })
  const fileHeader = new Bytes().u32(19).bytes(utf16le("PCB 5.0 Bi")).done()
  const sixText = cp1252("PCB 6.0 Binary File")
  const fileHeaderSix = new Bytes().u32(sixText.length).u8(sixText.length).bytes(sixText).done()
  const tree: CfbTree = {
    FileHeader: fileHeader,
    FileHeaderSix: fileHeaderSix,
    Board6: storage(1, board.done()),
    Nets6: storage(netList.length, nets.done()),
    Classes6: storage(classCount, classes.done()),
    Components6: storage(placed.length, components.done()),
    Rules6: storage(ruleCount, rules),
    Polygons6: storage(polygonCount, polygons.done()),
    Pads6: storage(padCount, pads.done()),
    Vias6: storage(viaCount, vias.done()),
    Tracks6: storage(trackCount, tracks.done()),
    Arcs6: storage(arcCount, arcs.done()),
    Fills6: storage(0, new Uint8Array(0)),
    Texts6: storage(textCount, texts.done()),
    WideStrings6: storage(textCount, wide.done()),
    Regions6: storage(regionCount, regions.done()),
    ShapeBasedRegions6: storage(0, new Uint8Array(0)),
    ComponentBodies6: storage(0, new Uint8Array(0)),
    Dimensions6: storage(0, new Uint8Array(0)),
    DifferentialPairs6: storage(0, new Uint8Array(0)),
    Connections6: storage(0, new Uint8Array(0)),
    Coordinates6: storage(0, new Uint8Array(0)),
    EmbeddedFonts6: storage(0, new Uint8Array(0)),
  }
  notes.push("3D models are not in the board: a part's 3D body is Altium's own, from its libraries.")
  return {
    bytes: writeCfb(tree),
    notes,
    counts: { components: placed.length, pads: padCount, vias: viaCount, tracks: trackCount, arcs: arcCount, texts: textCount, polygons: polygonCount, regions: regionCount, nets: netList.length },
  }
}

/** The name of a pour's polygon on `layer`: what its NAME holds and a rule's `InNamedPolygon` names it by. */
const polygonName = (z: Zone, netName: string, layer: CopperLayer) => z.name ?? `${netName || "NoNet"}_${layerName(copperLayerNumber(layer))}`

/** The angle of a slotted hole's axis, degrees. */
function slotAngle(pad: WorldPad): number {
  if (pad.slotAxis !== undefined) return pad.slotAxis
  const w = pad.oriented?.width ?? pad.width
  const h = pad.oriented?.height ?? pad.height
  return (w >= h ? 0 : 90) + (pad.oriented?.rot ?? 0)
}

const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff
    out[i * 2 + 1] = s.charCodeAt(i) >> 8
  }
  return out
}

/** A font name as a text record holds it: 32 UTF-16 characters, the rest zeros. */
const fontName = (name: string) => {
  const out = new Uint8Array(64)
  out.set(utf16le(name).subarray(0, 62))
  return out
}

/** A region: copper (or a keep-out, or a board cutout) of one outline with holes, its vertices as doubles in Altium's unit. */
function writeRegion(
  w: Bytes,
  o: { layer: number; net: number; comp: number; polygon?: number; outline: Vec2[]; holes: Vec2[][]; x: (x: number) => number; y: (y: number) => number; keepout?: boolean; cutout?: boolean },
) {
  const holes = o.holes.filter((h) => h.length >= 3)
  w.u8(11)
  w.block((r) => {
    r.u8(o.layer).u16(flagsOf({ keepout: o.keepout })).u16(o.net).u16(o.polygon ?? NONE).u16(o.comp).u32(0xffffffff)
    r.u8(0).u16(holes.length).u16(0)
    const list = props(
      [
        ["V7_LAYER", layerName(o.layer)],
        ["NAME", " "],
        ["KIND", 0],
        ["SUBPOLYINDEX", o.polygon !== undefined ? 0 : -1],
        ["UNIONINDEX", 0],
        ["ARCRESOLUTION", "0.5mil"],
        ["ISSHAPEBASED", false],
        ["CAVITYHEIGHT", "0mil"],
        ...(o.cutout ? ([["ISBOARDCUTOUT", true]] as [string, PropValue][]) : []),
        ...(o.keepout ? ([["KEEPOUTRESTRICTIONS", 31]] as [string, PropValue][]) : []),
      ],
      "long",
      "",
    )
    r.u32(list.length + 1).bytes(list).u8(0)
    const vertices = (ring: Vec2[]) => {
      r.u32(ring.length)
      for (const p of ring) r.f64(o.x(p.x)).f64(o.y(p.y))
    }
    vertices(o.outline)
    for (const h of holes) vertices(h)
  })
}

/** Board6: the board's file facts, its origin, the outline as its shape, and the layer stack, top to bottom, linked by each layer's PREV and NEXT. */
function boardProps(project: Project, shapePath: ShapePath | undefined, at: { milX: (x: number) => string; milY: (y: number) => string; off: Vec2 }): Uint8Array {
  const copper = copperLayers(project.board)
  const numbers = copper.map(copperLayerNumber)
  const stack = project.board.stack
  const thickness = project.board.thickness
  const coreHeight = Math.max(0.05, (thickness - copper.length * 0.035) / Math.max(1, copper.length - 1))
  const pairs: [string, PropValue][] = [
    ["SELECTION", false],
    ["LAYER", "UNKNOWN"],
    ["LOCKED", false],
    ["POLYGONOUTLINE", false],
    ["USERROUTED", true],
    ["KEEPOUT", false],
    ["UNIONINDEX", 0],
    ["FILENAME", `${project.name}.PcbDoc`],
    ["KIND", "Protel_Advanced_PCB"],
    ["VERSION", "5.01"],
    ["ORIGINX", mil(at.off.x)],
    ["ORIGINY", mil(at.off.y)],
    ["BIGVISIBLEGRIDSIZE", "10000000.000"],
    ["VISIBLEGRIDSIZE", "100000.000"],
    ["SNAPGRIDSIZE", "50000.000000"],
    ["SNAPGRIDSIZEX", "50000.000000"],
    ["SNAPGRIDSIZEY", "50000.000000"],
    ["COMPONENTGRIDSIZE", "50000.000000"],
    ["COMPONENTGRIDSIZEX", "50000.000000"],
    ["COMPONENTGRIDSIZEY", "50000.000000"],
    ["ELECTRICALGRIDRANGE", "8mil"],
    ["ELECTRICALGRIDENABLED", true],
    ["DOTGRID", false],
    ["DISPLAYUNIT", 0],
  ]
  // The board's shape: the first path of the outline, its lines and arcs as Altium's vertices (KIND 1 is an arc, by its centre, radius and angles).
  const vertices: { x: number; y: number; arc?: { c: Vec2; r: number; sa: number; ea: number } }[] = []
  for (const s of shapePath?.segs ?? []) {
    if (s.kind === "line") vertices.push({ x: s.a.x, y: s.a.y })
    else if (s.kind === "arc") {
      const c = arcCircle(s.start, s.mid, s.end)
      if (!c) {
        vertices.push({ x: s.start.x, y: s.start.y })
        continue
      }
      const deg = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360
      let sa = deg(c.a0)
      let ea = deg(c.a0 + c.sweep)
      if (c.sweep < 0) [sa, ea] = [ea, sa]
      vertices.push({ x: s.start.x, y: s.start.y, arc: { c: c.c, r: c.r, sa, ea } })
    } else for (const p of flattenPath({ closed: false, segs: [s] }).slice(0, -1)) vertices.push(p)
  }
  if (vertices.length) vertices.push({ ...vertices[0], arc: undefined })
  vertices.forEach((v, i) =>
    pairs.push(
      [`KIND${i}`, v.arc ? 1 : 0],
      [`VX${i}`, at.milX(v.x)],
      [`VY${i}`, at.milY(v.y)],
      [`CX${i}`, v.arc ? at.milX(v.arc.c.x) : "0mil"],
      [`CY${i}`, v.arc ? at.milY(v.arc.c.y) : "0mil"],
      [`SA${i}`, delphiReal(v.arc ? round(v.arc.sa, 9) : 0)],
      [`EA${i}`, delphiReal(v.arc ? round(v.arc.ea, 9) : 0)],
      [`R${i}`, v.arc ? mil(v.arc.r) : "0mil"],
    ),
  )
  pairs.push(["SHEETX", "1000mil"], ["SHEETY", "1000mil"], ["SHEETWIDTH", "10000mil"], ["SHEETHEIGHT", "8000mil"], ["SHOWSHEET", false], ["LOCKSHEET", true])
  pairs.push(["LAYERSETSCOUNT", 1], ["LAYERPAIR0LOW", "TOP"], ["LAYERPAIR0HIGH", "BOTTOM"], ["LAYERPAIR0DRILLGUIDE", false], ["LAYERPAIR0DRILLDRAWING", false])
  // The legacy layer list, every layer Altium has, with the copper linked top to bottom (PREV and NEXT are layer numbers, 0 at either end) and
  // each copper layer's thickness and the dielectric under it.
  const names: Record<number, string> = { 33: "Top Overlay", 34: "Bottom Overlay", 35: "Top Paste", 36: "Bottom Paste", 37: "Top Solder", 38: "Bottom Solder", 55: "Drill Guide", 56: "Keep-Out Layer", 73: "Drill Drawing", 74: "Multi-Layer" }
  for (let n = 1; n <= 74; n++) {
    const ci = numbers.indexOf(n)
    const name = n === 1 ? "Top Layer" : n === 32 ? "Bottom Layer" : n <= 31 ? `Mid-Layer ${n - 1}` : n >= 39 && n <= 54 ? `Internal Plane ${n - 38}` : n >= 57 && n <= 72 ? (MECH_LAYERS.find((m) => m.n === n - 56)?.name ?? `Mechanical ${n - 56}`) : names[n]
    const row = stack?.rows?.find((r) => /core|prepreg|dielectric/i.test(r.type))
    pairs.push(
      [`LAYER${n}NAME`, name],
      [`LAYER${n}PREV`, ci > 0 ? numbers[ci - 1] : 0],
      [`LAYER${n}NEXT`, ci >= 0 && ci + 1 < numbers.length ? numbers[ci + 1] : 0],
      [`LAYER${n}MECHENABLED`, n >= 57 && n <= 72],
      [`LAYER${n}COPTHICK`, mil(project.board.copperWeight === 2 ? 0.07 : 0.035)],
      [`LAYER${n}DIELTYPE`, ci >= 0 && ci + 1 < numbers.length ? (ci % 2 === 0 ? 1 : 2) : 0],
      [`LAYER${n}DIELCONST`, real(row?.epsilonR ?? 4.5, 3)],
      [`LAYER${n}DIELHEIGHT`, mil(row?.thickness ?? coreHeight)],
      [`LAYER${n}DIELMATERIAL`, row?.material ?? "FR-4"],
    )
    if (n >= 57 && n <= 72 && n === 57) pairs.push([`LAYER${n}MECHKIND`, "BoardShape"])
  }
  pairs.push(["TOPTYPE", 3], ["TOPCONST", "3.500"], ["TOPHEIGHT", "0.4mil"], ["TOPMATERIAL", "Solder Resist"], ["BOTTOMTYPE", 3], ["BOTTOMCONST", "3.500"], ["BOTTOMHEIGHT", "0.4mil"], ["BOTTOMMATERIAL", "Solder Resist"])
  pairs.push(["LAYERSTACKSTYLE", 0], ["SHOWTOPDIELECTRIC", false], ["SHOWBOTTOMDIELECTRIC", false])
  return props(pairs, "long")
}

/**
 * Rules6: the design rules as Altium rules, the board's own first, then a width and a clearance for each net class, which outrank them. `pours` are the
 * zones written as polygons, and `altiumNet` the Altium name of a net the project names.
 */
function rulesData(project: Project, ids: Set<string>, pours: Zone[], altiumNet: (name: string) => string): { bytes: Uint8Array; count: number } {
  const r = project.rules
  const w = new Bytes()
  let count = 0
  const rule = (kind: number, name: string, ruleKind: string, scope1: string, body: [string, PropValue][], o: { priority?: number; scope2?: string; netScope?: string } = {}) => {
    count++
    const list = props(
      [
        ["SELECTION", false],
        ["LAYER", "TOP"],
        ["LOCKED", false],
        ["POLYGONOUTLINE", false],
        ["USERROUTED", true],
        ["KEEPOUT", false],
        ["UNIONINDEX", 0],
        ["RULEKIND", ruleKind],
        ["NETSCOPE", o.netScope ?? "AnyNet"],
        ["LAYERKIND", "SameLayer"],
        ["SCOPE1EXPRESSION", scope1],
        ["SCOPE2EXPRESSION", o.scope2 ?? "All"],
        ["NAME", name],
        ["ENABLED", true],
        ["PRIORITY", o.priority ?? 1],
        ["COMMENT", ""],
        ["UNIQUEID", uniqueId(`rule:${name}`, ids)],
        ["DEFINEDBYLOGICALDOCUMENT", false],
        ...body,
      ],
      "long",
    )
    w.u16(kind).u32(list.length + 1).bytes(list).u8(0)
  }
  const classes = r.netClasses ?? []
  // Altium's priority 1 is the highest. A pour keeps its own clearance from everything (the editor fills it so), then a net class's clearance outranks the board's.
  const pourGaps = [...new Set(pours.filter((z) => z.clearance !== undefined).map((z) => z.clearance!))]
  let p = 1
  const clearance = (name: string, scope1: string, gap: number, scope2 = "All") =>
    rule(0, name, "Clearance", scope1, [["GAP", mil(gap)], ["GENERICCLEARANCE", mil(gap)], ["IGNOREPADTOPADCLEARANCEINFOOTPRINT", false]], { priority: p++, netScope: "DifferentNets", scope2 })
  for (const gap of pourGaps) {
    // Each polygon by the name it is written with, one per layer of its zone.
    const names = new Set(pours.filter((z) => z.clearance === gap).flatMap((z) => zoneLayers(z).map((layer) => polygonName(z, z.net ? altiumNet(z.net) : "", layer))))
    clearance(`Clearance_Pour_${real(gap / 0.0254, 2)}mil`, [...names].map((n) => `InNamedPolygon('${n}')`).join(" Or "), gap)
  }
  clearance("Clearance_Pours", "IsPolygon", r.pourClearance)
  for (const c of classes) if (c.clearance !== undefined) clearance(`Clearance_${c.name}`, `InNetClass('${c.name}')`, c.clearance)
  clearance("Clearance", "All", r.clearance)
  rule(63, "BoardOutlineClearance", "BoardOutlineClearance", "All", [["GAP", mil(r.edgeClearance)], ["GENERICCLEARANCE", mil(r.edgeClearance)], ["IGNOREPADTOPADCLEARANCEINFOOTPRINT", false]], { netScope: "DifferentNets" })
  // A net's own width outranks its class's, as the router takes it (`netWidths[name] ?? classWidth(name)`).
  const netWidths = Object.entries(r.netWidths ?? {}).map(([net, width]) => [altiumNet(net), width] as const)
  netWidths.forEach(([net, width], i) => rule(2, `Width_${net}`, "Width", `InNet('${net}')`, [["MAXLIMIT", mil(Math.max(width, 5))], ["MINLIMIT", mil(r.minTraceWidth)], ["PREFEREDWIDTH", mil(width)]], { priority: i + 1 }))
  const widthClasses = classes.filter((c) => c.traceWidth !== undefined)
  widthClasses.forEach((c, i) => rule(2, `Width_${c.name}`, "Width", `InNetClass('${c.name}')`, [["MAXLIMIT", mil(Math.max(c.traceWidth!, 5))], ["MINLIMIT", mil(r.minTraceWidth)], ["PREFEREDWIDTH", mil(c.traceWidth!)]], { priority: netWidths.length + i + 1 }))
  rule(2, "Width", "Width", "All", [["MAXLIMIT", mil(5)], ["MINLIMIT", mil(r.minTraceWidth)], ["PREFEREDWIDTH", mil(r.traceWidth)]], { priority: widthClasses.length + netWidths.length + 1 })
  rule(11, "RoutingVias", "RoutingVias", "All", [["HOLEWIDTH", mil(r.viaDrill)], ["WIDTH", mil(r.viaDiameter)], ["VIASTYLE", "Through Hole"], ["MINHOLEWIDTH", mil(r.minViaDrill ?? r.minDrill)], ["MINWIDTH", mil(r.minViaDiameter ?? r.viaDiameter)], ["MAXHOLEWIDTH", mil(Math.max(r.viaDrill, 1))], ["MAXWIDTH", mil(Math.max(r.viaDiameter, 2))]])
  rule(42, "HoleSize", "HoleSize", "All", [["ABSOLUTEVALUES", true], ["MAXLIMIT", mil(6.35)], ["MINLIMIT", mil(r.minDrill)], ["MAXPERCENT", "80.000"], ["MINPERCENT", "20.000"]])
  rule(52, "HoleToHoleClearance", "HoleToHoleClearance", "All", [["GAP", mil(r.holeClearance)], ["ALLOWSTACKEDMICROVIAS", true]])
  rule(13, "SolderMaskExpansion", "SolderMaskExpansion", "All", [["EXPANSION", mil(r.maskExpansion)]])
  rule(14, "PasteMaskExpansion", "PasteMaskExpansion", "All", [["EXPANSION", mil(r.pasteExpansion)]])
  const relief = r.thermalRelief !== "direct"
  rule(20, "PolygonConnect", "PolygonConnect", "All", [["CONNECTSTYLE", relief ? "Relief" : "Direct"], ["RELIEFCONDUCTORWIDTH", mil(r.thermalSpokeWidth)], ["RELIEFENTRIES", r.thermalSpokes], ["POLYGONRELIEFANGLE", r.thermalSpokeAngle === 45 ? "45 Angle" : "90 Angle"], ["AIRGAPWIDTH", mil(r.thermalGap ?? r.pourClearance)]])
  rule(6, "PlaneConnect", "PlaneConnect", "All", [["PLANECONNECTSTYLE", "Relief"], ["RELIEFEXPANSION", mil(0.508)], ["RELIEFENTRIES", 4], ["RELIEFCONDUCTORWIDTH", mil(0.254)], ["RELIEFAIRGAP", mil(0.254)]])
  rule(12, "PlaneClearance", "PlaneClearance", "All", [["CLEARANCE", mil(r.pourClearance)]])
  rule(15, "ShortCircuit", "ShortCircuit", "All", [["ALLOWED", false]])
  rule(16, "UnRoutedNet", "UnRoutedNet", "All", [])
  return { bytes: w.done(), count }
}
