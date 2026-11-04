import { normalizeAngle } from "../lib/geometry"
import { isObject } from "../lib/guards"
import { cleanBlockName } from "./blocks"
import { clean, DEFAULT_TEXT_SIZE, isDrawingColor, isLineDash, isLineWeight } from "./drawings"
import { normalizeNetChains } from "./netChains"
import { normalizePoints, normalizeUnits } from "./pcbPoints"
import { normalizeVia, unpackVias } from "./viaCodec"
import { packDimensions, packGroups, packImages, defaultPartGroupId, unpackDimensions, unpackGroups, unpackImages, type DimensionStyleDef } from "./dimCodec"
import { buildCustomPart, customPartProblems, registerProjectParts } from "./customParts"
import { registerProjectFootprints } from "./footprints"
import { findPart } from "./library"
import { kicadSymbols } from "./migrations/kicadSymbols"
import { libraryParts } from "./migrations/libraryParts"
import { schematicUnits } from "./migrations/schematicUnits"
import { sheetsRoot } from "./migrations/sheetsRoot"
import { normalizeModels } from "./models3d"
import { needsPadPacking, normalizePad, packPad } from "./padCodec"
import { normalizeOutline, unpackOutline } from "./outlineCodec"
import { syncOutlineBox } from "./outlineOps"
import { cleanFlags } from "./partFlags"
import { normalizeRules } from "./rules"
import { normalizeZones, packZones } from "./zoneCodec"
import { isShapeLayer } from "./shapeLayers"
import { isCompactShapes, packShapes, unpackGraphics, unpackShapes } from "./shapeCodec"
import { ROOT_SHEET } from "./sheets"
import { normalizeExact, normalizeKicadOnly, normalizeLabel, normalizeLook, normalizeRuleArea, normalizeStroke } from "./sheetItems"
import { normalizeShape } from "./shapes"
import { readDrawing } from "./symbolDrawing"
import { normalizeOverrides, normalizeProjectVariants, normalizeSheetOverrides } from "./variants"
import { normalizeStack } from "./stackCodec"
import { copperLayers } from "./stack"
import { normalizeBoardTextObjects, normalizePartTexts, unpackBoardTexts, unpackPartTexts, type TextStyleDef } from "./textCodec"
import { repairUnits } from "./units"
import type { LabelShape, Rotation, BoardDimension, BoardGraphic, PcbGroup, ReferenceImage, BoardShape, BoardText, ComponentInstance, CustomPartSpec, DrawingBox, DrawingLine, DrawingText, FieldPlace, FootprintDef, PadDef, PartDatabaseSource, PartSource, GenValue, Project, SchematicBlock, SchematicDrawing, SymbolDrawing, Trace, Vec2, Via, Wire } from "./types"

/**
 * The project file: how a project is written down wherever it is kept. One format for an
 * account, this browser's storage and a file the user downloads, so a download
 * is a backup that opens anywhere and there is one reader to keep working.
 *
 *     { "format": "cherryblossom.project", "version": 4, "project": { "name": ..., ... } }
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
export const PROJECT_FILE_VERSION = 5

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

/** Net classes and their rules are optional fields whose absence is the default, so nothing is filled in. */
function x10Rules(project: Json): Json {
  return project
}

/**
 * Directive labels (`drawings` of the type `directive`), rule areas (a closed line with `ruleArea`) and the net classes labels give
 * (`NetClass.labelNets`, and `implicit` for a class only a label names) are new drawings and optional fields whose absence is the default (none), so
 * nothing is filled in; the bump is what keeps an older reader, which drops a drawing of a type it does not know, from saving over a document that has them (S8).
 */
function s8Directives(project: Json): Json {
  return project
}

/** Buses, bus entries and bus aliases are optional and their absence is a schematic with none, so nothing is filled in. */
function busesStep(project: Json): Json {
  return project
}

/** A pad's X7 fields are optional and their absence is what a pad was, so nothing is filled in. */
function x7Pads(project: Json): Json {
  return project
}

/** Copper layers, the stackup, arc tracks and via kinds are optional fields whose absence is a board of two layers with straight tracks and through vias, so nothing is filled in. */
function x1Layers(project: Json): Json {
  return project
}

/** Variants (`Project.variants`, `ComponentInstance.variants`, `SheetSymbol.variants`) and a sheet's `kicadRules` are optional fields whose absence is a project with no variants and the editor's own joining rules, so nothing is filled in. */
function variantsAndJoin(project: Json): Json {
  return project
}

/** What the step from 2 to 3 does, in order. Most are the identity, kept for what they say about the shape; two rewrite. */
const STEPS_2_TO_3: ((project: Json) => Json)[] = [
  schematicUnits,
  x10Rules,
  x7Pads,
  (project) => sheetsRoot(x1Layers(project)),
  s8Directives,
  busesStep,
  variantsAndJoin,
]

