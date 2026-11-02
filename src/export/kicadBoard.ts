import { normalizeAngle, round, mm6 } from "../lib/geometry"
import { boardTextStrokeWidth, ownTexts } from "../model/board"
import { resolvedComponents } from "../model/ruleAreas"
import { computeConnectivity, pinKey } from "../model/connectivity"
import { componentFootprint } from "../model/instances"
import { componentModel } from "../model/models3d"
import { findPart } from "../model/library"
import { kicadAttributes, onBoard } from "../model/partFlags"
import { derivedCopperNets } from "../model/pcb"
import { kicadNetName } from "../model/netNames"
import type { ZoneFill } from "../model/pour"
import { flipShapeLayer } from "../model/shapeLayers"
import { BOARD_SHAPE_OWNER } from "../model/shapeItems"
import { flattenPath, mapShape, type PathSeg, type ShapePath } from "../model/shapes"
import { componentTexts, shownOf, textBoxCorners, worldTexts, isDimensionText, type WorldText } from "../model/texts"
import type { BoardDimension, BoardShape, ComponentInstance, FootprintDef, PadDef, PartText, PcbGroup, PinDef, Project, Vec2 } from "../model/types"
import type { Model3D } from "../model/types"
import { drawing, LINE_END_NOTE, type Out } from "./kicadShapes"
import { effects } from "./kicadTexts"
import { stableUuid } from "./kicadUuid"
import { encodeBase64 } from "../lib/imageFacts"
import { quoteTabs as quote } from "../lib/kicadQuote"
import type { EmbeddedFont } from "../model/types"
import { trapezoidOf, writePad } from "./kicadPads"
import { dimensionBlock, generatorBlock, groupBlock, imageBlock } from "./kicadObjects"
import { zoneText } from "./kicadZones"
import { isWholeBoardPour, zoneLayers } from "../model/zones"
import { worldPartZones } from "../model/partZones"
import { UNPLACED_PROPERTY_UUID_PREFIX } from "../model/unplacedProperty"
import { partSheet } from "../model/placementAreas"
import { isHierarchical } from "../model/sheets"
import { rotate90 } from "../lib/geometry"
import { copperLayers, kicadLayerName, viaLayers } from "../model/stack"
import { isArcTrace } from "../model/arcTracks"
import type { CopperLayer, StackRow } from "../model/types"

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

