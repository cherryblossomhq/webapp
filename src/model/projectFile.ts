import { cleanBlockName } from "./blocks"
import { clean, DEFAULT_TEXT_SIZE, isDrawingColor, isLineDash, isLineWeight } from "./drawings"
import { buildCustomPart, customPartProblems, registerProjectParts } from "./customParts"
import { registerProjectFootprints } from "./footprints"
import { findPart } from "./library"
import { kicadSymbols } from "./migrations/kicadSymbols"
import { normalizeModels } from "./models3d"
import { normalizeRules } from "./rules"
import type { ComponentInstance, CustomPartSpec, DrawingBox, DrawingLine, DrawingText, FootprintDef, PadDef, PartDatabaseSource, PartSource, Project, SchematicBlock, SchematicDrawing, Vec2 } from "./types"

/**
 * The project file: how a project is written down wherever it is kept. One format for an
 * account, this browser's storage and a file the user downloads, so a download
 * is a backup that opens anywhere and there is one reader to keep working.
 *
 *     { "format": "cherryblossom.project", "version": 2, "project": { "name": ..., ... } }
 *
 * - `format` says the JSON is ours. A file dropped on the dashboard could be anything.
 * - `version` is an integer for the shape of `project`. It goes up when a change would make an
 *   older reader misread a document: a field renamed, moved, split, or given a new unit or
 *   meaning. A new optional field that `normalizeProject` can default does not need one.
 * - `project` is the design itself. Its id and timestamps are not in it: those belong to where
 *   it is stored (a database row, a file on disk), and a copy is a new project.
 *
 * Reading runs the file through `MIGRATIONS` from its version to the current one, then through
 * `normalizeProject`, which fills whatever an older or hand-written file leaves out. A file
 * newer than this reader is refused rather than guessed at: opening it would drop what it
 * doesn't understand, and the next autosave would write that loss back over the original.
 *
 * To change the format:
 *
 * 1. Bump `PROJECT_FILE_VERSION`.
 * 2. Add `MIGRATIONS[old]`, which turns a version-`old` document into a version-`old + 1` one.
 *    Plain JSON in and out, and nothing imported from the live model: a migration describes a
 *    format as it was, and the model it would import will have moved on.
 * 3. Add a document of the old version to `tests/project-file.test.ts`.
 *
 * Never change or remove a migration once it has shipped. Rows in the database and files on
 * people's disks stay at whatever version wrote them until they are next saved, and the
 * `designs` table's `formatVersion` column is how to find the ones that haven't been.
 */

export const PROJECT_FILE_FORMAT = "cherryblossom.project"
export const PROJECT_FILE_VERSION = 2

/** A project as stored: everything but where it is stored. */
export type ProjectDocument = Omit<Project, "id" | "createdAt" | "updatedAt">

export interface ProjectFile {
  format: typeof PROJECT_FILE_FORMAT
  version: number
  project: ProjectDocument
}

/** Where a stored project came from, which the document itself doesn't say. */
export interface ProjectOrigin {
  id: string
  createdAt?: number
  updatedAt?: number
}

export type ProjectFileProblem = "not_json" | "not_a_project" | "too_new"

export class ProjectFileError extends Error {
  constructor(
    readonly problem: ProjectFileProblem,
    message: string,
  ) {
    super(message)
    this.name = "ProjectFileError"
  }
}

type Json = Record<string, unknown>

/**
 * `MIGRATIONS[v]` takes a version-`v` envelope's `project` to version `v + 1`.
 *
 * Version 0 is the bare `Project` the editor wrote before there was an envelope (October 2026):
 * every project in browser storage then and every file downloaded then. It already is the
 * version-1 document, plus the id and timestamps that now belong to the container.
 *
 * Version 2 drew the discrete symbols at KiCad's proportions, which moved their pins: the
 * migration reconnects what met them (`migrations/kicadSymbols.ts`).
 */
const MIGRATIONS: Record<number, (project: Json) => Json> = {
  0: ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...project }) => project,
  1: kicadSymbols,
}

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value)

/** The text to store or download for a project. */
export function serializeProject(project: Project, { pretty = false } = {}): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...document } = project
  const file: ProjectFile = { format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project: document }
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file)
}