/**
 * `MIGRATIONS[v]` takes a version-`v` envelope's `project` to version `v + 1`.
 *
 * Version 0 is the bare `Project` the editor wrote before there was an envelope (October 2026):
 * every project in browser storage then and every file downloaded then. It already is the
 * version-1 document, plus the id and timestamps that now belong to the container.
 *
 * Version 2 drew the discrete symbols at KiCad's proportions, which moved their pins: the
 * migration reconnects what met them (`migrations/kicadSymbols.ts`).
 *
 * Version 3 is the KiCad import, in one step from 2. It gave the project everything below, all as
 * optional fields whose absence is the default, except two rewrites (`schematicUnits`, `sheetsRoot`).
 * The bump is what keeps a version 2 reader, which would drop them and save the loss back, from opening one.
 *
 * - Boards: footprint flags and net ties (`flags`), a trace's net (`net`), a via's (`routedNet`), board and land
 *   drawings (`graphics`, `shapes`, `noCourtyard`), board and part text (`texts` with a `layer`, a part's `texts`),
 *   any angle (`pcb.rot`) and any outline (`board.outline`), net classes and the rules with them (`netClasses`,
 *   `viaSizes`, ...), dimensions, groups and reference images, zones as any polygon with their own settings,
 *   the pad model (`PadDef`: `rot`, `round`, `chamfer`, `custom`, `holeOffset`, `layers`, margins, ...), copper layers and the stackup
 *   (`board.stack`), arc tracks (`arc`) and via kinds (`kind`, `from`, `to`, ...).
 * - Schematics: a symbol's unit, body style, mirror, fields and pin alternates, the symbol drawings parts are drawn from
 *   (`symbols`), label kinds and looks, wire looks, block locks, `netNames`, and the wider drawings (arcs, curves, text boxes, tables, ...);
 *   hierarchical sheets (`sheets`, `sheetSymbols`, `sheet`, `inst`), directive labels and rule areas, buses (`bus`, `busentry`, `busAliases`),
 *   variants (`Project.variants` and those on a symbol and a sheet symbol) and KiCad's joining rules (`SchematicSheet.kicadRules`).
 * - `schematicUnits` rewrites two shapes only a development build of the schematic track wrote: a symbol's flags
 *   (`inBom: false`, ...) become the one `PartFlags` set, and a sheet's `items` become `drawings`. A document with neither comes out as it went in.
 * - `sheetsRoot` lists a one-sheet project's sheet as the root (`sheets: [{ id: "root" }]`).
 *
 * The extras of the KiCad import (zones on layers that are not copper, zones in parts, a pad's pour layers, placement rule areas, component classes, tuning patterns, via protection,
 * backdrills, net chains, TrueType text and embedded fonts, board variants on a part, a footprint's units and PCB points) are fields of version 3 too: all optional, absent means none.
 *
 * Version 4 took the chips and modules out of the built-in library: a project that placed one has
 * it as a part of its own, drawn as the library drew it (`migrations/libraryParts.ts`).
 *
 * Version 5 lets a schematic picture be a file in the host's file store (`DrawingImage.file`, with its size in pixels and
 * resolution) instead of base64 in the project (`data`), which a KiCad import now does. A version 4 document reads as it was;
 * the bump is what keeps a version 4 reader, which would drop such a picture and save the loss back, from opening one.
 */
const MIGRATIONS: Record<number, (project: Json) => Json> = {
  0: ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...project }) => project,
  1: kicadSymbols,
  2: (project) => STEPS_2_TO_3.reduce((doc, step) => step(doc), project),
  3: libraryParts,
  4: (project) => project,
}


/** The text to store or download for a project. */
/**
 * The board's texts in the order they were saved in: the editor's own silkscreen text and KiCad's can be mixed, and the stored form keeps them
 * apart (`texts` and `kt`), so `kp` says where each of KiCad's was (absent when they all come last, as a board brought in from KiCad has them).
 */
function orderTexts(own: BoardText[], kicad: BoardText[], kp: unknown, objects: number): BoardText[] {
  const total = own.length + kicad.length
  const positions = Array.isArray(kp) ? kp : null
  const valid =
    positions !== null &&
    objects === 0 &&
    positions.length === kicad.length &&
    positions.every((p) => Number.isInteger(p) && p >= 0 && p < total) &&
    new Set(positions).size === positions.length
  if (!valid) return [...own, ...kicad]
  const out: (BoardText | undefined)[] = new Array(total)
  positions.forEach((p, i) => (out[p as number] = kicad[i]))
  let next = 0
  for (let i = 0; i < total; i++) if (out[i] === undefined) out[i] = own[next++]
  return out as BoardText[]
}

/**
 * The board's texts: the list as it is written, the editor's own silkscreen text as it was and each of KiCad's read as a text. A file written before keeps KiCad's
 * compact (`kt`, placed among the editor's by `kp`); one an edit since put in the list as an object stands for the stored one of its id.
 */
function boardTexts(raw: Json, styles: TextStyleDef[]): BoardText[] {
  const rawTexts = list<Record<string, unknown>>(raw.texts)
  const kt = (raw as { kt?: unknown }).kt
  if (kt === undefined) {
    const taken = new Set<string>()
    return rawTexts.flatMap((t) => (isObject(t) && t.layer !== undefined ? normalizeBoardTextObjects([t], taken) : [t as unknown as BoardText]))
  }
  const ownTexts = rawTexts.filter((t) => !isObject(t) || t.layer === undefined)
  const objects = normalizeBoardTextObjects(rawTexts.filter((t) => isObject(t) && t.layer !== undefined), new Set())
  const edited = new Set(objects.map((t) => t.id))
  const kicadTexts = [...objects, ...unpackBoardTexts(kt, styles).filter((t) => !edited.has(t.id))]
  return orderTexts(ownTexts as unknown as BoardText[], kicadTexts, (raw as { kp?: unknown }).kp, rawTexts.length - ownTexts.length)
}

/** The items of a stored list written as objects, each read by `read` (which may throw on one that is not one), with an id once. */
function plainItems<T extends { id: string }>(raw: unknown, read: (item: Record<string, unknown>) => T | null | undefined): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const item of list<unknown>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || seen.has(item.id)) continue
    let made: T | null | undefined
    try {
      made = read(item)
    } catch {
      made = null
    }
    if (!made || made.id !== item.id) continue
    seen.add(made.id)
    out.push(made)
  }
  return out
}

/** Groups written as objects, read as the compact entries are (`unpackGroups`). */
function plainGroups(raw: unknown, defaultId?: (place: number) => string): PcbGroup[] {
  return plainItems(raw, (g) => unpackGroups(packGroups([g as unknown as PcbGroup], defaultId), defaultId)?.[0])
}

/** The items of a list as written before (`stored`) with the objects an edit since wrote (`edited`) over them by id, and after them where they are new. */
function byId<T extends { id: string }>(stored: T[], edited: T[]): T[] {
  if (!stored.length) return edited
  const fresh = new Map(edited.map((x) => [x.id, x]))
  const had = new Set(stored.map((x) => x.id))
  return [...stored.map((x) => fresh.get(x.id) ?? x), ...edited.filter((x) => !had.has(x.id))]
}

