import type { PartIndexPin } from "@cherryblossom/api-contract"
import { CUSTOM_CATEGORIES, DEFAULT_REF_PREFIX } from "./customParts"
import type { IndexDraft } from "./indexPart"
import { convertSymbol, SKIP_TEXT } from "./kicad/convert"
import { convertFootprint, type FootprintResult } from "./kicad/footprint"
import { all, first, flag, parseSexpr, str, type SNode } from "./kicad/sexpr"
import { parseSymbols, resolveExtends, type KicadPin, type RawSymbol } from "./kicad/symbol"
import { defaultModelScale, kicadModel, modelFormatOf } from "./models3d"
import { supplierFootprint, supplierPins } from "./supplier/build"
import { KICAD_MODEL_ID } from "./supplier/kicadModel"
import type { CustomPartSpec, Model3D, PartCategory } from "./types"

// A user's own KiCad files as project parts: a symbol library (`.kicad_sym`), the footprints its
// symbols sit on (`.kicad_mod`) and the 3D model files those name. It is the converter the parts
// database fills from KiCad's libraries (`model/kicad`), so a user's part is paired pin for pad
// exactly as a library part is, and refused with the same reasons; what differs is finding the
// footprint, since a user's files don't come in KiCad's library layout.
//
// A symbol's footprint is the file its Footprint field names, matched by name with the library
// left off. One symbol given with one footprint is paired whatever the field says (it is said in
// the result), since that is what the user handed over; among several, only a name pairs them, or
// a symbol could land on another part's pads. Footprints given with no symbol at all are parts of
// their own, with a pin for each pad, so a footprint alone can still be placed.

/** The release of KiCad's 3D library a footprint's library model is fetched at: the parts database's. */
export const KICAD_MODELS_RELEASE = "10.0.7"

export interface KicadFile {
  /** The file's name (a path inside a zip is fine: only the last part is read). */
  name: string
  text: string
}

/** Where a footprint places its model, in the document's terms: `Model3D`'s offset, rotation and scale. */
export interface ModelPlacement {
  offset: Model3D["offset"]
  rotation: Model3D["rotation"]
  scale?: number
}

export interface KicadImportPart extends IndexDraft {
  /**
   * A model file among those given that the part is drawn with: the one its footprint names, or the
   * only one given. `placement` is where the footprint puts it; null when the footprint doesn't say
   * (or says it in a way the editor can't follow), and the file is then fitted to the land.
   */
  modelFile: { name: string; placement: ModelPlacement | null } | null
}

export interface KicadImport {
  parts: KicadImportPart[]
  /** Why each file or symbol that didn't become a part didn't, one sentence each. */
  problems: string[]
}

const SYMBOL_FILE = /\.kicad_sym$/i
const FOOTPRINT_FILE = /\.kicad_mod$/i

export const isSymbolFile = (name: string) => SYMBOL_FILE.test(name)
export const isFootprintFile = (name: string) => FOOTPRINT_FILE.test(name)

export const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "")
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A symbol file's library: its `.kicad_symdir` directory (KiCad 10 keeps one symbol per file), else the file's own name. */
function libraryOf(path: string): string {
  const dir = path.split(/[\\/]/).slice(-2, -1)[0]
  return dir && /\.kicad_symdir$/i.test(dir) ? dir.replace(/\.kicad_symdir$/i, "") : stem(path)
}

// ---------- footprints ----------

interface ModelRef {
  path: string
  offset: [number, number, number]
  scale: [number, number, number]
  rotate: [number, number, number]
}

interface Footprint {
  file: string
  /** The name the file gives itself, `(footprint "SOIC-8_3.9x4.9mm_P1.27mm" ...)`, else the file's. */
  name: string
  description: string
  result: FootprintResult
  models: ModelRef[]
}

function xyz(node: SNode[], name: string): [number, number, number] | undefined {
  const v = first(first(node, name) ?? [], "xyz")?.slice(1, 4).map(Number)
  return v?.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : undefined
}

/** A model's offset in mm: KiCad 5.0 and older wrote it as `at`, in inches. */
function offsetOf(model: SNode[]): [number, number, number] {
  const inches = xyz(model, "at")
  return xyz(model, "offset") ?? (inches ? [inches[0] * 25.4, inches[1] * 25.4, inches[2] * 25.4] : [0, 0, 0])
}