const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
/** The file's frame: y down, no offset. */
const toFile = (p: Vec2): Vec2 => ({ x: p.x, y: 0 - p.y })
const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`)
/** A pad block comes indented for a footprint at two spaces; here the footprint's own lines start at the margin. */
const dedent = (block: string) => block.replace(/^ {2}/gm, "")
/** `lines.push(...more)` for any length: one footprint's drawing can be hundreds of thousands of lines (a TRS-80 board's), past what a spread passes. */
const pushAll = (lines: string[], more: readonly string[]) => {
  for (const l of more) lines.push(l)
}

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
export function isKicadBoardProject(project: Pick<Project, "components" | "properties" | "board" | "traces" | "vias" | "zones" | "graphics" | "texts" | "dimensions" | "images" | "groups">): boolean {
  if (project.components.some((c) => c.fpid !== undefined)) return true
  // A board of more than two copper layers (X1) has no place in the converter's file, which has two: it is written here, whoever drew it.
  if (project.board.stack && project.board.stack.copper.length > 2) return true
  // A KiCad schematic import has the same properties; what a board import has besides is a board: an outline, copper, zones, drawings, texts, dimensions, images or groups.
  const board = !!project.board.outline || !!project.board.stack || project.traces.length > 0 || project.vias.length > 0 || project.zones.length > 0 || (project.graphics?.length ?? 0) > 0 || project.texts.length > 0 || (project.dimensions?.length ?? 0) > 0 || (project.images?.length ?? 0) > 0 || (project.groups?.length ?? 0) > 0
  return board && !!project.properties?.some((p) => p.key === "KiCad file version")
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
  /** The bytes of each reference image, and of each embedded font file (X19), by the id the project holds it by. */
  pictures?: Map<string, Uint8Array>
}

/**
 * The font files a board or a footprint embeds, as KiCad writes them (`embedded_files`, then `embedded_fonts`): each file's bytes are written as the file stored
 * them (zstd compressed, base64 between two bars, 76 characters to a line) with the checksum it had. A file whose bytes this account does not hold is left out, and counted.
 */
function embeddedFontLines(files: EmbeddedFont[], allowed: boolean, bytes: Map<string, Uint8Array> | undefined, by: string, missing: { n: number }): string[] {
  const out: string[] = []
  const written = files.flatMap((f) => {
    const data = bytes?.get(f.file)
    if (!data) {
      missing.n++
      return []
    }
    return [{ f, data }]
  })
  if (written.length) {
    out.push(`${by}(embedded_files`)
    for (const { f, data } of written) {
      const b64 = encodeBase64(data)
      const rows = b64.match(/.{1,76}/g) ?? []
      out.push(`${by}  (file`, `${by}    (name ${quote(f.name)})`, `${by}    (type font)`)
      out.push(`${by}    (data |${rows[0] ?? ""}`, ...rows.slice(1).map((r) => `${by}      ${r}`))
      out[out.length - 1] += "|)"
      if (f.checksum) out.push(`${by}    (checksum ${quote(f.checksum)})`)
      out.push(`${by}  )`)
    }
    out.push(`${by})`)
  }
  if (allowed) out.push(`${by}(embedded_fonts yes)`)
  return out
}

/** The pin type KiCad names for a part's pin role. */
const PIN_TYPE: Record<NonNullable<PinDef["kind"]>, string> = { input: "input", output: "output", io: "bidirectional", passive: "passive", power: "power_in", ground: "power_in", nc: "no_connect" }

/** A uuid in KiCad's shape, numbered so the same project writes the same file. */
const uuidAt = (n: number) => stableUuid("8000", n)

/**
 * A model of KiCad's 3D library as a footprint's `(model ...)` lines: the path the file named it by (else the library's own), the offset as KiCad writes it, and the
 * angles turned back, since the import negates them (KiCad turns a model clockwise by the written angles). The board writer and the converter's board both write it.
 */
export function kicadModelLines(model: Model3D): string[] {
  const [, ...path] = model.id.split("/")
  const flip = (v: number) => (v === 0 ? 0 : -v)
  return [
    `(model ${quote(model.named ?? `\${KICAD9_3DMODEL_DIR}/${path.join("/")}`)}`,
    `  (offset (xyz ${mm6(model.offset.x)} ${mm6(model.offset.y)} ${mm6(model.offset.z)}))`,
    `  (scale (xyz ${model.stretch ? `${mm6(model.stretch.x)} ${mm6(model.stretch.y)} ${mm6(model.stretch.z)}` : "1 1 1"}))`,
    `  (rotate (xyz ${mm6(flip(model.rotation.x))} ${mm6(flip(model.rotation.y))} ${mm6(flip(model.rotation.z))}))`,
    ")",
  ]
}

export function writeKicadBoard(project: Project, options: KicadBoardOptions = {}): KicadBoardFile {
  const notes = new Set<string>()
  const missingFonts = { n: 0 }
  let serial = 0
  const newUuid = () => uuidAt(++serial)
  /** The uuids each part was written with, by part: one another part took already is not written again. */
  const uuidOwner = new Map<string, string>()
  /**
   * The uuid KiCad gave a footprint or pad of `part` (`ComponentInstance.fpUuid`, `padUuids`), in KiCad 9's shape (a `tstamp` of KiCad 5 is KiCad's legacy id, its
   * 8 digits at the end), so what KiCad keys by it still finds it; a new one where there is none, or where another part has it (a copy that kept it). One a
   * footprint's own pads repeat is written as the file had it.
   */
  const ownUuid = (given: string | undefined, part: string) => {
    const hex = given?.toLowerCase().replace(/-/g, "")
    const id = hex && /^[0-9a-f]{8}$/.test(hex) ? `00000000-0000-0000-0000-0000${hex}` : hex && /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null
    const owner = id ? uuidOwner.get(id) : undefined
    if (!id || (owner !== undefined && owner !== part)) return newUuid()
    uuidOwner.set(id, part)
    return id
  }
  /** The ids handed out since the counter stood at `from`. */
  const issuedSince = (from: number) => Array.from({ length: serial - from }, (_, i) => uuidAt(from + i + 1))
  const layers = new Set<string>()
  const useLayer = (name: string) => layers.add(name)
  const sch = computeConnectivity(project)
  // The net's own name, with its sheet's path (`/A/NAME`): the schematic export writes the same name (a local power symbol is local in the file, so its net has its sheet's path too).
  const netNameOf = new Map(sch.nets.map((n) => [n.id, n.name]))
  // The names as KiCad writes them: a `/` in a label's own text is `{slash}`, which the editor holds as a plain `/`.
  const fileName = new Map(sch.nets.map((n) => [n.name, kicadNetName(n, !project.netNames)]))
  const keptNames = project.kicad?.netNames
  const inFile = (name: string) => keptNames?.[name] ?? fileName.get(name) ?? name
  // ---------- nets: numbered in the order they are met ----------
  const netCodes = new Map<string, number>()
  const netCode = (given: string): number => {
    if (!given) return 0
    const name = inFile(given)
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
  let propCount = 0
  const members = new Map<string, string[]>()

  // ---------- footprints ----------
  const wanted = resolvedComponents(project).filter((c) => onBoard(c) && c.pcb.placed && componentFootprint(c))
  for (const c of wanted) push(indent(footprintBlock(c), "  "))
  const unplaced = resolvedComponents(project).filter((c) => onBoard(c) && !c.pcb.placed && componentFootprint(c)).length
  if (unplaced) notes.add(`${unplaced} ${unplaced === 1 ? "part is" : "parts are"} not placed on the board yet, so ${unplaced === 1 ? "it is" : "they are"} not in the board file.`)
  if (project.texts.some((t) => t.href) || project.components.some((c) => c.texts?.some((t) => t.href))) notes.add("A text's hyperlink is KiCad 10's: a KiCad 9 file cannot hold it, so it stays in the project and is not written.")
  // X23: board variants, footprint units and PCB points are KiCad 10's words, which the 9.0 parser refuses: they stay in the project, and each footprint is written as the variant shown makes it.
  if (project.components.some((c) => c.variants)) notes.add("A footprint's variants are KiCad 10's: a KiCad 9 file cannot hold them, so each footprint is written as the variant shown makes it and the variants stay in the project.")
  if (project.components.some((c) => c.units?.length)) notes.add("A footprint's units are KiCad 10's: a KiCad 9 file cannot hold them, so they stay in the project and are not written.")
  if (project.points?.length || project.components.some((c) => c.points?.length)) notes.add("PCB points are KiCad 10's: a KiCad 9 file cannot hold them, so they stay in the project and are not written.")
  // X21/X22: via protection, backdrills, tertiary drills and post-machining, a pad's die delay and net chains are KiCad 10's words, which the 9.0 parser refuses: they stay in the project.
  const holePads = wanted.flatMap((c) => componentFootprint(c)?.pads ?? [])
  if (project.vias.some((v) => v.protect || v.backdrill || v.tertiary || v.post) || project.rules.viaProtect || holePads.some((p) => p.backdrill || p.tertiary || p.post)) notes.add("Via protection, backdrills, tertiary drills and post-machining are KiCad 10's: a KiCad 9 file cannot hold them, so they stay in the project and are not written to the .kicad_pcb. A via's are in the drill files and the fabrication notes; a pad's are in the fabrication notes only.")
  if (holePads.some((p) => p.dieDelay !== undefined)) notes.add("A pad's die delay is KiCad 10's: a KiCad 9 file cannot hold it, so it stays in the project and is not written.")
  if (project.netChains?.length) notes.add("Net chains are KiCad 10's: a KiCad 9 file cannot hold them, so they stay in the project and are not written.")
  if (project.zones.some((z) => z.placement?.by === "group")) notes.add("A placement area for a group is KiCad 10's: the 9.0 file has no such source, so it stays in the project and is written switched off.")
  if (project.zones.some((z) => z.unordered || z.edgeGap !== undefined || z.holeGap !== undefined)) notes.add("A pour from a board of KiCad 5 or of KiCad 6's first files is written with its fill, but KiCad 9 refills it by its own rules: its distance to the board edge and to a hole is the project's design rule and KiCad 9's own (0.5 and 0.25 mm unless set), not the original board's, and zones of equal priority are ordered by their uuid, which this file gives them.")
  if (project.board.mountingHoles) notes.add("The board's corner mounting holes are not written to the KiCad board.")

  function footprintBlock(c: ComponentInstance): string[] {
    const land = componentFootprint(c) as FootprintDef
    const part = findPart(c.partId)
    const bottom = c.pcb.side === "bottom"
    const fa = normalizeAngle(bottom ? c.pcb.rot - 180 : c.pcb.rot)
    const at = toFile(c.pcb)
    const id = ownUuid(c.fpUuid, c.id)
    members.set(c.id, [id])
    const spec = project.parts?.find((s) => s.id === c.partId)
    // A part that came from a KiCad board has the footprint's name as the file gave it (none, for a footprint with no name), its drawings only where the file drew them, and the attributes it listed.
    // A footprint swapped for another (the editor drops the id then) is no longer the file's: it is named by its land and drawn from it.
    const fromFile = c.fpid !== undefined || (spec?.description === "From a KiCad board" && spec.footprint === c.footprint)
    const lines: string[] = [`(footprint ${quote(c.fpid ?? (fromFile ? "" : c.footprint))}`, `  (layer ${quote(bottom ? "B.Cu" : "F.Cu")})`]
    if (c.pcb.locked) lines.push("  (locked yes)")
    lines.push(`  (uuid ${id})`, `  (at ${mm6(at.x)} ${mm6(at.y)}${fa ? ` ${mm6(fa)}` : ""})`)
    // What the footprint said of itself, as typed; a part the editor made has its part's description and keywords.
    const descr = land.descr ?? (!fromFile && spec && spec.description && spec.description !== "From a KiCad board" && spec.description !== "From a KiCad schematic" ? spec.description : undefined)
    const tags = land.tags ?? (!fromFile && spec?.keywords?.length ? spec.keywords.join(" ") : undefined)
    if (descr) lines.push(`  (descr ${quote(descr)})`)
    if (tags) lines.push(`  (tags ${quote(tags)})`)
    // (A property with no place is a hidden field of the footprint, as KiCad reads one from an older file; written with no word of that it would be a visible text.)
    for (const p of c.fpProps ?? []) lines.push(`  (property ${quote(p.name)} ${quote(p.value)}`, `    (at 0 0 0)`, `    (layer ${quote(`${bottom ? "B" : "F"}.Fab`)})`, `    (hide yes)`, `    (uuid ${UNPLACED_PROPERTY_UUID_PREFIX}${(++propCount).toString(16).padStart(12, "0")})`, `    (effects (font (size 1 1) (thickness 0.15)))`, "  )")

    // Texts: where the part has put them; a part with none (drawn in the editor) gets its reference and value as KiCad's own two.
    const textLines: string[] = []
    const textIds: string[][] = []
    const own = c.texts !== undefined
    const wts = own ? componentTexts(c, copperLayers(project.board).length) : []
    if (own) {
      c.texts!.forEach((t, i) => {
        const wt = wts[i]
        const block = partTextBlock(c, t, wt, bottom, i)
        textLines.push(...indent(block.lines, "  "))
        textIds.push(block.ids)
      })
    } else {
      // The reference sits above the part's courtyard, as the converter places a designator, and its value is hidden on the fabrication layer.
      const side = bottom ? "B" : "F"
      const above = land.courtyard.maxY + 1
      const ref = defaultField("Reference", c.ref, `${side}.SilkS`, { x: 0, y: bottom ? above : 0 - above }, bottom)
      const val = defaultField("Value", part ? (c.props[part.valueProp ?? ""] ?? "") : "", `${side}.Fab`, { x: 0, y: 0 }, bottom, true)
      textLines.push(...indent(ref, "  "), ...indent(val, "  "))
      useLayer(`${side}.SilkS`)
      useLayer(`${side}.Fab`)
    }
    pushAll(lines, textLines)
    // X20: the part's component classes, and the sheet its footprint is from (a part of a hierarchical schematic is on the sheet its symbol is on).
    if (c.classes?.length) lines.push(`  (component_classes${c.classes.map((n) => ` (class ${quote(n)})`).join("")})`)
    if (fromFile ? c.sheetPath !== undefined : c.inst !== undefined || isHierarchical(project) || c.sheetPath !== undefined) lines.push(`  (sheetname ${quote(partSheet(project, c))})`)
    // The file a footprint of a KiCad board named is kept as it said it (a file may name a sheet other than the one its symbol is on); the link step only adds a name where there is none.
    if (fromFile && c.sheetFile !== undefined) lines.push(`  (sheetfile ${quote(c.sheetFile)})`)

    const flags = c.flags
    const words = kicadAttributes(flags)
    // A part with no flags that came from the editor is surface-mount unless a pad has a hole, as the converter writes it.
    const derived = !flags && !fromFile ? [land.pads.some((p) => p.holeDiameter !== undefined) ? "through_hole" : "smd"] : []
    const attr = [...words, ...derived]
    if (attr.length) {
      attr.sort((a, b) => Number(!/^(smd|through_hole)$/.test(a)) - Number(!/^(smd|through_hole)$/.test(b)))
      lines.push(`  (attr ${attr.join(" ")})`)
    }
    // `duplicate_pad_numbers_are_jumpers` and `jumper_pad_groups` are KiCad 10's: the 9.0 parser refuses a footprint that has either, so they stay in the project and out of the file.
    if (flags?.jumperDuplicates || flags?.jumperGroups?.length) notes.add("Jumper pad groups and \"duplicate pad numbers are jumpers\" are KiCad 10's: a KiCad 9 file cannot hold them, so they stay in the project and are not written.")
    if (flags?.netTies?.length) lines.push(`  (net_tie_pad_groups ${flags.netTies.map((g) => quote(g.join(","))).join(" ")})`)

    // Drawings of the land, then the pads.
    const shapeIds: string[][] = []
    const sgnY = bottom ? 1 : -1
    const map = (p: Vec2): Vec2 => ({ x: p.x, y: sgnY < 0 ? 0 - p.y : p.y })
    if (land.shapes) {
      for (const s of land.shapes) {
        const from = serial
        const mapped = mapShape(s, map)
        const shape: BoardShape = { ...mapped, layer: bottom ? flipShapeLayer(s.layer, copperLayers(project.board).length) : s.layer }
        useLayer(shape.layer)
        for (const b of drawing(shape, true, out)) pushAll(lines, indent(b, "  "))
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
    land.pads.forEach((def, i) => {
      const net = def.pin ? sch.pinNet.get(pinKey(c.id, def.pin)) : undefined
      // A pad that is alone on its net in the project keeps the net the board gave it (`unconnected-(R1-Pad2)`).
      const name = net ? netNameOf.get(net) : def.pin ? c.loneNets?.[def.pin] : undefined
      const uuid = ownUuid(c.padUuids?.[i], c.id)
      padIds.push(uuid)
      const pin = def.pin ? pins.get(def.pin) : undefined
      const fn = pin && pin.name !== pin.number ? pin.name : undefined
      const type = pin?.kind ? PIN_TYPE[pin.kind] : undefined
      // A polygon pad of four corners that is KiCad's trapezoid is written as one.
      const trapezoid = def.shape === "polygon" && !def.custom && def.points ? (trapezoidPad(def, bottom) ?? undefined) : undefined
      pushAll(lines, dedent(writePad(def, null, c, () => ({ x: 0, y: 0 }), c.pcb.rot, name ? { code: netCode(name), name: inFile(name) } : null, uuid, { exact: true, at: padAt(def, bottom), pinfunction: def.pinFunction ?? fn, pintype: def.pinType ?? type, trapezoid, copperCount: copperLayers(project.board).length })).split(String.fromCharCode(10)))
      for (const o of def.layers?.other ?? []) useLayer(bottom ? flipShapeLayer(o, copperLayers(project.board).length) : o)
      if (def.shape === "polygon" && !def.custom && !trapezoid) notes.add("A polygon pad that is not one of KiCad's trapezoids is written as a custom pad of the same polygon, which KiCad draws and plots the same.")
    })

    // X30: the zones drawn inside the footprint, in the board's frame as KiCad 9 writes a footprint's zone (the footprint's frame came with 20260616).
    for (const z of worldPartZones(project)) {
      if (z.part !== c.id) continue
      for (const l of zoneLayers(z)) useLayer(kicadLayerName(l))
      for (const n of z.other ?? []) useLayer(n)
      pushAll(lines, zoneText(project, z, options.fills ?? [], netCode, null, newUuid, toFile, inFile).split(String.fromCharCode(10)))
    }

    // The part's own groups, by place in the land.
    // (a group can hold another group of the part: it is named by its place in the list, `g<k>`)
    const groupIds = (c.groups ?? []).map(() => newUuid())
    ;(c.groups ?? []).forEach((g, gi) => {
      const ids = g.members.flatMap((m) => {
        const k = Number(m.slice(1))
        if (m[0] === "p") return padIds[k] ? [padIds[k]] : []
        if (m[0] === "s") return shapeIds[k] ?? []
        if (m[0] === "t") return textIds[k] ?? []
        if (m[0] === "g") return k !== gi && groupIds[k] ? [groupIds[k]] : []
        return []
      })
      if (ids.length) pushAll(lines, indent(groupBlock(g, groupIds[gi], ids), "  "))
    })

    // The project's model of the part, else a built-in part's own (a resistor added on 0603).
    const model = componentModel(project, c)
    if (model?.source === "kicad") lines.push(...kicadModelLines(model).map((l) => `  ${l}`))
    else if (model && !c.modelRefs?.length) notes.add("A 3D model that is not one of KiCad's stock library has no file the board can name, so it is not written.")
    // The models the project does not show are written back as the file had them.
    for (const ref of c.modelRefs ?? []) lines.push(`  ${ref}`)
    pushAll(lines, embeddedFontLines(project.fonts?.files.filter((f) => f.owner === c.id) ?? [], project.fonts?.parts?.includes(c.id) === true, options.pictures, "  ", missingFonts))
    lines.push(")")
    return lines
  }

  /** A property of a part that has no texts of its own, at `at` in the footprint's file frame, upright on the board (its angle is the board's own, 0); mirrored on the bottom. */
  function defaultField(name: string, value: string, layer: string, at: Vec2, mirror: boolean, hide = false): string[] {
    return [`(property ${quote(name)} ${quote(value)}`, `  (at ${xy(at)} 0)`, `  (layer ${quote(layer)})`, ...(hide ? ["  (hide yes)"] : []), `  (uuid ${newUuid()})`, "  (effects", "    (font", "      (size 1 1)", "      (thickness 0.15)", "    )", ...(mirror ? ["    (justify mirror)"] : []), "  )", ")"]
  }

  /** The block of one of a part's texts, in the footprint's file frame, and the ids it was written with. */
  function partTextBlock(c: ComponentInstance, t: PartText, wt: WorldText, bottom: boolean, index: number): { lines: string[]; ids: string[] } {
    const layer = bottom ? flipShapeLayer(t.layer, copperLayers(project.board).length) : t.layer
    useLayer(layer)
    const sgn = bottom ? 1 : -1
    const local = { x: t.x, y: sgn < 0 ? 0 - t.y : t.y }
    const angle = normalizeAngle(bottom ? c.pcb.rot - t.rot : c.pcb.rot + t.rot)
    const mirror = bottom ? !t.mirror : t.mirror === true
    const content = t.kind === "user" ? (t.text ?? "") : t.kind === "reference" ? (t.text ?? c.ref) : shownOf(project, wt)
    const id = newUuid()
    const at = `(at ${xy(local)}${angle ? ` ${mm6(angle)}` : ""})`
    // KiCad turns `%R` and `%V` into `${REFERENCE}` and `${VALUE}` in a text but not in a field's, so a text that has one (it came from a field) is written as a field of its own, named `Text N`: the project does not keep a field's name, and the notes say so.
    const field = t.kind === "user" && !t.box && /%[RV]/.test(content)
    if (field) notes.add("A field's text with %R or %V in it is written as a field named Text N (the project does not keep a field's name), because KiCad would turn the %R or %V of a plain text into the reference or value.")
    const head = t.kind === "reference" ? `(property "Reference" ${quote(content)}` : t.kind === "value" ? `(property "Value" ${quote(content)}` : t.name && !t.box ? `(property ${quote(t.name)} ${quote(content)}` : field ? `(property ${quote(`Text ${index + 1}`)} ${quote(content)}` : `(fp_text user ${quote(content)}`
    // X25: a part's text box (`fp_text_box`) is the rectangle as drawn in the part's own frame (the corners of its four sides for any turn that is not a quarter), as KiCad 9 stores it.
    if (t.box) {
      const b = t.box
      const turn = ((t.rot % 360) + 360) % 360
      const quarter = turn % 90 === 0
      const swap = turn === 90 || turn === 270
      const [w, h] = swap ? [b.h, b.w] : [b.w, b.h]
      const a = (turn * Math.PI) / 180
      const corner = (x: number, y: number) => ({ x: local.x + x * Math.cos(a) + y * Math.sin(a), y: local.y - x * Math.sin(a) + y * Math.cos(a) })
      const geometry = quarter
        ? [`  (start ${xy({ x: local.x - w / 2, y: local.y - h / 2 })})`, `  (end ${xy({ x: local.x + w / 2, y: local.y + h / 2 })})`]
        : [`  (pts ${[corner(-b.w / 2, -b.h / 2), corner(b.w / 2, -b.h / 2), corner(b.w / 2, b.h / 2), corner(-b.w / 2, b.h / 2)].map((p) => `(xy ${xy(p)})`).join(" ")})`]
      const boxLines = [
        `(fp_text_box ${quote(content)}`,
        ...geometry,
        `  (angle ${mm6(angle)})`,
        "  (stroke",
        `    (width ${mm6(b.border ?? 0)})`,
        "    (type solid)",
        "  )",
        `  (border ${b.border !== undefined ? "yes" : "no"})`,
        `  (margins ${b.margins.map(mm6).join(" ")})`,
        `  (layer ${quote(layer)})`,
        `  (uuid ${id})`,
        ...effects(wt, mirror, false, undefined, { project, to: toFile }).map((l) => `  ${l}`),
        ")",
      ]
      return { lines: boxLines, ids: [id] }
    }
    const lines = [head, `  ${at}`, ...(t.upright === false ? ["  (unlocked yes)"] : []), `  (layer ${quote(layer)}${t.knockout ? " knockout" : ""})`, ...(t.hide ? ["  (hide yes)"] : []), ...(t.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, mirror, false, undefined, { project, to: toFile }).map((l) => `  ${l}`), ")"]
    return { lines, ids: [id] }
  }

  /**
   * A polygon pad as the KiCad trapezoid it is, in the footprint's file frame: with a hole, the pad is at the hole and the drill's offset says where the copper
   * is; a slot has to run along one of the pad's own axes (the drill is written wide or tall), or the pad is a custom one.
   */
  function trapezoidPad(def: PadDef, bottom: boolean) {
    const t = trapezoidOf((def.points ?? []).map((p) => ({ x: p.x, y: bottom ? p.y : 0 - p.y })))
    if (!t || def.holeDiameter === undefined) return t
    const hole = padAt(def, bottom)
    const away = { x: t.at.x - hole.x, y: t.at.y - hole.y }
    const a = (-t.turn * Math.PI) / 180
    const own = { x: away.x * Math.cos(a) + away.y * Math.sin(a), y: -away.x * Math.sin(a) + away.y * Math.cos(a) }
    const out = { ...t, at: hole, ...(Math.abs(own.x) > 1e-9 || Math.abs(own.y) > 1e-9 ? { offset: own } : {}) }
    if (def.slotLength === undefined || def.slotLength <= def.holeDiameter + 1e-9) return out
    // The slot's axis in the land (0 along x) less the pad's turn is the drill's own: 0 for wide, 90 for tall.
    const axis = def.holeAxis ?? (def.width >= def.height ? 0 : 90)
    const own90 = (((axis - (bottom ? -t.turn : t.turn)) % 180) + 180) % 180
    if (Math.abs(own90) < 1e-6 || Math.abs(own90 - 180) < 1e-6) return out
    if (Math.abs(own90 - 90) < 1e-6) return { ...out, slotAcross: true }
    return null
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
  const edgeTail = () => ["  (stroke", `    (width ${mm6(project.kicad?.edgeWidth ?? 0.05)})`, "    (type solid)", "  )", `  (layer "Edge.Cuts")`, `  (uuid ${newUuid()})`]
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
  for (const path of paths) for (const s of path.segs) for (const b of outlineSeg(s)) pushAll(edge, indent(b, "  "))
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
  if (out.flattened.has("ends")) notes.add(LINE_END_NOTE)
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
          [`(gr_text_box ${quote(content)}`, ...geometry, ...(angle ? [`  (angle ${mm6(angle)})`] : []), "  (stroke", `    (width ${mm6(b.border ?? 0)})`, "    (type solid)", "  )", `  (border ${b.border !== undefined ? "yes" : "no"})`, `  (margins ${b.margins.map(mm6).join(" ")})`, `  (layer ${quote(wt.layer)})`, ...(wt.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, wt.mirror, false, undefined, { project, to: toFile }).map((l) => `  ${l}`), ")"],
          "  ",
        ).join("\n"),
      )
    } else {
      const at = toFile({ x: wt.x, y: wt.y })
      const rot = normalizeAngle(wt.rot)
      boardItems.push(indent([`(gr_text ${quote(content)}`, `  (at ${xy(at)}${rot ? ` ${mm6(rot)}` : ""})`, `  ${layer}`, ...(wt.locked ? ["  (locked yes)"] : []), `  (uuid ${id})`, ...effects(wt, wt.mirror, false, undefined, { project, to: toFile }).map((l) => `  ${l}`), ")"], "  ").join("\n"))
    }
    members.set(t.id, [id])
  }
  // The editor's own silkscreen text (no layer: the Gerber plots it, `gerberSilkscreen`): centred on its place, its size the letters' height,
  // turned by its angle, on the silk of its side and mirrored on the bottom, with the pen the Gerber draws it with.
  for (const t of ownTexts(project)) {
    const layer = t.side === "bottom" ? "B.SilkS" : "F.SilkS"
    useLayer(layer)
    const rot = normalizeAngle(t.rot)
    boardItems.push(
      indent([`(gr_text ${quote(t.text)}`, `  (at ${xy(toFile({ x: t.x, y: t.y }))}${rot ? ` ${mm6(rot)}` : ""})`, `  (layer ${quote(layer)})`, `  (uuid ${newUuid()})`, "  (effects", "    (font", `      (size ${mm6(t.size)} ${mm6(t.size)})`, `      (thickness ${mm6(boardTextStrokeWidth(t))})`, "    )", ...(t.side === "bottom" ? ["    (justify mirror)"] : []), "  )", ")"], "  ").join("\n"),
    )
  }
  for (const d of project.dimensions ?? []) {
    const id = newUuid()
    useLayer(d.layer)
    members.set(d.id, [id])
    boardItems.push(indent(dimensionBlock(d as BoardDimension, id, toFile), "  ").join("\n"))
  }
  if (project.dimensions?.length) notes.add("Dimensions are written as KiCad's own dimension items, with the text and where KiCad puts it; their lines and arrows are KiCad's to draw, by its rules, as they are here.")
  if ((project.images ?? []).some((m) => m.scale !== 1 || m.ppi !== 300)) notes.add("A reference image's scale is written with six digits, as KiCad writes it.")
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
  // Copper the file gave no net (added in the editor, or netless in the file) is on the net it touches.
  const lacking = project.traces.some((t) => t.net === undefined && !t.noNet) || project.vias.some((v) => v.routedNet === undefined && v.net === undefined && !v.noNet)
  const derived = lacking ? derivedCopperNets(project, sch) : null
  const nameOfNet = (id: string | null | undefined) => (id && id !== "short" ? (netNameOf.get(id) ?? "") : "")
  for (const t of project.traces) {
    const layer = kicadLayerName(t.layer)
    const net = netCode(t.net ?? (t.noNet ? "" : derived ? nameOfNet(derived.traceNet.get(t.id)) : ""))
    const ids: string[] = []
    // X24: a track open through the mask names the mask of its own side beside its copper layer, and may have its own margin for the opening.
    const layerNode = t.bare ? `(layers ${quote(layer)} ${quote(t.layer === "top" ? "F.Mask" : "B.Mask")})${t.bare.margin !== undefined ? `\n    (solder_mask_margin ${mm6(t.bare.margin)})` : ""}` : `(layer ${quote(layer)})`
    if (isArcTrace(t)) {
      // X4: an arc track is KiCad's `arc`: the three points as the project has them.
      const id = newUuid()
      ids.push(id)
      copperItems.push(`  (arc\n    (start ${xy(toFile(t.points[0]))})\n    (mid ${xy(toFile(t.points[1]))})\n    (end ${xy(toFile(t.points[2]))})\n    (width ${mm6(t.width)})${t.locked ? "\n    (locked yes)" : ""}\n    ${layerNode}\n    (net ${net})\n    (uuid ${id})\n  )`)
    } else {
      for (let i = 1; i < t.points.length; i++) {
        const id = newUuid()
        ids.push(id)
        copperItems.push(`  (segment\n    (start ${xy(toFile(t.points[i - 1]))})\n    (end ${xy(toFile(t.points[i]))})\n    (width ${mm6(t.width)})\n    ${layerNode}${t.locked ? "\n    (locked yes)" : ""}\n    (net ${net})\n    (uuid ${id})\n  )`)
      }
    }
    members.set(t.id, ids)
  }
  const stackCount = copperLayers(project.board).length
  for (const v of project.vias) {
    const id = newUuid()
    const net = netCode(v.routedNet ?? v.net ?? (v.noNet ? "" : derived ? nameOfNet(derived.viaNet.get(v.id)) : ""))
    members.set(v.id, [id])
    const span = viaLayers(project.board, v)
    const ends = v.kind ? [span[0], span[span.length - 1]] : (["top", "bottom"] as CopperLayer[])
    // KiCad 9 has `blind` and `micro`: a buried via is a blind one between two inner layers (the word `buried` is KiCad 10's).
    const word = v.kind === "micro" ? "micro " : v.kind ? "blind " : ""
    if (v.kind === "buried" && (ends[0] === "top" || ends[1] === "bottom")) notes.add("A buried via that has an outer layer for an end is written as a blind one: KiCad 9 tells the two by their layers, and the word `buried` is KiCad 10's.")
    const lines = [`  (via${word ? ` ${word.trim()}` : ""}`, `    (at ${xy(toFile(v))})`, `    (size ${mm6(v.diameter)})`, `    (drill ${mm6(v.drill)})`, `    (layers ${quote(kicadLayerName(ends[0]))} ${quote(kicadLayerName(ends[1]))})`]
    // KiCad 9 says what becomes of the layers nothing connects to as two words (`start_end_only` is KiCad 10's mode: the nearest KiCad 9 has is the one that keeps the ends).
    if (v.unused) {
      lines.push("    (remove_unused_layers yes)", `    (keep_end_layers ${v.unused === "remove" ? "no" : "yes"})`)
      if (v.unused === "startEnd") notes.add("A via that has copper at its two ends only (KiCad 10's `start_end_only`) is written as one that removes unused layers and keeps its ends: a KiCad 9 file has no such mode, and a layer a track touches keeps its copper.")
    }
    if (v.locked) lines.push("    (locked yes)")
    if (v.free) lines.push("    (free yes)")
    if (v.zoneLayers) lines.push(`    (zone_layer_connections${v.zoneLayers.map((l) => ` ${quote(kicadLayerName(l))}`).join("")})`)
    if (v.tent && (v.tent.front !== undefined || v.tent.back !== undefined)) {
      const f = v.tent.front === true
      const b = v.tent.back === true
      lines.push(`    (tenting${f ? " front" : ""}${b ? " back" : ""}${!f && !b ? " none" : ""})`)
      if ((v.tent.front === undefined) !== (v.tent.back === undefined)) notes.add("A via that says its tenting for one side only is written with the other side not tented: KiCad 9 has words for both sides together.")
    }
    if (v.stack) {
      if ("inner" in v.stack) lines.push(`    (padstack (mode front_inner_back) (layer "Inner" (size ${mm6(v.stack.inner)})) (layer "B.Cu" (size ${mm6(v.stack.back)})))`)
      else {
        const sizes: string[] = []
        for (let k = 1; k < stackCount; k++) {
          const l: CopperLayer = k === stackCount - 1 ? "bottom" : (`in${k}` as CopperLayer)
          sizes.push(`(layer ${quote(kicadLayerName(l))} (size ${mm6((v.stack as { layers: Partial<Record<CopperLayer, number>> }).layers[l] ?? v.diameter)}))`)
        }
        lines.push(`    (padstack (mode custom) ${sizes.join(" ")})`)
      }
    }
    lines.push(`    (net ${net})`, `    (uuid ${id})`, "  )")
    copperItems.push(lines.join("\n"))
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
    zoneItems.push(zoneText(project, z, options.fills ?? [], netCode, boardRings, newUuid, toFile, inFile))
    if (isWholeBoardPour(z)) notes.add("A pour that covers the whole board is written as a polygon of the board's box, which is what it is.")
  }
  if ([...project.zones, ...(project.footprints ?? []).flatMap((f) => f.zones ?? [])].some((z) => z.hatchAt)) notes.add("KiCad 9 has no hatch position (KiCad 10's `property` of a zone): it stays in the project and is not written, so KiCad 9 starts the hatch grid at the board's origin.")

  // ---------- groups ----------
  const groupItems: string[] = []
  const groupUuid = new Map((project.groups ?? []).map((g) => [g.id, newUuid()]))
  for (const [id, u] of groupUuid) members.set(id, [u])
  for (const g of project.groups ?? ([] as PcbGroup[])) {
    const ids = g.members.flatMap((m) => members.get(m) ?? [])
    if (!ids.length) continue
    // X21: a tuning pattern is KiCad 9's `generated`; a via stack or via stitching is KiCad 10's, so its vias are written and the group is a plain one.
    if (g.gen?.kind === "tuning_pattern") groupItems.push(indent(generatorBlock(g, groupUuid.get(g.id)!, ids, kicadLayerName(g.gen.layer), toFile), "  ").join("\n"))
    else {
      groupItems.push(indent(groupBlock(g, groupUuid.get(g.id)!, ids), "  ").join("\n"))
      if (g.gen) notes.add("A via stack or via stitching (KiCad 10's generated items) is written as a plain group of its vias: a KiCad 9 file has no such item, so its settings stay in the project.")
    }
  }
  if ((project.groups ?? []).some((g) => g.lib !== undefined)) notes.add("A group made from a design block keeps no link to it: KiCad 9's file has no node for one.")

  // ---------- the header ----------
  const rules = project.rules
  const stack = project.board.stack
  const setup: string[] = [`    (pad_to_mask_clearance ${mm6(rules.maskExpansion)})`]
  if (rules.maskMinWidth !== undefined) setup.push(`    (solder_mask_min_width ${mm6(rules.maskMinWidth)})`)
  if (rules.pasteExpansion) setup.push(`    (pad_to_paste_clearance ${mm6(rules.pasteExpansion)})`)
  if (rules.pasteRatio !== undefined) setup.push(`    (pad_to_paste_clearance_ratio ${round(rules.pasteRatio, 6)})`)
  if (rules.maskBridgesInParts) setup.push("    (allow_soldermask_bridges_in_footprints yes)")
  // The sides vias are tented on, in KiCad 9's words; every KiCad 9 board says so.
  const tentFront = rules.tentSides ? rules.tentSides.front : rules.tentVias
  const tentBack = rules.tentSides ? rules.tentSides.back : rules.tentVias
  setup.push(`    (tenting${tentFront ? " front" : ""}${tentBack ? " back" : ""}${!tentFront && !tentBack ? " none" : ""})`)
  const carry = project.kicad
  if (stack?.rows?.length || stack?.finish !== undefined || stack?.edgePlating !== undefined || stack?.dielectricConstraints !== undefined || stack?.edgeConnector) setup.push(...stackupText(stack!))
  if (rules.minMicroVia || rules.microVia || rules.microViasAllowed !== undefined || rules.blindBuriedViasAllowed !== undefined) notes.add("The sizes and permissions KiCad 5 kept for micro, blind and buried vias are not in a KiCad 9 board file: the smallest micro via is in the project file, and the rest stay in the project.")
  // The origins of the position and drill files and of the grid, and the plot dialog's settings, as the file had them.
  if (carry?.auxOrigin) setup.push(`    (aux_axis_origin ${mm6(carry.auxOrigin.x)} ${mm6(carry.auxOrigin.y)})`)
  if (carry?.gridOrigin) setup.push(`    (grid_origin ${mm6(carry.gridOrigin.x)} ${mm6(carry.gridOrigin.y)})`)
  if (carry?.plot) setup.push(`    ${carry.plot}`)
  const kept = (project.properties ?? []).filter((p) => !PROVENANCE_PROPERTIES.has(p.key))
  // (The board's title block comments are `Comment 1` and the schematic's are `Comment1`: a project from both has the second as well, and neither is a board property.)
  const isTitleBlock = (key: string) => /^(Title|Date|Rev|Company|Comment ?\d+)$/.test(key)
  const title: string[] = []
  const fileKey = (key: string) => (key === "Title" ? "title" : key === "Date" ? "date" : key === "Rev" ? "rev" : key === "Company" ? "company" : "")
  // The title is the project's name unless the board gave one that is not (then it is a property, kept in its place).
  if (!kept.some((p) => p.key === "Title") && project.name !== "Imported KiCad board") title.push(`    (title ${quote(project.name)})`)
  const commented = new Set<string>()
  for (const p of kept) {
    if (!isTitleBlock(p.key)) continue
    const m = p.key.match(/^Comment ?(\d+)$/)
    if (m && commented.has(m[1])) continue
    if (m) commented.add(m[1])
    title.push(m ? `    (comment ${m[1]} ${quote(p.value)})` : `    (${fileKey(p.key)} ${quote(p.value)})`)
  }
  const boardProps = kept.filter((p) => !isTitleBlock(p.key))

  // The copper layers from the front to the back as the project has them (X1), numbered as KiCad 9 numbers them (`F.Cu` 0, `B.Cu` 2, `In1.Cu` 4 and by twos), then the fixed layers.
  // What the file called its layers and which it hid (`KicadCarry.layers`), by name, and for the copper layers by place (KiCad 5 named them in the table's second word).
  const carried = project.kicad?.layers ?? []
  const carriedBy = new Map(carried.map((r) => [r.name, r]))
  const carriedCopper = carried.filter((r) => ["signal", "power", "mixed", "jumper"].includes(r.type))
  const copperRows = copperLayers(project.board).map((l, i) => {
    const n = l === "top" ? 0 : l === "bottom" ? 2 : 2 + 2 * Number(l.slice(2))
    const row = stack?.copper[i]
    const own = carriedCopper[i]
    const kicadName = kicadLayerName(l)
    const user = row?.label ?? own?.user ?? (own && own.name !== kicadName ? own.name : undefined)
    return `    (${n} ${quote(kicadName)} ${row?.type ?? "signal"}${user ? ` ${quote(user)}` : ""})`
  })
  const fixedRows = LAYER_TABLE.filter(([, name]) => name !== "F.Cu" && name !== "B.Cu").map(([n, name, type, std]) => {
    const row = carriedBy.get(name)
    // The name the file gave the layer, or KiCad's own name for it.
    const user = row?.user ?? std
    return `    (${n} ${quote(name)} ${type}${user ? ` ${quote(user)}` : ""})`
  })
  const layerRows: string[] = [...copperRows, ...fixedRows]
  const extra = [...layers]
    .flatMap((name) => {
      const n = userLayerNumber9(name)
      return n === null ? [] : [{ n, name }]
    })
    .sort((a, b) => a.n - b.n)
  const written = new Set(extra.map((e) => e.name))
  for (const e of extra) layerRows.push(`    (${e.n} ${quote(e.name)} user${carriedBy.get(e.name)?.user ? ` ${quote(carriedBy.get(e.name)!.user!)}` : ""})`)
  // A layer the file switched on that has nothing drawn on it (`User.1`) stays on.
  for (const r of carried) {
    const n = userLayerNumber9(r.name)
    if (n !== null && !written.has(r.name)) layerRows.push(`    (${n} ${quote(r.name)} user${r.user ? ` ${quote(r.user)}` : ""})`)
  }

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
    `  (paper ${project.kicad?.paper ?? '"A4"'})`,
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
    ...embeddedFontLines(project.fonts?.files.filter((f) => f.owner === undefined) ?? [], project.fonts?.board === true, options.pictures, "  ", missingFonts),
    ")",
    "",
  ]
  if (missingFonts.n) notes.add(`${missingFonts.n} embedded font file${missingFonts.n === 1 ? " was" : "s were"} left out: the bytes are not in this account's files, so there is nothing to write. The text that names ${missingFonts.n === 1 ? "it keeps" : "them keeps"} its font's name and its outlines, and KiCad finds the font on its own computer.`)
  if (project.fonts?.files.length) notes.add("Fonts the board embeds are written back as the file stored them.")
  if (project.texts.some((t) => t.outline) || project.components.some((c) => c.texts?.some((t) => t.outline))) notes.add("Text in a TrueType font keeps the outlines KiCad drew it with (`render_cache`) while it keeps its content, size, weight, slant, justification and font; a text edited in one of those has none, and KiCad draws it again from the font.")
  notes.add("The board is written natively in KiCad 9's format: footprints with their pads, drawings, text, groups and 3D models of KiCad's stock library, the outline, tracks, vias, zones, dimensions and reference images, each as KiCad has them. The design rules and net classes are in the project file.")
  return { text: body.join("\n"), notes: [...notes] }
}

/** One row of the stackup as KiCad 9 writes it: the fields it has, a dielectric's further sublayers after `addsublayer`. KiCad 11's `spec_frequency` and `dielectric_model` have no place in a KiCad 9 file. */
function stackRowText(row: StackRow): string {
  const field = (r: Omit<StackRow, "name" | "type" | "sub">): string[] => {
    const f: string[] = []
    if (r.color !== undefined) f.push(`(color ${quote(r.color)})`)
    if (r.thickness !== undefined) f.push(`(thickness ${mm6(r.thickness)}${r.locked ? " locked" : ""})`)
    if (r.material !== undefined) f.push(`(material ${quote(r.material)})`)
    if (r.epsilonR !== undefined) f.push(`(epsilon_r ${r.epsilonR})`)
    if (r.lossTangent !== undefined) f.push(`(loss_tangent ${r.lossTangent})`)
    return f
  }
  const parts = [...field(row), ...(row.sub ?? []).flatMap((s) => ["addsublayer", ...field(s)])]
  return `      (layer ${quote(row.name)} (type ${quote(row.type)})${parts.length ? ` ${parts.join(" ")}` : ""})`
}

/** The board's stackup (`setup (stackup ...)`) as a KiCad 9 board writes it. */
function stackupText(stack: NonNullable<Project["board"]["stack"]>): string[] {
  const out = ["    (stackup", ...(stack.rows ?? []).map(stackRowText)]
  if (stack.finish) out.push(`      (copper_finish ${quote(stack.finish)})`)
  if (stack.dielectricConstraints !== undefined) out.push(`      (dielectric_constraints ${stack.dielectricConstraints ? "yes" : "no"})`)
  if (stack.edgeConnector) out.push(`      (edge_connector ${stack.edgeConnector})`)
  if (stack.edgePlating) out.push("      (edge_plating yes)")
  out.push("    )")
  return out
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