/** A component as it is stored: a footprint's units as lists of a name and the pad numbers in one string (a board has one for every part). */
function storedComponent(c: ComponentInstance): unknown {
  const { units, ...rest } = c
  return { ...rest, ...(units ? { units: units.map((u) => [u.name, u.pins.some((n) => /\s/.test(n) || n === "") ? u.pins : u.pins.join(" ")]) } : {}) }
}

export function serializeProject(project: Project, { pretty = false } = {}): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, scope: _scope, ...plain } = project
  const document = Object.fromEntries(Object.entries(plain).map(([key, value]) => [key, storedValue(key, value)])) as unknown as ProjectDocument
  const file: ProjectFile = { format: PROJECT_FILE_FORMAT, version: PROJECT_FILE_VERSION, project: document }
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file)
}

/**
 * A value of the project as the file stores it under its key. Storage applies an edit to the stored file by the paths the live sync names (`store/changes.ts`): a list
 * edited item by item, an item's value by its key. So every such list is written as the list of its items, and every value under the key the model gives it: an edit made
 * to one written in another shape or under another key was lost once the project was read again. Only a value an edit always replaces whole is written compactly, under its
 * own key: a part's units, a land's drawings, pads and zones (`packShapes`, `packPad`, `packZones`), and a zone's polygon and kept fill. The compact forms written before
 * (`tx`, `gr`, `kt`, `kp`, `textStyles`, `dm`, `dimStyles`, `grp`, `gd`, `vx`, `im`, an outline's `ol`, a zone's `ff`, the board's drawings in runs) are still read.
 */
function storedValue(key: string, value: unknown): unknown {
  if (key === "components") {
    const components = value as Project["components"]
    return components.some((c) => c.units) ? components.map((c) => (c.units ? storedComponent(c) : c)) : components
  }
  if (key === "zones") {
    const zones = value as Project["zones"]
    return zones.some((z) => z.outline || z.kept) ? packZones(zones) : zones
  }
  if (key === "footprints") {
    const footprints = value as Project["footprints"]
    const packed = (f: NonNullable<Project["footprints"]>[number]) => f.shapes?.length || f.zones?.length || needsPadPacking(f.pads)
    if (!footprints?.some(packed)) return footprints
    return footprints.map((f) => (packed(f) ? { ...f, ...(f.zones?.length ? { zones: packZones(f.zones) } : {}), ...(f.shapes?.length ? { shapes: packShapes(f.shapes) } : {}), ...(needsPadPacking(f.pads) ? { pads: f.pads.map(packPad) } : {}) } : f))
  }
  return value
}

/**
 * `serializeProject`, for a stream of projects each an edit of the last: each top-level value's text is kept, and a value that is the same object as
 * last time is not written again. The editor's workers are sent the project after each edit, and Macbeth's took 0.4 s to write whole, most of it
 * its pours' kept fills, which an edit of a track or a part leaves as they are. The text is `serializeProject`'s, character for character.
 */
export function projectFileWriter(): (project: Project) => string {
  let kept = new Map<string, { value: unknown; json: string }>()
  return (project) => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, scope: _scope, ...plain } = project
    const next = new Map<string, { value: unknown; json: string }>()
    const parts: string[] = []
    for (const [key, value] of Object.entries(plain)) {
      if (value === undefined) continue
      const was = kept.get(key)
      const json = was && was.value === value ? was.json : JSON.stringify(storedValue(key, value))
      next.set(key, { value, json })
      parts.push(`${JSON.stringify(key)}:${json}`)
    }
    kept = next
    return `{"format":${JSON.stringify(PROJECT_FILE_FORMAT)},"version":${PROJECT_FILE_VERSION},"project":{${parts.join(",")}}}`
  }
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

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 256

/** A field's place as the editor draws it, or null when the entry is not one. */
function normalizePlace(raw: unknown): FieldPlace | null {
  if (!isObject(raw) || !finite(raw.x, raw.y)) return null
  const place: FieldPlace = { x: raw.x as number, y: raw.y as number, angle: raw.angle === 90 ? 90 : 0 }
  if (finite(raw.size) && (raw.size as number) > 0) place.size = raw.size as number
  if (raw.hidden === true) place.hidden = true
  if (raw.h === "left" || raw.h === "right") place.h = raw.h
  if (raw.v === "top" || raw.v === "bottom") place.v = raw.v
  if (raw.bold === true) place.bold = true
  if (raw.italic === true) place.italic = true
  if (raw.showName === true) place.showName = true
  if (typeof raw.color === "string" && raw.color) place.color = raw.color
  if (finite(raw.thickness) && (raw.thickness as number) > 0) place.thickness = raw.thickness as number
  if (raw.noAutoplace === true) place.noAutoplace = true
  return place
}

function normalizeFields(raw: unknown): ComponentInstance["fields"] {
  if (!isObject(raw)) return undefined
  const out: NonNullable<ComponentInstance["fields"]> = {}
  for (const [name, place] of Object.entries(raw)) {
    const p = normalizePlace(place)
    if (p) out[name] = p
  }
  return Object.keys(out).length ? out : undefined
}

/** The board: its stored fields over the defaults, its outline unpacked (or read from a hand-written file's plain objects), and its box following the outline. */
function normalizeBoard(raw: unknown): Project["board"] {
  const { ol, outline: plain, stack: rawStack, ...rest } = (isObject(raw) ? raw : {}) as Json & { ol?: unknown; outline?: unknown; stack?: unknown }
  const stack = normalizeStack(rawStack)
  const merged = { width: 50, height: 40, x: 0, y: 0, thickness: 1.6, cornerRadius: 1, ...rest, ...(stack ? { stack } : {}) } as Project["board"]
  // The outline as an object; or compact (`ol`), as it was written before, which an edit since (as an object) replaces.
  const outline = plain !== undefined ? normalizeOutline(plain) : ol !== undefined ? unpackOutline(ol) : null
  return outline ? syncOutlineBox({ ...merged, outline }) : merged
}