/**
 * The envelope of a stored or uploaded project, at the version it was written in. A bare project
 * from before the envelope reads as version 0.
 */
function readEnvelope(raw: unknown): { version: number; project: Json } {
  if (!isObject(raw)) throw new ProjectFileError("not_a_project", "This isn't a Cherry Blossom project file.")
  if (raw.format === undefined && Array.isArray(raw.components)) return { version: 0, project: raw }
  if (raw.format !== PROJECT_FILE_FORMAT || !isObject(raw.project)) {
    throw new ProjectFileError("not_a_project", "This isn't a Cherry Blossom project file.")
  }
  const version = raw.version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new ProjectFileError("not_a_project", "This project file has no valid version.")
  }
  if (version > PROJECT_FILE_VERSION) {
    throw new ProjectFileError("too_new", "This project was saved by a newer version of Cherry Blossom. Reload the page to update, then open it again.")
  }
  return { version, project: raw.project }
}

/** The current version's document for any version this reader knows. */
export function migrateProjectFile(raw: unknown): ProjectDocument & Json {
  let { version, project } = readEnvelope(raw)
  while (version < PROJECT_FILE_VERSION) {
    const step = MIGRATIONS[version]
    if (!step) throw new ProjectFileError("not_a_project", `No migration from project file version ${version}.`)
    project = step(project)
    version++
  }
  return project as ProjectDocument & Json
}

/**
 * Read a project file, from its text or already parsed. Throws `ProjectFileError` when it isn't
 * one or is newer than this reader; anything else wrong inside it is repaired by
 * `normalizeProject` rather than refused.
 */
export function parseProjectFile(input: string | unknown, origin: ProjectOrigin): Project {
  let raw = input
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input)
    } catch {
      throw new ProjectFileError("not_json", "This file isn't valid JSON.")
    }
  }
  const document = migrateProjectFile(raw)
  return normalizeProject({ ...document, id: origin.id, createdAt: origin.createdAt, updatedAt: origin.updatedAt })
}

/** What a project list shows without opening the project. */
export interface ProjectSummary {
  name: string
  description: string
  /** Parts, not counting power and ground ports. */
  componentCount: number
}

export function summarizeProject(project: Project): ProjectSummary {
  return {
    name: project.name,
    description: project.description,
    componentCount: project.components.filter((c) => !c.ref.startsWith("#")).length,
  }
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value : [])

function normalizeComponent(c: Partial<ComponentInstance> & Pick<ComponentInstance, "id" | "partId">): ComponentInstance {
  const part = findPart(c.partId)
  return {
    ...c,
    ref: typeof c.ref === "string" ? c.ref : "",
    props: isObject(c.props) ? (c.props as Record<string, string>) : {},
    footprint: typeof c.footprint === "string" && c.footprint ? c.footprint : (part?.footprints[0] ?? ""),
    sch: { x: 0, y: 0, rot: 0, ...c.sch },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false, ...c.pcb },
  }
}

const CHECK_VERDICTS = new Set(["agrees", "renamed", "contradicted", "no_record", "different_part", "ambiguous", "pending"])
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** Which parts index part a project part came from, or null when the field isn't one. */
function normalizeDatabaseSource(raw: unknown): PartDatabaseSource | null {
  if (!isObject(raw) || typeof raw.key !== "string" || !raw.key) return null
  if (raw.origin !== "kicad" && raw.origin !== "easyeda") return null
  const text = (v: unknown) => (typeof v === "string" ? v : undefined)
  return {
    origin: raw.origin,
    key: raw.key,
    ...(text(raw.release) && { release: text(raw.release) }),
    ...(text(raw.footprint) && { footprint: text(raw.footprint) }),
    licence: text(raw.licence) ?? "",
    attribution: text(raw.attribution) ?? "",
  }
}

/**
 * A part's provenance as the rest of the editor can rely on it: what is malformed is dropped or
 * given its neutral value, so a hand-edited or damaged file can't crash the Checks panel. Null
 * when it isn't provenance at all.
 */