function readFootprint(file: KicadFile): Footprint | { problem: string } {
  let root: SNode[] | undefined
  try {
    root = parseSexpr(file.text).find((n): n is SNode[] => Array.isArray(n) && (n[0] === "footprint" || n[0] === "module"))
  } catch (e) {
    return { problem: `${baseName(file.name)} can't be read: ${e instanceof Error ? e.message : String(e)}.` }
  }
  if (!root) return { problem: `${baseName(file.name)} isn't a KiCad footprint.` }
  const name = str(root, 1)?.trim() || stem(file.name)
  const models = all(root, "model")
    .filter((m) => !flag(m, "hide"))
    .map((m) => ({ path: str(m, 1) ?? "", offset: offsetOf(m), scale: xyz(m, "scale") ?? [1, 1, 1], rotate: xyz(m, "rotate") ?? [0, 0, 0] }))
    .filter((m) => m.path)
  return { file: file.name, name, description: str(first(root, "descr"), 1) ?? "", result: convertFootprint(file.text, name), models }
}

// ---------- symbols ----------

/** Props a vendor's download names the part number, maker and LCSC number by, compared as letters and digits only. */
const MPN_KEYS = new Set(["mpn", "manufacturerpartnumber", "mp", "partnumber", "mfrpartnumber", "mfrpn", "mfgpartnumber"])
const MAKER_KEYS = new Set(["manufacturer", "manufacturername", "mf", "mfr", "mfg"])
const LCSC_KEYS = new Set(["lcsc", "lcscpart", "lcscpartnumber", "lcscpn", "jlcpcbpart", "jlcpcbpartnumber"])

