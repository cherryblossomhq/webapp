import { newReport } from "../../board/report"
import { KicadSchematicReadError, readKicadSchematic, type SchematicReadResult } from "../read"
import type { LegacyInfo } from "../types"
import { legacyPartToSymbolText } from "./lib"
import { legacySchematicVersion, readLegacySchematicText } from "./sch"
import { legacyToKicadText } from "./sexpr"
import type { LegacySources } from "./sources"
import { LegacyParseError, decodeLegacy } from "./text"

// A KiCad 5 or older schematic (`.sch`), read into the typed schematic a `.kicad_sch` is read into:
// the legacy records are parsed strictly (`sch.ts`), written as the KiCad 6 items they become
// (`sexpr.ts`) and read by the one reader, and the symbols the schematic places are taken from the
// project's libraries (`sources.ts`, `lib.ts`) as the KiCad 6 symbols KiCad converts them to.

/** Whether the data is a legacy schematic: it begins with `EESchema Schematic File Version`. */
export function isLegacySchematic(data: string | Uint8Array): boolean {
  const head = typeof data === "string" ? data.slice(0, 120) : new TextDecoder("latin1").decode(data.subarray(0, 120))
  return legacySchematicVersion(head) !== null
}

/** The stamp the library symbols are read with: after the stamps whose rules a legacy symbol must not get (a lone `~` kept, an arc of a half turn replaced). */
const LIB_STAMP = 20230221

/** A `lib:name` of an `L` line: from version 4 on it has a library nickname. */
const splitLibId = (libName: string, version: number): { nickname: string; item: string } => {
  const colon = version > 3 ? libName.indexOf(":") : -1
  return colon >= 0 ? { nickname: libName.slice(0, colon), item: libName.slice(colon + 1) } : { nickname: "", item: libName }
}

const codeOf = (e: LegacyParseError): KicadSchematicReadError["code"] => {
  switch (e.code) {
    case "empty":
      return "empty"
    case "not-legacy":
      return "not-a-schematic"
    case "newer-version":
      return "bad-value"
    case "truncated":
      return "truncated"
    case "bad-number":
      return "bad-number"
    case "bad-value":
      return "bad-value"
    case "unknown-record":
      return "unknown-record"
    default:
      return "legacy-damaged"
  }
}

/** Reads a legacy schematic, as text or bytes, with the libraries of its project. Throws `KicadSchematicReadError` for a file that cannot be read. */
export function readLegacySchematic(input: string | Uint8Array, sources: LegacySources): SchematicReadResult {
  const report = newReport()
  let text: string
  let encoding: "utf-8" | "latin-1" = "utf-8"
  if (typeof input === "string") text = input
  else {
    const d = decodeLegacy(input)
    text = d.text
    encoding = d.encoding
    for (const why of d.notes) report.entries.push({ code: "encoding", severity: "note", object: "the file", why })
  }
  let kicadText: string
  let legacy: ReturnType<typeof readLegacySchematicText>
  try {
    legacy = readLegacySchematicText(text)
    kicadText = legacyToKicadText(legacy)
  } catch (e) {
    if (e instanceof LegacyParseError) throw new KicadSchematicReadError(codeOf(e), e.message, e.path)
    throw e
  }

  // ---------- the symbols the sheet places, from the project's libraries ----------
  const symbolSources: LegacyInfo["symbolSources"] = []
  const found = new Map<string, string>()
  const wanted = [...new Set(legacy.comps.map((c) => c.libName))]
  for (const name of wanted) {
    const { nickname, item } = splitLibId(name, legacy.version)
    const hit = sources.find(nickname, item)
    if (!hit) {
      symbolSources.push({ libId: name, from: "missing", file: null, name: null })
      continue
    }
    found.set(name, legacyPartToSymbolText(hit.part, name))
    symbolSources.push({ libId: name, from: hit.source.kind, file: hit.source.file, name: hit.name })
  }
  let libSymbols: SchematicReadResult["schematic"]["libSymbols"] = []
  if (found.size) {
    const lib = readKicadSchematic(`(kicad_sch (version ${LIB_STAMP}) (lib_symbols ${[...found.values()].join(" ")}))`)
    libSymbols = lib.schematic.libSymbols
  }

  const info: LegacyInfo = { version: legacy.version, encoding, records: Object.fromEntries(legacy.records), markers: legacy.markers.length, symbolSources }
  const read = readKicadSchematic(kicadText, info)
  read.schematic.libSymbols = libSymbols
  read.report.entries.push(...report.entries)
  const ignored = legacy.notes.filter((n) => n.code === "ignored-v1")
  if (ignored.length) {
    read.report.entries.push({
      code: "legacy-ignored",
      severity: "note",
      object: `${ignored.length} value${ignored.length > 1 ? "s" : ""} KiCad does not read in a version 1 file`,
      why: `KiCad does not read the justification of a field or the style of a text in a version 1 schematic, and draws them plain; so does the importer (${ignored.slice(0, 3).map((n) => n.text).join("; ")}${ignored.length > 3 ? "; ..." : ""}).`,
      count: ignored.length,
    })
  }
  const commas = legacy.notes.filter((n) => n.code === "comma-decimal")
  if (commas.length) {
    read.report.entries.push({ code: "legacy-comma-decimal", severity: "changed", object: commas.map((n) => n.text).join("; "), why: "The file was written in a language that has a decimal comma; the number is read as it says (KiCad would read the part before the comma).", count: commas.length })
  }
  if (legacy.markers.length) {
    read.report.entries.push({
      code: "legacy-markers-not-brought",
      severity: "not-brought",
      object: `${legacy.markers.length} ERC marker${legacy.markers.length > 1 ? "s" : ""}`,
      why: "Old KiCad versions saved the results of the electrical rule check in the schematic; KiCad recomputes them, and so does the editor.",
      count: legacy.markers.length,
    })
  }
  return { schematic: read.schematic, text: kicadText, report: read.report }
}