function normalizeSource(raw: unknown): PartSource | null {
  if (!isObject(raw) || typeof raw.pins !== "string") return null
  const out: PartSource = {
    pins: raw.pins === "supplier" || raw.pins === "database" ? raw.pins : "memory",
    land: raw.land === "supplier" || raw.land === "checked" || raw.land === "database" ? raw.land : "memory",
  }
  if (typeof raw.note === "string") out.note = raw.note
  const database = normalizeDatabaseSource(raw.database)
  if (database) out.database = database
  const supplier = raw.supplier
  if (isObject(supplier) && typeof supplier.lcsc === "string") {
    const disputes = strings(supplier.disputes)
    out.supplier = {
      lcsc: supplier.lcsc,
      mpn: typeof supplier.mpn === "string" ? supplier.mpn : supplier.lcsc,
      confidence: typeof supplier.confidence === "string" ? supplier.confidence : "single_source",
      vendors: typeof supplier.vendors === "number" && Number.isFinite(supplier.vendors) ? supplier.vendors : 1,
      fetchedAt: typeof supplier.fetchedAt === "string" ? supplier.fetchedAt : "",
      ...(disputes.length && { disputes }),
      ...(supplier.userUpload === true && { userUpload: true }),
      ...(typeof supplier.attribution === "string" && supplier.attribution && { attribution: supplier.attribution }),
    }
  } else if (out.pins === "supplier") {
    // Built from a supplier's pinout, but not saying which record: nothing to stand on.
    out.pins = "memory"
  }
  // From the parts index, but not saying which part: the same.
  if (out.pins === "database" && !out.database) out.pins = "memory"
  if (out.land === "database" && !out.database) out.land = "memory"
  const datasheet = raw.datasheet
  if (isObject(datasheet) && typeof datasheet.lcsc === "string" && Array.isArray(datasheet.pages)) {
    const pages = datasheet.pages.filter((p): p is number => Number.isInteger(p) && p > 0)
    if (pages.length) out.datasheet = { at: typeof datasheet.at === "string" ? datasheet.at : "", lcsc: datasheet.lcsc, pages }
  }
  const check = raw.check
  if (isObject(check) && typeof check.verdict === "string" && CHECK_VERDICTS.has(check.verdict) && Array.isArray(check.findings)) {
    out.check = {
      at: typeof check.at === "string" ? check.at : "",
      ...(typeof check.lcsc === "string" && { lcsc: check.lcsc }),
      verdict: check.verdict as NonNullable<PartSource["check"]>["verdict"],
      findings: strings(check.findings),
    }
  }
  return out
}

/** A project's own parts that still build: a hand-edited one that doesn't is dropped, not fatal. */
function normalizeParts(raw: unknown): CustomPartSpec[] {
  const out: CustomPartSpec[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.name !== "string") continue
    if (!Array.isArray(item.pins) || typeof item.footprint !== "string") continue
    const spec = { ...item, props: isObject(item.props) ? item.props : {} } as CustomPartSpec
    // Provenance that isn't an object reads as none (made from memory), rather than costing the part.
    if (spec.source !== undefined) {
      const source = normalizeSource(spec.source)
      if (source) spec.source = source
      else delete spec.source
    }
    try {
      if (customPartProblems(spec).length) continue
      buildCustomPart(spec)
      out.push(spec)
    } catch {
      // malformed pins or symbol
    }
  }
  return out
}

const finite = (...values: unknown[]) => values.every((v) => typeof v === "number" && Number.isFinite(v))
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)
const PAD_SHAPES = new Set(["rect", "circle", "pill", "polygon"])

function isPad(pad: unknown): pad is PadDef {
  return (
    isObject(pad) &&
    (pad.pin === null || typeof pad.pin === "string") &&
    PAD_SHAPES.has(pad.shape as string) &&
    (pad.layer === "top" || pad.layer === "through") &&
    finite(pad.x, pad.y, pad.width, pad.height) &&
    (pad.points === undefined || (Array.isArray(pad.points) && pad.points.every(isPoint)))
  )
}

/**
 * A project's own land patterns that can be drawn. One with a malformed pad is dropped whole
 * rather than drawn without it: a missing pad is a board that can't be built.
 */
