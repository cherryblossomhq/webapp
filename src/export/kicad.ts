import JSZip from "jszip"
import type { AnyCircuitElement } from "circuit-json"
import { applyToPoint } from "transformation-matrix"
import { computeConnectivity } from "../model/connectivity"
import { findPart } from "../model/library"
import { powerNetName } from "../model/instances"
import { useFillsOf, zoneFillsOf } from "../model/pcb"
import { ownFlagComponents, withRuleAreaFlags, withRuleAreaFlagsOnly } from "../model/ruleAreas"
import { hasPartZones, kicadWritesZones } from "../model/zones"
import type { ComponentInstance, Project, SymbolDrawing } from "../model/types"
import { applyZones } from "./kicadZones"
import { slugify } from "./bundle"
import { projectToCircuitJson, type PlacedText } from "./circuitJson"
import { imageBytes, pictureFiles, preloadImages } from "../store/imageFiles"
import { keepOriginal, unchangedExport, warmBefore, type KeptExport } from "./keep/original"
import { applyOutline } from "./kicadOutline"
import { applyFootprintLinks, applySymbolUuids } from "./kicadLinks"
import { applyLibraryIdentity } from "./kicadLibNames"
import { applyPads } from "./kicadPads"
import { applyBoardObjects } from "./kicadObjects"
import { applyDrawings } from "./kicadShapes"
import { applyTexts } from "./kicadTexts"
import { isKicadBoardProject, writeKicadBoard } from "./kicadBoard"
import { rootFileStem, sheetTitleBlock, sheetFileNames, sheetSymbolNode, retarget, sheetUuid, sharedSheetNotes, spreadInstances, symbolUuid, symbolsOf, sheetFlagsWritten, writeVariants, unitsOfOtherUses, VARIANT_FILE_VERSION } from "./kicadSheets"
import { uuidFrom } from "./kicadUuid"
import { ROOT_SHEET, isHierarchical, sheetsOf, sheetView, useAt, usesOfSheet } from "../model/sheets"
import { mayHaveBuses } from "../model/busConnectivity"
import { variantExportNotes, variantNames } from "../model/variants"
import { addBlockGroups, addBusItems, addSheetItems, localizePower, roundedFill, applySymbolFlags, rewriteLabels, rewriteWireStrokes } from "./kicadSheet"
import { addNoConnects, addSymbolFields, applyComponentClasses, applyPowerTexts, finishPower, applyBoardSettings, applyFootprintFlags, applyFootprintModels, applyFootprintNames, applyMountingHoleMarks, applyProjectSettings, boardFootprintIds, kicadCustomRules, kicadDruText, noConnectPins, symbolFields, titleBlock, writeSymbolLinks, shareUnitSymbols, type PlacedField } from "./kicadPost"

// KiCad files from Circuit JSON, through tscircuit's `circuit-json-to-kicad` (MIT), loaded when
// the user asks for them: it and the packages it needs (the KiCad file writer and tscircuit's
// symbol drawings) are about 4 MB that nobody should download to edit a board.
//
// The converter draws a schematic unit as 15 mm; ours is 12.7 mm (ten of KiCad's 50 mil grid
// squares), so the schematic is scaled by 12.7 / 15 first, which puts every pin on KiCad's
// 1.27 mm grid exactly.

const KICAD_MM_PER_UNIT = 15
const EDITOR_MM_PER_UNIT = 12.7
const SCHEMATIC_SCALE = EDITOR_MM_PER_UNIT / KICAD_MM_PER_UNIT

type Point = { x: number; y: number }
const scalePoint = <T extends Point | undefined>(p: T): T => (p ? ({ ...p, x: p.x * SCHEMATIC_SCALE, y: p.y * SCHEMATIC_SCALE } as T) : p)

