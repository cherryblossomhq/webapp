import { normalizeAngle, round } from "../lib/geometry"
import { computeConnectivity, pinKey } from "../model/connectivity"
import { componentFootprint } from "../model/instances"
import { findPart } from "../model/library"
import { kicadAttributes, onBoard } from "../model/partFlags"
import { derivedCopperNets } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import { flipShapeLayer } from "../model/shapeLayers"
import { BOARD_SHAPE_OWNER } from "../model/shapeItems"
import { flattenPath, mapShape, type PathSeg, type ShapePath } from "../model/shapes"
import { componentTexts, shownOf, textBoxCorners, worldTexts, isDimensionText, type WorldText } from "../model/texts"
import type { BoardDimension, BoardShape, ComponentInstance, FootprintDef, PadDef, PartText, PcbGroup, PinDef, Project, Vec2 } from "../model/types"
import type { Model3D } from "../model/types"
import { drawing, type Out } from "./kicadShapes"
import { effects, quote } from "./kicadTexts"
import { writePad } from "./kicadPads"
import { dimensionBlock, groupBlock, imageBlock } from "./kicadObjects"
import { zoneText } from "./kicadZones"
import { isWholeBoardPour } from "../model/zones"
import { rotate90 } from "../lib/geometry"

// A `.kicad_pcb` written natively, in KiCad 9's format (stamp 20241229, `generator "pcbnew"`), for a project that came from a KiCad board
// (X16). The converter path (`kicad.ts`) goes through Circuit JSON, which has no inner layers, outline arcs, keepouts, graphics, padless
// footprints, rounded pads or arc tracks, and then edits text; this writer says each item as KiCad has it, so the board reads back as the
// project it came from. Every number is as the project has it (a nanometre, KiCad's own unit), in the file's frame: x as it is, y negated,
// with no page offset, so the importer reads each place back where it was.
//
// A footprint's own frame is the library's, unturned and (for a part on the bottom) flipped about its x axis as KiCad stores it
// (`FOOTPRINT::Flip`): the land's vectors map to the file by `(x, -y)` on the top and `(x, y)` on the bottom, and the file's angle is the
// editor's turn on the top and that less half a turn on the bottom (docs/kicad-import.md, section 7). Pads, drawings and texts are written
// from the land itself, never from the board's frame, so no turn and no float noise is in what is written.
//
// What a KiCad 9 file cannot say, and so is written another way, is listed in `notes` (an ellipse as the polygon it flattens to, a rounded
// rectangle as a polygon with arc corners, a filled polygon with holes as one outline joined to its holes, a trapezoid pad as a custom pad
// of its polygon).

