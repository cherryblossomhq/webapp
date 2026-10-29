import { legacyArc, rotK } from "./geometry"
import { backdrillOf, generatorOf, netChainsOf, postMachiningOf, setupProtectionOf, viaProtectionOf } from "./drilling"
import { decodeBase64, imageFacts } from "../../../lib/imageFacts"
import { newReport, type ImportReport } from "./report"
import { atomsOf, decodeBytes, flagOf, kid, kids, KicadReadError, nameOf, numAt, parseSexpr, strAt, type List } from "./sexpr"
import type {
  Era,
  KicadArcTrack,
  KicadBoard,
  KicadDimension,
  KicadFontFile,
  KicadFootprint,
  KicadGenerator,
  KicadGroup,
  KicadImage,
  KicadModel,
  KicadNet,
  KicadPad,
  KicadPadLayer,
  KicadPadStack,
  KicadPoint,
  KicadSegment,
  KicadStackup,
  KicadStackupRow,
  KicadShape,
  KicadTarget,
  KicadText,
  KicadVariant,
  KicadVia,
  KicadZone,
  KicadZoneSeg,
  LayerRow,
  LegacyNetClass,
  PadLocal,
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
const SHAPE_KINDS = new Set<string>(["line", "arc", "circle", "rect", "poly", "curve", "bbox", "ellipse", "ellipse_arc"])

/** Everything the reader types; any other root list goes to `others` by its token. */
const TYPED_ROOT = new Set(["version", "generator", "generator_version", "host", "general", "layers", "setup", "net", "net_class", "footprint", "module", "segment", "arc", "via", "zone", "gr_text", "gr_text_box", "target", "title_block", "property", "paper", "page", "dimension", "group", "image", "generated", "net_chains", "variants", "point"])

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


/** The newest stamp whose `tenting` words are an explicit choice for each side (KiCad 9 and earlier: `(tenting front)` says the back is not tented, `(tenting none)` says neither is). Later files write `(front yes) (back no)`, where a side not named follows the board. */
export const TENTING_WORDS_UNTIL = 20241229

/**
 * A `tenting` node of a via or a pad: each side as the file says it. KiCad's parser reads the words (`front`, `back`, `none`) up to KiCad 9
 * as a choice for both sides (parseTenting, 9.0.0 `:5799-5813`: a side not named is false), and a later file as `(front yes) (back no)`, where a
 * side that is not named is no choice (parseFrontBackOptBool, 10.0.0 `:6315-6321`). The stamp tells which a file is.
 */
export function tentingOf(node: List | undefined, stamp: number | null): { front?: boolean; back?: boolean } | undefined {
  if (!node) return undefined
  const parts = node.slice(1)
  const lists = parts.filter((x): x is List => Array.isArray(x))
  if (lists.length) {
    const out: { front?: boolean; back?: boolean } = {}
    for (const l of lists) {
      if (l[0] !== "front" && l[0] !== "back") continue
      // `none` is no choice (KiCad 10's `parseOptBool`: `std::nullopt`), the side follows the board; KiCad 10 writes it for every side a via or pad does not set.
      if (l[1] === "none") continue
      out[l[0]] = l[1] === undefined || l[1] === "yes" || l[1] === "true"
    }
    return out
  }
  const words = parts.filter((x): x is string => typeof x === "string")
  if (stamp === null || stamp <= TENTING_WORDS_UNTIL) return { front: words.includes("front"), back: words.includes("back") }
  const out: { front?: boolean; back?: boolean } = {}
  if (words.includes("front")) out.front = true
  if (words.includes("back")) out.back = true
  return out
}

/** The board's `setup (tenting ...)`: the sides the file tents, or null when it has none (KiCad's default is both). A side not named is not tented (10.0.0 `:2717-2722`, and what the writer meant). */
export function setupTenting(setup: List | undefined): { front: boolean; back: boolean } | null {
  const node = kid(setup, "tenting")
  if (!node) return null
  const t = tentingOf(node, 0)
  return { front: t?.front === true, back: t?.back === true }
}

const yesOf = (w: string | List | undefined) => w === undefined || w === "yes" || w === "true"

/** The stackup of `setup (stackup ...)`, read as KiCad reads it (parseBoardStackup, 10.0.0 `:2090`): rows in order, a layer listed twice is a stackup appended twice and ends the rows, at most 128. */
export function readStackup(setup: List | undefined): KicadStackup | null {
  const node = kid(setup, "stackup")
  if (!node) return null
  const out: KicadStackup = { rows: [], dropped: 0, node }
  const seen = new Set<string>()
  let duplicated = false
  const sublayer = (fields: List[]): Omit<KicadStackupRow, "name" | "type" | "sub"> => {
    const r: Omit<KicadStackupRow, "name" | "type" | "sub"> = {}
    for (const f of fields) {
      switch (f[0]) {
        case "thickness": {
          const v = numAt(f, 1, NaN)
          if (Number.isFinite(v)) r.thickness = v
          if (f.includes("locked")) r.locked = true
          break
        }
        case "material":
          if (strAt(f, 1) !== undefined) r.material = strAt(f, 1)
          break
        case "epsilon_r":
          if (Number.isFinite(numAt(f, 1, NaN))) r.epsilonR = numAt(f, 1)
          break
        case "loss_tangent":
          if (Number.isFinite(numAt(f, 1, NaN))) r.lossTangent = numAt(f, 1)
          break
        case "spec_frequency":
          if (Number.isFinite(numAt(f, 1, NaN))) r.specFreq = numAt(f, 1)
          break
        case "dielectric_model":
          if (f[1] === "constant" || f[1] === "djordjevic_sarkar") r.model = f[1]
          break
        case "color":
          if (strAt(f, 1) !== undefined) r.color = strAt(f, 1)
          break
      }
    }
    return r
  }
  for (const c of node.slice(1)) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    if (c[0] === "copper_finish") out.finish = strAt(c, 1) ?? ""
    else if (c[0] === "edge_plating") out.edgePlating = yesOf(c[1])
    else if (c[0] === "dielectric_constraints") out.dielectricConstraints = yesOf(c[1])
    else if (c[0] === "edge_connector") out.edgeConnector = c[1] === "yes" ? "yes" : c[1] === "bevelled" ? "bevelled" : "none"
    else if (c[0] === "castellated_pads") out.castellated = yesOf(c[1])
    else if (c[0] === "layer") {
      const name = strAt(c, 1) ?? ""
      if (seen.has(name) && /\.(Cu|SilkS|Mask|Paste)$/.test(name)) duplicated = true
      else seen.add(name)
      if (duplicated || out.rows.length >= 128) {
        out.dropped++
        continue
      }
      // The first sublayer is the fields before the first `addsublayer`; each later one follows one.
      const parts: List[][] = [[]]
      let type = ""
      for (const f of c.slice(2)) {
        if (f === "addsublayer") parts.push([])
        else if (Array.isArray(f) && f[0] === "type") type = strAt(f, 1) ?? ""
        else if (Array.isArray(f) && typeof f[0] === "string") parts[parts.length - 1].push(f)
      }
      const [first, ...rest] = parts.map(sublayer)
      out.rows.push({ name, type, ...first, sub: rest })
    }
  }
  return out
}

/** The layers a via's `padstack` gives a diameter: `Inner` is the inner layers, any other is a copper layer's own name. */
export function viaStackOf(node: List | undefined): KicadVia["stack"] | undefined {
  if (!node) return undefined
  const mode = strAt(kid(node, "mode"), 1)
  const sizes: { name: string; size: number }[] = []
  for (const l of kids(node, "layer")) {
    const size = numAt(kid(l, "size"), 1, NaN)
    if (Number.isFinite(size)) sizes.push({ name: strAt(l, 1) ?? "", size })
  }
  return { mode: mode === "custom" ? "custom" : "front_inner_back", sizes }
}