function prop(props: Record<string, string>, keys: Set<string>): string | undefined {
  for (const [k, v] of Object.entries(props)) {
    if (keys.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")) && v.trim() && v.trim() !== "~") return v.trim()
  }
  return undefined
}

/** A part's category by its designator, for a library whose name says nothing (`categoryOf` reads KiCad's own library names). */
const BY_REFERENCE: [RegExp, PartCategory][] = [
  [/^(R|RN|C|L|FB|Y|X)$/, "Passives"],
  [/^(D|LED)$/, "Diodes"],
  [/^Q$/, "Transistors"],
  [/^(J|P|CN|CON|USB)$/, "Connectors"],
  [/^(SW|S|K|F|BZ|LS|M)$/, "Electromechanical"],
  [/^(MOD|A)$/, "Modules"],
]

function categoryFor(converted: string, refPrefix: string): PartCategory {
  if (converted !== "ICs" && (CUSTOM_CATEGORIES as string[]).includes(converted)) return converted as PartCategory
  return BY_REFERENCE.find(([re]) => re.test(refPrefix))?.[1] ?? "ICs"
}

/**
 * A symbol for a footprint given alone: a pin for each numbered pad, named by its number, down the
 * left side and back up the right as a DIP is numbered.
 */
function symbolForFootprint(fp: Footprint & { result: { ok: true } }): RawSymbol {
  const numbers = [...new Set(fp.result.land.pads.filter((p) => p.number && p.plated !== false).map((p) => p.number))]
  const half = Math.ceil(numbers.length / 2)
  const pins: KicadPin[] = numbers.map((number, i) => {
    const left = i < half
    return { number, name: number, etype: "passive", hidden: false, x: 0, y: left ? -i : -(numbers.length - 1 - i), angle: left ? 0 : 180, unit: 1, alternates: [] }
  })
  return { name: fp.name, props: { Reference: "U", Footprint: fp.name, Description: fp.description }, pins, power: false, units: 1, unnumbered: 0 }
}

// ---------- models ----------

/** KiCad's own 3D library, as a footprint names a file in it: `${KICAD9_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl` (`${KISYS3DMOD}` before KiCad 6). */
const KICAD_LIBRARY_MODEL = /^\$\{(?:KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\/(.+)$/

/**
 * Where a footprint places a model, as `Model3D` keeps it: the offset as written, the angles
 * negated (KiCad turns a model clockwise), a mesh's scale times its format's units. Null for a
 * scale the editor can't follow: uneven, or any at all on a STEP file, which says its own units.
 */
function placementOf(ref: ModelRef, fileName: string): ModelPlacement | null {
  const [sx, sy, sz] = ref.scale
  if (sx !== sy || sy !== sz || sx <= 0) return null
  const format = modelFormatOf(fileName)
  if (!format || (format === "step" && sx !== 1)) return null
  const flip = (v: number) => (v === 0 ? 0 : -v)
  const scale = defaultModelScale(format) * sx
  return {
    offset: { x: ref.offset[0], y: ref.offset[1], z: ref.offset[2] },
    rotation: { x: flip(ref.rotate[0]), y: flip(ref.rotate[1]), z: flip(ref.rotate[2]) },
    ...(scale !== 1 && { scale }),
  }
}

/** The file given for a path a footprint names: the same name, else the same name with another model extension, a STEP file first. */
function givenModel(path: string, models: string[]): string | undefined {
  const want = baseName(path)
  const exact = models.find((m) => same(baseName(m), want))
  if (exact) return exact
  const alike = models.filter((m) => same(stem(m), stem(want)) && modelFormatOf(m))
  return alike.find((m) => modelFormatOf(m) === "step") ?? alike[0]
}

/** The model a footprint names in KiCad's own 3D library, as the parts index serves it: the STEP file, since only those are kept there. */
function libraryModel(ref: ModelRef): Model3D | null {
  const path = ref.path.match(KICAD_LIBRARY_MODEL)?.[1]?.replace(/\.(wrl|vrml)$/i, ".step")
  const id = path && `${KICAD_MODELS_RELEASE}/${path}`
  if (!id || !KICAD_MODEL_ID.test(id)) return null
  const v = (t: [number, number, number]) => ({ x: t[0], y: t[1], z: t[2] })
  return kicadModel({ source: "kicad", id, name: stem(path), offset: v(ref.offset), rotate: v(ref.rotate), scale: v(ref.scale) })
}

// ---------- parts ----------

/** A land's name part for an imported footprint: its name as a slug, so it reads like the footprint it came from. */
const fileLandKey = (footprint: string) =>
  `file_${footprint}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)

function buildPart(symbol: RawSymbol, library: string, fp: Footprint & { result: { ok: true } }, models: string[], onlyPart: boolean): KicadImportPart | { problem: string } {
  // The footprint was found by the import, not by the field: the field is made to name it.
  const converted = convertSymbol({ ...symbol, props: { ...symbol.props, Footprint: fp.name } }, { library, release: "", footprint: () => fp.result })
  if (!converted.ok) return { problem: `${symbol.name}: ${SKIP_TEXT[converted.code]}${converted.detail ? ` (${converted.detail})` : ""}.` }
  const row = converted.part
  const land = supplierFootprint({ land: converted.land.land, package: fp.name, lcsc: fileLandKey(fp.name) })
  if (!land) return { problem: `${symbol.name}: ${fp.name} has no pads.` }
  const category = categoryFor(row.category, row.refPrefix)
  const mpn = prop(symbol.props, MPN_KEYS) ?? symbol.name
  const props: Record<string, string> = { mpn }
  const maker = prop(symbol.props, MAKER_KEYS)
  if (maker) props.manufacturer = maker
  if (row.datasheet) props.datasheet = row.datasheet
  const lcsc = prop(symbol.props, LCSC_KEYS)
  if (lcsc && /^C\d+$/i.test(lcsc)) props.lcsc = lcsc.toUpperCase()
  const keywords = [...new Set(row.keywords)].slice(0, 24)
  const pins: PartIndexPin[] = row.pins
  const draft: Omit<CustomPartSpec, "id"> = {
    name: symbol.name,
    description: row.description || fp.description || symbol.name,
    category,
    refPrefix: row.refPrefix || DEFAULT_REF_PREFIX[category],
    footprint: land.name,
    pins: supplierPins(pins, pins.map((p) => ({ number: p.number, name: p.name, kind: p.kind, side: p.side }))),
    props,
    valueProp: "mpn",
    ...(keywords.length && { keywords }),
    // A KiCad 10 symbol file picked on its own is named after its symbol, which is no library to name.
    source: { pins: "file", land: "file", file: { symbol: !library ? null : library === symbol.name ? symbol.name : `${library}:${symbol.name}`, footprint: fp.name } },
  }

  // The model: a file given for the one the footprint names, else the only file given when this is
  // the only part (the user handed it over with the part), else KiCad's own when the footprint names
  // one from its 3D library.
  let modelFile: KicadImportPart["modelFile"] = null
  for (const ref of fp.models) {
    const name = givenModel(ref.path, models)
    if (name) {
      modelFile = { name, placement: placementOf(ref, name) }
      break
    }
  }
  if (!modelFile && onlyPart && models.length === 1) modelFile = { name: models[0], placement: null }
  const model = modelFile ? null : (fp.models.map(libraryModel).find(Boolean) ?? null)
  return { draft, land, model, modelFile }
}

/**
 * Parts from a user's KiCad files: every symbol in the symbol libraries that pairs with a footprint
 * given, or, with no symbol library given, every footprint as a part of its own. `models` are the
 * names of the 3D model files given alongside. Power symbols are passed over without a word.
 */
export function importKicadFiles(files: KicadFile[], models: string[] = []): KicadImport {
  const problems: string[] = []
  const footprints: (Footprint & { result: { ok: true } })[] = []
  for (const file of files.filter((f) => isFootprintFile(f.name))) {
    const fp = readFootprint(file)
    if ("problem" in fp) problems.push(fp.problem)
    else if (!fp.result.ok) problems.push(`${fp.name}: ${fp.result.reason}.`)
    else footprints.push(fp as Footprint & { result: { ok: true } })
  }

  // A symbol may extend one in another file: KiCad 10 keeps a library as a directory of one-symbol files.
  const read: { library: string; raws: RawSymbol[] }[] = []
  const symbolFiles = files.filter((f) => isSymbolFile(f.name))
  for (const file of symbolFiles) {
    try {
      read.push({ library: libraryOf(file.name), raws: parseSymbols(file.text) })
    } catch (e) {
      problems.push(`${baseName(file.name)} can't be read: ${e instanceof Error ? e.message : String(e)}.`)
    }
  }
  const symbols: { library: string; symbol: RawSymbol; alone: boolean }[] = []
  for (const { library, raws } of read) {
    const lookup = (name: string) =>
      raws.find((s) => s.name === name) ?? read.find((r) => r.library === library && r.raws.some((s) => s.name === name))?.raws.find((s) => s.name === name)
    for (const raw of raws) {
      try {
        symbols.push({ library, symbol: resolveExtends(raw, lookup), alone: raws.length === 1 })
      } catch (e) {
        problems.push(`${raw.name} can't be read: ${e instanceof Error ? e.message : String(e)}. Add the symbol it extends.`)
      }
    }
  }
  // A base symbol given in a file of its own only for another to extend is not a part of its own;
  // one in a library file of many symbols was given with the rest of that library.
  const bases = new Set(read.flatMap((r) => r.raws.map((s) => s.extendsName).filter(Boolean)))
  const asked = symbols.filter((s) => !(s.alone && bases.has(s.symbol.name)) || read.length === 1)
  const parts: KicadImportPart[] = []
  const add = (built: KicadImportPart | { problem: string }) => ("problem" in built ? problems.push(built.problem) : parts.push(built))

  if (!symbolFiles.length) {
    for (const fp of footprints) add(buildPart(symbolForFootprint(fp), "", fp, models, footprints.length === 1))
    return { parts, problems }
  }
  const real = asked.filter((s) => !s.symbol.power)
  if (!real.length && symbols.length) problems.push("The symbol library holds only power symbols, which are nets, not parts.")
  for (const { library, symbol } of real) {
    const wanted = (symbol.props.Footprint ?? "").trim()
    const wantedName = wanted.slice(wanted.indexOf(":") + 1)
    const named = wantedName ? footprints.find((f) => same(f.name, wantedName) || same(stem(f.file), wantedName)) : undefined
    // One symbol and one footprint are a part whatever their names say; among several, only names pair them.
    const only = !named && real.length === 1 && footprints.length === 1 ? footprints[0] : undefined
    const fp = named ?? only ?? (wanted ? undefined : footprints.find((f) => same(f.name, symbol.name)))
    if (only && wanted) problems.push(`${symbol.name} names the footprint ${wanted}; it was put on ${only.name}, the one given.`)
    if (!fp) {
      problems.push(
        wanted
          ? `${symbol.name}: its footprint ${wanted} wasn't among the files. Add its .kicad_mod file.`
          : footprints.length
            ? `${symbol.name} names no footprint, and none of the footprint files is named after it.`
            : `${symbol.name}: no footprint was given. Add its .kicad_mod file.`,
      )
      continue
    }
    add(buildPart(symbol, library, fp, models, real.length === 1))
  }
  return { parts, problems }
}