/** The schematic's elements at the converter's scale; the board's are in millimetres already. */
export function scaleSchematic(elements: AnyCircuitElement[]): AnyCircuitElement[] {
  const k = SCHEMATIC_SCALE
  return elements.map((e): AnyCircuitElement => {
    switch (e.type) {
      case "schematic_component":
        return { ...e, center: scalePoint(e.center), size: { width: e.size.width * k, height: e.size.height * k } }
      case "schematic_port":
        return { ...e, center: scalePoint(e.center) }
      case "schematic_path":
        return {
          ...e,
          points: e.points.map(scalePoint),
          ...(typeof e.stroke_width === "number" ? { stroke_width: e.stroke_width * k } : {}),
          ...(typeof e.dash_length === "number" ? { dash_length: e.dash_length * k } : {}),
          ...(typeof e.dash_gap === "number" ? { dash_gap: e.dash_gap * k } : {}),
        }
      case "schematic_arc":
        return { ...e, center: scalePoint(e.center), radius: e.radius * k, ...(typeof e.stroke_width === "number" ? { stroke_width: e.stroke_width * k } : {}) }
      case "schematic_circle":
        return { ...e, center: scalePoint(e.center), radius: e.radius * k, ...(typeof e.stroke_width === "number" ? { stroke_width: e.stroke_width * k } : {}) }
      case "schematic_text":
        return { ...e, position: scalePoint(e.position), ...(typeof e.font_size === "number" ? { font_size: e.font_size * k } : {}) }
      case "schematic_trace":
        return { ...e, edges: e.edges.map((d) => ({ ...d, from: scalePoint(d.from), to: scalePoint(d.to) })), junctions: e.junctions.map(scalePoint) }
      case "schematic_net_label":
        return { ...e, center: scalePoint(e.center), anchor_position: scalePoint(e.anchor_position) }
      default:
        return e
    }
  })
}

/**
 * The converter works in floating point, so a pin and the wire that ends on it can differ in the
 * fourteenth decimal; KiCad reads them as the same nanometre, but other readers compare exactly.
 * Numbers are rounded to a nanometre. Text in quotes (silkscreen text, part numbers) is left as it is.
 */
export function tidyNumbers(text: string): string {
  // Also the 1.1e-16 that stands for 0 after a rotation.
  return text.replace(/"(?:[^"\\]|\\.)*"|(?<=[\s(])-?\d+(?:\.\d{7,}|(?:\.\d+)?e[+-]?\d+)(?=[\s)])/g, (m) => (m.startsWith('"') ? m : String(Number(Number(m).toFixed(6)) || 0)))
}

/** What the converter leaves of the symbols that came from KiCad, said only for a project that has them. */
function kicadSymbolNotes(elements: AnyCircuitElement[]): string[] {
  const notes = ["The drawing of each symbol, its mirror and its units come across, and so do the pin numbers, names and electrical types. The text drawn inside a symbol is written on the sheet beside it, not inside the symbol; the shapes of pin ends are drawn as lines, and the other functions a pin can take are left out (the converter has no place for them). A symbol's Reference and Value are written where it had them, the other fields as hidden ones."]
  if (elements.some((e) => (e.type === "schematic_path" && e.stroke_color) || ((e.type === "schematic_circle" || e.type === "schematic_arc") && e.color !== "#000000"))) notes.push("The colours of lines are not written to the KiCad schematic, which draws every line in its theme's colour; fill colours are.")
  if (elements.some((e) => (e.type === "schematic_path" || e.type === "schematic_circle" || e.type === "schematic_arc") && e.is_dashed)) notes.push("Dashed, dotted and dash-dot lines are all written as KiCad's dash.")
  return notes
}

interface BoardText {
  text: string
  /** Notes that come before the schematic's in the list, and those that come after it. */
  notes: string[]
  afterNotes: string[]
  /** Whether the native writer made it. */
  native: boolean
}

/** The bytes of the project's reference images and embedded fonts that the page has, by the id the project names them by. */
async function loadPictures(project: Project): Promise<Map<string, Uint8Array>> {
  const pictures = new Map<string, Uint8Array>()
  // A schematic's pictures in the file store are read here too: the sheet writer takes their bytes from the page (`kicadSheet.ts`).
  if (!project.images?.length && !project.fonts?.files.length && !pictureFiles(project).length) return pictures
  await preloadImages(project)
  for (const id of [...(project.images ?? []).map((m) => m.file), ...(project.fonts?.files ?? []).map((f) => f.file)]) {
    const bytes = imageBytes(id)
    if (bytes) pictures.set(id, new Uint8Array(bytes))
  }
  return pictures
}

/** The board of a project that came from KiCad: the native writer, with the editor's fill of each zone and the pictures of the reference images. */
async function nativeBoard(project: Project): Promise<BoardText> {
  const pictures = await loadPictures(project)
  const fills = project.zones.length || hasPartZones(project) ? zoneFillsOf(project, () => computeConnectivity(project)) : []
  const board = writeKicadBoard(project, { fills, pictures })
  const zoneNotes = project.zones.length || hasPartZones(project) ? ["Zones are written with their outlines, layers, nets, priorities and settings, filled as the editor filled them; press B in KiCad to refill them by its own rules. KiCad's thermal reliefs have four spokes; the pour's own spoke count and angle rules do not exist there."] : []
  return { text: board.text, notes: [...board.notes, ...zoneNotes], afterNotes: [], native: true }
}