/** X22: a via's or pad's backdrills and post-machining, and a via's own protection (a pad has none of the latter), each present only where the file says it. */
function drilling(c: List, pad = false): Partial<Pick<KicadVia, "protect" | "backdrill" | "tertiary" | "post">> {
  const out: Partial<Pick<KicadVia, "protect" | "backdrill" | "tertiary" | "post">> = {}
  if (!pad) {
    const protect = viaProtectionOf(c)
    if (protect) out.protect = protect
  }
  const backdrill = backdrillOf(kid(c, "backdrill"))
  if (backdrill) out.backdrill = backdrill
  const tertiary = backdrillOf(kid(c, "tertiary_drill"))
  if (tertiary) out.tertiary = tertiary
  const post = postMachiningOf(c)
  if (post) out.post = post
  return out
}

/** The mode a via's words leave its copper in, as KiCad's parser applies them in order: `remove_unused_layers` (on) removes all, `keep_end_layers` (on) keeps the ends, `start_end_only` is KiCad 10's own mode; a word that says no changes nothing. */
export function viaUnusedOf(via: List): KicadVia["unused"] | undefined {
  let mode: KicadVia["unused"] | undefined
  for (const w of via) {
    if (!Array.isArray(w)) continue
    const on = yesOf(w[1])
    if (w[0] === "remove_unused_layers" && on) mode = "remove"
    else if (w[0] === "keep_end_layers" && on) mode = "keepEnds"
    else if (w[0] === "start_end_only" && on) mode = "startEnd"
  }
  return mode
}