/** A part's PCB place: its stored fields over the defaults, with any angle of a number kept (brought into [0, 360)) and anything else read as 0. */
function pcbOf(raw: Partial<ComponentInstance["pcb"]> | undefined): ComponentInstance["pcb"] {
  const merged = { x: 0, y: 0, rot: 0, side: "top" as const, placed: false, ...raw }
  return { ...merged, rot: typeof merged.rot === "number" && Number.isFinite(merged.rot) ? normalizeAngle(merged.rot) : 0 }
}

function normalizeComponent(c: Partial<ComponentInstance> & Pick<ComponentInstance, "id" | "partId">, styles: TextStyleDef[]): ComponentInstance {
  const part = findPart(c.partId)
  const { unit, bodyStyle, fields, pinAlt, fieldsAutoplaced, flags: rawFlags, variants, texts: rawTexts, tx, gr, groups: rawGroups, classes: rawClasses, sheetPath: rawSheetPath, units: rawUnits, points: rawPoints, ...rest } = c as typeof c & { tx?: unknown; gr?: unknown }
  const flags = cleanFlags(rawFlags)
  // A part's own text and its groups: objects, or the compact entries written before (`tx`, `gr`), which an edit since (as objects) replaces. A part drawn in the editor has neither.
  const texts = rawTexts !== undefined ? normalizePartTexts(rawTexts) : tx !== undefined ? unpackPartTexts(tx, styles) : undefined
  const groups = rawGroups !== undefined ? plainGroups(rawGroups, defaultPartGroupId) : unpackGroups(gr, defaultPartGroupId)
  // X20: its component classes, each name once and none empty; the sheet path its footprint says.
  const classes = Array.isArray(rawClasses) ? [...new Set(rawClasses.filter((n): n is string => typeof n === "string" && n !== ""))] : []
  // X23: its footprint's units and PCB points.
  const units = normalizeUnits(rawUnits)
  const points = normalizePoints(rawPoints)
  const out: ComponentInstance = {
    ...rest,
    ...(classes.length ? { classes } : {}),
    ...(units ? { units } : {}),
    ...(points ? { points } : {}),
    ...(typeof rawSheetPath === "string" && rawSheetPath ? { sheetPath: rawSheetPath } : {}),
    ...(flags ? { flags } : {}),
    ...(texts ? { texts } : {}),
    ...(groups?.length ? { groups } : {}),
    ref: typeof c.ref === "string" ? c.ref : "",
    props: isObject(c.props) ? (c.props as Record<string, string>) : {},
    footprint: typeof c.footprint === "string" && c.footprint ? c.footprint : (part?.footprints[0] ?? ""),
    sch: normalizePlacement(c.sch),
    pcb: pcbOf(c.pcb),
  }
  // What a symbol of a part with several units or body styles adds; each kept only when it says something.
  if (positiveInt(unit) && unit > 1) out.unit = unit
  if (positiveInt(bodyStyle) && bodyStyle > 1) out.bodyStyle = bodyStyle
  const f = normalizeFields(fields)
  if (f) out.fields = f
  const overrides = normalizeOverrides(variants)
  if (overrides) out.variants = overrides
  if (fieldsAutoplaced === true) out.fieldsAutoplaced = true
  if (isObject(pinAlt)) {
    const alts = Object.fromEntries(Object.entries(pinAlt).filter((e): e is [string, string] => typeof e[1] === "string"))
    if (Object.keys(alts).length) out.pinAlt = alts
  }
  return out
}

/** Wires as the editor holds them: the points, and a look of the wire's own when it has one. */
function normalizeWires(raw: unknown): Wire[] {
  return list<Wire>(raw).map((w) => {
    if (!isObject(w) || !("look" in w)) return w
    const { look, ...rest } = w as Wire & Json
    const l = normalizeStroke(look)
    return (l ? { ...rest, look: l } : rest) as Wire
  })
}

/** Where a symbol is on the sheet, with the mirror kept when it is one. */
function normalizePlacement(raw: unknown): ComponentInstance["sch"] {
  const sch = isObject(raw) ? raw : {}
  const out: ComponentInstance["sch"] = { x: 0, y: 0, rot: 0, ...(sch as Partial<ComponentInstance["sch"]>) }
  if (out.mirror !== "x" && out.mirror !== "y") delete out.mirror
  return out
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
    pins: raw.pins === "supplier" || raw.pins === "database" || raw.pins === "file" || raw.pins === "import" || raw.pins === "library" || raw.pins === "user" ? raw.pins : "memory",
    land:
      raw.land === "supplier" || raw.land === "checked" || raw.land === "database" || raw.land === "file" || raw.land === "import" || raw.land === "library" || raw.land === "user"
        ? raw.land
        : "memory",
  }
  const imported = raw.imported
  if (isObject(imported) && typeof imported.file === "string" && typeof imported.libId === "string") out.imported = { file: imported.file, libId: imported.libId }
  if (typeof raw.note === "string") out.note = raw.note
  const database = normalizeDatabaseSource(raw.database)
  if (database) out.database = database
  const file = raw.file
  if (isObject(file) && typeof file.footprint === "string" && file.footprint) {
    out.file = { symbol: typeof file.symbol === "string" && file.symbol ? file.symbol : null, footprint: file.footprint }
  }
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
  // Imported, but not saying from which files: the same.
  if (out.pins === "file" && !out.file) out.pins = "memory"
  if (out.land === "file" && !out.file) out.land = "memory"
  if (!out.imported) {
    if (out.pins === "import") out.pins = "memory"
    if (out.land === "import") out.land = "memory"
  }
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

/** The symbol drawings of a project that the editor can draw: one that cannot is dropped, and with it the parts that name it. */
function normalizeSymbols(raw: unknown): Project["symbols"] {
  if (!isObject(raw)) return undefined
  const out: Record<string, SymbolDrawing> = {}
  for (const [key, value] of Object.entries(raw)) {
    const d = readDrawing(value)
    if (d) out[key] = d
  }
  return Object.keys(out).length ? out : undefined
}

/** A project's own parts that still build: a hand-edited one that does not is dropped, not fatal. */
function normalizeParts(raw: unknown, symbols: Project["symbols"]): CustomPartSpec[] {
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
      if (customPartProblems(spec, symbols).length) continue
      buildCustomPart(spec, symbols)
      out.push(spec)
    } catch {
      // malformed pins or symbol
    }
  }
  return out
}

