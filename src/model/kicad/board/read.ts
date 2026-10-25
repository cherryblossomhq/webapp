import { legacyArc, rotK } from "./geometry"
import { newReport, type ImportReport } from "./report"
import { atomsOf, decodeBytes, flagOf, kid, kids, KicadReadError, nameOf, numAt, parseSexpr, strAt, type List } from "./sexpr"
import type {
  Era,
  KicadArcTrack,
  KicadBoard,
  KicadFootprint,
  KicadModel,
  KicadNet,
  KicadPad,
  KicadSegment,
  KicadShape,
  KicadText,
  KicadVia,
  KicadZone,
  LayerRow,
  LegacyNetClass,
  Pt,
  ShapeKind,
} from "./types"

// The reader: a KiCad board of any release (stamps 3 to 11) into `KicadBoard`. It goes by the
// token and the layer table wherever KiCad's own parser does, and by the version stamp only where
// the file format really changed with it. The numbered switches are the rows of section 3.3 of
// docs/kicad-import.md, each with its test in tests/kicad-board-read.test.ts.

/** The newest stamp in the KiCad source this reader was written against (pcb_io_kicad_sexpr.h, line 225). */
export const NEWEST_KNOWN_STAMP = 20261018

/** Switch 3: `gr_arc` and `fp_arc` hold a centre and a sweep up to this stamp. */
export const LEGACY_ARC_UNTIL = 20210925
/**
 * Switch 5 and 6: from this stamp a footprint has `(transform ...)` for `(at ...)`, and its zones and
 * points are in the footprint's frame, not the board's. Text angles did not change (switch 7): they
 * are the board-frame angle before and after, `parsePCB_TEXT_effects` keeps them so (docs, section 10).
 */
export const FIRST_FP_AFFINE_TRANSFORM = 20260616
/** Switch 13: before this stamp an overbar is `~DSS~`, from it `~{DSS}`. */
export const OVERBAR_NOTATION_FROM = 20210606
/** Switch 8: a zero local clearance or margin means "inherit" in files up to this stamp. */
export const ZERO_MEANS_INHERIT_UNTIL = 20240201
/** Switch 10: a footprint tagged "net tie" is a net tie up to this stamp. */
export const LEGACY_NET_TIES_UNTIL = 20220815
/** Switch 11: no `attr` means through-hole before this stamp. */
export const FIRST_EXPLICIT_ATTR = 20200826
/** Switch 19: from this stamp a net has no number. */
export const NO_NET_CODES_FROM = 20251028

/** KiCad's release for a stamp (docs/kicad-import.md, 3.2). */
export function eraOf(stamp: number | null): Era {
  if (stamp === null) return "unknown"
  if (stamp <= 3) return "kicad3"
  if (stamp <= 4) return "kicad4"
  if (stamp <= 20171130) return "kicad5"
  if (stamp < 20211014) return "pre6-nightly"
  if (stamp <= 20211014) return "kicad6"
  if (stamp <= 20221018) return "kicad7"
  if (stamp <= 20240108) return "kicad8"
  if (stamp <= 20241229) return "kicad9"
  if (stamp <= 20260206) return "kicad10"
  return "kicad11-dev"
}