/** The mode a pad's words leave its copper in: each word sets it (`remove_unused_layers` yes removes all, no keeps all; `keep_end_layers` yes keeps the ends, no removes all), the later word wins (parsePAD, 10.0.0 `:6300-6313`). */
export function padUnusedOf(pad: List): "remove" | "keepEnds" | undefined {
  let mode: "remove" | "keepEnds" | undefined
  for (const w of pad) {
    if (!Array.isArray(w)) continue
    const on = yesOf(w[1])
    if (w[0] === "remove_unused_layers") mode = on ? "remove" : undefined
    else if (w[0] === "keep_end_layers") mode = on ? "keepEnds" : "remove"
  }
  return mode
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
    // The words after the type: the name a person gave the layer, and `hide` (a word of KiCad's parser, not a name).
    const after = row.slice(3).filter((w): w is string => typeof w === "string")
    const named = after.find((w) => w !== "hide")
    layers.push({ ordinal, name: row[1], type: typeof row[2] === "string" ? row[2] : "", ...(named !== undefined ? { userName: named } : {}), ...(after.includes("hide") ? { hide: true as const } : {}) })
  }
  const copperNames = layers.filter((l) => COPPER_TYPES.has(l.type)).map((l) => l.name)
  // KiCad has a front, a back and 30 inner copper layers (`BOARD_STACKUP`'s limit, `MAX_CU_LAYERS` is 32): a file with more is not one KiCad wrote.
  if (copperNames.length > 32) throw new KicadReadError("not-a-board", `This board lists ${copperNames.length} copper layers, and KiCad boards have at most 32 (a front, a back and 30 inner layers), so this is not a board KiCad wrote.`)
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
  const netOf = (node: List, unknown?: string[]): { raw: string; name: string } | null => {
    const k = kid(node, "net")
    if (!k) return null
    let raw: string | undefined
    if (k.length >= 3) raw = overbarOpt(strAt(k, 2))
    else if (!stampFrom(NO_NET_CODES_FROM) || /^-?\d+$/.test(strAt(k, 1) ?? "") && byCode.has(Number(k[1]))) {
      const code = Number(k[1])
      if (code === 0) return null
      raw = byCode.get(code)?.raw
      // On a drawing KiCad logs "Invalid net ID" and loads it with no net, so the caller may take the number instead of the file being unreadable.
      if (raw === undefined) {
        if (unknown) unknown.push(String(k[1]))
        else issues.note("a net number the net table does not list")
      }
    } else raw = overbarOpt(strAt(k, 1))
    if (!raw) return null
    return { raw, name: decodeNetName(raw) }
  }

  // ---- setup ----
  const setup: Record<string, number> = {}
  const setupWords: Record<string, string> = {}
  const userTraceWidths: number[] = []
  const userVias: { diameter: number; drill: number }[] = []
  const userDiffPairs: { width: number; gap: number; viaGap?: number }[] = []
  for (const c of kid(tree, "setup")?.slice(1) ?? []) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    // the lists of sizes offered while routing: a via is a diameter and a drill, a differential pair a width, a gap and, in KiCad 5, a via gap
    if (c[0] === "user_via") {
      userVias.push({ diameter: Number(c[1]), drill: Number(c[2]) })
      continue
    }
    if (c[0] === "user_diff_pair") {
      userDiffPairs.push({ width: Number(c[1]), gap: Number(c[2]), ...(c.length > 3 ? { viaGap: Number(c[3]) } : {}) })
      continue
    }
    const v = Number(c[1])
    if (typeof c[1] === "string" && Number.isFinite(v)) {
      if (c[0] === "user_trace_width") userTraceWidths.push(v)
      else setup[c[0]] = v
    } else if (typeof c[1] === "string" && c.length === 2 && !Array.isArray(c[1])) setupWords[c[0]] = c[1]
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
    ...(kid(c, "diff_pair_width") ? { diffPairWidth: numAt(kid(c, "diff_pair_width"), 1, NaN) } : {}),
    ...(kid(c, "diff_pair_gap") ? { diffPairGap: numAt(kid(c, "diff_pair_gap"), 1, NaN) } : {}),
    nets: kids(c, "add_net").map((a) => decodeNetName(overbar(strAt(a, 1) ?? ""))),
    netsRaw: kids(c, "add_net").map((a) => overbar(strAt(a, 1) ?? "")),
    missing: ["clearance", "trace_width", "via_dia", "via_drill", "uvia_dia", "uvia_drill"].filter((k) => !kid(c, k)),
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

  // ---- X23: PCB points and the variants of a board (KiCad 10) ----
  /** A `point` node. Switch 6: a footprint's point is in the board frame before stamp 20260616, and the footprint's own after. */
  const pointOf = (c: List, fp: { at: Pt; angle: number } | null): KicadPoint => {
    let at = ptOf(c, "at", "a PCB point") ?? { x: 0, y: 0 }
    if (fp && !stampFrom(FIRST_FP_AFFINE_TRANSFORM)) at = rotK(at.x - fp.at.x, at.y - fp.at.y, -fp.angle)
    return { at, size: numAt(kid(c, "size"), 1, 0), layer: strAt(kid(c, "layer"), 1) ?? "", node: c }
  }
  /** A flag a `variant` node says, in every spelling `flagOf` knows; undefined when it does not say it (the footprint's own stands). */
  const variantFlag = (v: List, name: string): boolean | undefined => (kid(v, name) || v.includes(name) ? flagOf(v, name) : undefined)
  const variantOf = (v: List): KicadVariant => {
    const out: KicadVariant = {
      name: strAt(kid(v, "name"), 1) ?? "",
      fields: kids(v, "field").flatMap((f) => {
        const name = strAt(kid(f, "name"), 1) ?? ""
        return name ? [{ name, value: strAt(kid(f, "value"), 1) ?? "" }] : []
      }),
    }
    const flags = { dnp: "dnp", excludeFromBom: "exclude_from_bom", excludeFromPos: "exclude_from_pos_files", excludeFromSim: "exclude_from_sim" } as const
    for (const [key, word] of Object.entries(flags) as [keyof typeof flags, string][]) {
      const on = variantFlag(v, word)
      if (on !== undefined) out[key] = on
    }
    return out
  }

  // ---- shapes (graphics) ----
  const shapeOf = (c: List, kind: ShapeKind): KicadShape => {
    const layerList = kid(c, "layers") ? atomsOf(kid(c, "layers")) : []
    const layer = strAt(kid(c, "layer"), 1) ?? layerList[0] ?? ""
    const stroke = kid(c, "stroke")
    const width = stroke ? numAt(kid(stroke, "width"), 1, 0) : numAt(kid(c, "width"), 1, 0)
    const dashType = stroke ? strAt(kid(stroke, "type"), 1) : undefined
    const fillNode = kid(c, "fill")
    // Switch 9: with no `fill` token, polygons off Edge.Cuts are filled, and zero-width rectangles and circles.
    const fillWord = fillNode ? (strAt(fillNode, 1) ?? strAt(kid(fillNode, "type"), 1)) : undefined
    const solid = fillWord === "solid" || fillWord === "yes" || fillWord === "true"
    const hatched = fillWord !== undefined && /hatch/.test(fillWord)
    const filled = fillNode ? solid : kind === "poly" ? layer !== "Edge.Cuts" : (kind === "rect" || kind === "circle") && width === 0
    // Only copper has a net: on any other layer a drawing's net means nothing and is ignored (accounted as not needed), and a number the
    // net table does not list on copper is no net, as KiCad loads it.
    const onCopper = (layerList.length ? layerList : [layer]).some((n) => copperNames.includes(n) || /\.Cu$/.test(n))
    const badNet: string[] = []
    const net = onCopper ? netOf(c, badNet) : null
    const mask = kid(c, "solder_mask_margin")
    const s: KicadShape = {
      kind,
      layer,
      layers: layerList.length ? layerList : layer ? [layer] : [],
      width,
      filled,
      hatched,
      dash: dashType && dashType !== "default" && dashType !== "solid" ? dashType : null,
      locked: flagOf(c, "locked"),
      net: net?.name ?? null,
      netRaw: net?.raw ?? null,
      ...(badNet.length ? { badNet: badNet[0] } : {}),
      radius: numAt(kid(c, "radius"), 1, 0),
      ...(mask ? { maskMargin: numAt(mask, 1, 0) } : {}),
      ending: !!(kid(c, "start_shape") || kid(c, "end_shape")),
      colored: !!(stroke && kid(stroke, "color")),
      node: c,
    }
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
      if (kind === "poly") {
        s.polyItems = (pts ?? []).slice(1).flatMap((n): NonNullable<KicadShape["polyItems"]> => {
          if (!Array.isArray(n)) return []
          if (n[0] === "xy") return [{ xy: pt(n, where) }]
          if (n[0] === "arc") return [{ arc: { start: ptOf(n, "start", where) ?? { x: 0, y: 0 }, mid: ptOf(n, "mid", where) ?? { x: 0, y: 0 }, end: ptOf(n, "end", where) ?? { x: 0, y: 0 } } }]
          return []
        })
      }
    } else if (kind === "ellipse" || kind === "ellipse_arc") {
      const num = (name: string) => numAt(kid(c, name), 1, NaN)
      s.ellipse = {
        center: ptOf(c, "center", where) ?? { x: 0, y: 0 },
        major: num("major_radius"),
        minor: num("minor_radius"),
        rotation: numAt(kid(c, "rotation_angle"), 1, 0),
        ...(kind === "ellipse_arc" ? { start: numAt(kid(c, "start_angle"), 1, 0), end: numAt(kid(c, "end_angle"), 1, 0) } : {}),
      }
      if (!Number.isFinite(s.ellipse.major) || !Number.isFinite(s.ellipse.minor)) issues.note(where)
    }
    return s
  }

  /** A number of the file that KiCad clamps to a text size (`SetTextSize` with its minimum and maximum, eda_text.h:61-62). */
  const textSize = (v: number) => Math.min(250, Math.max(0.001, v))
  const DEFAULT_TEXT_SIZE = 1.524
  /** KiCad's `%R` and `%V` in text are `${REFERENCE}` and `${VALUE}` (10.0.0 parser lines 3748-3749, master 4484-4485); a field's own text (a `property`) is not converted. */
  const legacyVars = (text: string) => text.replace(/%V/g, "${VALUE}").replace(/%R/g, "${REFERENCE}")
  /** A `(border yes)` or `(border)` flag. */
  const flagOrYes = (n: List) => n[1] === undefined || n[1] === "yes" || n[1] === "true"

  /** The outlines KiCad cached for a text drawn in a TrueType font (`render_cache`): what it drew them for, and each polygon's rings in whole nanometres, the board's frame with y up. */
  const renderCacheOf = (c: List, text: string): KicadText["renderCache"] => {
    const node = kid(c, "render_cache")
    if (!node) return null
    const whole = (v: string | undefined) => {
      const n = Number(v)
      if (v === undefined || !Number.isFinite(n)) {
        issues.note(`a text outline of "${text}"`)
        return 0
      }
      return Math.round(n * 1e6) || 0
    }
    const polygons = kids(node, "polygon").map((poly) =>
      kids(poly, "pts").map((pts) => {
        const ring: number[] = []
        for (const p of kids(pts, "xy")) ring.push(whole(strAt(p, 1)), 0 - whole(strAt(p, 2)))
        return ring
      }),
    )
    return { text: strAt(node, 1) ?? "", angle: numAt(node, 2, 0) || 0, polygons }
  }

  /**
   * A text object: `(fp_text reference R1 (at ..))`, `(property "Reference" "R1" (at ..))`, `(gr_text "x" (at ..))`, or a
   * text box. The first number of a size is its height and the second its width (`parseEDA_TEXT`, 10.0.0 parser line 780, master 817).
   */
  const textOf = (c: List, kind: string, defaults: { layer: string } = { layer: "" }): KicadText => {
    // `(fp_text reference R1 (at ..))` has the kind first and the text second; `(property "Reference" "R1")` and `(gr_text "x")` the text first.
    const head = c[0]
    const isFpText = head === "fp_text"
    const isBox = head === "gr_text_box" || head === "fp_text_box"
    const first = c[1] === "locked" ? 2 : 1
    const raw = isFpText ? (strAt(c, 2) ?? "") : head === "property" ? (strAt(c, 2) ?? "") : (strAt(c, first) ?? "")
    const text = overbar(head === "property" || isBox ? raw : legacyVars(raw))
    const at = kid(c, "at")
    // Switch 7: the angle is the board-frame angle as stored, in every release (the position moved into the footprint's frame in 20260616, the angle did not).
    const angle = isBox ? numAt(kid(c, "angle"), 1, 0) : numAt(at, 3, 0)
    const effects = kid(c, "effects")
    const font = kid(effects, "font")
    const size = kid(font, "size")
    const justify = atomsOf(kid(effects, "justify"))
    const layerNode = kid(c, "layer")
    const stroke = kid(c, "stroke")
    const marginsNode = kid(c, "margins")
    const start = kid(c, "start")
    const end = kid(c, "end")
    const box: KicadText["box"] = isBox
      ? {
          start: start ? pt(start, `the text box "${text}"`) : { x: 0, y: 0 },
          end: end ? pt(end, `the text box "${text}"`) : { x: 0, y: 0 },
          hasOutline: !!kid(c, "pts"),
          // From stamp 20230825 the border is its own flag, on unless the file says no (the text box starts with it on, pcb_textbox.cpp:53 of 10.0.0); before, it is there when the stroke has a width (10.0.0 parser line 4250, master 5019).
          border: kid(c, "border") ? flagOrYes(kid(c, "border")!) : stampBefore(20230825) ? !!stroke && kid(stroke, "width") !== undefined && numAt(kid(stroke, "width"), 1, 0) >= 0 : true,
          strokeWidth: stroke && kid(stroke, "width") ? numAt(kid(stroke, "width"), 1, 0) : null,
          margins: marginsNode ? [numAt(marginsNode, 1), numAt(marginsNode, 2), numAt(marginsNode, 3), numAt(marginsNode, 4)] : null,
        }
      : null
    const fontAtoms = atomsOf(font)
    const flagIn = (name: string) => fontAtoms.includes(name) || flagOf(font, name)
    return {
      kind,
      text,
      at: at ? pt(at, `the text "${text}"`) : { x: 0, y: 0 },
      angle,
      layer: strAt(layerNode, 1) ?? defaults.layer,
      // `(size h w)`: the first number is the height, the second the width; absent, both are 60 mils.
      h: size ? textSize(numAt(size, 1, 0)) : DEFAULT_TEXT_SIZE,
      w: size ? textSize(numAt(size, 2, 0)) : DEFAULT_TEXT_SIZE,
      thickness: numAt(kid(font, "thickness"), 1, 0),
      hide: flagOf(c, "hide") || flagOf(effects, "hide"),
      mirror: justify.includes("mirror"),
      // `(at x y a unlocked)` (10.0.0 parser line 3811, master 4551) and `(unlocked yes)` (3867, master 4607) turn keep-upright off; a footprint's text is upright by default.
      keepUpright: !(atomsOf(at).includes("unlocked") || flagOf(c, "unlocked")),
      justify,
      // A text says `(layer "F.Cu" knockout)` (parser 10.0.0 lines 3828-3835); a text box has its own node, `(knockout yes)` (KiCad 10, parser lines 4190-4200), and its layer node takes no word after the name.
      knockout: isBox ? flagOf(c, "knockout") : layerNode ? layerNode.includes("knockout") || flagOf(layerNode, "knockout") : false,
      bold: flagIn("bold"),
      italic: flagIn("italic"),
      face: strAt(kid(font, "face"), 1) ?? null,
      lineSpacing: kid(font, "line_spacing") ? numAt(kid(font, "line_spacing"), 1, 1) : 1,
      href: strAt(kid(effects, "href"), 1) ?? null,
      locked: flagOf(c, "locked") || c[1] === "locked",
      renderCache: renderCacheOf(c, text),
      field: head === "property" ? (strAt(c, 1) ?? "") : null,
      box,
      node: c,
    }
  }

  const zoneOf = (z: List, fp: { at: Pt; angle: number } | null): KicadZone => {
    const layerNames = kid(z, "layers") ? atomsOf(kid(z, "layers")) : kid(z, "layer") ? [strAt(kid(z, "layer"), 1) ?? ""] : []
    const keepoutNode = kid(z, "keepout")
    const restricted = (k: string) => strAt(kid(keepoutNode, k), 1) === "not_allowed"
    const keepout = keepoutNode ? { tracks: restricted("tracks"), vias: restricted("vias"), pads: restricted("pads"), copperpour: restricted("copperpour"), footprints: restricted("footprints") } : null
    const anyRestricted = !!keepout && Object.values(keepout).some(Boolean)
    // KiCad 9 writes a `placement` node on every rule area, switched off (`enabled no`) on an ordinary keepout: only a switched on one places parts (X20).
    // The parser (`parseZONE`, 9.0.0 line 6911, 10.0.0 line 8100) takes the last of `sheetname`, `component_class` and `group` as the source (a sheet with no name by default).
    const placementNode = kid(z, "placement")
    let placement: KicadZone["placement"] = null
    if (placementNode) {
      placement = { enabled: strAt(kid(placementNode, "enabled"), 1) === "yes", by: "sheet", name: "" }
      for (const c of placementNode.slice(1)) {
        if (!Array.isArray(c)) continue
        if (c[0] === "sheetname") placement = { ...placement, by: "sheet", name: strAt(c, 1) ?? "" }
        else if (c[0] === "component_class") placement = { ...placement, by: "class", name: strAt(c, 1) ?? "" }
        else if (c[0] === "group") placement = { ...placement, by: "group", name: strAt(c, 1) ?? "" }
      }
    }
    const kind = keepout ? (anyRestricted ? "keepout" : "rule-area") : placementNode ? "rule-area" : kid(z, "teardrop") || kid(kid(z, "attr"), "teardrop") ? "teardrop" : "copper"
    const pts = kid(kid(z, "polygon"), "pts")
    const ringOf = (node: List): KicadZoneSeg[] => {
      const segs: KicadZoneSeg[] = []
      for (const c of node.slice(1)) {
        if (!Array.isArray(c)) continue
        if (c[0] === "xy") segs.push({ kind: "xy", at: pt(c, "a zone outline") })
        else if (c[0] === "arc") segs.push({ kind: "arc", start: pt(kid(c, "start"), "a zone outline arc"), mid: pt(kid(c, "mid"), "a zone outline arc"), end: pt(kid(c, "end"), "a zone outline arc") })
      }
      return segs
    }
    let rings = kids(z, "polygon").map((poly) => ringOf(kid(poly, "pts") ?? []))
    let polygon = points(pts, "a zone outline")
    // Switch 6: a footprint's zone is in the board frame before stamp 20260616.
    if (fp && !stampFrom(FIRST_FP_AFFINE_TRANSFORM)) {
      const back = (p: Pt): Pt => {
        const r = rotK(p.x - fp.at.x, p.y - fp.at.y, -fp.angle)
        return { x: r.x, y: r.y }
      }
      polygon = polygon.map(back)
      rings = rings.map((r) => r.map((s) => (s.kind === "xy" ? { kind: "xy" as const, at: back(s.at) } : { kind: "arc" as const, start: back(s.start), mid: back(s.mid), end: back(s.end) })))
    }
    const connectNode = kid(z, "connect_pads")
    const connectWord = connectNode ? (atomsOf(connectNode).find((a) => a === "yes" || a === "no" || a === "thru_hole_only") ?? "thermal") : "thermal"
    const fillNode = kid(z, "fill")
    const modeWord = strAt(kid(fillNode, "mode"), 1)
    const smoothWord = strAt(kid(fillNode, "smoothing"), 1)
    const teardropType = strAt(kid(kid(kid(z, "attr"), "teardrop"), "type"), 1)
    // A copper zone is on the net its `net_name` says: KiCad takes the net of the number only while the table's name for it is the one the zone
    // gives, and otherwise looks the zone's name up (an empty name is no net) or makes a net of that name (parser `parseZONE`, `netnameFromfile`).
    const byNumber = netOf(z)
    const named = strAt(kid(z, "net_name"), 1)
    const wanted = named === undefined ? undefined : overbar(named)
    const copperZone = !keepout && !placementNode
    let net = byNumber
    if (copperZone && wanted !== undefined && byNumber?.raw !== wanted) {
      const found = nets.find((n) => n.raw === wanted)
      net = found ? { raw: found.raw, name: found.name } : wanted === "" ? null : { raw: wanted, name: decodeNetName(wanted) }
    }
    return {
      net: net ? net.name : null,
      netRaw: net ? net.raw : null,
      layers: layerNames,
      name: strAt(kid(z, "name"), 1) ?? "",
      priority: numAt(kid(z, "priority"), 1, 0),
      uuid: strAt(kid(z, "uuid"), 1) ?? strAt(kid(z, "tstamp"), 1),
      kind,
      placement,
      keepout,
      polygon,
      rings,
      hasArcs: rings.some((r) => r.some((s) => s.kind === "arc")),
      filled: kids(z, "filled_polygon").length > 0,
      connect: connectWord as KicadZone["connect"],
      clearance: connectNode && kid(connectNode, "clearance") ? numAt(kid(connectNode, "clearance"), 1, 0) : null,
      minThickness: kid(z, "min_thickness") ? numAt(kid(z, "min_thickness"), 1, 0) : null,
      thermalGap: kid(fillNode, "thermal_gap") ? numAt(kid(fillNode, "thermal_gap"), 1, 0) : null,
      thermalBridge: kid(fillNode, "thermal_bridge_width") ? numAt(kid(fillNode, "thermal_bridge_width"), 1, 0) : null,
      smoothing: smoothWord === "chamfer" || smoothWord === "fillet" ? smoothWord : "none",
      radius: numAt(kid(fillNode, "radius"), 1, 0),
      outlineHatch: (() => {
        const h = kid(z, "hatch")
        const style = strAt(h, 1)
        return h && (style === "none" || style === "edge" || style === "full") ? { style, pitch: numAt(h, 2, 0.5) } : null
      })(),
      islandMode: numAt(kid(fillNode, "island_removal_mode"), 1, 0),
      islandArea: kid(fillNode, "island_area_min") ? numAt(kid(fillNode, "island_area_min"), 1, 0) : null,
      fillMode: modeWord === "hatch" ? "hatch" : modeWord === "thieving" ? "thieving" : "polygon",
      teardrop: teardropType === "padvia" || teardropType === "track_end" ? teardropType : null,
      strokedFill: !["no", "false"].includes(strAt(kid(z, "filled_areas_thickness"), 1) ?? ""),
      locked: flagOf(z, "locked"),
      inFootprint: fp !== null,
      node: z,
    }
  }

  const isBack = (layerName: string) => layerName === copper.back || layerName === "B.Cu"

  // ---- footprints ----
  /** The id of an object: `(uuid ...)` or, before KiCad 7, `(tstamp ...)`. */
  const uuidOf = (c: List): string | null => strAt(kid(c, "uuid"), 1) ?? strAt(kid(c, "tstamp"), 1) ?? null

  /**
   * A group (`parseGROUP`, parser line 8285 of master): a name and the word `locked` before its lists, then its id (`id` from format 20200811 to 20231214, `uuid` after),
   * `(locked yes)`, the design block it came from (`lib_id`) and the ids of its `members`.
   */
  const groupOf = (c: List): KicadGroup => {
    const members: string[] = []
    for (const m of kids(c, "members")) for (const x of m.slice(1)) if (typeof x === "string") members.push(x)
    return {
      name: typeof c[1] === "string" && c[1] !== "locked" ? c[1] : "",
      uuid: strAt(kid(c, "uuid"), 1) ?? strAt(kid(c, "id"), 1) ?? null,
      locked: c.slice(1).some((x) => x === "locked") || flagOf(c, "locked"),
      libId: strAt(kid(c, "lib_id"), 1)?.replace(/\{slash\}/g, "/") ?? null,
      members,
      node: c,
    }
  }

  /** The units a KiCad 5 dimension's text names (`FetchUnitsFromString`): inches 0, mils 1, millimetres 2, none named 3 (automatic, shown as millimetres), another unit 4. */
  const unitsOfText = (text: string): number => {
    const trimmed = text.trim()
    let at = 0
    while (at < trimmed.length && /[0-9.,+-]/.test(trimmed[at])) at++
    const unit = trimmed.slice(at).trimStart().slice(0, 2).toLowerCase()
    if (unit === "um" || unit === "\u00b5m" || unit === "\u03bcm" || unit === "cm" || unit === "de" || unit === "ra" || unit === "fs" || unit === "ps") return 4
    if (unit === "mm") return 2
    if (unit === "mi" || unit === "th") return 1
    if (unit === "in" || unit === "\"") return 0
    return 3
  }

  /** A dimension: the constructor's own values for its kind, then the file's over them (`parseDIMENSION`, parser line 5593 of master; the constructors of pcb_dimension.cpp). */
  const dimensionOf = (c: List): KicadDimension => {
    let i = 1
    let locked = false
    if (c[i] === "locked") {
      locked = true
      i++
    }
    // A number before the first list is the value old files saved; it is skipped.
    if (typeof c[i] === "string") i++
    const first = c[i]
    const legacy = Array.isArray(first) && first[0] === "width"
    const typeWord = legacy ? "aligned" : (strAt(kid(c, "type"), 1) ?? "aligned")
    const known = typeWord === "aligned" || typeWord === "orthogonal" || typeWord === "leader" || typeWord === "center" || typeWord === "radial"
    if (!known) issues.note(`a dimension of the unknown type ${typeWord}`)
    const kind = (known ? typeWord : "aligned") as KicadDimension["kind"]
    const d: KicadDimension = {
      legacy,
      kind,
      layer: "Dwgs.User",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      height: 0,
      vertical: false,
      extensionHeight: null,
      extensionOffset: 0,
      leaderLength: null,
      frame: 0,
      thickness: 0.2,
      arrowLength: 1.27,
      inward: false,
      textMode: 0,
      keep: kind === "aligned" || kind === "orthogonal" || kind === "radial",
      units: 0,
      format: kind === "aligned" || kind === "orthogonal" ? 1 : 0,
      precision: 4,
      zeros: false,
      prefix: kind === "radial" ? "R " : "",
      suffix: "",
      override: kind === "leader" ? "Leader" : kind === "center" ? "" : null,
      text: null,
      locked,
      uuid: uuidOf(c),
      node: c,
    }
    const number = (n: List | undefined, k: number, what: string) => {
      const v = Number(strAt(n, k))
      if (!n || !Number.isFinite(v)) {
        issues.note(what)
        return 0
      }
      return v
    }
    let crossbar: [Pt, Pt] | null = null
    let feature1: Pt | null = null
    let feature2: Pt | null = null
    if (legacy) d.thickness = number(first as List, 1, "a dimension's width")
    for (let k = legacy ? i + 1 : i; k < c.length; k++) {
      const n = c[k]
      if (!Array.isArray(n) || typeof n[0] !== "string") continue
      switch (n[0]) {
        case "layer":
          d.layer = strAt(n, 1) ?? d.layer
          break
        case "uuid":
        case "tstamp":
          d.uuid = strAt(n, 1) ?? d.uuid
          break
        case "gr_text": {
          const t = textOf(n, "board")
          d.text = t
          d.layer = t.layer || d.layer
          d.uuid = uuidOf(n) ?? d.uuid
          if (t.locked) d.locked = true
          if (legacy) d.units = unitsOfText(t.text)
          break
        }
        case "pts": {
          const p = kids(n, "xy").map((x) => pt(x, "a dimension's points"))
          if (p[0]) d.start = p[0]
          if (p[1]) d.end = p[1]
          break
        }
        case "height":
          if (kind === "aligned" || kind === "orthogonal") d.height = number(n, 1, "a dimension's height")
          break
        case "leader_length":
          if (kind === "radial") d.leaderLength = number(n, 1, "a dimension's leader length")
          break
        case "orientation":
          if (kind === "orthogonal") d.vertical = Math.min(1, Math.max(0, Math.trunc(number(n, 1, "a dimension's orientation")))) === 1
          break
        case "format":
          for (const f of n.slice(1)) {
            if (!Array.isArray(f)) continue
            if (f[0] === "prefix") d.prefix = strAt(f, 1) ?? ""
            else if (f[0] === "suffix") d.suffix = strAt(f, 1) ?? ""
            else if (f[0] === "units") {
              const mode = Math.max(0, Math.min(4, Math.trunc(number(f, 1, "a dimension's units"))))
              if (mode !== 4) d.units = mode
            } else if (f[0] === "units_format") d.format = Math.max(0, Math.min(3, Math.trunc(number(f, 1, "a dimension's unit format"))))
            else if (f[0] === "precision") d.precision = Math.trunc(number(f, 1, "a dimension's precision"))
            else if (f[0] === "override_value") d.override = strAt(f, 1) ?? ""
            else if (f[0] === "suppress_zeroes") d.zeros = f[1] === undefined || f[1] === "yes" || f[1] === "true"
          }
          break
        case "style":
          // In the typed format the text keeps aligned only when the style says so.
          d.keep = false
          for (const s of n.slice(1)) {
            // KiCad's parser takes a bare `keep_text_aligned` as the flag set (`parseMaybeAbsentBool`: no parenthesis after the word means its default, on), as the files of its first typed format write it.
            if (s === "keep_text_aligned") d.keep = true
            if (!Array.isArray(s)) continue
            if (s[0] === "thickness") d.thickness = number(s, 1, "a dimension's line width")
            else if (s[0] === "arrow_direction") d.inward = s[1] === "inward"
            else if (s[0] === "arrow_length") d.arrowLength = number(s, 1, "a dimension's arrow length")
            else if (s[0] === "text_position_mode") d.textMode = Math.min(2, Math.max(0, Math.trunc(number(s, 1, "a dimension's text position"))))
            else if (s[0] === "extension_height") d.extensionHeight = number(s, 1, "a dimension's extension height")
            else if (s[0] === "extension_offset") d.extensionOffset = number(s, 1, "a dimension's extension offset")
            else if (s[0] === "keep_text_aligned") d.keep = s[1] === undefined || s[1] === "yes" || s[1] === "true"
            else if (s[0] === "text_frame") d.frame = Math.max(0, Math.min(3, Math.trunc(number(s, 1, "a dimension's text frame"))))
          }
          break
        case "feature1":
          feature1 = pt(kids(kid(n, "pts"), "xy")[0], "a dimension's feature line")
          break
        case "feature2":
          feature2 = pt(kids(kid(n, "pts"), "xy")[0], "a dimension's feature line")
          break
        case "crossbar": {
          const p = kids(kid(n, "pts"), "xy").map((x) => pt(x, "a dimension's crossbar"))
          if (p.length >= 2) crossbar = [p[0], p[1]]
          break
        }
        case "locked":
          d.locked = n[1] === undefined || n[1] === "yes" || n[1] === "true"
          break
        default:
          break
      }
    }
    if (legacy) {
      if (feature1) d.start = feature1
      if (feature2) d.end = feature2
      if (crossbar) {
        // `UpdateHeight( point2, point1 )` of the crossbar's two ends, backwards on purpose: its distance from the first feature point, signed by the way round.
        const [p1, p2] = crossbar
        const iu = (v: number) => Math.round(v * 1e6)
        const hx = iu(p2.x) - iu(d.start.x)
        const hy = iu(p2.y) - iu(d.start.y)
        const bx = iu(p1.x) - iu(p2.x)
        const by = iu(p1.y) - iu(p2.y)
        const length = Math.trunc(Math.hypot(hx, hy))
        d.height = (hx * by - hy * bx > 0 ? -length : length) / 1e6
      }
      // A KiCad 5 dimension's text keeps aligned and sits outside: the object is made before its style is known and takes the constructor's settings back.
      d.keep = true
      d.textMode = 0
    }
    return d
  }

  /** A reference image (`parsePCB_REFERENCE_IMAGE`, parser line 4322 of master): its place, layer and scale, the picture as base64, and the id. */
  const imageOf = (c: List): KicadImage => {
    const dataNode = kid(c, "data")
    const bytes = dataNode ? decodeBase64(dataNode.slice(1).filter((x): x is string => typeof x === "string").join("")) : null
    if (!bytes) issues.note("a reference image whose data does not decode")
    const facts = imageFacts(bytes ?? new Uint8Array(0))
    const scaleNode = kid(c, "scale")
    const rawScale = scaleNode ? numAt(scaleNode, 1, 1) : 1
    // `std::isnormal` of the scale: zero, infinity and a denormal are 1.
    const scale = Number.isFinite(rawScale) && Math.abs(rawScale) >= 2.2250738585072014e-308 ? rawScale : 1
    return {
      at: pt(kid(c, "at"), "a reference image's place"),
      layer: strAt(kid(c, "layer"), 1) ?? "",
      scale,
      locked: flagOf(c, "locked"),
      uuid: uuidOf(c),
      data: bytes ?? new Uint8Array(0),
      format: facts.format,
      px: facts.px,
      py: facts.py,
      ppi: facts.ppi,
      legacyPpi: facts.legacyPpi,
      node: c,
    }
  }

  /**
   * What a pad or a footprint sets for itself. In a file up to stamp 20240201 a margin, a paste ratio or a clearance of zero is no setting
   * (switch 8; `parsePAD` and `parseFOOTPRINT` clear it, 10.0.0 `:6098-6140` and `:5325-5365`); later, zero is a setting.
   */
  const localOf = (node: List): PadLocal => {
    const out: PadLocal = {}
    const num = (name: string, zeroInherits: boolean): number | undefined => {
      const k = kid(node, name)
      if (!k) return undefined
      const v = numAt(k, 1, NaN)
      if (!Number.isFinite(v) || (zeroInherits && v === 0 && stampAtMost(ZERO_MEANS_INHERIT_UNTIL))) return undefined
      return v
    }
    const maskMargin = num("solder_mask_margin", true)
    const pasteMargin = num("solder_paste_margin", true)
    const pasteRatio = num("solder_paste_margin_ratio", true) ?? num("solder_paste_ratio", true)
    const clearance = num("clearance", true)
    const zoneConnect = num("zone_connect", false)
    const thermalGap = num("thermal_gap", false)
    const thermalWidth = num("thermal_bridge_width", false) ?? num("thermal_width", false)
    const thermalAngle = num("thermal_bridge_angle", false)
    if (maskMargin !== undefined) out.maskMargin = maskMargin
    if (pasteMargin !== undefined) out.pasteMargin = pasteMargin
    if (pasteRatio !== undefined) out.pasteRatio = pasteRatio
    if (clearance !== undefined) out.clearance = clearance
    // `-1` is KiCad's "inherit": the same as writing nothing.
    if (zoneConnect !== undefined && zoneConnect >= 0 && zoneConnect <= 3) out.zoneConnect = zoneConnect
    if (thermalGap !== undefined) out.thermalGap = thermalGap
    if (thermalWidth !== undefined) out.thermalWidth = thermalWidth
    if (thermalAngle !== undefined) out.thermalAngle = thermalAngle
    return out
  }

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
        const t = textOf(c, kind, { layer: isBack(layerName) ? "B.SilkS" : "F.SilkS" })
        texts.push(t)
        if (kind === "reference") ref = t.text
        else if (kind === "value") value = t.text
      } else if (head === "fp_text_box") {
        texts.push(textOf(c, "user", { layer: isBack(layerName) ? "B.SilkS" : "F.SilkS" }))
      } else if (head === "property") {
        const key = strAt(c, 1) ?? ""
        const val = overbar(strAt(c, 2) ?? "")
        props.push({ key, value: val })
        if (key === "Reference") ref = val
        else if (key === "Value") value = val
        // A property that says where it is is a text (the reference, the value and every field KiCad draws or hides); one with no place is only a property.
        if (kid(c, "at") || kid(c, "layer") || kid(c, "effects")) texts.push(textOf(c, key === "Reference" ? "reference" : key === "Value" ? "value" : "user", { layer: isBack(layerName) ? "B.SilkS" : "F.SilkS" }))
      }
    }
    function padStackOf(node: List, number: string): KicadPadStack {
      const mode = strAt(kid(node, "mode"), 1) === "custom" ? "custom" : "front_inner_back"
      const layers: KicadPadLayer[] = kids(node, "layer").map((l) => {
        const what = `pad ${number} of ${ref || "a footprint"}`
        const size = kid(l, "size")
        const off = kid(l, "offset")
        const rd = kid(l, "rect_delta")
        const options = kid(l, "options")
        const anchorWord = strAt(kid(options, "anchor"), 1)
        const chamferNode = kid(l, "chamfer")
        const primitives: KicadShape[] = []
        const proxies: KicadShape[] = []
        for (const g of kid(l, "primitives")?.slice(1) ?? []) {
          if (!Array.isArray(g) || typeof g[0] !== "string" || !g[0].startsWith("gr_")) continue
          const kind = g[0].slice(3)
          if (kind === "bbox" || kind === "vector") proxies.push(shapeOf(g, kind === "vector" ? "line" : "bbox"))
          else if (["line", "arc", "circle", "rect", "poly", "curve"].includes(kind)) primitives.push(shapeOf(g, kind as ShapeKind))
        }
        const layer: KicadPadLayer = { name: strAt(l, 1) ?? "", primitives, proxies, node: l }
        if (strAt(kid(l, "shape"), 1) !== undefined) layer.shape = strAt(kid(l, "shape"), 1)
        if (size) {
          layer.w = numAt(size, 1, 0)
          layer.h = numAt(size, 2, 0)
        }
        if (off) layer.offset = pt(off, what)
        if (rd) layer.rectDelta = pt(rd, what)
        if (kid(l, "roundrect_rratio")) layer.roundrectRatio = numAt(kid(l, "roundrect_rratio"), 1, 0)
        if (kid(l, "chamfer_ratio")) layer.chamferRatio = numAt(kid(l, "chamfer_ratio"), 1, 0)
        if (chamferNode) {
          const corners = atomsOf(chamferNode)
          layer.chamferCorners = (corners.includes("top_left") ? 1 : 0) | (corners.includes("top_right") ? 2 : 0) | (corners.includes("bottom_right") ? 4 : 0) | (corners.includes("bottom_left") ? 8 : 0)
        }
        if (anchorWord === "circle" || anchorWord === "rect") layer.anchor = anchorWord
        if (strAt(kid(options, "clearance"), 1) === "convexhull") layer.hull = true
        if (kid(l, "thermal_gap")) layer.thermalGap = numAt(kid(l, "thermal_gap"), 1, 0)
        if (kid(l, "thermal_bridge_width")) layer.thermalWidth = numAt(kid(l, "thermal_bridge_width"), 1, 0)
        if (kid(l, "thermal_bridge_angle")) layer.thermalAngle = numAt(kid(l, "thermal_bridge_angle"), 1, 0)
        if (kid(l, "zone_connect")) layer.zoneConnect = numAt(kid(l, "zone_connect"), 1, 0)
        if (kid(l, "clearance")) layer.clearance = numAt(kid(l, "clearance"), 1, 0)
        return layer
      })
      return { mode, layers }
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
      const options = kid(c, "options")
      const anchorWord = strAt(kid(options, "anchor"), 1)
      const chamferNode = kid(c, "chamfer")
      const primitives: KicadShape[] = []
      const proxies: KicadShape[] = []
      for (const g of kid(c, "primitives")?.slice(1) ?? []) {
        if (!Array.isArray(g) || typeof g[0] !== "string" || !g[0].startsWith("gr_")) continue
        const kind = g[0].slice(3)
        if (kind === "bbox" || kind === "vector") proxies.push(shapeOf(g, kind === "vector" ? "line" : "bbox"))
        else if (["line", "arc", "circle", "rect", "poly", "curve"].includes(kind)) primitives.push(shapeOf(g, kind as ShapeKind))
      }
      // `remove_unused_layers` and `keep_end_layers` set one mode in turn, the later word winning (parsePAD, 10.0.0 `:6372-6382`): yes and yes keeps the ends, yes alone keeps none, no keeps every layer.
      let removeUnused: boolean | undefined
      let keepEnds: boolean | undefined
      for (const w of c) {
        if (!Array.isArray(w)) continue
        const yes = w[1] === undefined || w[1] === "yes" || w[1] === "true"
        if (w[0] === "remove_unused_layers") {
          removeUnused = yes
          keepEnds = undefined
        } else if (w[0] === "keep_end_layers") {
          keepEnds = yes
          removeUnused = true
        }
      }
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
        primitives,
        proxies,
        local: localOf(c),
        properties: atomsOf(kid(c, "property")),
        padstack: !!kid(c, "padstack"),
        stack: kid(c, "padstack") ? padStackOf(kid(c, "padstack")!, number) : null,
        zoneLayers: kid(c, "zone_layer_connections") ? atomsOf(kid(c, "zone_layer_connections")) : null,
        tented: !!kid(c, "tenting") && (kid(c, "tenting") as List).slice(1).some((t) => (Array.isArray(t) ? t[1] !== undefined && t[1] !== "none" : true)),
        ...(kid(c, "tenting") ? { tenting: tentingOf(kid(c, "tenting"), version) } : {}),
        node: c,
      }
      Object.assign(pad, drilling(c, true))
      const dieLength = numAt(kid(c, "die_length"), 1, 0)
      if (dieLength > 0) pad.dieLength = dieLength
      // `die_delay` is in picoseconds in every release (the 20250926 files wrote the same number as a length, whose internal unit is the same one).
      const dieDelay = numAt(kid(c, "die_delay"), 1, 0)
      if (dieDelay > 0) pad.dieDelay = dieDelay
      if (removeUnused !== undefined) pad.removeUnused = removeUnused
      if (keepEnds !== undefined) pad.keepEnds = keepEnds
      if (anchorWord === "circle" || anchorWord === "rect") pad.anchor = anchorWord
      if (strAt(kid(options, "clearance"), 1) === "convexhull") pad.hull = true
      if (chamferNode) {
        const corners = atomsOf(chamferNode)
        pad.chamferCorners = (corners.includes("top_left") ? 1 : 0) | (corners.includes("top_right") ? 2 : 0) | (corners.includes("bottom_right") ? 4 : 0) | (corners.includes("bottom_left") ? 8 : 0)
      }
      const chamferRatio = kid(c, "chamfer_ratio")
      if (chamferRatio) pad.chamferRatio = numAt(chamferRatio, 1, 0)
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
      classes: [...new Set(kids(fp, "component_classes").flatMap((n) => kids(n, "class").map((k) => strAt(k, 1) ?? "")).filter((n) => n !== ""))],
      variants: kids(fp, "variant").map(variantOf).filter((v) => v.name !== ""),
      units: kids(kid(fp, "units"), "unit").map((u) => ({ name: strAt(kid(u, "name"), 1) ?? "", pins: atomsOf(kid(u, "pins")) })),
      points: kids(fp, "point").map((c) => pointOf(c, place)),
      props,
      pads,
      local: localOf(fp),
      models,
      texts,
      shapes,
      zones: kids(fp, "zone").map((z) => zoneOf(z, place)),
      groups: kids(fp, "group").map(groupOf),
      privateLayers: atomsOf(kid(fp, "private_layers")),
      netTies,
      jumperGroups,
      jumperDuplicates: flagOf(fp, "duplicate_pad_numbers_are_jumpers"),
      embedFonts: strAt(kid(fp, "embedded_fonts"), 1) === "yes",
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
  // A track, arc track or via on a net number the net table does not list: KiCad logs "Invalid net ID" and loads it with no net
  // (`parseNet`, parser lines 305-315), so it is no net here, and the number is kept to say so in the report.
  const copperNet = (c: List) => {
    const bad: string[] = []
    const net = netOf(c, bad)
    return { net: net?.name ?? null, netRaw: net?.raw ?? null, ...(bad.length ? { badNet: bad[0] } : {}) }
  }
  const segments: KicadSegment[] = kids(tree, "segment").map((c) => ({
    start: ptOf(c, "start", "a track segment") ?? { x: 0, y: 0 },
    end: ptOf(c, "end", "a track segment") ?? { x: 0, y: 0 },
    width: numAt(kid(c, "width"), 1, 0),
    layer: strAt(kid(c, "layer"), 1) ?? "",
    ...copperNet(c),
    locked: flagOf(c, "locked") || lockedBit(c),
    node: c,
  }))
  const arcTracks: KicadArcTrack[] = kids(tree, "arc").map((c) => ({
    start: ptOf(c, "start", "an arc track") ?? { x: 0, y: 0 },
    mid: ptOf(c, "mid", "an arc track") ?? { x: 0, y: 0 },
    end: ptOf(c, "end", "an arc track") ?? { x: 0, y: 0 },
    width: numAt(kid(c, "width"), 1, 0),
    layer: strAt(kid(c, "layer"), 1) ?? "",
    ...copperNet(c),
    locked: flagOf(c, "locked") || lockedBit(c),
    node: c,
  }))
  const viaOf = (c: List): KicadVia => {
    // Switch 4: a bare `blind`, `micro` or `buried` after `via`.
    const kind = c.includes("buried") ? "buried" : c.includes("blind") ? "blind" : c.includes("micro") ? "micro" : "through"
    return {
      at: ptOf(c, "at", "a via") ?? { x: 0, y: 0 },
      size: numAt(kid(c, "size"), 1, 0),
      drill: numAt(kid(c, "drill"), 1, 0),
      layers: atomsOf(kid(c, "layers")),
      kind,
      free: flagOf(c, "free"),
      ...(viaUnusedOf(c) ? { unused: viaUnusedOf(c) } : {}),
      ...(kid(c, "zone_layer_connections") ? { zoneLayers: atomsOf(kid(c, "zone_layer_connections")) } : {}),
      ...(kid(c, "tenting") ? { tenting: tentingOf(kid(c, "tenting"), version) } : {}),
      ...(kid(c, "padstack") ? { stack: viaStackOf(kid(c, "padstack")) } : {}),
      ...drilling(c),
      ...copperNet(c),
      locked: flagOf(c, "locked") || lockedBit(c),
      node: c,
    }
  }
  const vias: KicadVia[] = kids(tree, "via").map(viaOf)
  const zones = kids(tree, "zone").map((z) => zoneOf(z, null))
  const targets: KicadTarget[] = kids(tree, "target").map((c) => ({
    shape: c.includes("x") ? "x" : "plus",
    at: ptOf(c, "at", "a target") ?? { x: 0, y: 0 },
    size: numAt(kid(c, "size"), 1, 0),
    width: numAt(kid(c, "width"), 1, 0),
    layer: strAt(kid(c, "layer"), 1) ?? "",
    node: c,
  }))
  const shapes: KicadShape[] = []
  const texts: KicadText[] = []
  const dimensions: KicadDimension[] = []
  const groups: KicadGroup[] = []
  const generators: KicadGenerator[] = []
  const images: KicadImage[] = []
  const others: Record<string, List[]> = {}
  for (const c of tree) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    const head = c[0]
    if (head.startsWith("gr_") && SHAPE_KINDS.has(head.slice(3))) shapes.push(shapeOf(c, head.slice(3) as ShapeKind))
    else if (head === "gr_text" || head === "gr_text_box") texts.push(textOf(c, "board"))
    else if (head === "dimension") dimensions.push(dimensionOf(c))
    else if (head === "group") groups.push(groupOf(c))
    else if (head === "generated") generators.push(generatorOf(c, viaOf))
    else if (head === "image") images.push(imageOf(c))
    else if (!TYPED_ROOT.has(head)) (others[head] ??= []).push(c)
  }

  // ---- embedded files: a font is kept (X19), and every other file is named, one report entry each (founder decision: no models packed in the file for now) ----
  const embedded: { file: string; owner: string; what: string }[] = []
  const fontFiles: KicadFontFile[] = []
  const embed = (f: List, owner: string, from: KicadFootprint | null) => {
    const name = strAt(kid(f, "name"), 1) ?? "(unnamed)"
    const what = embeddedKind(name, strAt(kid(f, "type"), 1) ?? "")
    if (what !== "Font") {
      embedded.push({ file: name, owner, what })
      return
    }
    // The data is the font as KiCad stores it (compressed with zstd, in base64 between two bars): its bytes are kept as they are and written back as they were.
    const dataNode = kid(f, "data")
    const bytes = dataNode ? decodeBase64(dataNode.slice(1).filter((x): x is string => typeof x === "string").join("").replace(/\|/g, "")) : null
    if (!bytes || !bytes.length) {
      report.entries.push({ code: "embedded-font", severity: "not-brought", object: `${name} (in ${owner})`, why: "The font embedded in the KiCad file has no data that decodes, so it was not brought in; the text that names it is drawn as the file's outlines say, and KiCad finds the font on its own computer." })
      return
    }
    const sum = strAt(kid(f, "checksum"), 1)
    fontFiles.push({ name, owner: from, bytes, checksum: sum ?? null, node: f })
  }
  for (const e of kids(tree, "embedded_files")) for (const f of kids(e, "file")) embed(f, "the board", null)
  for (const fp of footprints) for (const e of kids(fp.node, "embedded_files")) for (const f of kids(e, "file")) embed(f, fp.ref || fp.name, fp)
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
    stackup: readStackup(kid(tree, "setup")),
    tenting: setupTenting(kid(tree, "setup")),
    setup,
    setupWords,
    userTraceWidths,
    userVias,
    userDiffPairs,
    nets,
    variants: kids(kid(tree, "variants"), "variant").map((v) => ({ name: strAt(kid(v, "name"), 1) ?? "", description: strAt(kid(v, "description"), 1) ?? "" })).filter((v) => v.name !== ""),
    points: kids(tree, "point").map((c) => pointOf(c, null)),
    padsOnSilk,
    netClasses,
    footprints,
    segments,
    arcTracks,
    vias,
    zones,
    shapes,
    targets,
    texts,
    dimensions,
    groups,
    generators,
    netChains: netChainsOf(tree),
    ...(setupProtectionOf(kid(tree, "setup")) ? { viaProtect: setupProtectionOf(kid(tree, "setup")) } : {}),
    images,
    embeddedFonts: { board: strAt(kid(tree, "embedded_fonts"), 1) === "yes", files: fontFiles },
    others,
    tree,
  }
}