const finite = (...values: unknown[]) => values.every((v) => typeof v === "number" && Number.isFinite(v))
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)
/**
 * A project's own land patterns that can be drawn. One with a malformed pad is dropped whole
 * rather than drawn without it: a missing pad is a board that can't be built.
 */
function normalizeFootprints(raw: unknown): FootprintDef[] {
  const out: FootprintDef[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.name !== "string" || !item.name.trim()) continue
    // A land may have no pad (a logo, a mounting hole's drawing) and no drawing either (a footprint of text only): it has a courtyard, and its parts have text.
    if (!Array.isArray(item.pads)) continue
    const pads = item.pads.map(normalizePad)
    if (!pads.every((pad): pad is PadDef => pad !== null)) continue
    const c = item.courtyard
    if (!isObject(c) || !finite(c.minX, c.minY, c.maxX, c.maxY)) continue
    const silk = list<unknown>(item.silk).filter((path): path is Vec2[] => Array.isArray(path) && path.every(isPoint))
    // `package`, `like` and `noBody` were for the generated 3D bodies, gone since November 2026: a file written before holds them, and they are dropped.
    const { package: _package, like: _like, noBody: _noBody, shapes: rawShapes, zones: rawZones, noCourtyard, descr, tags, ...rest } = item
    const landZones = normalizeZones(rawZones).filter((z) => z.outline?.length).map((z, i) => ({ ...z, id: `z${i}` }))
    const shapes = isCompactShapes(rawShapes) ? (unpackShapes(rawShapes) ?? []) : list<unknown>(rawShapes).flatMap((x) => normalizeShape(x, isShapeLayer) ?? [])
    out.push({
      ...rest,
      pads: pads as PadDef[],
      silk,
      ...(shapes.length ? { shapes } : {}),
      // X30: the zones drawn inside the footprint, read as a board's are and with the same repairs; their ids name their place in the land and are made unique here.
      ...(landZones.length ? { zones: landZones } : {}),
      ...(noCourtyard === true ? { noCourtyard: true } : {}),
      ...(typeof descr === "string" && descr ? { descr: descr.slice(0, 2000) } : {}),
      ...(typeof tags === "string" && tags ? { tags: tags.slice(0, 2000) } : {}),
    } as FootprintDef)
  }
  return out
}

/** Traces and vias as the editor reads them: a net that is not a name is dropped, so copper is never on a net that is not there. */
function normalizeCopper<T extends object>(raw: unknown, key: "net" | "routedNet"): T[] {
  return list<Record<string, unknown>>(raw).map((item) => {
    if (!isObject(item)) return item as T
    const fixed = key === "net" ? normalizeTrace(item) : normalizeVia(item)
    if (fixed[key] === undefined || (typeof fixed[key] === "string" && (fixed[key] as string).trim())) return fixed as T
    const { [key]: _drop, ...rest } = fixed
    return rest as T
  })
}

/**
 * Copper as the board's own layers have it: a trace on a layer the board lacks is dropped (there is no layer to draw it on) with a console warning, and a via that names a layer the board lacks is a
 * through via, with no extra layer lists. The editor never reads a layer id it cannot place.
 */
function fitCopperToStack(traces: Trace[], vias: Via[], board: Project["board"]): { traces: Trace[]; vias: Via[] } {
  const ids = new Set<string>(copperLayers(board))
  const known = (l: unknown) => typeof l === "string" && ids.has(l)
  const kept = traces.filter((t) => !isObject(t) || known(t.layer) || t.layer === undefined)
  if (kept.length < traces.length) console.warn(`Project load: dropped ${traces.length - kept.length} trace${traces.length - kept.length === 1 ? "" : "s"} on a copper layer the board does not have (${[...ids].join(", ")}).`)
  return {
    traces: kept,
    vias: vias.map((v) => {
      if (!isObject(v)) return v
      let out: Via = v
      if (out.kind && !(known(out.from) && known(out.to))) {
        const { kind: _k, from: _f, to: _t, ...rest } = out
        out = rest as Via
      }
      if (out.zoneLayers && !out.zoneLayers.every(known)) out = { ...out, zoneLayers: out.zoneLayers.filter(known) }
      // X22: a backdrill between layers the board lacks has nothing to drill.
      if (out.backdrill && !(known(out.backdrill.from) && known(out.backdrill.to))) {
        const { backdrill: _b, ...rest } = out
        out = rest as Via
      }
      if (out.tertiary && !(known(out.tertiary.from) && known(out.tertiary.to))) {
        const { tertiary: _t, ...rest } = out
        out = rest as Via
      }
      if (out.stack && "layers" in out.stack) {
        const layers = Object.fromEntries(Object.entries(out.stack.layers).filter(([k]) => known(k)))
        const { stack: _s, ...rest } = out
        out = Object.keys(layers).length ? { ...rest, stack: { layers } } : (rest as Via)
      }
      return out
    }),
  }
}

/** An arc track keeps its flag only with its three points: any other trace is a polyline. Its bare copper (X24) is its opening in the mask: how much wider than the track, or the board's rule where that is not said. */
function normalizeTrace(item: Json): Json {
  let out = item
  if (out.bare !== undefined) {
    const { bare, ...rest } = out
    out = isObject(bare) && (bare.margin === undefined || (typeof bare.margin === "number" && Number.isFinite(bare.margin))) ? out : rest
  }
  if (out.arc === undefined) return out
  const { arc, ...rest } = out
  return arc === true && Array.isArray(out.points) && out.points.length === 3 ? out : rest
}