function normalizeFootprints(raw: unknown): FootprintDef[] {
  const out: FootprintDef[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.name !== "string" || !item.name.trim()) continue
    if (!Array.isArray(item.pads) || !item.pads.length || !item.pads.every(isPad)) continue
    const c = item.courtyard
    if (!isObject(c) || !finite(c.minX, c.minY, c.maxX, c.maxY)) continue
    const silk = list<unknown>(item.silk).filter((path): path is Vec2[] => Array.isArray(path) && path.every(isPoint))
    const { package: pkg, ...rest } = item
    out.push({ ...rest, silk, ...(typeof pkg === "string" && pkg.trim() ? { package: pkg.trim().slice(0, 120) } : {}) } as FootprintDef)
  }
  return out
}

/** Project properties with a key, keeping their order; absent when there are none. */
function normalizeProperties(raw: unknown): Project["properties"] {
  const props = list<{ key?: unknown; value?: unknown }>(raw)
    .filter((p) => isObject(p) && typeof p.key === "string" && p.key.trim() !== "")
    .map((p) => ({ key: String(p.key).trim(), value: typeof p.value === "string" ? p.value : "" }))
  return props.length ? props : undefined
}

const ROTATIONS = [0, 90, 180, 270]
function normalizeSch(raw: unknown): ComponentInstance["sch"] | null {
  if (!isObject(raw) || typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null
  const rot = raw.rot === undefined ? 0 : raw.rot
  return typeof rot === "number" && ROTATIONS.includes(rot) ? { x: raw.x, y: raw.y, rot: rot as ComponentInstance["sch"]["rot"] } : null
}

/** The positions a leftover block remembers, for the components that are there and entries that read as positions. */
function normalizeOrigins(raw: unknown, exists: Set<string>): SchematicBlock["origins"] {
  if (!isObject(raw)) return undefined
  const out: NonNullable<SchematicBlock["origins"]> = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (!exists.has(id) || !isObject(entry)) continue
    const from = normalizeSch(entry.from)
    const to = normalizeSch(entry.to)
    if (from && to) out[id] = { from, to }
  }
  return Object.keys(out).length ? out : undefined
}

/** Ignored check keys, once each; absent when there are none. */
function normalizeIgnoredChecks(raw: unknown): Project["ignoredChecks"] {
  const keys = [...new Set(list<unknown>(raw).filter((k): k is string => typeof k === "string" && k.trim() !== ""))]
  return keys.length ? keys : undefined
}

/**
 * Blocks with a name and at least one of the project's components, each component in the first
 * block that lists it; absent when there are none. Their frames are worked out from the parts, so
 * there is nothing else in them to repair.
 */
function normalizeBlocks(raw: unknown, components: ComponentInstance[]): Project["blocks"] {
  const exists = new Set(components.map((c) => c.id))
  const placed = new Set<string>()
  const ids = new Set<string>()
  const out: SchematicBlock[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || ids.has(item.id) || typeof item.name !== "string" || !cleanBlockName(item.name)) continue
    const members = [...new Set(list<unknown>(item.components))].filter((id): id is string => typeof id === "string" && exists.has(id) && !placed.has(id))
    if (!members.length) continue
    for (const id of members) placed.add(id)
    ids.add(item.id)
    // Names as the editor writes them: spaces collapsed, and unique whatever their case.
    const base = cleanBlockName(item.name)
    const taken = (n: string) => out.some((b) => b.name.toLowerCase() === n.toLowerCase())
    let name = base
    for (let i = 2; taken(name); i++) name = `${base} ${i}`
    const block: SchematicBlock = { ...item, name, components: members } as SchematicBlock
    // Flags as the editor writes them: a hand-edited "no" is not a leftover block.
    delete block.leftover
    delete block.origins
    if (item.leftover === true) {
      block.leftover = true
      const origins = normalizeOrigins(item.origins, exists)
      if (origins) block.origins = origins
    }
    out.push(block)
  }
  return out.length ? out : undefined
}

const ARROWS = new Set(["start", "end", "both"])
const ALIGNS = new Set(["left", "center", "right"])