/** The board of a project drawn in the editor: the converter's file with what it has no place for written into it. */
async function converterBoard(project: Project, converted: string): Promise<BoardText> {
  // What the converter has no place for: put into the files it wrote.
  const flagged = applyComponentClasses(applyFootprintFlags(applyBoardSettings(applyMountingHoleMarks(applyFootprintNames(converted, project), project), project), project), project)
  // Zones with a polygon, rule areas and zone settings of their own are written by the editor (`kicadZones.ts`); whole-board pours go through the converter as they did.
  const zones = kicadWritesZones(project) ? applyZones(flagged, project, zoneFillsOf(project, () => computeConnectivity(project))) : { text: flagged, notes: [] as string[] }
  // The pads of a part that has X7 features, as KiCad has them (the converter writes every pad as a rectangle, circle or oval).
  const padded = applyPads(zones.text, project)
  const drawings = applyDrawings(padded.text, project)
  const outline = applyOutline(drawings.text, project)
  const texts = applyTexts(outline.text, project)
  // Dimensions, reference images and groups come last, naming the items the writers above made (a board with none is written as it was).
  const pictures = await loadPictures(project)
  const objects = applyBoardObjects(texts.text, project, drawings.uuids, texts.uuids, pictures)
  // The parts' 3D models of KiCad's library, last in each footprint.
  const models = applyFootprintModels(objects.text, project)
  return { text: models.text, notes: [...zones.notes, ...padded.notes, ...drawings.notes, ...outline.notes, ...texts.notes, ...models.notes], afterNotes: objects.notes, native: false }
}

/** Whether the project was made from KiCad's files (the import marks it with the file version of what it read). */
const fromKicadFiles = (p: Pick<Project, "properties">) => !!p.properties?.some((x) => x.key === "KiCad file version")