/** The embedded fonts (X19) as they read: files with a name, a SHA-256 id and a size, each owned by a part that exists or by the board; a bad entry is dropped, and none left is no `fonts`. */
function normalizeFonts(raw: unknown, components: ComponentInstance[]): Project["fonts"] {
  if (!isObject(raw) || !Array.isArray(raw.files)) return undefined
  const ids = new Set(components.map((c) => c.id))
  const files: NonNullable<Project["fonts"]>["files"] = []
  for (const f of raw.files) {
    if (!isObject(f) || typeof f.name !== "string" || typeof f.file !== "string" || !/^[0-9a-f]{64}$/.test(f.file)) continue
    if (typeof f.size !== "number" || !Number.isFinite(f.size) || f.size < 0) continue
    if (f.owner !== undefined && (typeof f.owner !== "string" || !ids.has(f.owner))) continue
    files.push({ name: f.name, file: f.file, size: f.size, ...(typeof f.checksum === "string" ? { checksum: f.checksum } : {}), ...(typeof f.owner === "string" ? { owner: f.owner } : {}) })
  }
  const parts = Array.isArray(raw.parts) ? raw.parts.filter((x): x is string => typeof x === "string" && ids.has(x)) : []
  if (!files.length && !parts.length && raw.board !== true) return undefined
  return { ...(raw.board === true ? { board: true as const } : {}), ...(parts.length ? { parts } : {}), files }
}

/** The board's drawings: each with an id (once each) and a shape that reads; absent when there are none. */
function normalizeGraphics(raw: unknown): BoardGraphic[] | undefined {
  if (isCompactShapes(raw)) {
    const seen = new Set<string>()
    const unpacked = (unpackGraphics(raw) ?? []).filter((g) => !seen.has(g.id) && !!seen.add(g.id))
    return unpacked.length ? unpacked : undefined
  }
  const ids = new Set<string>()
  const out: BoardGraphic[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)) continue
    const shape: BoardShape | null = normalizeShape(item, isShapeLayer)
    if (!shape) continue
    ids.add(item.id)
    out.push({ ...shape, id: item.id })
  }
  return out.length ? out : undefined
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
  if (typeof rot !== "number" || !ROTATIONS.includes(rot)) return null
  return { x: raw.x, y: raw.y, rot: rot as ComponentInstance["sch"]["rot"], ...(raw.mirror === "x" || raw.mirror === "y" ? { mirror: raw.mirror } : {}) }
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

/** What an import marked by itself, with only the entries that read as it: absent when none do. */
function normalizeImportMarks(raw: unknown): Project["importMarks"] {
  if (!isObject(raw)) return undefined
  const checks = strings(raw.checks)
  const noConnect: Record<string, string[]> = {}
  if (isObject(raw.noConnect)) for (const [id, pins] of Object.entries(raw.noConnect)) if (strings(pins).length) noConnect[id] = strings(pins)
  if (!checks.length && !Object.keys(noConnect).length) return undefined
  return { ...(checks.length ? { checks } : {}), ...(Object.keys(noConnect).length ? { noConnect } : {}) }
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
    delete block.locked
    if (item.locked === true) block.locked = true
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
  // What a KiCad file said exactly; an empty stroke on a line or a box says "KiCad's own line" and stays.
  const exact = normalizeExact(item)
  const exactOwn = { ...exact, stroke: exact.stroke ?? (isObject(item.stroke) ? {} : undefined) }
  if (item.type === "line") {
    if (!Array.isArray(item.points) || item.points.length < 2 || !item.points.every(isPoint)) return null
    const points = (item.points as Vec2[]).map((p) => ({ x: p.x, y: p.y }))
    const arrows = ARROWS.has(item.arrows as string) ? (item.arrows as DrawingLine["arrows"]) : undefined
    const closed = item.closed === true && points.length > 2
    // S8: a closed line may be a rule area: what it says is kept, nothing else of it.
    const ruleArea = closed ? normalizeRuleArea(item.ruleArea) : undefined
    return clean({ ...item, ...style, ...exactOwn, type: "line", points, closed, arrows, ruleArea } as DrawingLine)
  }
  if (item.type === "rect") {
    // A rectangle KiCad drew can have no width or no height (a line or a point drawn as a box): it carries a stroke or a fill of its own and stays. One the tools made has a size.
    const kicadLook = exactOwn.stroke !== undefined || exactOwn.paint !== undefined
    const [w, h] = [item.width as number, item.height as number]
    if (!finite(item.x, item.y, item.width, item.height) || !(kicadLook ? w >= 0 && h >= 0 : w > 0 && h > 0)) return null
    const radius = finite(item.radius) && (item.radius as number) > 0 ? (item.radius as number) : undefined
    return clean({ ...item, ...style, ...exactOwn, type: "rect", radius } as DrawingBox)
  }
  if (item.type === "text") {
    // A text from a KiCad file says where its anchor is on the text's height (`valign`); it may be empty, turned any quarter, and big.
    const kicad = item.valign === "top" || item.valign === "middle" || item.valign === "bottom"
    if (typeof item.text !== "string" || (!kicad && !item.text.trim()) || !finite(item.x, item.y)) return null
    const size = finite(item.size) && (item.size as number) > 0 ? Math.min(item.size as number, kicad ? 50 : 5) : DEFAULT_TEXT_SIZE
    const flag = (k: string) => item[k] === true
    return clean({
      ...item,
      ...style,
      ...exact,
      type: "text",
      size,
      align: ALIGNS.has(item.align as string) ? (item.align as DrawingText["align"]) : undefined,
      bold: flag("bold"),
      italic: flag("italic"),
      mono: flag("mono"),
      border: flag("border"),
      rot: kicad ? ([90, 180, 270].includes(item.rot as number) ? (item.rot as DrawingText["rot"]) : undefined) : item.rot === 90 ? 90 : undefined,
      valign: kicad ? (item.valign as DrawingText["valign"]) : undefined,
      mirror: kicad && flag("mirror") ? true : undefined,
      hidden: kicad && flag("hidden") ? true : undefined,
      href: kicad && typeof item.href === "string" && item.href ? item.href : undefined,
      face: kicad && typeof item.face === "string" && item.face ? item.face : undefined,
      lineSpacing: kicad && finite(item.lineSpacing) && (item.lineSpacing as number) > 0 ? (item.lineSpacing as number) : undefined,
    } as DrawingText)
  }
  return normalizeKicadOnly(item)
}

/**
 * S1: the sheets of the schematic. Sheets are kept by id; a sheet symbol is kept when it sits on a sheet and names one, with the pins it has;
 * what is malformed is dropped, and so is a symbol that would close a loop of sheets (a sheet that holds itself), so the tree always ends.
 */