/** A drawing as the editor can draw it, or null when it can't be: no points, no size, no text. */
function normalizeDrawing(item: Record<string, unknown> & { id: string }): SchematicDrawing | null {
  // A style the editor doesn't know reads as the default rather than costing the drawing.
  const style = {
    color: isDrawingColor(item.color) ? item.color : undefined,
    fill: isDrawingColor(item.fill) ? item.fill : undefined,
    weight: isLineWeight(item.weight) ? item.weight : undefined,
    dash: isLineDash(item.dash) ? item.dash : undefined,
  }
  if (item.type === "line") {
    if (!Array.isArray(item.points) || item.points.length < 2 || !item.points.every(isPoint)) return null
    const points = (item.points as Vec2[]).map((p) => ({ x: p.x, y: p.y }))
    const arrows = ARROWS.has(item.arrows as string) ? (item.arrows as DrawingLine["arrows"]) : undefined
    return clean({ ...item, ...style, type: "line", points, closed: item.closed === true && points.length > 2, arrows } as DrawingLine)
  }
  if (item.type === "rect") {
    if (!finite(item.x, item.y, item.width, item.height) || !((item.width as number) > 0 && (item.height as number) > 0)) return null
    const radius = finite(item.radius) && (item.radius as number) > 0 ? (item.radius as number) : undefined
    return clean({ ...item, ...style, type: "rect", radius } as DrawingBox)
  }
  if (item.type === "text") {
    if (typeof item.text !== "string" || !item.text.trim() || !finite(item.x, item.y)) return null
    const size = finite(item.size) && (item.size as number) > 0 ? Math.min(item.size as number, 5) : DEFAULT_TEXT_SIZE
    const flag = (k: string) => item[k] === true
    return clean({
      ...item,
      ...style,
      type: "text",
      size,
      align: ALIGNS.has(item.align as string) ? (item.align as DrawingText["align"]) : undefined,
      bold: flag("bold"),
      italic: flag("italic"),
      mono: flag("mono"),
      border: flag("border"),
      rot: item.rot === 90 ? 90 : undefined,
    } as DrawingText)
  }
  return null
}

/** Drawings that can be drawn, each id once, in their order; absent when there are none. */
function normalizeDrawings(raw: unknown): Project["drawings"] {
  const ids = new Set<string>()
  const out: SchematicDrawing[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || ids.has(item.id)) continue
    const d = normalizeDrawing(item as Record<string, unknown> & { id: string })
    if (!d) continue
    ids.add(d.id)
    out.push(d)
  }
  return out.length ? out : undefined
}

/**
 * Fill fields missing from older or hand-written projects, down to each component's position:
 * the editor reads them on every render, so one gap would crash it on every load. Registers the
 * project's own land patterns and parts as a side effect, before its parts and components need
 * them.
 */
export function normalizeProject(raw: Partial<Project> & { id: string }): Project {
  const now = Date.now()
  const footprints = normalizeFootprints(raw.footprints)
  registerProjectFootprints({ footprints })
  const parts = normalizeParts(raw.parts)
  registerProjectParts({ parts })
  const components = list<Partial<ComponentInstance>>(raw.components)
    .filter((c): c is Partial<ComponentInstance> & Pick<ComponentInstance, "id" | "partId"> =>
      isObject(c) && typeof c.id === "string" && typeof c.partId === "string",
    )
    .map(normalizeComponent)
  const models = normalizeModels(raw.models)
  return {
    ...raw,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Untitled project",
    description: typeof raw.description === "string" ? raw.description : "",
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    components,
    wires: list(raw.wires),
    labels: list(raw.labels),
    traces: list(raw.traces),
    vias: list(raw.vias),
    zones: list(raw.zones),
    texts: list(raw.texts),
    board: { width: 50, height: 40, x: 0, y: 0, thickness: 1.6, cornerRadius: 1, ...raw.board },
    rules: normalizeRules(raw.rules),
    blocks: normalizeBlocks(raw.blocks, components),
    drawings: normalizeDrawings(raw.drawings),
    properties: normalizeProperties(raw.properties),
    ignoredChecks: normalizeIgnoredChecks(raw.ignoredChecks),
    parts: parts.length ? parts : undefined,
    footprints: footprints.length ? footprints : undefined,
    models: models.length ? models : undefined,
  } as Project
}