/** One sheet's schematic text from what the converter wrote, with what it has no place for put in (the post-processing every sheet gets). */
function schematicText(
  view: Project,
  data: Pick<ReturnType<typeof projectToCircuitJson>, "symbols" | "powerTexts">,
  circuit: AnyCircuitElement[],
  sch: { getOutputString(): string; ctx: { c2kMatSch?: Parameters<typeof applyToPoint>[0] } },
  footprintIds: Parameters<typeof symbolFields>[1],
  sheetNotes: string[],
  symbolFlags: ReadonlyMap<string, ComponentInstance>,
  libOf?: Map<string, string>,
): string {
  const fromKicad = fromKicadFiles(view)
  const fields = new Map(view.components.map((c) => [c.ref, symbolFields(c, footprintIds, fromKicad)]))
  const busy = mayHaveBuses(view)
  const page = sch.ctx.c2kMatSch
  const flags = page ? noConnectPins(circuit).map((p) => applyToPoint(page, p)) : []
  // Symbols that came from KiCad: the units of a part as one symbol, and the reference and value where the symbol had them.
  const field = (t: PlacedText | undefined): PlacedField | undefined => {
    if (!t || !page) return undefined
    const at = applyToPoint(page, { x: t.x * SCHEMATIC_SCALE, y: t.y * SCHEMATIC_SCALE })
    return { text: t.text, x: at.x, y: at.y, angle: t.angle, size: t.size * EDITOR_MM_PER_UNIT, h: t.h, v: t.v }
  }
  const links = data.symbols.map((l) => ({ id: l.id, owner: l.owner, unit: l.unit, virtual: l.virtual, part: l.part, reference: field(l.reference), value: field(l.value), texts: l.texts?.map((t) => field(t)!), refPrefix: l.refPrefix, pins: l.pins }))
  let schText = applyPowerTexts(writeSymbolLinks(addNoConnects(addSymbolFields(sch.getOutputString(), fields), flags), links, libOf), data.powerTexts.map((t) => ({ id: t.id, field: field(t.text)! })))
  // Flags of symbols, and what only a project named as KiCad names its nets has: labels as they were drawn, wire strokes, and the drawings of the sheet.
  // A symbol says its own flags (`symbolFlags`), never those a sheet symbol above it gives: the file is every use of the sheet's.
  schText = applySymbolFlags(schText, new Map(view.components.map((c) => [c.ref, { flags: symbolFlags.get(c.id)?.flags, fieldsAutoplaced: c.fieldsAutoplaced }] as const).filter(([, c]) => c.flags || c.fieldsAutoplaced)))
  // The symbols' uuids (before the groups, which name their members by them): the ones they had, else made from the part's id.
  const symbolUuids = new Map(view.components.map((c) => [`${c.ref}|${c.unit ?? 1}`, c.uuid ?? uuidFrom(`symbol:${c.id}`)]))
  schText = applySymbolUuids(schText, (ref, unit) => symbolUuids.get(`${ref}|${unit}`))
  if (page) {
    const toPage = (p: { x: number; y: number }) => applyToPoint(page, { x: p.x * SCHEMATIC_SCALE, y: p.y * SCHEMATIC_SCALE })
    // A hierarchy has its labels as drawn whoever named its nets: a sheet pin joins a hierarchical label only, and a local label is not global.
    // S3: a label that names a bus is no net's label, so the converter wrote none for it: those are written below, with the aliases.
    const conn = busy ? computeConnectivity(view) : undefined
    const busLabels = conn ? view.labels.filter((l) => !conn.labelNet.has(l.id)) : []
    const netLabels = busLabels.length ? view.labels.filter((l) => conn!.labelNet.has(l.id)) : view.labels
    if (view.netNames || isHierarchical(view)) {
      const labels = rewriteLabels(schText, netLabels, toPage)
      schText = labels.text
      if (!labels.ok) sheetNotes.push("The labels could not be matched with the converter's, so they keep the converter's own shape (every one a global label).")
    }
    if (view.netNames) {
      const strokes = view.wires.flatMap((w) => (w.points.length >= 2 ? w.points.slice(1).map(() => w.look) : []))
      const wires = rewriteWireStrokes(schText, strokes)
      schText = wires.text
      if (!wires.ok) sheetNotes.push("The widths, dashes and colours of the wires could not be matched with the converter's wires, so they are written plain.")
    }
    // A local power symbol is local in the file too (`(power local)` is KiCad 10's: the file is stamped to match, see `finishPower`), so a sheet used twice has a net of its own for each use.
    schText = localizePower(schText, new Set(view.components.flatMap((c) => (findPart(c.partId)?.powerLocal ? [powerNetName(c) ?? ""] : []))))
    schText = addSheetItems(schText, view.drawings ?? [], toPage)
    schText = addBusItems(schText, busLabels, (view.busAliases ?? []).filter((a) => view.scope === undefined || (a.sheet ?? ROOT_SHEET) === useAt(view, view.scope).sheet), toPage)
    // The titled blocks are groups of their symbols in the file, which the import reads back as blocks.
    schText = addBlockGroups(schText, view.blocks ?? [], new Map(view.components.map((c) => [c.id, c.ref])))
  }
  // KiCad writes a `/` in a label's text as `{slash}` (a net's name has the sheet's path in front of it, so a slash in the text must not read as part of the path).
  return schText.replace(/(\n {2}\((?:label|global_label|hierarchical_label) )"((?:[^"\\]|\\.)*)"/g, (_m, head: string, text: string) => `${head}"${text.replace(/\//g, "{slash}")}"`)
}

export interface KicadExport {
  files: Record<string, string>
  /** What didn't come across, in words for whoever exported it. */
  notes: string[]
  /** The exact bytes of the files that are the user's own, for a project imported from KiCad files (`keep/original.ts`); a zip is written from these. */
  exact?: Record<string, Uint8Array>
  /** What became of each file of a project imported from KiCad files: the user's own, patched with what changed, or written from the project. */
  kept?: NonNullable<KeptExport["kept"]>
}

/**
 * The schematic, board and project files of a KiCad 9 project. A project that came from KiCad files has them kept (`KicadCarry.original`): what the user did not
 * change is the user's own file, byte for byte, and what changed is written into it.
 */
export async function kicadFiles(source: Project): Promise<KicadExport> {
  if (!source.kicad?.original) return writtenKicadFiles(source)
  // A project nobody changed is its files as they were: neither it nor the files it was imported from are written.
  const unchanged = await unchangedExport(source)
  if (unchanged) return unchanged
  return keepOriginal(source, await writtenKicadFiles(source), writtenKicadFiles)
}

/** Write what the export of a project from KiCad files compares with, ahead of the export (`keep/original.ts`). */
export const prepareKicadExport = (source: Project) => warmBefore(source, writtenKicadFiles)

/** The schematic, board and project files of a KiCad 9 project, all written from the project. */
async function writtenKicadFiles(source: Project): Promise<KicadExport> {
  // S8: KiCad 9's file has no flag on a rule area, so the flags of one are written on the symbols it touches, which is where KiCad 9 reads them.
  // S9: nor does it have schematic variants, so its files are written from the symbols as the active variant makes them; `withRuleAreaFlags` applies the variant,
  // the sheet symbols' flags and the areas' in one chain. A project that is written as KiCad 10 files anyway (it has a local power symbol) keeps its variants in the
  // files instead, with every symbol as it is by itself (the areas' flags are written on the symbols all the same).
  const asKicad10 = variantNames(source).length > 0 && source.components.some((c) => findPart(c.partId)?.powerLocal)
  const project = asKicad10 ? withRuleAreaFlagsOnly(source) : withRuleAreaFlags(source)
  // The board written is the project's, so its pours are the project's fills (its kept fills, or the editor's), not filled again for this copy.
  if (project !== source && (source.zones.length || hasPartZones(source))) useFillsOf(project, zoneFillsOf(source, () => computeConnectivity(source)))
  // A project from a KiCad board writes its board natively (`kicadBoard.ts`), so the converter is given no copper; a sheet's view never is.
  const native = isKicadBoardProject(project)
  // The sheets' pictures in the file store are written from their bytes, read before any sheet is written.
  if (pictureFiles(project).length) await preloadImages(project)
  // What each symbol says of itself in its file: the variant's and the areas' flags, not the flags of a sheet symbol above it (those are written on the sheet symbol).
  const symbolFlags = new Map((asKicad10 ? project.components : ownFlagComponents(source)).map((c) => [c.id, c]))
  const { elements, notes, symbols, powerTexts } = projectToCircuitJson(project, { nameAllNets: true, forKicad: true, keepVariants: asKicad10, copper: !native })
  const circuit = scaleSchematic(elements)
  const { CircuitJsonToKicadSchConverter, CircuitJsonToKicadPcbConverter, CircuitJsonToKicadProConverter } = await import("circuit-json-to-kicad")
  // An imported project keeps its root schematic's name, and the board and project file take it too (KiCad pairs the three by name).
  const base = rootFileStem(project) || slugify(project.name)

  // S1: a project with sheets writes a schematic for each sheet, from a view of its first use; one without writes the one it has.
  const hierarchical = isHierarchical(project) && project.scope === undefined
  const sheetIds = hierarchical ? sheetsOf(project).map((x) => x.id) : [ROOT_SHEET]
  const viewOf = (sheet: string) => (hierarchical ? sheetView(project, usesOfSheet(project, sheet)[0]?.path ?? "") : project)
  const converters = new Map<string, { sch: InstanceType<typeof CircuitJsonToKicadSchConverter>; view: Project; data: ReturnType<typeof projectToCircuitJson>; circuit: AnyCircuitElement[] }>()
  for (const id of sheetIds) {
    const view = viewOf(id)
    const data = hierarchical ? projectToCircuitJson(view, { nameAllNets: true, forKicad: true, keepVariants: asKicad10, extraUnits: unitsOfOtherUses(project, id), copper: false }) : { elements, notes, symbols, powerTexts }
    const scaled = hierarchical ? scaleSchematic(data.elements) : circuit
    // A project that came from KiCad files keeps its sheets where they were: the page's own origin is the editor's, so every item is at the millimetre it had, on KiCad's grid, not moved to the middle of a page.
    const conv = new CircuitJsonToKicadSchConverter(scaled, { titleBlock: (hierarchical && id !== ROOT_SHEET ? sheetTitleBlock(project, id) : null) ?? titleBlock(project), ...(fromKicadFiles(project) ? { schematicSheets: [{ circuitOrigin: { x: 0, y: 0 } }] } : {}) })
    conv.runUntilFinished()
    converters.set(id, { sch: conv, view, data, circuit: scaled })
  }
  const sch = converters.get(ROOT_SHEET)!.sch
  // A project that came from a KiCad board writes its board natively, so the converter's board is not made (it stops with "Max iterations reached" on a board of thousands of footprints, and is not used).
  const pcb = new CircuitJsonToKicadPcbConverter(circuit)
  if (!native) pcb.runUntilFinished()
  const pro = new CircuitJsonToKicadProConverter(circuit, { projectName: base, schematicFilename: `${base}.kicad_sch`, pcbFilename: `${base}.kicad_pcb`, schematicSheetPlan: sch.schematicSheetPlan })
  pro.runUntilFinished()

  // A project that came from a KiCad board is written natively (`kicadBoard.ts`); one drawn in the editor goes through the converter, then the text writers below.
  const board = native ? await nativeBoard(project) : await converterBoard(project, pcb.getOutputString())
  const boardText = board.text
  const footprintIds = boardFootprintIds(boardText)
  const sheetTexts = new Map<string, string>()
  const sheetNotes: string[] = []
  const files = hierarchical ? sheetFileNames(project, base) : new Map<string, string>()
  // The units of a part drawn on different sheets share one library symbol in each file (`shareUnitSymbols`).
  const libOfs = sheetIds.map(() => new Map<string, string>())
  const drawnTexts = sheetIds.map((id, i) => {
    const made = converters.get(id)!
    return schematicText(made.view, made.data, made.circuit, made.sch, footprintIds, sheetNotes, symbolFlags, libOfs[i])
  })
  const sharedTexts0 = hierarchical ? shareUnitSymbols(drawnTexts, libOfs) : drawnTexts
  // A symbol that came from a KiCad schematic keeps its library name and what its library entry said of itself.
  const drawingByRef = new Map<string, SymbolDrawing>()
  if (fromKicadFiles(project)) {
    for (const c of project.components) {
      const spec = project.parts?.find((p) => p.id === c.partId)
      const drawing = spec?.drawing ? project.symbols?.[spec.drawing] : undefined
      if (drawing && !drawingByRef.has(c.ref)) drawingByRef.set(c.ref, drawing)
    }
  }
  const sharedTexts = drawingByRef.size ? sharedTexts0.map((t) => applyLibraryIdentity(t, (ref) => drawingByRef.get(ref))) : sharedTexts0
  for (const [i, id] of sheetIds.entries()) {
    const made = converters.get(id)!
    const text = sharedTexts[i]
    if (!hierarchical) {
      sheetTexts.set(id, text)
      continue
    }
    const page = made.sch.ctx.c2kMatSch
    const toPage = (p: { x: number; y: number }) => (page ? applyToPoint(page, { x: p.x * SCHEMATIC_SCALE, y: p.y * SCHEMATIC_SCALE }) : p)
    const own = symbolsOf(project, id).map((sym) => sheetSymbolNode(project, sym, toPage, files, asKicad10 ? "keep" : "apply"))
    const converterUuid = made.sch.getOutputString().match(/\(uuid ([0-9a-f-]+)\)/)?.[1] ?? ""
    sheetTexts.set(id, retarget(spreadInstances(text, project, id, converterUuid), sheetUuid(project, id), own))
  }
  // Power symbols as the file version reads them: bare `(power)` for KiCad 9, or `(power local)` and a KiCad 10 stamp when a sheet has a local one.
  const power = finishPower([...sheetTexts.values()])
  sheetIds.forEach((id, i) => sheetTexts.set(id, power.texts[i]))
  if (asKicad10 && power.kicad10) {
    sheetIds.forEach((id) => sheetTexts.set(id, writeVariants(sheetTexts.get(id)!, project, hierarchical ? id : null)))
    sheetNotes.push(`The project's ${variantNames(project).length} schematic variant${variantNames(project).length > 1 ? "s are" : " is"} written in the symbols' instance data, as KiCad 10 keeps them, so the files are stamped ${VARIANT_FILE_VERSION}. Which variant is shown is KiCad's own setting and is not in the files; the symbols are as they are by themselves.`)
  } else if (asKicad10) {
    // The variants were meant for KiCad 10 files and no local power symbol made the files one: they are in neither place, and none was applied to the symbols.
    sheetNotes.push(`KiCad 9 has no schematic variants and none is applied: the symbols are written as they are by themselves, and the project's ${variantNames(project).length} variant${variantNames(project).length > 1 ? "s are" : " is"} not in the files.`)
  } else sheetNotes.push(...variantExportNotes(source, "KiCad 9", { sheets: hierarchical }))
  // A sheet used more than once is one file with no flags of its own for a use: where the uses differ, the file says what the first use has.
  if (hierarchical) sheetNotes.push(...sharedSheetNotes(project, symbolFlags, asKicad10 ? "keep" : "apply", files))
  if (power.kicad10) sheetNotes.push("This project has a local power symbol, which only KiCad 10 reads: its schematic files are stamped as KiCad 10 files, and KiCad 9 will not open them.")
  const schText = sheetTexts.get(ROOT_SHEET)!
  if (project.drawings?.some((d) => d.type === "rect" && d.radius && d.radius > 0)) sheetNotes.push("KiCad 9 has no rounded rectangle, so each one is four lines and four arcs with the rectangle's stroke." + (project.drawings.some(roundedFill) ? " A filled one has its fill as a polygon behind them that follows the corners in short steps (within 0.004 mm at a 2.54 mm radius); a dashed one has its gaps drawn solid by it." : ""))
  if (project.drawings?.some((d) => d.type === "image")) sheetNotes.push("Pictures are written as KiCad's own image nodes.")
  const unread = pictureFiles(project).filter((f) => !imageBytes(f)).length
  if (unread) sheetNotes.push(`${unread} picture${unread > 1 ? "s are" : " is"} left out: ${unread > 1 ? "their files are" : "its file is"} not in this account, or in the account of anyone this project is shared with.`)
  if (project.drawings?.some((d) => d.type === "busentry" && d.toBus)) sheetNotes.push("KiCad 6 and later have one kind of bus entry in the file, from a wire to a bus; a bus-to-bus entry (KiCad 5's) is written as a short bus segment, which joins the same two buses.")
  if (project.drawings?.some((d) => d.type === "line" && d.arrows && !d.closed)) sheetNotes.push("KiCad's lines have no arrowheads, so each one is a small filled triangle drawn at the end.")
  if (project.drawings?.some((d) => d.type === "text" && d.mono && d.valign === undefined)) sheetNotes.push("The monospace face of a text has no setting in KiCad; the text is written in KiCad's own.")
  if (project.components.some((c) => findPart(c.partId)?.powerLocal)) sheetNotes.push("A local power symbol is written as one: its library symbol has (power local) (KiCad 10), so its net belongs to the sheet it is on.")
  if (project.components.some((c) => c.flags?.excludeFromPos || c.flags?.virtual)) sheetNotes.push("A part left out of the position file is written as a footprint attribute on the board; the KiCad 9 schematic has no such flag.")
  if ([...symbolFlags.values()].some((c) => c.flags?.dnp || c.flags?.excludeFromBom || c.flags?.notOnBoard || c.flags?.excludeFromSim)) sheetNotes.push("Do not populate, out of the BOM, not on the board and out of simulation are written on the symbol; do not populate and out of the BOM are also attributes of its footprint.")
  if (hierarchical && (project.sheetSymbols ?? []).some((sym) => sheetFlagsWritten(project, sym, asKicad10 ? "keep" : "apply"))) sheetNotes.push("The flags of a sheet symbol are written on the sheet symbol, in the file of the sheet it is drawn on, as KiCad 9 reads them: KiCad applies them to everything below it, so the symbols in that sheet's own file say only their own flags.")
  if (hierarchical) sheetNotes.push(`The schematic is ${sheetIds.length} files: the root and a file for each other sheet, drawn once however many sheet symbols use it, with every symbol's reference for each use in its instance data.`)
  const settings = applyProjectSettings(pro.getOutputString(), project)
  const custom = kicadCustomRules(project)
  const dru = kicadDruText(project.kicad?.dru, custom?.text ?? null)
  // The project file lists the sheets by their symbols' ids and names.
  if (hierarchical) {
    const json = JSON.parse(settings.text) as Record<string, unknown>
    json.sheets = [[sheetUuid(project, ROOT_SHEET), ""], ...(project.sheetSymbols ?? []).map((sym) => [symbolUuid(sym), sym.name])]
    settings.text = JSON.stringify(json, null, 2)
  }

  return {
    files: {
      [`${base}.kicad_pro`]: settings.text,
      [`${base}.kicad_sch`]: tidyNumbers(schText),
      ...Object.fromEntries(sheetIds.filter((id) => id !== ROOT_SHEET).map((id) => [files.get(id)!, tidyNumbers(sheetTexts.get(id)!)])),
      [`${base}.kicad_pcb`]: tidyNumbers(applyFootprintLinks(boardText, [...sheetTexts].map(([id, text]) => ({ file: id === ROOT_SHEET ? `${base}.kicad_sch` : (files.get(id) ?? `${base}.kicad_sch`), text })), (ref) => !fromKicadFiles(project) || project.components.some((c) => c.ref === ref && c.sheetFile !== undefined))),
      // The custom design rules the project was imported with, written back as they were, and the clearance rules after them.
      ...(dru ? { [`${base}.kicad_dru`]: dru } : {}),
    },
    notes: [
      ...notes,
      ...board.notes,
      ...sheetNotes,
      ...(symbols.length && project.components.some((c) => findPart(c.partId)?.jumpers) ? kicadSymbolNotes(elements) : []),
      ...board.afterNotes,
      "KiCad names every net, so nets the schematic leaves unnamed are called Net-(REF-PIN), as KiCad would.",
      ...(board.native
      ? []
      : [
          "Parts keep our schematic symbols and land patterns; they are stored in the files, not in a KiCad library, and carry the 3D model of KiCad's library the part is drawn with, where it has one. The footprints are named CherryBlossom:<name> (CherryBlossom:0603, CherryBlossom:soic8), which is how Cherry Blossom finds them, and their bodies, again when it reads the board back.",
          ...(symbols.some((l) => l.reference || l.value || l.texts) ? ["Each part's designator and value are fields shown where the sheet draws them, and the names and numbers of its pins are texts inside its symbol, where the sheet draws them, so the sheet reads the same in KiCad (KiCad lays pin names out by its own rules where it draws them itself)."] : []),
          ...((project.blocks ?? []).length ? ["Each titled block of the sheet is a group of its symbols, named as the block is."] : []),
        ]),
      board.native ? "Symbols carry the footprint, part number, LCSC number, manufacturer and every other part property as hidden fields." : "Symbols carry the footprint, part number, LCSC number, manufacturer and every other part property as hidden fields; the board's footprints carry only the part and LCSC numbers.",
      ...(project.zones.length && !board.native && !kicadWritesZones(project) ? ["Pours arrive filled as Cherry Blossom filled them, with its clearance, thinnest neck and thermal settings; press B in KiCad to refill them. KiCad's thermal spokes are always four, at its own angle."] : []),
      "The design rules are in the KiCad project: clearance, trace width, via and drill sizes, annular ring, hole to hole, copper to the board edge, mask and paste openings, and trace widths by net as net classes. Vias in pads and via tenting have no setting there.",
      ...(project.rules.netClasses?.length ? ["Net classes are in the KiCad project (net settings): each class's clearance, trace width, via, micro via and differential pair sizes, with its nets as patterns that match them exactly. A width given to one net is a class of its own that sets only the width."] : []),
      ...settings.notes,
      ...(custom?.text ? [`Clearance rules for a pair of nets or a part's pads are KiCad custom rules, in the .kicad_dru beside the project${project.kicad?.dru ? ", after the rules it was imported with" : ""}.`] : []),
      ...(custom?.notes ?? []),
      ...(settings.unmatched.length ? [`Trace widths for nets with * or ? in the name were left out, since KiCad reads those as wildcards: ${settings.unmatched.join(", ")}.`] : []),
      "The project's name, revision, company, description and other properties are in the schematic's title block and the project's text variables.",
      ...(project.kicad?.pro ? ["The project file keeps what the KiCad project it came from said that the editor has no setting for (the severity of each check, the sizes offered while routing, the text sizes of new items, the BOM and ERC settings, the colours of net classes), written back as it was."] : []),
      ...(project.kicad?.dru ? ["The custom design rules file is written back as it was."] : []),
      ...(project.kicad && (project.kicad.paper || project.kicad.auxOrigin || project.kicad.gridOrigin || project.kicad.plot || project.kicad.layers) ? ["The board's page size, drill and place file origin, grid origin, plot settings and layer names are written back as the KiCad board had them."] : []),
      ...(project.components.some((c) => c.flags) ? ["Part flags (surface mount or through-hole, not in the BOM or position file, board only, do not populate, allowed missing courtyard and mask bridges) and net ties are written as each footprint's attributes and pad groups."] : []),
    ],
  }
}

export async function kicadZip(project: Project): Promise<{ blob: Blob; notes: string[] }> {
  const { files, notes, exact } = await kicadFiles(project)
  const zip = new JSZip()
  const folder = zip.folder(slugify(project.name))!
  for (const [name, content] of Object.entries(files)) folder.file(name, exact?.[name] ?? content)
  return { blob: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), notes }
}