function normalizeSheets(raw: Partial<Project>): Pick<Project, "sheets" | "sheetSymbols"> {
  const sheets: NonNullable<Project["sheets"]> = []
  const seen = new Set<string>()
  for (const s of list<Record<string, unknown>>(raw.sheets)) {
    if (!isObject(s) || typeof s.id !== "string" || !s.id || seen.has(s.id)) continue
    seen.add(s.id)
    const out: NonNullable<Project["sheets"]>[number] = { id: s.id }
    // A file saved while the model kept KiCad's `page` and `uuid` of a sheet has them: they are read past, as the export makes them (ids from ours, pages in tree order).
    if (typeof s.name === "string" && s.name) out.name = s.name
    if (typeof s.file === "string" && s.file) out.file = s.file
    // A sub-sheet's own title block, as the entries it has.
    const title = list<Record<string, unknown>>(s.titleBlock).filter((t): t is { key: string; value: string } => isObject(t) && typeof t.key === "string" && typeof t.value === "string")
    if (title.length) out.titleBlock = title.map((t) => ({ key: t.key, value: t.value }))
    if (s.kicadRules === true) out.kicadRules = true
    if (s.id === ROOT_SHEET) sheets.unshift(out)
    else sheets.push(out)
  }
  const ids = new Set<string>()
  const symbols: NonNullable<Project["sheetSymbols"]> = []
  for (const sym of list<Record<string, unknown>>(raw.sheetSymbols)) {
    if (!isObject(sym) || typeof sym.id !== "string" || !sym.id || ids.has(sym.id) || /[\\/|@]/.test(sym.id)) continue
    if (typeof sym.sheet !== "string" || typeof sym.child !== "string" || !finite(sym.x, sym.y, sym.w, sym.h)) continue
    if (sym.child === ROOT_SHEET || sym.child === sym.sheet) continue
    ids.add(sym.id)
    symbols.push(normalizeSheetSymbol(sym))
  }
  const kept = dropSheetCycles(symbols)
  return { sheets: sheets.length ? sheets : undefined, sheetSymbols: kept.length ? kept : undefined }
}

/** The sheets, and the variants, which are read together: a name only a symbol mentions is a variant of the project. */
function sheetsAndVariants(raw: Partial<Project>, components: ComponentInstance[]): Pick<Project, "sheets" | "sheetSymbols" | "variants"> {
  const sheets = normalizeSheets(raw)
  return { ...sheets, variants: normalizeProjectVariants((raw as { variants?: unknown }).variants, components, sheets.sheetSymbols) }
}

const FLAG_KEYS = ["dnp", "excludeFromBom", "notOnBoard", "excludeFromSim"] as const

function normalizeSheetSymbol(raw: Record<string, unknown>): NonNullable<Project["sheetSymbols"]>[number] {
  const pinIds = new Set<string>()
  const pins: NonNullable<Project["sheetSymbols"]>[number]["pins"] = []
  for (const p of list<Record<string, unknown>>(raw.pins)) {
    if (!isObject(p) || typeof p.id !== "string" || !p.id || pinIds.has(p.id) || typeof p.name !== "string" || !finite(p.x, p.y)) continue
    pinIds.add(p.id)
    const look = normalizeLook(p.look)
    pins.push({
      id: p.id,
      name: p.name,
      shape: ["input", "output", "bidirectional", "tri_state", "passive"].includes(p.shape as string) ? (p.shape as LabelShape) : "bidirectional",
      x: p.x as number,
      y: p.y as number,
      rot: ([0, 90, 180, 270].includes(p.rot as number) ? p.rot : 0) as Rotation,
      ...(look ? { look } : {}),
    })
  }
  const out: NonNullable<Project["sheetSymbols"]>[number] = {
    id: raw.id as string,
    ...(typeof raw.uuid === "string" && /^[0-9a-fA-F-]{36}$/.test(raw.uuid) ? { uuid: raw.uuid } : {}),
    sheet: raw.sheet as string,
    child: raw.child as string,
    x: raw.x as number,
    y: raw.y as number,
    w: Math.max(0, raw.w as number),
    h: Math.max(0, raw.h as number),
    name: typeof raw.name === "string" ? raw.name : "",
    pins,
  }
  const fields: NonNullable<typeof out.fields> = []
  for (const f of list<Record<string, unknown>>(raw.fields)) {
    if (!isObject(f) || typeof f.name !== "string" || typeof f.value !== "string") continue
    const place = normalizePlace(f.place)
    if (place) fields.push({ name: f.name, value: f.value, place })
  }
  if (fields.length) out.fields = fields
  const stroke = normalizeStroke(raw.stroke)
  if (stroke || isObject(raw.stroke)) out.stroke = stroke ?? {}
  const fill = raw.fill
  if (isObject(fill) && (fill.kind === "outline" || fill.kind === "background" || fill.kind === "color")) out.fill = { kind: fill.kind, ...(typeof fill.color === "string" && fill.color ? { color: fill.color } : {}) }
  if (isObject(raw.flags)) {
    const flags: NonNullable<typeof out.flags> = {}
    for (const k of FLAG_KEYS) if ((raw.flags as Record<string, unknown>)[k] === true) flags[k] = true
    if (Object.keys(flags).length) out.flags = flags
  }
  // A sheet symbol saved with `pages` or a pin's `uuid` has them read past: the export numbers pages in tree order and makes pins' uuids from ids; the sheet symbol's own uuid is kept (a footprint's path passes through it).
  if (raw.fieldsAutoplaced === true) out.fieldsAutoplaced = true
  const variants = normalizeSheetOverrides(raw.variants)
  if (variants) out.variants = variants
  return out
}

/** The sheet symbols with those that close a loop of sheets taken out: a sheet cannot hold itself, and the tree has no loop. */
function dropSheetCycles(symbols: NonNullable<Project["sheetSymbols"]>): NonNullable<Project["sheetSymbols"]> {
  const kept: NonNullable<Project["sheetSymbols"]> = []
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return kept.some((s) => s.sheet === from && reaches(s.child, to, seen))
  }
  for (const s of symbols) {
    if (reaches(s.child, s.sheet)) continue
    kept.push(s)
  }
  return kept
}