const mm6 = (n: number) => String(round(n, 6) || 0)
const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
/** The file's frame: y down, no offset. */
const toFile = (p: Vec2): Vec2 => ({ x: p.x, y: 0 - p.y })
const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`)
/** A pad block comes indented for a footprint at two spaces; here the footprint's own lines start at the margin. */
const dedent = (block: string) => block.replace(/^ {2}/gm, "")

/** KiCad 9's numbers for the user layers: `User.1` is 39, `User.2` 41, and so on by twos. */
const userLayerNumber9 = (name: string): number | null => {
  const m = name.match(/^User\.(\d+)$/)
  return m ? 37 + 2 * Number(m[1]) : null
}

const LAYER_TABLE: [number, string, string, string?][] = [
  [0, "F.Cu", "signal"],
  [2, "B.Cu", "signal"],
  [9, "F.Adhes", "user", "F.Adhesive"],
  [11, "B.Adhes", "user", "B.Adhesive"],
  [13, "F.Paste", "user"],
  [15, "B.Paste", "user"],
  [5, "F.SilkS", "user", "F.Silkscreen"],
  [7, "B.SilkS", "user", "B.Silkscreen"],
  [1, "F.Mask", "user"],
  [3, "B.Mask", "user"],
  [17, "Dwgs.User", "user", "User.Drawings"],
  [19, "Cmts.User", "user", "User.Comments"],
  [21, "Eco1.User", "user", "User.Eco1"],
  [23, "Eco2.User", "user", "User.Eco2"],
  [25, "Edge.Cuts", "user"],
  [27, "Margin", "user"],
  [31, "F.CrtYd", "user", "F.Courtyard"],
  [29, "B.CrtYd", "user", "B.Courtyard"],
  [35, "F.Fab", "user"],
  [33, "B.Fab", "user"],
]

/** Whether the project came from a KiCad board, which is what the native writer is for (a project drawn in the editor keeps the converter's path). */
export function isKicadBoardProject(project: Pick<Project, "components" | "properties">): boolean {
  return project.components.some((c) => c.fpid !== undefined) || !!project.properties?.some((p) => p.key === "KiCad file version")
}

/** The properties the import adds about where the file came from, which are not the board's. */
export const PROVENANCE_PROPERTIES = new Set(["Imported from", "KiCad file version"])

export interface KicadBoardFile {
  text: string
  /** What did not come across as it is, in words for whoever exported it. */
  notes: string[]
}

export interface KicadBoardOptions {
  /** The editor's fill of each zone, written as the zone's `filled_polygon`; none writes the zones unfilled. */
  fills?: ZoneFill[]
  /** The bytes of each reference image by the id the project holds it by. */
  pictures?: Map<string, Uint8Array>
}

/** The pin type KiCad names for a part's pin role. */
const PIN_TYPE: Record<NonNullable<PinDef["kind"]>, string> = { input: "input", output: "output", io: "bidirectional", passive: "passive", power: "power_in", ground: "power_in", nc: "no_connect" }

/** A uuid in KiCad's shape, numbered so the same project writes the same file. */
const uuidAt = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

export function writeKicadBoard(project: Project, options: KicadBoardOptions = {}): KicadBoardFile {
  const notes = new Set<string>()
  let serial = 0
  const newUuid = () => uuidAt(++serial)
  /** The ids handed out since the counter stood at `from`. */
  const issuedSince = (from: number) => Array.from({ length: serial - from }, (_, i) => uuidAt(from + i + 1))
  const layers = new Set<string>()
  const useLayer = (name: string) => layers.add(name)
  const sch = computeConnectivity(project)
  const netNameOf = new Map(sch.nets.map((n) => [n.id, n.name]))
  // ---------- nets: numbered in the order they are met ----------
  const netCodes = new Map<string, number>()
  const netCode = (name: string): number => {
    if (!name) return 0
    let n = netCodes.get(name)
    if (n === undefined) {
      n = netCodes.size + 1
      netCodes.set(name, n)
    }
    return n
  }
  const out: Out = { exact: true, uuid: newUuid, flattened: new Set(), netCode }

  const items: string[] = []
  const push = (lines: string[]) => items.push(lines.join("\n"))
  /** What each project id is in the file (the uuids it was written with), for the groups to list. */
  const members = new Map<string, string[]>()

  // ---------- footprints ----------
  const modelOf = new Map<string, Model3D>()
  for (const m of project.models ?? []) modelOf.set(`${m.part}\n${m.footprint}`, m.model)
  const wanted = project.components.filter((c) => onBoard(c) && c.pcb.placed && componentFootprint(c))
  for (const c of wanted) push(indent(footprintBlock(c), "  "))

  function footprintBlock(c: ComponentInstance): string[] {
    const land = componentFootprint(c) as FootprintDef
    const part = findPart(c.partId)
    const bottom = c.pcb.side === "bottom"
    const fa = normalizeAngle(bottom ? c.pcb.rot - 180 : c.pcb.rot)
    const at = toFile(c.pcb)
    const id = newUuid()
    members.set(c.id, [id])
    const spec = project.parts?.find((s) => s.id === c.partId)
    // A part that came from a KiCad board has the footprint's name as the file gave it (none, for a footprint with no name), its drawings only where the file drew them, and the attributes it listed.
    const fromFile = c.fpid !== undefined || spec?.description === "From a KiCad board" || (spec !== undefined && c.texts !== undefined)
    const lines: string[] = [`(footprint ${quote(c.fpid ?? (fromFile ? "" : c.footprint))}`, `  (layer ${quote(bottom ? "B.Cu" : "F.Cu")})`]
    if (c.pcb.locked) lines.push("  (locked yes)")
    lines.push(`  (uuid ${id})`, `  (at ${mm6(at.x)} ${mm6(at.y)}${fa ? ` ${mm6(fa)}` : ""})`)
    if (spec && spec.description && spec.description !== "From a KiCad board") lines.push(`  (descr ${quote(spec.description)})`)
    if (spec?.keywords?.length) lines.push(`  (tags ${quote(spec.keywords.join(" "))})`)

    // Texts: where the part has put them; a part with none (drawn in the editor) gets its reference and value as KiCad's own two.
    const textLines: string[] = []
    const textIds: string[][] = []
    const own = c.texts !== undefined
    const wts = own ? componentTexts(c) : []
    if (own) {
      c.texts!.forEach((t, i) => {
        const wt = wts[i]
        const block = partTextBlock(c, t, wt, bottom)
        textLines.push(...indent(block.lines, "  "))
        textIds.push(block.ids)
      })
    } else {
      const ref = defaultField("Reference", c.ref, "F.SilkS", false)
      const val = defaultField("Value", part ? (c.props[part.valueProp ?? ""] ?? "") : "", "F.Fab", false)
      textLines.push(...indent(ref, "  "), ...indent(val, "  "))
      useLayer("F.SilkS")
      useLayer("F.Fab")
    }
    lines.push(...textLines)

    const flags = c.flags
    const words = kicadAttributes(flags)
    // A part with no flags that came from the editor is surface-mount unless a pad has a hole, as the converter writes it.
    const derived = !flags && !fromFile ? [land.pads.some((p) => p.holeDiameter !== undefined) ? "through_hole" : "smd"] : []
    const attr = [...words, ...derived]
    if (attr.length) {
      attr.sort((a, b) => Number(!/^(smd|through_hole)$/.test(a)) - Number(!/^(smd|through_hole)$/.test(b)))
      lines.push(`  (attr ${attr.join(" ")})`)
    }
    if (flags?.jumperDuplicates) lines.push("  (duplicate_pad_numbers_are_jumpers yes)")
    if (flags?.netTies?.length) lines.push(`  (net_tie_pad_groups ${flags.netTies.map((g) => quote(g.join(","))).join(" ")})`)
    if (flags?.jumperGroups?.length) lines.push(`  (jumper_pad_groups ${flags.jumperGroups.map((g) => `(${g.map(quote).join(" ")})`).join(" ")})`)

    // Drawings of the land, then the pads.
    const shapeIds: string[][] = []
    const sgnY = bottom ? 1 : -1
    const map = (p: Vec2): Vec2 => ({ x: p.x, y: sgnY < 0 ? 0 - p.y : p.y })
    if (land.shapes) {
      for (const s of land.shapes) {
        const from = serial
        const mapped = mapShape(s, map)
        const shape: BoardShape = { ...mapped, layer: bottom ? flipShapeLayer(s.layer) : s.layer }
        useLayer(shape.layer)
        for (const b of drawing(shape, true, out)) lines.push(...indent(b, "  "))
        shapeIds.push(issuedSince(from))
      }
    } else if (!fromFile) {
      // A land from the library: its silkscreen lines and its courtyard.
      const side = bottom ? "B" : "F"
      const stroke = ["(stroke", "  (width 0.12)", "  (type solid)", ")"]
      for (const path of land.silk) {
        for (let i = 1; i < path.length; i++) lines.push(...indent([`(fp_line`, `  (start ${xy(map(path[i - 1]))})`, `  (end ${xy(map(path[i]))})`, ...indent(stroke, "  "), `  (layer ${quote(`${side}.SilkS`)})`, `  (uuid ${newUuid()})`, ")"], "  "))
      }
      useLayer(`${side}.SilkS`)
      if (!land.noCourtyard) {
        const k = land.courtyard
        const a = map({ x: k.minX, y: k.minY })
        const b = map({ x: k.maxX, y: k.maxY })
        lines.push(...indent([`(fp_rect`, `  (start ${xy(a)})`, `  (end ${xy(b)})`, "  (stroke", "    (width 0.05)", "    (type default)", "  )", "  (fill no)", `  (layer ${quote(`${side}.CrtYd`)})`, `  (uuid ${newUuid()})`, ")"], "  "))
        useLayer(`${side}.CrtYd`)
      }
    }
    const padIds: string[] = []
    const pins = new Map((spec?.pins ?? part?.pins ?? []).map((p) => [p.number, p]))
    land.pads.forEach((def) => {
      const net = def.pin ? sch.pinNet.get(pinKey(c.id, def.pin)) : undefined
      const name = net ? netNameOf.get(net) : undefined
      const uuid = newUuid()
      padIds.push(uuid)
      const pin = def.pin ? pins.get(def.pin) : undefined
      const fn = pin && pin.name !== pin.number ? pin.name : undefined
      const type = pin?.kind ? PIN_TYPE[pin.kind] : undefined
      lines.push(dedent(writePad(def, null, c, () => ({ x: 0, y: 0 }), c.pcb.rot, name ? { code: netCode(name), name } : null, uuid, { exact: true, at: padAt(def, bottom), pinfunction: fn, pintype: type })))
      for (const o of def.layers?.other ?? []) useLayer(bottom ? flipShapeLayer(o) : o)
      if (def.shape === "polygon" && !def.custom) notes.add("A trapezoid or polygon pad is written as a custom pad of the same polygon, which KiCad draws and plots the same.")
    })

    // The part's own groups, by place in the land.
    for (const g of c.groups ?? []) {
      const ids = g.members.flatMap((m) => {
        const k = Number(m.slice(1))
        if (m[0] === "p") return padIds[k] ? [padIds[k]] : []
        if (m[0] === "s") return shapeIds[k] ?? []
        if (m[0] === "t") return textIds[k] ?? []
        return []
      })
      if (ids.length) lines.push(...indent(groupBlock(g, newUuid(), ids), "  "))
    }

    const model = modelOf.get(`${c.partId}\n${c.footprint}`)
    if (model?.source === "kicad") {
      const [, ...path] = model.id.split("/")
      const flip = (v: number) => (v === 0 ? 0 : -v)
      lines.push(`  (model ${quote(`\${KICAD9_3DMODEL_DIR}/${path.join("/")}`)}`, `    (offset (xyz ${mm6(model.offset.x)} ${mm6(model.offset.y)} ${mm6(model.offset.z)}))`, "    (scale (xyz 1 1 1))", `    (rotate (xyz ${mm6(flip(model.rotation.x))} ${mm6(flip(model.rotation.y))} ${mm6(flip(model.rotation.z))}))`, "  )")
    } else if (model) notes.add("A 3D model that is not one of KiCad's stock library has no file the board can name, so it is not written.")
    lines.push(")")
    return lines
  }

  /** A property of a part that has no texts of its own, hidden unless it is the reference. */
  function defaultField(name: string, value: string, layer: string, hide: boolean): string[] {
    return [`(property ${quote(name)} ${quote(value)}`, "  (at 0 0 0)", `  (layer ${quote(layer)})`, ...(hide || name === "Value" ? ["  (hide yes)"] : []), `  (uuid ${newUuid()})`, "  (effects", "    (font", "      (size 1 1)", "      (thickness 0.15)", "    )", "  )", ")"]
  }

  /** The block of one of a part's texts, in the footprint's file frame, and the ids it was written with. */
  function partTextBlock(c: ComponentInstance, t: PartText, wt: WorldText, bottom: boolean): { lines: string[]; ids: string[] } {
    const layer = bottom ? flipShapeLayer(t.layer) : t.layer
    useLayer(layer)
    const sgn = bottom ? 1 : -1
    const local = { x: t.x, y: sgn < 0 ? 0 - t.y : t.y }
    const angle = normalizeAngle(bottom ? c.pcb.rot - t.rot : c.pcb.rot + t.rot)
    const mirror = bottom ? !t.mirror : t.mirror === true
    const content = t.kind === "user" ? (t.text ?? "") : t.kind === "reference" ? (t.text ?? c.ref) : shownOf(project, wt)
    const id = newUuid()
    const at = `(at ${xy(local)}${angle ? ` ${mm6(angle)}` : ""}${t.upright === false ? " unlocked" : ""})`
    const head = t.kind === "reference" ? `(property "Reference" ${quote(content)}` : t.kind === "value" ? `(property "Value" ${quote(content)}` : `(fp_text user ${quote(content)}`
    const lines = [head, `  ${at}`, `  (layer ${quote(layer)}${t.knockout ? " knockout" : ""})`, ...(t.hide ? ["  (hide yes)"] : []), ...(t.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, mirror, false, t.href).map((l) => `  ${l}`), ")"]
    return { lines, ids: [id] }
  }

  /** Where a pad's hole is in the footprint's file frame: the pad's centre less the offset the copper has from the hole, exactly. */
  function padAt(def: PadDef, bottom: boolean): Vec2 {
    let hole: Vec2 = { x: def.x, y: def.y }
    const o = def.holeOffset
    if (o && (o.x !== 0 || o.y !== 0)) {
      // A polygon has no turn of its own: its hole is the offset from its centre. Any other pad turns the offset with the pad.
      const moved = def.shape === "polygon" && !def.custom ? o : rotate90(o, def.rot ?? 0)
      hole = { x: def.x + moved.x, y: def.y + moved.y }
    }
    return { x: round(hole.x, 6), y: round(bottom ? hole.y : 0 - hole.y, 6) }
  }

  // ---------- the board's outline ----------
  const edge: string[] = []
  const edgeTail = () => ["  (stroke", "    (width 0.05)", "    (type solid)", "  )", `  (layer "Edge.Cuts")`, `  (uuid ${newUuid()})`]
  const edgeBlock = (name: string, body: string[]) => [`(${name}`, ...body.map((l) => `  ${l}`), ...edgeTail(), ")"]
  let flattenedOutline = false
  const outlineSeg = (s: PathSeg): string[][] => {
    switch (s.kind) {
      case "line":
        return [edgeBlock("gr_line", [`(start ${xy(toFile(s.a))})`, `(end ${xy(toFile(s.b))})`])]
      case "arc":
        return [edgeBlock("gr_arc", [`(start ${xy(toFile(s.start))})`, `(mid ${xy(toFile(s.mid))})`, `(end ${xy(toFile(s.end))})`])]
      case "bezier":
        return [edgeBlock("gr_curve", [`(pts (xy ${xy(toFile(s.p0))}) (xy ${xy(toFile(s.c1))}) (xy ${xy(toFile(s.c2))}) (xy ${xy(toFile(s.p1))}))`])]
      case "ellipse": {
        flattenedOutline = true
        const pts = flattenPath({ closed: false, segs: [s] }, 0.0005)
        return pts.slice(1).map((p, i) => edgeBlock("gr_line", [`(start ${xy(toFile(pts[i]))})`, `(end ${xy(toFile(p))})`]))
      }
    }
  }
  const paths = outlinePaths(project)
  for (const path of paths) for (const s of path.segs) for (const b of outlineSeg(s)) edge.push(...indent(b, "  "))
  if (paths.length) useLayer("Edge.Cuts")
  if (flattenedOutline) notes.add("KiCad 9 has no ellipse: an elliptical piece of the outline is written as lines within 0.5 micrometre of the true curve.")
  const edgeLines = edge.length ? [edge.join("\n")] : []

  // ---------- drawings, texts, dimensions and images of the board ----------
  const boardItems: string[] = []
  for (const g of project.graphics ?? []) {
    const from = serial
    useLayer(g.layer)
    for (const b of drawing(mapShape(g, toFile), false, out)) boardItems.push(indent(b, "  ").join("\n"))
    members.set(g.id, issuedSince(from))
    if (g.type === "ellipse") out.flattened.add("ellipse")
  }
  if (out.flattened.has("ellipse")) notes.add("KiCad 9 has no ellipse: ellipses and elliptical arcs are written as polygons and lines within 0.5 micrometre of the true curve.")
  if (out.flattened.has("hole")) notes.add("KiCad 9's polygon has no holes: a filled polygon with holes is written as one outline joined to its holes by zero-width bridges, with its edges drawn on top.")
  if ((project.graphics ?? []).some((g) => g.type === "rect" && g.radius)) notes.add("KiCad 9's rectangle has no corner radius: a rounded one is written as a polygon with arc corners.")

  for (const wt of worldTexts(project)) {
    if (wt.owner !== BOARD_SHAPE_OWNER && wt.owner !== "#board") continue
    if (isDimensionText(wt)) continue
    const t = wt.source as { id: string; href?: string; locked?: true }
    useLayer(wt.layer)
    const content = (wt.source as { text?: string }).text ?? wt.content
    const layer = `(layer ${quote(wt.layer)}${wt.knockout ? " knockout" : ""})`
    const id = newUuid()
    if (wt.box) {
      const b = wt.box
      const corners = textBoxCorners(wt).map(toFile)
      const angle = normalizeAngle(wt.rot)
      const quarter = angle % 90 === 0
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      const geometry = quarter ? [`  (start ${xy({ x: Math.min(...xs), y: Math.min(...ys) })})`, `  (end ${xy({ x: Math.max(...xs), y: Math.max(...ys) })})`] : [`  (pts ${corners.map((p) => `(xy ${xy(p)})`).join(" ")})`]
      if (wt.knockout) notes.add("KiCad 9 has no knockout for a text box (its parser has no such node), so a box with knockout is written without it.")
      boardItems.push(
        indent(
          [`(gr_text_box ${quote(content)}`, ...geometry, ...(angle ? [`  (angle ${mm6(angle)})`] : []), "  (stroke", `    (width ${mm6(b.border ?? 0)})`, "    (type solid)", "  )", `  (border ${b.border !== undefined ? "yes" : "no"})`, `  (margins ${b.margins.map(mm6).join(" ")})`, `  (layer ${quote(wt.layer)})`, ...(wt.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, wt.mirror, false, t.href).map((l) => `  ${l}`), ")"],
          "  ",
        ).join("\n"),
      )
    } else {
      const at = toFile({ x: wt.x, y: wt.y })
      const rot = normalizeAngle(wt.rot)
      boardItems.push(indent([`(gr_text ${quote(content)}`, `  (at ${xy(at)}${rot ? ` ${mm6(rot)}` : ""})`, `  ${layer}`, ...(wt.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, wt.mirror, false, t.href).map((l) => `  ${l}`), ")"], "  ").join("\n"))
    }
    members.set(t.id, [id])
  }
  for (const d of project.dimensions ?? []) {
    const id = newUuid()
    useLayer(d.layer)
    members.set(d.id, [id])
    boardItems.push(indent(dimensionBlock(d as BoardDimension, id, toFile), "  ").join("\n"))
  }
  let missingPictures = 0
  for (const m of project.images ?? []) {
    const bytes = options.pictures?.get(m.file)
    if (!bytes) {
      missingPictures++
      continue
    }
    const id = newUuid()
    useLayer(m.layer)
    members.set(m.id, [id])
    boardItems.push(indent(imageBlock(m, bytes, id, toFile), "  ").join("\n"))
  }
  if (missingPictures) notes.add(`${missingPictures} reference ${missingPictures === 1 ? "image was" : "images were"} left out: ${missingPictures === 1 ? "its picture is" : "their pictures are"} not in this account's files, so there is nothing to write.`)

  // ---------- copper ----------
  const copperItems: string[] = []
  const netless = project.traces.every((t) => t.net === undefined) && project.vias.every((v) => v.routedNet === undefined)
  const derived = netless && (project.traces.length || project.vias.length) ? derivedCopperNets(project, sch) : null
  const nameOfNet = (id: string | null | undefined) => (id && id !== "short" ? (netNameOf.get(id) ?? "") : "")
  for (const t of project.traces) {
    const layer = t.layer === "top" ? "F.Cu" : "B.Cu"
    const net = netCode(t.net ?? (derived ? nameOfNet(derived.traceNet.get(t.id)) : ""))
    const ids: string[] = []
    for (let i = 1; i < t.points.length; i++) {
      const id = newUuid()
      ids.push(id)
      copperItems.push(`  (segment\n    (start ${xy(toFile(t.points[i - 1]))})\n    (end ${xy(toFile(t.points[i]))})\n    (width ${mm6(t.width)})\n    (layer ${quote(layer)})${t.locked ? "\n    (locked yes)" : ""}\n    (net ${net})\n    (uuid ${id})\n  )`)
    }
    members.set(t.id, ids)
  }
  for (const v of project.vias) {
    const id = newUuid()
    const net = netCode(v.routedNet ?? v.net ?? (derived ? nameOfNet(derived.viaNet.get(v.id)) : ""))
    members.set(v.id, [id])
    copperItems.push(`  (via\n    (at ${xy(toFile(v))})\n    (size ${mm6(v.diameter)})\n    (drill ${mm6(v.drill)})\n    (layers "F.Cu" "B.Cu")${v.locked ? "\n    (locked yes)" : ""}\n    (net ${net})\n    (uuid ${id})\n  )`)
  }

  // ---------- zones ----------
  const zoneItems: string[] = []
  const boardRings = (() => {
    const b = project.board
    const hw = b.width / 2
    const hh = b.height / 2
    const p = [
      { x: b.x - hw, y: b.y - hh },
      { x: b.x + hw, y: b.y - hh },
      { x: b.x + hw, y: b.y + hh },
      { x: b.x - hw, y: b.y + hh },
    ]
    return [{ closed: true, segs: p.map((a, i) => ({ kind: "line" as const, a, b: p[(i + 1) % 4] })) }] as ShapePath[]
  })()
  for (const z of project.zones) {
    zoneItems.push(zoneText(project, z, options.fills ?? [], netCode, boardRings, newUuid))
    if (isWholeBoardPour(z)) notes.add("A pour that covers the whole board is written as a polygon of the board's box, which is what it is.")
  }

  // ---------- groups ----------
  const groupItems: string[] = []
  const groupUuid = new Map((project.groups ?? []).map((g) => [g.id, newUuid()]))
  for (const [id, u] of groupUuid) members.set(id, [u])
  for (const g of project.groups ?? ([] as PcbGroup[])) {
    const ids = g.members.flatMap((m) => members.get(m) ?? [])
    if (ids.length) groupItems.push(indent(groupBlock(g, groupUuid.get(g.id)!, ids), "  ").join("\n"))
  }
  if ((project.groups ?? []).some((g) => g.lib !== undefined)) notes.add("A group made from a design block keeps no link to it: KiCad 9's file has no node for one.")

  // ---------- the header ----------
  const rules = project.rules
  const setup: string[] = [`    (pad_to_mask_clearance ${mm6(rules.maskExpansion)})`]
  if (rules.maskMinWidth !== undefined) setup.push(`    (solder_mask_min_width ${mm6(rules.maskMinWidth)})`)
  if (rules.pasteExpansion) setup.push(`    (pad_to_paste_clearance ${mm6(rules.pasteExpansion)})`)
  if (rules.pasteRatio !== undefined) setup.push(`    (pad_to_paste_clearance_ratio ${round(rules.pasteRatio, 6)})`)
  if (rules.maskBridgesInParts) setup.push("    (allow_soldermask_bridges_in_footprints yes)")
  const kept = (project.properties ?? []).filter((p) => !PROVENANCE_PROPERTIES.has(p.key))
  const isTitleBlock = (key: string) => /^(Title|Date|Rev|Company|Comment \d+)$/.test(key)
  const title: string[] = []
  const fileKey = (key: string) => (key === "Title" ? "title" : key === "Date" ? "date" : key === "Rev" ? "rev" : key === "Company" ? "company" : "")
  // The title is the project's name unless the board gave one that is not (then it is a property, kept in its place).
  if (!kept.some((p) => p.key === "Title") && project.name !== "Imported KiCad board") title.push(`    (title ${quote(project.name)})`)
  for (const p of kept) {
    if (!isTitleBlock(p.key)) continue
    const m = p.key.match(/^Comment (\d+)$/)
    title.push(m ? `    (comment ${m[1]} ${quote(p.value)})` : `    (${fileKey(p.key)} ${quote(p.value)})`)
  }
  const boardProps = kept.filter((p) => !isTitleBlock(p.key))

  const layerRows: string[] = LAYER_TABLE.map(([n, name, type, user]) => `    (${n} ${quote(name)} ${type}${user ? ` ${quote(user)}` : ""})`)
  const extra = [...layers]
    .flatMap((name) => {
      const n = userLayerNumber9(name)
      return n === null ? [] : [{ n, name }]
    })
    .sort((a, b) => a.n - b.n)
  for (const e of extra) layerRows.push(`    (${e.n} ${quote(e.name)} user)`)

  const netRows = [`  (net 0 "")`, ...[...netCodes].map(([name, n]) => `  (net ${n} ${quote(name)})`)]
  const body = [
    "(kicad_pcb",
    "  (version 20241229)",
    '  (generator "pcbnew")',
    '  (generator_version "9.0")',
    "  (general",
    `    (thickness ${mm6(project.board.thickness)})`,
    "    (legacy_teardrops no)",
    "  )",
    '  (paper "A4")',
    ...(title.length ? ["  (title_block", ...title, "  )"] : []),
    "  (layers",
    ...layerRows,
    "  )",
    "  (setup",
    ...setup,
    "  )",
    ...boardProps.map((p) => `  (property ${quote(p.key)} ${quote(p.value)})`),
    ...netRows,
    ...items,
    ...edgeLines,
    ...boardItems,
    ...copperItems,
    ...zoneItems,
    ...groupItems,
    ")",
    "",
  ]
  notes.add("The board is written natively in KiCad 9's format: footprints with their pads, drawings, text, groups and 3D models of KiCad's stock library, the outline, tracks, vias, zones, dimensions and reference images, each as KiCad has them. The design rules and net classes are in the project file.")
  return { text: body.join("\n"), notes: [...notes] }
}

/** The outline as paths: its own paths, or the rectangle (with its rounded corners) the board is. */
export function outlinePaths(project: Pick<Project, "board">): ShapePath[] {
  const b = project.board
  if (b.outline) return b.outline.paths
  const hw = b.width / 2
  const hh = b.height / 2
  const r = Math.min(b.cornerRadius ?? 0, hw, hh)
  const x0 = b.x - hw
  const x1 = b.x + hw
  const y0 = b.y - hh
  const y1 = b.y + hh
  if (!(r > 0)) {
    const p = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]
    return [{ closed: true, segs: p.map((a, i) => ({ kind: "line" as const, a, b: p[(i + 1) % 4] })) }]
  }
  const k = Math.SQRT1_2
  const corner = (cx: number, cy: number, sx: number, sy: number): PathSeg => ({ kind: "arc", start: { x: cx + sx * r, y: cy }, mid: { x: cx + sx * r * k, y: cy + sy * r * k }, end: { x: cx, y: cy + sy * r } })
  void corner
  const segs: PathSeg[] = [
    { kind: "line", a: { x: x0 + r, y: y0 }, b: { x: x1 - r, y: y0 } },
    { kind: "arc", start: { x: x1 - r, y: y0 }, mid: { x: x1 - r + r * k, y: y0 + r - r * k }, end: { x: x1, y: y0 + r } },
    { kind: "line", a: { x: x1, y: y0 + r }, b: { x: x1, y: y1 - r } },
    { kind: "arc", start: { x: x1, y: y1 - r }, mid: { x: x1 - r + r * k, y: y1 - r + r * k }, end: { x: x1 - r, y: y1 } },
    { kind: "line", a: { x: x1 - r, y: y1 }, b: { x: x0 + r, y: y1 } },
    { kind: "arc", start: { x: x0 + r, y: y1 }, mid: { x: x0 + r - r * k, y: y1 - r + r * k }, end: { x: x0, y: y1 - r } },
    { kind: "line", a: { x: x0, y: y1 - r }, b: { x: x0, y: y0 + r } },
    { kind: "arc", start: { x: x0, y: y0 + r }, mid: { x: x0 + r - r * k, y: y0 + r - r * k }, end: { x: x0 + r, y: y0 } },
  ]
  return [{ closed: true, segs }]
}