/** What an embedded file is, by its `(type ...)` and its name: a model, a drawing sheet, a font, a datasheet, an image. */
export function embeddedKind(name: string, type: string): string {
  const ext = /\.([A-Za-z0-9_]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  if (type === "model" || ["step", "stp", "wrl", "wrz", "iges", "igs", "stl", "x3d"].includes(ext)) return "3D model"
  if (type === "worksheet" || ext === "kicad_wks") return "Drawing sheet (worksheet)"
  if (type === "font" || ["ttf", "otf", "ttc", "woff", "woff2"].includes(ext)) return "Font"
  if (type === "datasheet" || ext === "pdf") return "Datasheet"
  if (["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "tif", "tiff"].includes(ext)) return "Image"
  return "File"
}

/** Net names as the user reads them: KiCad writes `/` inside a name as `{slash}`. */
export const decodeNetName = (raw: string) => raw.replace(/\{slash\}/g, "/")

/**
 * KiCad's `ConvertToNewOverbarNotation` (common/string_utils.cpp, line 87), which its board parser
 * applies to net names, net class members and text in files before stamp 20210606: `~DSS~` is
 * `~{DSS}`, `~~` is a tilde, and a text that already says `~{` is left alone.
 */
export function convertOverbar(old: string): string {
  // Don't get tripped up by the legacy empty-string token.
  if (old === "~") return old
  let out = ""
  let inOverbar = false
  for (let i = 0; i < old.length; i++) {
    const ch = old[i]
    if (ch === "~") {
      if (old[i + 1] === "~") {
        if (old[i + 2] === "{") {
          // This way the subsequent opening curly brace will not start an overbar.
          out += "~~{}"
          continue
        }
        // Two subsequent tildes mean a tilde.
        out += "~"
        i++
        continue
      }
      // Could mean the user wants "{" with an overbar, but more likely this is a double conversion: bail out.
      if (old[i + 1] === "{") return old
      if (inOverbar) {
        out += "}"
        inOverbar = false
      } else {
        out += "~{"
        inOverbar = true
      }
      continue
    }
    // Spaces were used to terminate an overbar as well.
    if ((ch === " " || ch === "}" || ch === ")") && inOverbar) {
      out += "}"
      inOverbar = false
    }
    out += ch
  }
  // Explicitly end the overbar even if there was no terminating "~".
  if (inOverbar) out += "}"
  return out
}

export interface ReadResult {
  board: KicadBoard
  /** The text that was read, for the node accounting. */
  text: string
  report: ImportReport
}

const COPPER_TYPES = new Set(["signal", "power", "mixed", "jumper"])
const SHAPE_KINDS = new Set<string>(["line", "arc", "circle", "rect", "poly", "curve", "bbox"])

/** Everything the reader types; any other root list goes to `others` by its token. */
const TYPED_ROOT = new Set(["version", "generator", "generator_version", "host", "general", "layers", "setup", "net", "net_class", "footprint", "module", "segment", "arc", "via", "zone", "gr_text", "title_block", "property", "paper", "page"])

function kicadKind(text: string): string | null {
  const head = text.slice(0, 400).replace(/^﻿/, "").trimStart()
  const legacy = /^PCBNEW-BOARD\s+Version\s+(\d+)/i.exec(head)
  if (legacy) return `legacy:${legacy[1]}`
  if (/^\(kicad_pcb\b/.test(head)) return "board"
  if (/^\(kicad_sch\b/.test(head)) return "schematic"
  if (/^\(kicad_symbol_lib\b/.test(head)) return "symbol-library"
  if (/^\((footprint|module)\b/.test(head)) return "footprint"
  if (/^EESchema/i.test(head)) return "legacy-schematic"
  return null
}

/** Reads a `.kicad_pcb`, as text or bytes. Throws `KicadReadError` for a file that is not a board it can read at all. */
export function readKicadBoard(input: string | Uint8Array): ReadResult {
  const report = newReport()
  let text: string
  if (typeof input === "string") text = input
  else {
    const decoded = decodeBytes(input)
    text = decoded.text
    for (const why of decoded.notes) report.entries.push({ code: "encoding", severity: "note", object: "the file", why })
  }
  if (!text.trim()) throw new KicadReadError("empty", "The file is empty.")
  const kind = kicadKind(text)
  if (kind?.startsWith("legacy:")) {
    throw new KicadReadError(
      "legacy-board",
      `This is a KiCad board from before version 4 (a PCBNEW-BOARD Version ${kind.slice(7)} text file). It is not supported: open it in KiCad 5 or later and save it again.`,
    )
  }
  if (kind && kind !== "board") {
    const what = { schematic: "a KiCad schematic", "symbol-library": "a KiCad symbol library", footprint: "a single KiCad footprint", "legacy-schematic": "a KiCad 5 schematic" }[kind] ?? "another KiCad file"
    throw new KicadReadError("not-a-board", `This is ${what}, not a board (.kicad_pcb).`)
  }
  const root = parseSexpr(text)
  const tree = root.find((n): n is List => nameOf(n) === "kicad_pcb")
  if (!tree) throw new KicadReadError("not-a-board", "This file has no (kicad_pcb ...) list, so it is not a KiCad board.")
  const board = readBoard(tree, report)
  return { board, text, report }
}

// ---------- reading ----------

/** What went wrong with a value in one place, counted for the report. */
class Issues {
  readonly bad = new Map<string, number>()
  note(what: string) {
    this.bad.set(what, (this.bad.get(what) ?? 0) + 1)
  }
}

function readBoard(tree: List, report: ImportReport): KicadBoard {
  const issues = new Issues()
  const versionNode = kid(tree, "version")
  const stamp = versionNode ? numAt(versionNode, 1, NaN) : NaN
  const version = Number.isFinite(stamp) ? stamp : null
  const era = eraOf(version)
  if (version === null) report.entries.push({ code: "no-version", severity: "note", object: "the file", why: "The file has no (version N) stamp, so it is read by its tokens alone." })
  else if (version > NEWEST_KNOWN_STAMP) {
    report.entries.push({ code: "newer-format", severity: "note", object: "the file", why: `The file's version stamp ${version} is newer than the newest this importer was written against (${NEWEST_KNOWN_STAMP}). It is read by its tokens, and anything new is named in this report.` })
  }
  const stampAtMost = (limit: number) => version !== null && version <= limit
  const stampBefore = (limit: number) => version !== null && version < limit
  // A file without a stamp is read as the newest format, as KiCad reads one.
  const stampFrom = (first: number) => version === null || version >= first
  /** Text as KiCad's parser reads it: an old overbar `~DSS~` is `~{DSS}` (switch 13). */
  const overbar = (text: string) => (stampBefore(OVERBAR_NOTATION_FROM) ? convertOverbar(text) : text)

  // ---- layers: copper is every row typed signal, power, mixed or jumper; front is the first, back the last (switch 1) ----
  const layers: LayerRow[] = []
  for (const row of kid(tree, "layers")?.slice(1) ?? []) {
    if (!Array.isArray(row)) continue
    const ordinal = Number(row[0])
    if (!Number.isFinite(ordinal) || typeof row[1] !== "string") {
      issues.note("a layer row that is not (number name type)")
      continue
    }
    layers.push({ ordinal, name: row[1], type: typeof row[2] === "string" ? row[2] : "", ...(typeof row[3] === "string" ? { userName: row[3] } : {}) })
  }
  const copperNames = layers.filter((l) => COPPER_TYPES.has(l.type)).map((l) => l.name)
  const general = kid(tree, "general")
  const declared = copperNames.length || numAt(kid(general, "layers"), 1, 0)
  const copper = { names: copperNames, front: copperNames[0] ?? "F.Cu", back: copperNames[copperNames.length - 1] ?? "B.Cu" }

  // ---- nets (switches 13 and 19) ----
  const nets: KicadNet[] = []
  const byCode = new Map<number, KicadNet>()
  for (const n of kids(tree, "net")) {
    const hasCode = n.length >= 3 || (typeof n[1] === "string" && /^-?\d+$/.test(n[1]) && !stampFrom(NO_NET_CODES_FROM))
    const raw = overbar(n.length >= 3 ? (strAt(n, 2) ?? "") : hasCode ? "" : (strAt(n, 1) ?? ""))
    const code = hasCode ? Number(n[1]) : null
    const net: KicadNet = { code, raw, name: decodeNetName(raw) }
    nets.push(net)
    if (code !== null) byCode.set(code, net)
  }
  const overbarOpt = (text: string | undefined) => (text === undefined ? undefined : overbar(text))
  /** The net of an object: its `(net 3 "GND")`, `(net 3)` or, from stamp 20251028, `(net "GND")`; null for no net. */
  const netOf = (node: List): { raw: string; name: string } | null => {
    const k = kid(node, "net")
    if (!k) return null
    let raw: string | undefined
    if (k.length >= 3) raw = overbarOpt(strAt(k, 2))
    else if (!stampFrom(NO_NET_CODES_FROM) || /^-?\d+$/.test(strAt(k, 1) ?? "") && byCode.has(Number(k[1]))) {
      const code = Number(k[1])
      if (code === 0) return null
      raw = byCode.get(code)?.raw
      if (raw === undefined) issues.note("a net number the net table does not list")
    } else raw = overbarOpt(strAt(k, 1))
    if (!raw) return null
    return { raw, name: decodeNetName(raw) }
  }

  // ---- setup ----
  const setup: Record<string, number> = {}
  const userTraceWidths: number[] = []
  for (const c of kid(tree, "setup")?.slice(1) ?? []) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    const v = Number(c[1])
    if (typeof c[1] === "string" && Number.isFinite(v)) {
      if (c[0] === "user_trace_width") userTraceWidths.push(v)
      else setup[c[0]] = v
    }
  }

  const padsOnSilk = ["true", "yes"].includes(strAt(kid(kid(kid(tree, "setup"), "pcbplotparams"), "padsonsilk"), 1) ?? "")

  // ---- properties: the title block, and board properties (KiCad 8) ----
  const properties: { key: string; value: string }[] = []
  const title = kid(tree, "title_block")
  for (const c of title?.slice(1) ?? []) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    if (c[0] === "comment") {
      const v = strAt(c, 2)
      if (v) properties.push({ key: `Comment ${strAt(c, 1) ?? ""}`.trim(), value: v })
    } else {
      const v = strAt(c, 1)
      if (v) properties.push({ key: c[0][0].toUpperCase() + c[0].slice(1), value: v })
    }
  }
  for (const p of kids(tree, "property")) {
    const k = strAt(p, 1)
    const v = strAt(p, 2)
    if (k && v !== undefined) properties.push({ key: k, value: v })
  }

  // ---- legacy net classes (switch 20) ----
  const netClasses: LegacyNetClass[] = kids(tree, "net_class").map((c) => ({
    name: strAt(c, 1) ?? "",
    description: strAt(c, 2) ?? "",
    clearance: numAt(kid(c, "clearance"), 1, NaN),
    traceWidth: numAt(kid(c, "trace_width"), 1, NaN),
    viaDiameter: numAt(kid(c, "via_dia"), 1, NaN),
    viaDrill: numAt(kid(c, "via_drill"), 1, NaN),
    uviaDiameter: numAt(kid(c, "uvia_dia"), 1, NaN),
    uviaDrill: numAt(kid(c, "uvia_drill"), 1, NaN),
    nets: kids(c, "add_net").map((a) => decodeNetName(overbar(strAt(a, 1) ?? ""))),
  }))

  // ---- points and numbers ----
  const pt = (node: List | undefined, what: string): Pt => {
    const x = Number(strAt(node, 1))
    const y = Number(strAt(node, 2))
    if (!node || !Number.isFinite(x) || !Number.isFinite(y)) {
      issues.note(what)
      return { x: 0, y: 0 }
    }
    return { x, y }
  }
  const ptOf = (node: List, name: string, what: string): Pt | undefined => {
    const k = kid(node, name)
    return k ? pt(k, what) : undefined
  }
  const points = (pts: List | undefined, what: string): Pt[] => kids(pts, "xy").map((p) => pt(p, what))

  // ---- shapes (graphics) ----
  const shapeOf = (c: List, kind: ShapeKind): KicadShape => {
    const layer = strAt(kid(c, "layer"), 1) ?? strAt(kid(c, "layers"), 1) ?? ""
    const stroke = kid(c, "stroke")
    const width = stroke ? numAt(kid(stroke, "width"), 1, 0) : numAt(kid(c, "width"), 1, 0)
    const dashType = stroke ? strAt(kid(stroke, "type"), 1) : undefined
    const fillNode = kid(c, "fill")
    // Switch 9: with no `fill` token, polygons off Edge.Cuts are filled, and zero-width rectangles and circles.
    const fillWord = fillNode ? (strAt(fillNode, 1) ?? strAt(kid(fillNode, "type"), 1)) : undefined
    const filled = fillNode ? fillWord === "solid" || fillWord === "yes" || fillWord === "true" || (fillWord !== undefined && fillWord !== "none" && fillWord !== "no" && fillWord !== "false") : kind === "poly" ? layer !== "Edge.Cuts" : (kind === "rect" || kind === "circle") && width === 0
    const s: KicadShape = { kind, layer, width, filled, dash: dashType && dashType !== "default" && dashType !== "solid" ? dashType : null, locked: flagOf(c, "locked"), node: c }
    const where = `a ${kind} on ${layer || "no layer"}`
    if (kind === "line" || kind === "rect" || kind === "bbox") {
      s.start = ptOf(c, "start", where)
      s.end = ptOf(c, "end", where)
    } else if (kind === "circle") {
      s.center = ptOf(c, "center", where)
      s.end = ptOf(c, "end", where)
    } else if (kind === "arc") {
      if (stampAtMost(LEGACY_ARC_UNTIL) && !kid(c, "mid")) {
        const centre = ptOf(c, "start", where)
        const first = ptOf(c, "end", where)
        const sweep = numAt(kid(c, "angle"), 1, 0)
        if (centre && first) {
          const a = legacyArc(centre, first, sweep)
          s.start = a.start
          s.mid = a.mid
          s.end = a.end
          s.center = centre
          s.legacySweep = sweep
        }
      } else {
        s.start = ptOf(c, "start", where)
        s.mid = ptOf(c, "mid", where)
        s.end = ptOf(c, "end", where)
      }
    } else if (kind === "poly" || kind === "curve") {
      const pts = kid(c, "pts")
      s.pts = points(pts, where)
      if (kids(pts, "arc").length) s.hasArcs = true
    }
    return s
  }

  const textOf = (c: List, kind: string): KicadText => {
    // `(fp_text reference R1 (at ..))` has the kind first and the text second; `(property "Reference" "R1")` and `(gr_text "x")` the text first.
    const isFpText = c[0] === "fp_text"
    const text = overbar(isFpText ? (strAt(c, 2) ?? "") : c[0] === "property" ? (strAt(c, 2) ?? "") : (strAt(c, 1) ?? ""))
    const at = kid(c, "at")
    // Switch 7: the angle is the board-frame angle as stored, in every release (the position moved into the footprint's frame in 20260616, the angle did not).
    const angle = numAt(at, 3, 0)
    const effects = kid(c, "effects")
    const font = kid(effects, "font")
    const size = kid(font, "size")
    const justify = atomsOf(kid(effects, "justify"))
    return {
      kind,
      text,
      at: at ? pt(at, `the text "${text}"`) : { x: 0, y: 0 },
      angle,
      layer: strAt(kid(c, "layer"), 1) ?? "",
      w: numAt(size, 1, 1),
      h: numAt(size, 2, 1),
      thickness: numAt(kid(font, "thickness"), 1, 0),
      hide: flagOf(c, "hide") || flagOf(effects, "hide"),
      mirror: justify.includes("mirror"),
      // `(at x y a unlocked)` (parser line 4551) and `(unlocked yes)` (line 4607) turn keep-upright off; a footprint's text is upright by default.
      keepUpright: !(atomsOf(at).includes("unlocked") || flagOf(c, "unlocked")),
      justify,
      node: c,
    }
  }

  const zoneOf = (z: List, fp: { at: Pt; angle: number } | null): KicadZone => {
    const layerNames = kid(z, "layers") ? atomsOf(kid(z, "layers")) : kid(z, "layer") ? [strAt(kid(z, "layer"), 1) ?? ""] : []
    const keepoutNode = kid(z, "keepout")
    const restricted = (k: string) => strAt(kid(keepoutNode, k), 1) === "not_allowed"
    const keepout = keepoutNode ? { tracks: restricted("tracks"), vias: restricted("vias"), pads: restricted("pads"), copperpour: restricted("copperpour"), footprints: restricted("footprints") } : null
    const anyRestricted = !!keepout && Object.values(keepout).some(Boolean)
    const kind = kid(z, "placement") ? "placement" : keepout ? (anyRestricted ? "keepout" : "rule-area") : kid(z, "teardrop") || kid(kid(z, "attr"), "teardrop") ? "teardrop" : "copper"
    const pts = kid(kid(z, "polygon"), "pts")
    let polygon = points(pts, "a zone outline")
    // Switch 6: a footprint's zone is in the board frame before stamp 20260616.
    if (fp && !stampFrom(FIRST_FP_AFFINE_TRANSFORM)) {
      polygon = polygon.map((p) => {
        const r = rotK(p.x - fp.at.x, p.y - fp.at.y, -fp.angle)
        return { x: r.x, y: r.y }
      })
    }
    const net = netOf(z)
    const named = strAt(kid(z, "net_name"), 1)
    return {
      net: net ? net.name : named ? decodeNetName(overbar(named)) : null,
      netRaw: net ? net.raw : named ? overbar(named) : null,
      layers: layerNames,
      name: strAt(kid(z, "name"), 1) ?? "",
      priority: numAt(kid(z, "priority"), 1, 0),
      kind,
      keepout,
      polygon,
      hasArcs: kids(pts, "arc").length > 0,
      filled: kids(z, "filled_polygon").length > 0,
      locked: flagOf(z, "locked"),
      inFootprint: fp !== null,
      node: z,
    }
  }

  const isBack = (layerName: string) => layerName === copper.back || layerName === "B.Cu"

  // ---- footprints ----
  const footprints: KicadFootprint[] = []
  for (const fp of tree) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const atNode = kid(fp, "at")
    const transform = kid(fp, "transform")
    let at: Pt
    let angle: number
    let scale = 1
    const transformed = !atNode && !!transform
    if (transformed) {
      at = pt(kid(transform, "translate"), "a footprint's position")
      angle = numAt(kid(transform, "rotate"), 1, 0)
      scale = numAt(kid(transform, "scale"), 1, 1)
    } else {
      at = pt(atNode, "a footprint's position")
      angle = numAt(atNode, 3, 0)
    }
    const place = { at, angle }
    const layerName = strAt(kid(fp, "layer"), 1) ?? ""
    const pads: KicadPad[] = []
    const texts: KicadText[] = []
    const props: { key: string; value: string }[] = []
    let ref = ""
    let value = ""
    for (const c of fp) {
      if (!Array.isArray(c)) continue
      const head = c[0]
      if (head === "pad") pads.push(padOf(c))
      else if (head === "fp_text") {
        const kind = strAt(c, 1) ?? "user"
        const t = textOf(c, kind)
        texts.push(t)
        if (kind === "reference") ref = t.text
        else if (kind === "value") value = t.text
      } else if (head === "property") {
        const key = strAt(c, 1) ?? ""
        const val = overbar(strAt(c, 2) ?? "")
        props.push({ key, value: val })
        if (key === "Reference") ref = val
        else if (key === "Value") value = val
        texts.push(textOf(c, key === "Reference" ? "reference" : key === "Value" ? "value" : "user"))
      }
    }
    function padOf(c: List): KicadPad {
      const number = strAt(c, 1) ?? ""
      const at = kid(c, "at")
      const size = kid(c, "size")
      const drillNode = kid(c, "drill")
      let drill: KicadPad["drill"] = null
      if (drillNode) {
        const words = atomsOf(drillNode)
        const nums = words.map(Number).filter(Number.isFinite)
        const oval = words.includes("oval")
        const a = nums[0] ?? 0
        const b = oval ? (nums[1] ?? a) : a
        const off = kid(drillNode, "offset")
        drill = { oval, w: a, h: b, offset: off ? pt(off, `pad ${number} of ${ref || "a footprint"}`) : null }
      }
      const net = netOf(c)
      const rd = kid(c, "rect_delta")
      const pad: KicadPad = {
        number,
        type: strAt(c, 2) ?? "",
        shape: strAt(c, 3) ?? "",
        at: at ? pt(at, `pad ${number} of ${ref || "a footprint"}`) : { x: 0, y: 0 },
        angle: numAt(at, 3, 0),
        hasAngle: !!at && at.length > 3,
        w: numAt(size, 1, 0),
        h: numAt(size, 2, 0),
        layers: atomsOf(kid(c, "layers")),
        drill,
        net: net ? net.name : null,
        netRaw: net ? net.raw : null,
        node: c,
      }
      const pf = strAt(kid(c, "pinfunction"), 1)
      const pt_ = strAt(kid(c, "pintype"), 1)
      if (pf) pad.pinFunction = pf
      if (pt_) pad.pinType = pt_
      if (rd) pad.rectDelta = pt(rd, `pad ${number} of ${ref || "a footprint"}`)
      const rr = kid(c, "roundrect_rratio")
      if (rr) pad.roundrectRatio = numAt(rr, 1, 0)
      if (!size || !Number.isFinite(Number(strAt(size, 1))) || !Number.isFinite(Number(strAt(size, 2)))) issues.note(`a pad with no readable size`)
      return pad
    }

    const attrNode = kid(fp, "attr")
    const attr = atomsOf(attrNode)
    const tags = strAt(kid(fp, "tags"), 1) ?? ""
    const netTies: string[][] = []
    for (const g of kids(fp, "net_tie_pad_groups")) for (const s of g.slice(1)) if (typeof s === "string") netTies.push(s.split(",").map((x) => x.trim()).filter(Boolean))
    // Jumper pad groups: each child list is a group, its pad numbers written as the list's own words (`("1" "2")`).
    const jumperGroups: string[][] = []
    for (const g of kids(fp, "jumper_pad_groups")) {
      for (const s of g.slice(1)) if (Array.isArray(s)) jumperGroups.push(s.filter((x): x is string => typeof x === "string"))
    }
    // Switch 10: up to stamp 20220815 a footprint whose tags start "net tie" is one group of all its pads.
    if (stampAtMost(LEGACY_NET_TIES_UNTIL) && tags.startsWith("net tie") && pads.length) netTies.push(pads.map((p) => p.number))
    const models: KicadModel[] = kids(fp, "model").map((m) => {
      const xyz = (name: string, fallback: number): { x: number; y: number; z: number } => {
        const holder = kid(m, name)
        const v = kid(holder, "xyz")
        return v ? { x: numAt(v, 1, fallback), y: numAt(v, 2, fallback), z: numAt(v, 3, fallback) } : { x: fallback, y: fallback, z: fallback }
      }
      // Switch 16: `(at (xyz ...))` is inches and `(offset (xyz ...))` millimetres, whatever the stamp: KiCad's parser multiplies an `at` by 25.4 (parse3DModel, parser lines 981-989) and the later of the two wins.
      let offset = { x: 0, y: 0, z: 0 }
      for (const h of m) {
        if (!Array.isArray(h) || (h[0] !== "at" && h[0] !== "offset")) continue
        const o = kid(h, "xyz")
        const k = h[0] === "at" ? 25.4 : 1
        if (o) offset = { x: numAt(o, 1) * k, y: numAt(o, 2) * k, z: numAt(o, 3) * k }
      }
      return {
        path: strAt(m, 1) ?? "",
        offset,
        scale: xyz("scale", 1),
        rotate: xyz("rotate", 0),
        hidden: flagOf(m, "hide"),
        node: m,
      }
    })
    const shapes: KicadShape[] = []
    for (const c of fp) {
      if (!Array.isArray(c) || typeof c[0] !== "string" || !c[0].startsWith("fp_")) continue
      const kind = c[0].slice(3)
      if (SHAPE_KINDS.has(kind)) shapes.push(shapeOf(c, kind as ShapeKind))
    }
    footprints.push({
      name: strAt(fp, 1) ?? "",
      ref,
      value,
      at,
      angle,
      transformed,
      scale,
      side: isBack(layerName) ? "bottom" : "top",
      locked: flagOf(fp, "locked"),
      placed: flagOf(fp, "placed"),
      attr,
      hasAttr: !!attrNode,
      throughHole: attr.includes("through_hole") || (!attrNode && stampBefore(FIRST_EXPLICIT_ATTR)),
      descr: strAt(kid(fp, "descr"), 1) ?? "",
      tags,
      path: strAt(kid(fp, "path"), 1) ?? "",
      sheetname: strAt(kid(fp, "sheetname"), 1) ?? "",
      sheetfile: strAt(kid(fp, "sheetfile"), 1) ?? "",
      props,
      pads,
      models,
      texts,
      shapes,
      zones: kids(fp, "zone").map((z) => zoneOf(z, place)),
      netTies,
      jumperGroups,
      jumperDuplicates: flagOf(fp, "duplicate_pad_numbers_are_jumpers"),
      node: fp,
    })
  }

  // ---- tracks, vias, zones, graphics ----
  const lockedBit = (c: List) => {
    // Switch (status): bit 0x40000 is KiCad 4 and 5's track lock.
    const st = strAt(kid(c, "status"), 1)
    const v = st === undefined ? NaN : parseInt(st, 16)
    return Number.isFinite(v) && (v & 0x40000) !== 0
  }
  const segments: KicadSegment[] = kids(tree, "segment").map((c) => ({
    start: ptOf(c, "start", "a track segment") ?? { x: 0, y: 0 },
    end: ptOf(c, "end", "a track segment") ?? { x: 0, y: 0 },
    width: numAt(kid(c, "width"), 1, 0),
    layer: strAt(kid(c, "layer"), 1) ?? "",
    net: netOf(c)?.name ?? null,
    netRaw: netOf(c)?.raw ?? null,
    locked: flagOf(c, "locked") || lockedBit(c),
    node: c,
  }))
  const arcTracks: KicadArcTrack[] = kids(tree, "arc").map((c) => ({
    start: ptOf(c, "start", "an arc track") ?? { x: 0, y: 0 },
    mid: ptOf(c, "mid", "an arc track") ?? { x: 0, y: 0 },
    end: ptOf(c, "end", "an arc track") ?? { x: 0, y: 0 },
    width: numAt(kid(c, "width"), 1, 0),
    layer: strAt(kid(c, "layer"), 1) ?? "",
    net: netOf(c)?.name ?? null,
    netRaw: netOf(c)?.raw ?? null,
    locked: flagOf(c, "locked") || lockedBit(c),
    node: c,
  }))
  const vias: KicadVia[] = kids(tree, "via").map((c) => {
    // Switch 4: a bare `blind`, `micro` or `buried` after `via`.
    const kind = c.includes("buried") ? "buried" : c.includes("blind") ? "blind" : c.includes("micro") ? "micro" : "through"
    return {
      at: ptOf(c, "at", "a via") ?? { x: 0, y: 0 },
      size: numAt(kid(c, "size"), 1, 0),
      drill: numAt(kid(c, "drill"), 1, 0),
      layers: atomsOf(kid(c, "layers")),
      kind,
      net: netOf(c)?.name ?? null,
      netRaw: netOf(c)?.raw ?? null,
      locked: flagOf(c, "locked") || lockedBit(c),
      node: c,
    }
  })
  const zones = kids(tree, "zone").map((z) => zoneOf(z, null))
  const shapes: KicadShape[] = []
  const texts: KicadText[] = []
  const others: Record<string, List[]> = {}
  for (const c of tree) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    const head = c[0]
    if (head.startsWith("gr_") && SHAPE_KINDS.has(head.slice(3))) shapes.push(shapeOf(c, head.slice(3) as ShapeKind))
    else if (head === "gr_text") texts.push(textOf(c, "board"))
    else if (!TYPED_ROOT.has(head)) (others[head] ??= []).push(c)
  }

  // ---- embedded files are named, one report entry each (founder decision: no models packed in the file for now) ----
  const embedded: { file: string; owner: string; what: string }[] = []
  const embed = (f: List, owner: string) => embedded.push({ file: strAt(kid(f, "name"), 1) ?? "(unnamed)", owner, what: embeddedKind(strAt(kid(f, "name"), 1) ?? "", strAt(kid(f, "type"), 1) ?? "") })
  for (const e of kids(tree, "embedded_files")) for (const f of kids(e, "file")) embed(f, "the board")
  for (const fp of footprints) for (const e of kids(fp.node, "embedded_files")) for (const f of kids(e, "file")) embed(f, fp.ref || fp.name)
  for (const e of embedded) {
    report.entries.push({ code: "embedded-file", severity: "not-brought", object: `${e.file} (in ${e.owner})`, why: `${e.what} embedded in the KiCad file was not brought in.` })
  }

  // ---- values that did not read are a refusal: a guessed number moves a part ----
  for (const [what, count] of issues.bad) {
    report.entries.push({ code: "unreadable-value", severity: "refused", object: what, why: "A number in the file could not be read, so the geometry would be a guess. Nothing was imported.", count })
  }
  if (footprints.some((f) => f.transformed && Math.abs(f.scale - 1) > 1e-9)) {
    report.entries.push({ code: "scaled-footprint", severity: "refused", object: "a footprint with a scale other than 1", why: "KiCad scales footprints from stamp 20260616; this importer does not." })
  }

  return {
    version,
    era,
    generator: strAt(kid(tree, "generator"), 1) ?? null,
    generatorVersion: strAt(kid(tree, "generator_version"), 1) ?? null,
    host: kid(tree, "host") ? atomsOf(kid(tree, "host")).slice(0, 2).join(" ") : null,
    thickness: kid(general, "thickness") ? numAt(kid(general, "thickness"), 1, 1.6) : null,
    properties,
    layers,
    copper,
    copperLayerCount: declared,
    setup,
    userTraceWidths,
    nets,
    padsOnSilk,
    netClasses,
    footprints,
    segments,
    arcTracks,
    vias,
    zones,
    shapes,
    texts,
    others,
    tree,
  }
}