/** S3: the bus aliases that have a name and members that are text, each id once, in their order; absent when there are none. */
function normalizeBusAliases(raw: unknown): Project["busAliases"] {
  const ids = new Set<string>()
  const out: NonNullable<Project["busAliases"]> = []
  for (const a of list<Record<string, unknown>>(raw)) {
    if (!isObject(a) || typeof a.id !== "string" || !a.id || ids.has(a.id) || typeof a.name !== "string" || !a.name || !Array.isArray(a.members)) continue
    ids.add(a.id)
    out.push({ id: a.id, ...(typeof a.sheet === "string" && a.sheet ? { sheet: a.sheet } : {}), name: a.name, members: a.members.filter((m): m is string => typeof m === "string") })
  }
  return out.length ? out : undefined
}

/** Drawings that can be drawn, each id once, in their order; absent when there are none. */
function normalizeDrawings(raw: unknown): Project["drawings"] {
  const ids = new Set<string>()
  const out: SchematicDrawing[] = []
  for (const item of list<Record<string, unknown>>(raw)) {
    if (!isObject(item) || typeof item.id !== "string" || ids.has(item.id)) continue
    const d = normalizeDrawing(item as Record<string, unknown> & { id: string })
    if (!d) continue
    // S1: the sheet it is on, which the readers of the kinds KiCad alone has do not carry over.
    if (typeof item.sheet === "string" && item.sheet) d.sheet = item.sheet
    ids.add(d.id)
    out.push(d)
  }
  return out.length ? out : undefined
}

/** The drawings the project keeps. A drawing no part names is kept too: an imported schematic's cache can hold symbols nothing is placed from yet, and they stay stored until one is. */
function keptSymbols(symbols: Project["symbols"]): Project["symbols"] {
  return symbols && Object.keys(symbols).length ? symbols : undefined
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
  const symbols = normalizeSymbols(raw.symbols)
  const parts = normalizeParts(raw.parts, symbols)
  registerProjectParts({ parts, symbols })
  const textStyles = list<TextStyleDef>((raw as { textStyles?: unknown }).textStyles)
  const dimStyles = list<DimensionStyleDef>((raw as { dimStyles?: unknown }).dimStyles)
  const components = repairUnits(
    list<Partial<ComponentInstance>>(raw.components)
      .filter((c): c is Partial<ComponentInstance> & Pick<ComponentInstance, "id" | "partId"> => isObject(c) && typeof c.id === "string" && typeof c.partId === "string")
      .map((c) => normalizeComponent(c, textStyles)),
  )
  const texts = boardTexts(raw, textStyles)
  const models = normalizeModels(raw.models)
  const { textStyles: _textStyles, kt: _kt, kp: _kp, dimStyles: _dimStyles, dm, grp, gd, im, vx, fonts: _fonts, ...stored } = raw as typeof raw & { fonts?: unknown; textStyles?: unknown; kt?: unknown; kp?: unknown; dimStyles?: unknown; dm?: unknown; grp?: unknown; gd?: unknown; im?: unknown; vx?: unknown }
  // Dimensions, groups and images as objects, and those of the compact entries written before (`dm`, `grp`, `im`) that an edit since did not put among the objects.
  const dimensions = byId(unpackDimensions(dm, dimStyles), plainItems(raw.dimensions, (d) => {
    const one = packDimensions([d as unknown as BoardDimension])
    return unpackDimensions(one.dm, one.dimStyles ?? [])[0]
  }))
  const storedVias = unpackVias(raw.vias, vx)
  const ids = [...list<unknown>(raw.traces), ...list<unknown>(storedVias)].map((t) => (isObject(t) && typeof t.id === "string" ? t.id : ""))
  const groups = byId(unpackGroups(grp, undefined, { ids, shared: isObject(gd) ? (gd as Record<string, Record<string, GenValue>>) : undefined }) ?? [], plainGroups(raw.groups))
  const images = byId(unpackImages(im) ?? [], plainItems(raw.images, (m) => unpackImages(packImages([m as unknown as ReferenceImage]))?.[0]))
  const board = normalizeBoard(raw.board)
  const copper = fitCopperToStack(normalizeCopper<Trace>(raw.traces, "net"), normalizeCopper<Via>(storedVias, "routedNet"), board)
  return {
    ...stored,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Untitled project",
    description: typeof raw.description === "string" ? raw.description : "",
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    components,
    wires: normalizeWires(raw.wires),
    labels: list(raw.labels).map(normalizeLabel).filter((l): l is NonNullable<typeof l> => l !== null),
    traces: copper.traces,
    vias: copper.vias,
    zones: normalizeZones(raw.zones),
    texts: texts as Project["texts"],
    graphics: normalizeGraphics(raw.graphics),
    dimensions: dimensions.length ? dimensions : undefined,
    groups: groups.length ? groups : undefined,
    images: images.length ? images : undefined,
    fonts: normalizeFonts((raw as { fonts?: unknown }).fonts, components),
    netChains: normalizeNetChains((raw as { netChains?: unknown }).netChains),
    points: normalizePoints((raw as { points?: unknown }).points),
    board,
    rules: normalizeRules(raw.rules),
    blocks: normalizeBlocks(raw.blocks, components),
    drawings: normalizeDrawings(raw.drawings),
    ...sheetsAndVariants(raw, components),
    busAliases: normalizeBusAliases(raw.busAliases),
    netNames: raw.netNames === "kicad" || raw.netNames === "kicad6" || raw.netNames === "kicad5" ? raw.netNames : undefined,
    properties: normalizeProperties(raw.properties),
    ignoredChecks: normalizeIgnoredChecks(raw.ignoredChecks),
    importMarks: normalizeImportMarks(raw.importMarks),
    parts: parts.length ? parts : undefined,
    symbols: keptSymbols(symbols),
    footprints: footprints.length ? footprints : undefined,
    models: models.length ? models : undefined,
  } as Project
}
