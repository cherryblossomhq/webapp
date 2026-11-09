import { copperLayers } from "../model/stack"
import { setCopperLayerCount } from "../model/layerOps"
import { boxesOverlap, round, samePoint, snap } from "../lib/geometry"
import { resolvedComponents } from "../model/ruleAreas"
import { pinKey } from "../model/connectivity"
import { footprintPinProblem, isValidFootprint } from "../model/footprints"
import { footprintOptionProblem } from "../model/supplier/footprintGuard"
import { labelTextFor } from "../model/netNames"
import { componentFootprint, hasUnits, isPhysical, isSchematicPart, powerNetName, schematicBounds, schematicPins, unitGroup, unitOwners, valueText } from "../model/instances"
import { uid } from "../lib/id"
import { removeStitching, routeAroundStitching, stitchVias } from "../model/stitch"
import { pourMissNote } from "../model/pourReach"
import { autoroute, type AutorouteResult } from "../model/autoroute"
import { drawHint, narrowList, openList } from "./routeReport"
import type { PcbAnalysis } from "../model/pcb"
import { blockPorts, readingOrder } from "../model/blockPorts"
import { netInfo } from "../model/tidy/nets"
import { tidySchematic } from "../model/tidy"
import { decouplingSummary } from "../model/decoupling"
import { clearanceRuleRows, pcbToolLabel, pcbToolSpecs } from "./pcbTools"
import { dimensionsReport, drawingsReport, groupsReport, imagesReport, textsReport } from "./shapeReport"
import { padMachining, protectionWords, viaProtection } from "../model/machining"
import { padDieTimes, tuningPatterns } from "../model/netLengths"
import { stageGaps } from "../model/powerStage"
import { projectPartDefs } from "../model/customParts"
import { findPart } from "../model/library"
import { flagWords, onBoard, setFlags } from "../model/partFlags"
import { activeVariant, variantNames, variantWords } from "../model/variants"
import { unconnectedPinSeverity } from "../model/checkRules"
import { partFindings } from "../model/partChecks"
import { addToBlock, blockFrames, blockOf, cleanBlockName, contentsOf, createBlock, deleteBlocks, findBlock, removeFromBlocks, renameBlock } from "../model/blocks"
import { planConnect, type ConnectPlan } from "../model/attach"
import { AUTO_NET_NAME, connectionsLost, moveProblems, pinGroup, schematicEditProblems, unrequestedMerges } from "../model/merges"
import { findSafeSpot } from "../model/spots"
import { moveDrawing, updateDrawings } from "../model/drawings"
import { dragSelection } from "../model/schematicEdit"
import { searchLibrary } from "../model/search"
import {
  addComponent,
  autoPlacePcb,
  freeSchematicSpot,
  moveComponent,
  removeItems,
  rotateComponent,
  repackCopper,
  repackPcb,
  resolvePinSpec,
  updateComponent,
} from "../model/ops"
import { copperRemovedNote, removeCopper } from "../model/boardCopper"
import { isAutoNetName } from "../model/netNames"
import { rekeyAutoNets } from "../model/rekeyNets"
import { addUnit, mirrorSelection, renameReference, setFieldPlace, setSymbolVariant } from "../model/schematicEdit"
import { bodyStyleCount, fieldPlaceOf, fieldValue, symbolOf, unitCount } from "../model/symbolDrawing"
import { SCH_GRID } from "../model/symbols"
import { outlineGeometry, outlineState } from "../model/outline"
import { outlineCrossingProblem } from "../model/outlineCrossing"
import { addOutlinePaths, explicitPaths, joinPaths, resetOutline, setOutlinePaths } from "../model/outlineOps"
import { cutoutTexts, edgeText, parseOutlineText } from "../model/outlineText"
import { flattenPath } from "../model/shapes"
import { MOUNTING_HOLE_PRESETS, mountingHoles, SURFACE_FINISHES } from "../model/board"
import { applyCapability, BOARD_THICKNESSES, FAB_CAPABILITIES, matchCapability, THERMAL_RELIEF_OPTIONS } from "../model/rules"
import { addZone, makeZone, outlinePoints, removeZones, updateZone } from "../model/zoneOps"
import { withPartZones } from "../model/partZones"
import { hasPartZones, isWholeBoardPour, keepoutFlags, zoneLayers } from "../model/zones"
import { areaReport, partSheet, placementAreas, placementProblems, placementWords } from "../model/placementAreas"
import type { ComponentInstance, CopperLayer, DesignRules, FieldPlace, Mirror, PartDef, PinDef, PinRef, Project, Rotation, SchematicBlock, SurfaceFinish, ZonePlacement } from "../model/types"
import { getConnectivity, getErc, getPcbAnalysis } from "../store/analysis"
import { paperOf } from "../model/paper"
import { SHEET_ARG, SHEET_PROPERTY, onSheet, pageReport, resolveSheet, sheetEditTools, sheetWiringTools, shownUse } from "./sheetTools"
import { isHierarchical, sheetUses, sheetView, syncEdited, useAt, type SheetUse } from "../model/sheets"
import { splitIgnored } from "../model/erc"
import { looseIslands, takenCount, withoutTaken, wiringAt, type Taken } from "../model/unwire"
import { lookTool } from "./lookTool"
import { readDatasheetTool } from "./datasheetTool"
import { WEB_TOOLS, webToolLabel } from "./webTools"
import { createPartTool, findPartTool, getPartDataTool, verifyPartsTool } from "./partTools"
import { designDrawings, drawingsMore, drawingToolLabel, drawingToolSpecs } from "./drawingTools"
import { arrangeBlocksTool } from "./arrangeTool"
import { drawWiringTool, editNetTool, getWiringTool } from "./wiringTools"
import { VERSION_TOOLS } from "./versionTools"
import { fail, ok, pinList, stringProps, type JsonSchema, type ToolContext, type ToolInput, type ToolOutcome, type ToolSpec } from "./toolKit"

export type { JsonSchema, ToolContext, ToolInput, ToolOutcome } from "./toolKit"

const ROTATIONS = [0, 90, 180, 270]
const snapSch = (n: number) => round(snap(n, SCH_GRID))

const findByRef = (project: Project, ref: unknown) =>
  typeof ref === "string" ? project.components.find((c) => c.ref.toLowerCase() === ref.trim().toLowerCase()) : undefined

// ---------- parts with several units ----------

/** The symbol that is the part itself (the one on the board), else the first. */
const partSymbol = (group: ComponentInstance[]) => group.find((x) => !findPart(x.partId)?.unitOf) ?? group[0]

/** The units of a part that draw a pin, whatever the body style. */
function unitsOfPin(part: PartDef, pin: string): number[] {
  const symbols = part.units?.symbols
  if (!symbols) return [1]
  const out = new Set<number>()
  for (const [key, symbol] of Object.entries(symbols)) if (symbol.ports.some((p) => p.pin === pin)) out.add(Number(key.split(":")[0]))
  return [...out].sort((a, b) => a - b)
}

/**
 * The connectivity lists a pin of a unit under the part's own symbol as well (`unitOwners`), so a
 * pin that is joined is joined twice over: these are the groups of that second listing, which
 * stand for the same pin and may join with it.
 */
function aliasGroups(project: Project, before: ReturnType<typeof getConnectivity>, refs: PinRef[]): string[] {
  const owners = unitOwners(project.components)
  return refs.flatMap((r) => {
    const owner = owners.get(r.componentId)
    return owner ? [pinGroup(before, { componentId: owner, pin: r.pin })] : []
  })
}

const listUnits = (group: ComponentInstance[]) => group.map((x) => x.unit ?? 1).sort((a, b) => a - b).join(", ")

/** The symbol a call means by `ref`: the part itself, or the placed unit `placed_unit` names. A string says why there is none. */
function pickSymbol(project: Project, input: ToolInput): ComponentInstance | string {
  const c = findByRef(project, input.ref)
  if (!c) return `No component ${String(input.ref)}`
  const group = unitGroup(project, c)
  const wanted = input.placed_unit
  if (wanted === undefined) return partSymbol(group)
  const hit = group.find((x) => (x.unit ?? 1) === wanted)
  return hit ?? `${c.ref} has no unit ${String(wanted)} on the sheet. Units placed: ${listUnits(group)}`
}

/** A field of a placed symbol: its name, what it says, where it sits on the sheet when it is shown. */
function fieldsOf(c: ComponentInstance, part: PartDef) {
  const names = [...new Set([...Object.keys(part.fieldPlaces ?? {}), ...Object.keys(c.fields ?? {})])]
  const out: { name: string; text: string; hidden?: true; x?: number; y?: number }[] = []
  for (const name of names) {
    const place = fieldPlaceOf(c, part, name)
    const text = fieldValue(c, part, name)
    if (!place || !text.trim()) continue
    out.push({ name, text, ...(place.hidden ? { hidden: true as const } : { x: round(c.sch.x + place.x), y: round(c.sch.y + place.y) }) })
  }
  return out
}

/** What get_design says of a part drawn from a KiCad symbol beyond what it says of every part. */
function symbolFacts(project: Project, c: ComponentInstance, part: PartDef) {
  const group = unitGroup(project, c)
  const count = unitCount(part)
  const styles = bodyStyleCount(part)
  const placed = new Set(group.map((x) => x.unit ?? 1))
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((u) => !placed.has(u))
  const fields = fieldsOf(c, part)
  return {
    ...(count > 1 && { unit: c.unit ?? 1 }),
    ...(styles > 1 && { body_style: c.bodyStyle ?? 1 }),
    ...(count > 1 && {
      units_placed: group.map((x) => ({
        unit: x.unit ?? 1,
        x: x.sch.x,
        y: x.sch.y,
        rotation: x.sch.rot,
        ...(x.sch.mirror && { mirror: x.sch.mirror }),
        ...(styles > 1 && { body_style: x.bodyStyle ?? 1 }),
      })),
      units_missing: missing,
    }),
    ...(fields.length && { fields }),
  }
}

/** One pin of a part drawn from a KiCad symbol, as get_design lists it. */
function pinFacts(project: Project, c: ComponentInstance, part: PartDef, pin: PinDef, net: string | null) {
  const group = unitGroup(project, c)
  const at = group.find((x) => schematicPins(x).some((w) => w.pin === pin.number))
  const world = at ? schematicPins(at).find((w) => w.pin === pin.number) : undefined
  const type = world?.type ?? pin.type
  const selected = group.map((x) => x.pinAlt?.[pin.number]).find(Boolean)
  const joins = world?.hidden && type === "power_in" && world.name.trim() ? world.name.trim() : undefined
  return {
    pin: pin.number,
    name: pin.name,
    net,
    ...(type && { type }),
    ...(world?.hidden && { hidden: true }),
    ...(unitCount(part) > 1 && { unit: unitsOfPin(part, pin.number)[0], ...(!at && { unit_not_placed: true }) }),
    ...(pin.alternates?.length && { functions: pin.alternates.map((a) => a.name), ...(selected && { function: selected }) }),
    ...(joins && { joins_net: joins, note: `hidden power pin: joins net ${joins}, it is not unconnected` }),
    ...(type === "no_connect" && { note: "no-connect pin: on no net, leave it open" }),
  }
}

function describePart(c: ComponentInstance) {
  const part = findPart(c.partId)
  const name = part?.name ?? c.partId
  const value = valueText(c, part)
  return `${name}${value && value !== name ? `, ${value}` : ""}`
}

function partSuggestions(project: Project, query: string) {
  const hits = searchLibrary(query.replace(/[_-]/g, " "), projectPartDefs(project)).slice(0, 5)
  const create = " If the library has no such part, make it with create_part."
  return hits.length ? ` Closest parts: ${hits.map((h) => h.part.id).join(", ")}.${create}` : ` Use search_parts to find a part id.${create}`
}

/** Map every pin to its net name; null when the pin is not connected to anything. */
function pinNetNames(project: Project) {
  const conn = getConnectivity(project)
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  return (componentId: string, pin: string): string | null => {
    const id = conn.pinNet.get(pinKey(componentId, pin))
    if (!id) return null
    const net = byId.get(id)
    if (!net) return null
    if (!net.named && net.pins.length < 2) return null
    return net.name
  }
}

function pinLabel(project: Project, ref: PinRef) {
  const c = project.components.find((x) => x.id === ref.componentId)
  const part = c ? findPart(c.partId) : undefined
  const name = part?.pins.find((p) => p.number === ref.pin)?.name
  return `${c?.ref ?? "?"}.${name && name !== ref.pin ? name : ref.pin}`
}

/** Accept "R1.2", "U1.VCC", or a bare ref for one-pin parts ("#PWR1"). */
function resolveSpec(project: Project, spec: string): PinRef | null {
  if (!spec.includes(".")) {
    const c = findByRef(project, spec)
    const part = c ? findPart(c.partId) : undefined
    if (c && part?.pins.length === 1) return { componentId: c.id, pin: part.pins[0].number }
    return null
  }
  return resolvePinSpec(project, spec)
}

type PinResolved = { ref: PinRef } | { unknown: string } | { unplaced: string }

/**
 * `resolveSpec` for the tools. A part with several units is several symbols of one designator, and
 * each draws some of the part's pins: the pin is the one on the symbol that has it, and a pin whose unit
 * is not on the sheet says which unit to place first.
 */
function resolvePin(project: Project, spec: string): PinResolved {
  const m = spec.match(/^([^.\s]+)\.(.+)$/)
  const first = m ? findByRef(project, m[1]) : undefined
  const part = first ? findPart(first.partId) : undefined
  if (!m || !first || !part || unitCount(part) < 2) {
    const ref = resolveSpec(project, spec)
    return ref ? { ref } : { unknown: pinHelp(project, spec) }
  }
  const group = unitGroup(project, first)
  const name = m[2].trim()
  let pins = part.pins.filter((p) => p.number === name)
  if (!pins.length) pins = part.pins.filter((p) => p.name.toLowerCase() === name.toLowerCase())
  if (!pins.length) return { unknown: pinHelp(project, spec) }
  const onSheet = pins.map((pin) => ({ pin, at: group.find((x) => schematicPins(x).some((w) => w.pin === pin.number)) })).filter((h) => h.at)
  if (onSheet.length === 1) return { ref: { componentId: onSheet[0].at!.id, pin: onSheet[0].pin.number } }
  if (onSheet.length > 1) return { unknown: `"${spec}": ${first.ref} has pins ${onSheet.map((h) => h.pin.number).join(" and ")} called ${name}; give the pin number` }
  const pin = pins[0]
  const units = unitsOfPin(part, pin.number)
  const base = part.unitOf ?? part.id
  return {
    unplaced: `Pin ${pin.number}${pin.name !== pin.number ? ` (${pin.name})` : ""} of ${first.ref} is on unit ${units.join(" or ")}, which is not on the sheet yet. Place it first: add_component with part_id "${base}", ref "${first.ref}" and unit ${units[0]}`,
  }
}

function pinHelp(project: Project, spec: string) {
  const ref = spec.split(".")[0]
  const c = findByRef(project, ref)
  if (!c) return `"${spec}": no component ${ref}`
  const part = findPart(c.partId)
  if (!part?.pins.length) return `"${spec}": ${c.ref} has no pins`
  const units = unitCount(part) > 1
  return `"${spec}": ${c.ref} has pins ${part.pins.map((p) => `${p.name === p.number ? p.number : `${p.number}/${p.name}`}${units ? ` (unit ${unitsOfPin(part, p.number).join("/")})` : ""}`).join(", ")}`
}

// ---------- Tools ----------

/**
 * The most get_design answers at once, in characters. It is what an assistant reads first, so it may
 * go up to where Claude Code stops showing a tool's text and puts it in a file instead (50,000
 * characters, or 25k tokens), less room for the notes the MCP server adds (`designNotes`). At about
 * 430 characters a part, a design past about 100 parts answers with an overview instead.
 */
export const DESIGN_BUDGET = 45_000

const getDesign: ToolSpec = {
  name: "get_design",
  description:
    "Read the open project: every component (real parts only; power and ground symbols are listed apart as power_symbols and are not counted) with its part id, value, footprint, schematic position, each pin's net and, when it has any, its flags (do not populate, not in the BOM or position file, not on the board, board only, virtual, net ties), plus the net list, each sheet's page (the area inside its border, the title block), the schematic's blocks with their parts and frames, the schematic's drawings (texts, lines, shapes, pictures and tables, with their ids), board size, the board's own drawings and texts (counts per layer and on parts, copper drawings listed, parts with no pins) when there are any, and a check summary, and the variants (the one shown and what each changes on which parts) when the project has any. Parts from KiCad symbols also list their mirror, fields, units, pin types and pin functions. Call this before editing an existing design; get_wiring gives the coordinates of pin ends, wires and labels. block or refs reads only those parts, with the nets that touch them: a design too big for one answer lists its parts and nets by name only, to read again so.",
  input_schema: {
    type: "object",
    properties: {
      sheet: SHEET_PROPERTY,
      block: { type: "string", description: "Only this block's parts" },
      refs: { type: "array", items: { type: "string" }, description: "Only these parts, e.g. [\"U1\", \"C3\"]" },
    },
  },
  run: (project, input) => {
    // A project with sheets: the whole design, each part saying which sheet it is on, or one sheet's parts and the nets that touch them.
    const hier = isHierarchical(project)
    const asked = typeof input?.sheet === "string" ? input.sheet.trim() : ""
    let only: SheetUse | undefined
    if (asked) {
      if (!hier && !("use" in resolveSheet(project, asked))) return fail(project, `This project has one sheet, so there is no sheet called ${asked}.`)
      const r = resolveSheet(project, asked)
      if ("error" in r) return fail(project, r.error)
      only = hier ? r.use : undefined
    }
    // Part of the design: a block's parts (with the power ports drawn for them), or parts by designator, and the nets that touch them.
    const blockName = typeof input?.block === "string" ? input.block.trim() : ""
    const refs = Array.isArray(input?.refs) ? input.refs.filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim()) : []
    if (blockName && refs.length) return fail(project, "Give block or refs, not both.")
    let picked: Set<string> | undefined
    let pickedBlock: SchematicBlock | undefined
    let missingRefs: string[] = []
    if (blockName) {
      pickedBlock = findBlock(project, blockName)
      if (!pickedBlock) return fail(project, `No block ${blockName}. Blocks: ${blockNames(project)}`)
      picked = new Set([...pickedBlock.components, ...contentsOf(project, [pickedBlock.id]).components])
    } else if (refs.length) {
      // The refs the design has are read; the others are named, rather than the whole call refused for one typo.
      const known = refs.filter((r) => findByRef(project, r))
      if (!known.length) return fail(project, `No component ${refs.join(", ")}. Call get_design without refs for the designators.`)
      const found = componentsByRef(project, known)
      if (typeof found === "string") return fail(project, found)
      picked = new Set(found.map((c) => c.id))
      missingRefs = refs.filter((r) => !known.includes(r))
    }
    const shown = (c: ComponentInstance) => (!only || (c.inst ?? "") === only.path) && (!picked || picked.has(c.id))
    const useOfRef = new Map(project.components.map((c) => [c.ref, c.inst ?? ""]))
    const humanOf = (inst: string) => useAt(project, inst).human
    // A design with a placement area for a sheet says which sheet each part is on, as a design with sheets does.
    const sheetAreas = placementAreas(project).some((z) => z.placement?.by === "sheet")
    const netOf = pinNetNames(project)
    const conn = getConnectivity(project)
    const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
    const pcb = getPcbAnalysis(project)
    // A power or ground symbol is a drawing of a net, not a part on the board: counting it as a
    // component made one 19-part board read as 24, 45 and 47 components as symbols were drawn.
    const isSymbol = (c: ComponentInstance) => !!findPart(c.partId)?.powerNet
    // A unit of a part with several is listed with its part (`units_placed`), not as a component of its own.
    const unitSymbols = unitOwners(project.components)
    const components = resolvedComponents(project).filter((c) => !isSymbol(c) && !unitSymbols.has(c.id) && shown(c)).map((c) => {
      const part = findPart(c.partId)
      const base = {
        ref: c.ref,
        ...(hier ? { sheet: humanOf(c.inst ?? "") } : sheetAreas ? { sheet: partSheet(project, c) } : {}),
        ...(c.classes?.length ? { classes: c.classes } : {}),
        part: c.partId,
        name: part?.name ?? c.partId,
        value: valueText(c, part) || undefined,
        x: c.sch.x,
        y: c.sch.y,
        rotation: c.sch.rot,
        mirror: c.sch.mirror,
        // Only parts that have flags (do not populate, not in the BOM, net ties and the rest) say so.
        ...(c.flags && { flags: flagWords(c.flags), ...(c.flags.netTies && { net_ties: c.flags.netTies.map((g) => g.join("+")) }) }),
      }
      // A part drawn from a KiCad symbol is read in full even with no footprint: its pins are what Sakura wires.
      const kicad = !!part?.jumpers
      if (!isPhysical(part) && !kicad) return base
      const padNumbers = new Map<string, string>()
      for (const pad of componentFootprint(c)?.pads ?? []) if (pad.pin && pad.number !== undefined && !padNumbers.has(pad.pin)) padNumbers.set(pad.pin, pad.number)
      return {
        ...base,
        ...(kicad && part ? symbolFacts(project, c, part) : {}),
        footprint: c.footprint,
        props: c.props,
        // Where it stands on the PCB (mm, y up): enough to reason about placement, small per part.
        ...(c.pcb.placed && onBoard(c) && { pcb: { x: round(c.pcb.x, 2), y: round(c.pcb.y, 2), rot: c.pcb.rot, side: c.pcb.side, ...(c.pcb.locked && { locked: true }) } }),
        pins: (part?.pins ?? []).map((p) => {
          const facts = kicad && part ? pinFacts(project, c, part, p, netOf(c.id, p.number)) : { pin: p.number, name: p.name, net: netOf(c.id, p.number) }
          // A pin that is one of several pads sharing a number (each on its own net), or the pin of a pad with no number: the number the board file gives it.
          const number = padNumbers.get(p.number)
          return number === undefined ? facts : { ...facts, pad_number: number }
        }),
      }
    })
    const powerSymbols = project.components.filter((c) => isSymbol(c) && shown(c)).map((c) => ({
      ref: c.ref,
      net: powerNetName(c) ?? undefined,
      x: c.sch.x,
      y: c.sch.y,
      rotation: c.sch.rot,
      mirror: c.sch.mirror,
    }))
    const nets = conn.nets
      .filter((n) => n.named || n.pins.length > 1)
      .filter((n) => !only || n.pins.some((p) => useOfRef.get(refOf.get(p.componentId) ?? "") === only!.path))
      .filter((n) => !picked || n.pins.some((p) => picked!.has(p.componentId)))
      .map((n) => {
        // Read for some parts, a net like GND lists their pins and counts the rest: its dozens of pins were most of a scoped answer.
        const mine = picked ? n.pins.filter((p) => picked!.has(p.componentId)) : n.pins
        const others = n.pins.length - mine.length
        return { name: n.name, pins: mine.map((p) => `${refOf.get(p.componentId)}.${p.pin}`), ...(picked && others ? { other_pins: others } : {}) }
      })
    const erc = splitIgnored(getErc(project), project.ignoredChecks)
    const frames = new Map(blockFrames(project).map((f) => [f.id, f.box]))
    const info = project.blocks?.length ? netInfo(project) : null
    const order = info && readingOrder(project, info)
    const blocks = (project.blocks ?? [])
      .filter((b) => !only || (b.inst ?? "") === only.path)
      .filter((b) => !picked || (pickedBlock ? b.id === pickedBlock.id : b.components.some((id) => picked!.has(id))))
      .map((b) => {
        const box = frames.get(b.id)
        const ports = blockPorts(project, b.id, info!, order!)
        return {
          name: b.name,
          parts: [...new Set(b.components.map((id) => refOf.get(id)))],
          ...(box && { frame: { min_x: box.minX, min_y: box.minY, max_x: box.maxX, max_y: box.maxY } }),
          ...(ports.length && { ports: ports.map((p) => ({ net: p.name, direction: p.direction, ...(p.group && { group: p.group }) })) }),
        }
      })
    const drawings = designDrawings(project)
    const boardDrawings = drawingsReport(project)
    const texts = textsReport(project)
    const dimensions = dimensionsReport(project)
    const groups = groupsReport(project)
    const images = imagesReport(project)
    const zones = zonesReport(project)
    const variants = variantsReport(project)
    // Drawing that reaches no part makes a sheet with no parts look empty in this list when it isn't.
    const sheetsOnce = hier ? [...new Map(sheetUses(project).map((u) => [u.sheet, u.path])).values()].map((path) => sheetView(project, path)) : [project]
    const loose = sheetsOnce.flatMap(looseIslands)
    const looseText = wiringList({ wires: loose.reduce((a, i) => a + i.wires.length, 0), labels: loose.reduce((a, i) => a + i.labels.length, 0), ports: loose.reduce((a, i) => a + i.ports.length, 0) })
    const design = {
      project: project.name,
      // Every sheet is a page: what its drawing stays inside and clear of, in its own units.
      ...(hier
        ? {
            sheets: sheetUses(project).map((u) => ({
              path: u.human,
              ...(u.symbol ? { box: { x: u.symbol.x, y: u.symbol.y, w: u.symbol.w, h: u.symbol.h }, ...(u.symbol.pins.length ? { pins: u.symbol.pins.map((p) => `${p.name} (${p.shape})`) } : {}) } : {}),
              page: pageReport(paperOf(project, u.sheet)),
            })),
            ...(only ? { showing_sheet: only.human } : {}),
          }
        : { page: pageReport(paperOf(project)) }),
      board_mm: { width: project.board.width, height: project.board.height, thickness: project.board.thickness, center_x: project.board.x, center_y: project.board.y, ...outlineReport(project.board), ...layersReport(project) },
      design_rules_mm: ruleSummary(project.rules, project),
      components,
      power_symbols: powerSymbols,
      nets,
      ...(blocks.length ? { blocks } : {}),
      ...(looseText ? { loose_wiring: `${looseText} reach no part (remove_wiring loose deletes them)` } : {}),
      ...(drawings.length ? { drawings } : {}),
      ...(drawingsMore(project) ? { drawings_more: drawingsMore(project) } : {}),
      ...(boardDrawings ? { board_drawings: boardDrawings } : {}),
      ...(texts ? { texts } : {}),
      ...(dimensions ? { dimensions } : {}),
      ...(groups ? { groups } : {}),
      ...machiningReport(project),
      ...(images ? { images } : {}),
      ...(zones ? { zones } : {}),
      ...(variants ? { variants } : {}),
      checks: {
        unconnected_pins: unconnectedPinSeverity(project) ? conn.unconnectedPins.length : 0,
        electrical_warnings: erc.active.length,
        electrical_ignored_by_user: erc.ignored.length,
        pcb_errors: pcb.violations.filter((v) => v.severity === "error").length,
        pcb_warnings: pcb.violations.filter((v) => v.severity === "warning").length,
        unplaced_on_pcb: resolvedComponents(project).filter((c) => onBoard(c) && !c.pcb.placed).length,
      },
    }
    if (picked) {
      // Read for some parts: what is about them. The page, board, rules and drawings are the same for every part, and were most of
      // a scoped answer (12k characters at the median over MCP), sent again on every call.
      const scoped = {
        project: project.name,
        scope: `Only ${pickedBlock ? `block ${pickedBlock.name}` : "these parts"}, with the nets that touch them (pins of other parts counted). get_design without block or refs has the board, the rules and the drawings.`,
        ...(missingRefs.length ? { not_found: `No component ${missingRefs.join(", ")}` } : {}),
        ...(only ? { showing_sheet: only.human } : {}),
        components,
        ...(powerSymbols.length ? { power_symbols: powerSymbols } : {}),
        nets,
        ...(blocks.length ? { blocks } : {}),
      }
      const summary = `Read ${pickedBlock ? pickedBlock.name : `${components.length} part${components.length === 1 ? "" : "s"}`} of the design`
      const scopedText = JSON.stringify(scoped)
      if (scopedText.length <= DESIGN_BUDGET) return ok(project, scopedText, summary)
      // Still too much for one answer (a block of a hundred parts): the parts by name, to ask for fewer at a time.
      return ok(
        project,
        JSON.stringify({ ...scoped, too_big: `${plural(components.length, "component")} with their pins are too many for one answer: ask again with fewer refs.`, components: components.map((c) => [c.ref, c.part, c.value].filter(Boolean).join(" ")), nets: nets.map((n) => n.name) }),
        summary,
      )
    }
    const text = JSON.stringify(design)
    if (text.length <= DESIGN_BUDGET) return ok(project, text, `Read the design (${components.length} components, ${nets.length} nets)`)
    // Too much for one answer: every part and net by name, to read again a block or some parts at a time.
    const { power_symbols: _symbols, ...rest } = design
    const overview = {
      too_big: `${plural(components.length, "component")} with their pins are too many for one answer, so this lists each as its designator, part id and value, and each net by name. Ask again with block or refs for their pins, places and nets.`,
      ...rest,
      components: components.map((c) => [c.ref, c.part, c.value, "sheet" in c && `on ${c.sheet}`].filter(Boolean).join(" ")),
      nets: nets.map((n) => n.name),
      ...(blocks.length ? { blocks: blocks.map(({ ports: _ports, ...b }) => b) } : {}),
    }
    return ok(project, JSON.stringify(overview), `Read the design's parts and nets by name (${components.length} components, ${nets.length} nets)`)
  },
}

/**
 * X22 and X21, what get_design says of via protection (how many vias have each combination, in words), backdrills and post-machining (vias and pads), tuning patterns and the lengths inside
 * pad packages. Each is listed only when the board has it, so a board that has none looks as it always did.
 */
function machiningReport(project: Project) {
  const protection: Record<string, number> = {}
  for (const v of project.vias) {
    const words = protectionWords(viaProtection(project.rules, v, project.board)).join(", ")
    if (words) protection[words] = (protection[words] ?? 0) + 1
  }
  const pads = padMachining(project)
  const drills = { vias: project.vias.reduce((n, v) => n + (v.backdrill ? 1 : 0) + (v.tertiary ? 1 : 0), 0), pads: pads.reduce((n, p) => n + (p.backdrill ? 1 : 0) + (p.tertiary ? 1 : 0), 0) }
  const posts = { vias: project.vias.reduce((n, v) => n + (v.post?.front ? 1 : 0) + (v.post?.back ? 1 : 0), 0), pads: pads.reduce((n, p) => n + (p.front ? 1 : 0) + (p.back ? 1 : 0), 0) }
  const patterns = tuningPatterns(project)
  const dies = padDieTimes(project).length
  return {
    ...(Object.keys(protection).length ? { via_protection: protection } : {}),
    ...(drills.vias || drills.pads ? { backdrills: drills } : {}),
    ...(posts.vias || posts.pads ? { post_machining: posts } : {}),
    ...(patterns.length ? { tuning_patterns: patterns.map((t) => ({ name: t.name, layer: t.layer, target_mm: t.target })) } : {}),
    ...(dies ? { package_lengths: dies } : {}),
  }
}

/** Components by designator, or an error naming the ones the design doesn't have. All units of a part go with it. */
function componentsByRef(project: Project, refs: string[]): ComponentInstance[] | string {
  const found = refs.map((r) => findByRef(project, r))
  const missing = refs.filter((_, i) => !found[i])
  if (missing.length) return `No component ${missing.join(", ")}`
  const all = (found as ComponentInstance[]).flatMap((c) => unitGroup(project, c))
  return all.filter((c, i) => !hasUnits(findPart(c.partId)) || all.indexOf(c) === i)
}

const blockNames = (project: Project) => (project.blocks ?? []).map((b) => b.name).join(", ") || "none yet"

const groupPartsTool: ToolSpec = {
  name: "group_parts",
  description:
    "Group components into a named block of the schematic, drawn as a frame around them with the name as its title, the way an engineering sheet splits a circuit by function. A component is in one block at most, so grouping it again moves it; when a block of that name exists, the components join it. The frame follows its parts and takes in the wires, labels and power ports drawn for them alone, so place a block's parts together.",
  input_schema: {
    type: "object",
    properties: {
      block: { type: "string", description: "Block name by function, short and in capitals, e.g. \"3.3V POWER\"" },
      refs: { type: "array", items: { type: "string" }, minItems: 1, description: "Designators, e.g. [\"U2\", \"C3\", \"C4\"]" },
      sheet: SHEET_ARG,
    },
    required: ["block", "refs"],
  },
  run: (project, input) => {
    const name = cleanBlockName(String(input.block))
    if (!name) return fail(project, "Give the block a name")
    const found = componentsByRef(project, (input.refs as string[]).map((r) => r.trim()).filter(Boolean))
    if (typeof found === "string") return fail(project, found)
    if (!found.length) return fail(project, "Give at least one designator")
    const ids = found.map((c) => c.id)
    const target = findBlock(project, name)
    const moved = found.filter((c) => {
      const from = blockOf(project, c.id)
      return from && from.id !== target?.id
    })
    const next = target ? addToBlock(project, target.id, ids) : createBlock(project, name, ids).project
    const block = findBlock(next, name)!
    const refOf = new Map(next.components.map((c) => [c.id, c.ref]))
    const refsIn = (ids: string[]) => [...new Set(ids.map((id) => refOf.get(id)))].join(", ")
    const from = moved.length ? ` Moved out of their old blocks: ${[...new Set(moved.map((c) => `${c.ref} (${blockOf(project, c.id)!.name})`))].join(", ")}.` : ""
    return ok(
      next,
      `Block ${block.name} holds ${refsIn(block.components)}.${from}`,
      `Grouped ${[...new Set(found.map((c) => c.ref))].join(", ")} into ${block.name}`,
    )
  },
}

const editBlockTool: ToolSpec = {
  name: "edit_block",
  description:
    "Rename a schematic block, move it whole, take components out of it, or ungroup it: the block goes and its components stay where they are, in no block. move_by shifts the block's parts with the wires, labels, ports and drawings inside its frame, as dragging its title does; wires to parts outside stretch.",
  input_schema: {
    type: "object",
    properties: {
      block: { type: "string", description: "The block's name now" },
      sheet: SHEET_ARG,
      new_name: { type: "string" },
      move_by: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
        description: "Shift the whole block by x and y schematic units (y up)",
      },
      remove_refs: { type: "array", items: { type: "string" }, description: "Components to take out of the block" },
      ungroup: { type: "boolean" },
    },
    required: ["block"],
  },
  run: (project, input) => {
    const block = findBlock(project, String(input.block))
    if (!block) return fail(project, `No block ${String(input.block)}. Blocks: ${blockNames(project)}`)
    if (input.ungroup === true) {
      return ok(deleteBlocks(project, [block.id]), `Ungrouped ${block.name}; its components stay where they are.`, `Ungrouped ${block.name}`)
    }
    let next = project
    const changes: string[] = []
    if (typeof input.new_name === "string") {
      if (!cleanBlockName(input.new_name)) return fail(project, "new_name is empty")
      next = renameBlock(next, block.id, input.new_name)
      changes.push(`renamed to ${next.blocks!.find((b) => b.id === block.id)!.name}`)
    }
    if (input.move_by) {
      const by = input.move_by as { x: number; y: number }
      const delta = { x: snapSch(by.x), y: snapSch(by.y) }
      if (!delta.x && !delta.y) {
        // Nothing to move: what an assistant asking for no move wants is where the frame is.
        const frame = blockFrames(next).find((f) => f.id === block.id)?.box
        changes.push(`not moved${frame ? `; its frame is x ${frame.minX} to ${frame.maxX}, y ${frame.minY} to ${frame.maxY}` : ""}`)
      } else {
        // Checked as a drag of the block's title is: a move that would join or cut nets changes nothing.
        const held = contentsOf(next, [block.id])
        const moved = dragSelection(next, held, delta, { conn: getConnectivity })
        if (!moved.ok) return fail(project, moved.message)
        next = updateDrawings(moved.project, held.drawings, (d) => moveDrawing(d, delta))
        const frame = blockFrames(next).find((f) => f.id === block.id)?.box
        changes.push(`moved by (${delta.x}, ${delta.y})${frame ? `, its frame now x ${frame.minX} to ${frame.maxX}, y ${frame.minY} to ${frame.maxY}` : ""}`)
      }
    }
    if (Array.isArray(input.remove_refs) && input.remove_refs.length) {
      const found = componentsByRef(project, (input.remove_refs as string[]).map((r) => r.trim()).filter(Boolean))
      if (typeof found === "string") return fail(project, found)
      const outside = found.filter((c) => !block.components.includes(c.id))
      if (outside.length) return fail(project, `${outside.map((c) => c.ref).join(", ")} ${outside.length > 1 ? "aren't" : "isn't"} in ${block.name}`)
      next = removeFromBlocks(next, found.map((c) => c.id))
      const gone = !next.blocks?.some((b) => b.id === block.id)
      changes.push(`took out ${[...new Set(found.map((c) => c.ref))].join(", ")}${gone ? ", which left it empty, so it is gone" : ""}`)
    }
    if (!changes.length) return fail(project, "Give new_name, move_by, remove_refs or ungroup")
    const text = `Block ${block.name}: ${changes.join("; ")}`
    return ok(next, `${text}.`, text)
  },
}

const searchPartsTool: ToolSpec = {
  name: "search_parts",
  description:
    "Search this project's own parts and the library of basic parts by name, function, MPN, value or package (e.g. \"10k 0603\", \"mosfet\", \"6 pin header\"). The library has no chips or modules: find_part finds those. Returns part ids, pins, footprints and default properties, plus the properties and footprint the query named (suggested_props, suggested_footprint) to pass to add_component. An empty query lists every part.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search terms" } },
    required: ["query"],
  },
  run: (project, input) => {
    const query = String(input.query ?? "")
    const own = projectPartDefs(project)
    if (!query.trim()) {
      const all = searchLibrary("", own).map((h) => `${h.part.id}: ${h.part.name} (${h.part.category})`)
      return ok(project, all.join("\n"), `Listed ${all.length} parts`)
    }
    const hits = searchLibrary(query, own).slice(0, 12)
    if (!hits.length) {
      return ok(
        project,
        `No parts match "${query}". The library has basic parts only: for a specific part (a chip, a regulator, a module), call find_part, or create_part with its name.`,
        `No parts for "${query}"`,
      )
    }
    const rows = hits.map(({ part: p, props, footprint }) => ({
      part_id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      ...(p.custom && { project_part: true }),
      pins: pinList(p.pins),
      footprints: p.footprints,
      default_props: p.defaultProps,
      ...(props && { suggested_props: props }),
      ...(footprint && { suggested_footprint: footprint }),
    }))
    const partial = hits[0].partial
      ? `No part matches every word of "${query}"; these are the closest. If none fits, find the specific part with find_part, or create_part with its name.\n`
      : ""
    return ok(project, partial + JSON.stringify(rows), `Searched parts for "${query}" (${hits.length} found)`)
  },
}

/** What to do about a footprint whose pads aren't numbered like a part's pins. */
const MISFIT_ADVICE = "Pick one whose pads are numbered like the part's pins, or make the part again on that land with create_part (footprint or land, pad_alias for pads that share a pin) and replaces, which maps each pin to its pad."

/** What to do about a footprint string whose options the footprinter ignores, where the part is already made. */
const OWN_LAND_ADVICE = "Use only the options it takes; for a land no footprint string draws, make the part with create_part and land, pad by pad."

const MIRRORS = ["x", "y", "none"]

/** `mirror` as the model it is: "x", "y", or none. */
const mirrorOf = (v: unknown): Mirror | undefined => (v === "x" || v === "y" ? v : undefined)

/** The component with these changes to how it lies on the sheet, no key left behind for what is not set. */
function withSymbol(project: Project, id: string, patch: { unit?: number; bodyStyle?: number; mirror?: Mirror }): Project {
  if (!patch.mirror && !(patch.unit && patch.unit > 1) && !(patch.bodyStyle && patch.bodyStyle > 1)) return project
  return {
    ...project,
    components: project.components.map((c) => {
      if (c.id !== id) return c
      const next: ComponentInstance = { ...c, sch: { ...c.sch, ...(patch.mirror ? { mirror: patch.mirror } : {}) } }
      if (patch.unit && patch.unit > 1) next.unit = patch.unit
      if (patch.bodyStyle && patch.bodyStyle > 1) next.bodyStyle = patch.bodyStyle
      return next
    }),
  }
}

const addComponentTool: ToolSpec = {
  name: "add_component",
  description:
    "Add a part to the schematic. Position is in schematic units on a 0.1 grid (y up); omit x/y to place it in free space right of the existing parts and their labels (a part dropped onto another part's pins is refused). Returns the new reference designator. To add another unit of a part already on the sheet, pass its ref, the same part_id and the unit.",
  input_schema: {
    type: "object",
    properties: {
      part_id: { type: "string", description: "Part id from search_parts, e.g. \"resistor\"" },
      ref: { type: "string", description: "Optional designator, e.g. \"R5\"" },
      sheet: SHEET_ARG,
      props: {
        type: "object",
        description: "Properties such as {\"resistance\": \"4.7k\"} or {\"net\": \"3V3\"} for power ports",
        additionalProperties: { type: "string" },
      },
      footprint: { type: "string", description: "Footprint name, e.g. \"0805\"; defaults to the part's first footprint" },
      x: { type: "number" },
      y: { type: "number" },
      rotation: { type: "integer", enum: ROTATIONS },
      unit: { type: "integer" },
      body_style: { type: "integer" },
      mirror: { type: "string", enum: MIRRORS },
    },
    required: ["part_id"],
  },
  run: (project, input) => {
    const asked = String(input.part_id)
    // A project part named by its name or part number, when that is one part: assistants guessed ids from names (`ws2812b_v5_...`).
    const byName = findPart(asked) ? [] : (project.parts ?? []).filter((p) => [p.name, p.props?.mpn].some((n) => n && n.toLowerCase() === asked.trim().toLowerCase()))
    const partId = byName.length === 1 ? byName[0].id : asked
    const part = findPart(partId)
    if (!part) return fail(project, `Unknown part "${partId}".${partSuggestions(project, partId)}`)
    const props = stringProps(input.props)
    if (!props) return fail(project, "props must be an object of string values")
    const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : undefined
    const existing = ref ? findByRef(project, ref) : undefined
    const existingPart = existing && findPart(existing.partId)
    // A designator in use is another unit's, when the part is the same and several units are meant.
    const anotherUnit = !!existing && !!existingPart && unitCount(existingPart) > 1 && (existingPart.unitOf ?? existingPart.id) === (part.unitOf ?? part.id) && input.unit !== undefined
    if (ref && existing && !anotherUnit) {
      return fail(project, `Designator ${ref} is already used${input.unit !== undefined && existingPart && unitCount(existingPart) > 1 ? `, by ${existingPart.name}; to add a unit of it give its part_id "${existingPart.unitOf ?? existingPart.id}"` : ""}`)
    }
    const footprint = typeof input.footprint === "string" && input.footprint.trim() ? input.footprint.trim() : undefined
    if (footprint && !part.footprints.includes(footprint) && !isValidFootprint(footprint)) {
      return fail(project, `Unknown footprint "${footprint}". ${part.name} supports: ${part.footprints.join(", ") || "none"}`)
    }
    const ignored = footprint && !part.footprints.includes(footprint) && footprintOptionProblem(footprint)
    if (ignored) return fail(project, `${ignored} ${OWN_LAND_ADVICE}`)
    const misfit = footprint && footprintPinProblem(part, footprint)
    if (misfit) return fail(project, `${misfit} ${MISFIT_ADVICE}`)
    const units = unitCount(part)
    const unit = typeof input.unit === "number" ? input.unit : 1
    if (unit < 1 || unit > units) return fail(project, `${part.name} has ${units} unit${units === 1 ? "" : "s"}, so there is no unit ${unit}`)
    const style = typeof input.body_style === "number" ? input.body_style : 1
    if (style < 1 || style > bodyStyleCount(part)) return fail(project, `${part.name} has ${bodyStyleCount(part)} body style${bodyStyleCount(part) === 1 ? "" : "s"}, so there is no style ${style}`)
    const mirror = mirrorOf(input.mirror)
    const rot = (typeof input.rotation === "number" ? input.rotation : 0) as Rotation
    // The room to look for is the one this unit's symbol takes, not the first unit's.
    const looked = part.units ? { ...part, units: undefined, symbol: symbolOf(part, { unit, bodyStyle: style }) } : part
    const spot = freeSchematicSpot(project, looked, rot)
    const x = typeof input.x === "number" ? snapSch(input.x) : spot.x
    const y = typeof input.y === "number" ? snapSch(input.y) : spot.y

    let next: Project
    let component: ComponentInstance
    if (anotherUnit) {
      const added = addUnit(project, existing!.id, unit, { x, y })
      if (!added.ok) return fail(project, added.message)
      next = added.project
      // addUnit places the symbol upright; turn and mirror it where it stands, so the check below sees what will be drawn.
      next = {
        ...next,
        components: next.components.map((c) => (c.id === added.component.id ? { ...c, sch: { ...c.sch, rot, ...(mirror ? { mirror } : {}) }, ...(style > 1 ? { bodyStyle: style } : {}) } : c)),
      }
      component = next.components.find((c) => c.id === added.component.id)!
    } else {
      const made = addComponent(project, partId, { ref, props, footprint, sch: { x, y, rot } })
      next = withSymbol(made.project, made.component.id, { unit, bodyStyle: style, mirror })
      component = next.components.find((c) => c.id === made.component.id)!
    }

    // A part dropped onto drawn pins, wires or labels would join their nets without anyone asking.
    const before = getConnectivity(project)
    const pinRefs = schematicPins(component).map((p) => ({ componentId: component.id, pin: p.pin }))
    const own = new Set(pinRefs.map((r) => pinGroup(before, r)))
    const rail = part.powerNet ? [`net:${component.props.net?.trim() || part.powerNet}`] : []
    const joined = schematicEditProblems(project, next, before, getConnectivity(next), new Set([...own, ...rail, ...(anotherUnit ? aliasGroups(next, before, pinRefs) : [])]))
    if (joined.length) {
      return fail(
        project,
        `Not added: ${part.name} at (${x}, ${y}) would connect ${joined.join("; ")}. Pick another x/y, or leave them out to place it in free space.`,
      )
    }
    const box = schematicBounds(component)
    const over = project.components.filter((c) => boxesOverlap(box, schematicBounds(c))).map((c) => c.ref)
    const note = over.length ? ` Note: it overlaps ${over.join(", ")}; update_component can move it (a move that would join nets is refused, and says where it fits).` : ""
    if (units < 2 && style < 2 && !mirror) {
      return ok(
        next,
        `Added ${component.ref} (${part.name}) at (${x}, ${y}). Pins: ${pinList(part.pins)}${note}`,
        `Added ${component.ref} (${describePart(component)})`,
      )
    }
    // A part with several units: the pins of this symbol, and the units still to place.
    const group = unitGroup(next, component)
    const placed = new Set(group.map((c) => c.unit ?? 1))
    const missing = Array.from({ length: units }, (_, i) => i + 1).filter((u) => !placed.has(u))
    const drawn = symbolOf(part, component).ports.map((p) => p.pin)
    const shown = part.pins.filter((p) => drawn.includes(p.number))
    const left = missing.length ? ` Units not on the sheet yet: ${missing.join(", ")}; add each with add_component part_id "${part.unitOf ?? part.id}", ref "${component.ref}" and unit.` : ""
    const what = units > 1 ? `unit ${unit} of ${component.ref}` : component.ref
    return ok(
      next,
      `Added ${what} (${part.name}) at (${x}, ${y}). Pins on this symbol: ${pinList(shown)}.${left}${note}`,
      `Added ${what} (${describePart(component)})`,
    )
  },
}

/** update_component's flag inputs: the input name, the flag it sets, and whether the input says the opposite of the flag (`in_bom` true clears `excludeFromBom`). */
const FLAG_INPUTS: [string, "dnp" | "excludeFromBom" | "notOnBoard" | "excludeFromPos" | "boardOnly" | "virtual", boolean][] = [
  ["dnp", "dnp", false],
  ["in_bom", "excludeFromBom", true],
  ["on_board", "notOnBoard", true],
  ["in_pos_files", "excludeFromPos", true],
  ["board_only", "boardOnly", false],
  ["virtual", "virtual", false],
]
const FLAG_NAMES: Record<string, string> = { dnp: "do not populate", in_bom: "in the BOM", on_board: "on the board", in_pos_files: "in the position file", board_only: "board only", virtual: "virtual" }

const updateComponentTool: ToolSpec = {
  name: "update_component",
  description:
    "Change a component's properties, footprint, designator, rotation or schematic position. Moving or rotating keeps the part's connections: wires stretch, and the net labels, power symbols and branch wires that hang off its pins alone go with it. A move, rotation or net change that would join nets nobody asked to join, park a pin under another net's wire, or cut any pin off its net is refused and changes nothing; the reply names the pins and says where the part does fit. It also takes mirror (any part) and a part's flags: dnp, in_bom, on_board (false also removes its unlocked traces), in_pos_files, board_only, virtual; on a KiCad symbol it takes unit, body_style, pin_function and fields too, and placed_unit picks the symbol of a part with several units.",
  input_schema: {
    type: "object",
    properties: {
      ref: { type: "string" },
      new_ref: { type: "string" },
      props: { type: "object", additionalProperties: { type: "string" } },
      footprint: { type: "string" },
      rotation: { type: "integer", enum: ROTATIONS },
      x: { type: "number" },
      y: { type: "number" },
      placed_unit: { type: "integer" },
      unit: { type: "integer" },
      body_style: { type: "integer" },
      mirror: { type: "string", enum: MIRRORS },
      dnp: { type: "boolean" },
      in_bom: { type: "boolean" },
      on_board: { type: "boolean" },
      in_pos_files: { type: "boolean" },
      board_only: { type: "boolean" },
      virtual: { type: "boolean" },
      classes: { type: "array", items: { type: "string" }, description: "Component classes (placement areas pick parts by them)" },
      pin_function: { type: "object", properties: { pin: { type: "string" }, function: { type: "string" } }, required: ["pin", "function"] },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, hidden: { type: "boolean" }, x: { type: "number" }, y: { type: "number" }, angle: { type: "integer", enum: [0, 90] }, size: { type: "number" } },
          required: ["name"],
        },
      },
    },
    required: ["ref"],
  },
  run: (project, input) => {
    const picked = pickSymbol(project, input)
    if (typeof picked === "string") return fail(project, picked)
    const c = picked
    const part = findPart(c.partId)
    const props = stringProps(input.props)
    if (!props) return fail(project, "props must be an object of string values")
    const changes: string[] = []
    let next = project
    const group = unitGroup(project, c)

    // How this symbol is drawn: its unit, body style and the function of a pin.
    const variant: Parameters<typeof setSymbolVariant>[2] = {}
    if (typeof input.unit === "number" && input.unit !== (c.unit ?? 1)) {
      const taken = group.find((x) => x.id !== c.id && (x.unit ?? 1) === input.unit)
      if (taken) return fail(project, `Unit ${input.unit} of ${c.ref} is already on the sheet; units placed: ${listUnits(group)}`)
      variant.unit = input.unit
      changes.push(`now unit ${input.unit}`)
    }
    if (typeof input.body_style === "number" && input.body_style !== (c.bodyStyle ?? 1)) {
      variant.bodyStyle = input.body_style
      changes.push(`body style ${input.body_style}`)
    }
    const fn = input.pin_function as { pin: string; function: string } | undefined
    if (fn) {
      const pin = part?.pins.find((p) => p.number === fn.pin) ?? part?.pins.find((p) => p.name.toLowerCase() === String(fn.pin).toLowerCase())
      if (!pin) return fail(project, `${c.ref} has no pin ${fn.pin}`)
      if (!pin.alternates?.length) return fail(project, `Pin ${pin.number} of ${c.ref} has one function only`)
      const wanted = fn.function.trim()
      const reset = wanted === "" || wanted.toLowerCase() === "default"
      const alternate = reset ? null : pin.alternates.find((a) => a.name.toLowerCase() === wanted.toLowerCase())?.name
      if (alternate === undefined) return fail(project, `Pin ${pin.number} of ${c.ref} has no function ${wanted}. Its functions: ${pin.alternates.map((a) => a.name).join(", ")}, or default`)
      variant.pinAlt = { pin: pin.number, alternate }
      changes.push(`pin ${pin.number} ${alternate ? `is ${alternate}` : "back to its own function"}`)
    }
    if (Object.keys(variant).length) {
      const r = setSymbolVariant(next, c.id, variant)
      if (!r.ok) return fail(project, r.message)
      next = r.project
    }

    const rotation = typeof input.rotation === "number" && input.rotation !== c.sch.rot ? (input.rotation as Rotation) : null
    let moveTo: { x: number; y: number } | null = null
    if (typeof input.x === "number" || typeof input.y === "number") {
      const x = typeof input.x === "number" ? snapSch(input.x) : c.sch.x
      const y = typeof input.y === "number" ? snapSch(input.y) : c.sch.y
      if (x !== c.sch.x || y !== c.sch.y) {
        moveTo = { x, y }
        next = moveComponent(next, c.id, moveTo)
        changes.push(`moved to (${x}, ${y})`)
      }
    }

    const patch: Parameters<typeof updateComponent>[2] = {}
    if (Object.keys(props).length) {
      patch.props = { ...c.props, ...props }
      changes.push(Object.entries(props).map(([k, v]) => `${k}=${v}`).join(", "))
    }
    if (typeof input.footprint === "string" && input.footprint.trim()) {
      const fp = input.footprint.trim()
      if (!part?.footprints.includes(fp) && !isValidFootprint(fp)) {
        return fail(project, `Unknown footprint "${fp}". ${part?.name} supports: ${part?.footprints.join(", ")}`)
      }
      const ignored = !part?.footprints.includes(fp) && footprintOptionProblem(fp)
      if (ignored) return fail(project, `${ignored} ${OWN_LAND_ADVICE}`)
      const misfit = part && footprintPinProblem(part, fp)
      if (misfit) return fail(project, `Nothing was changed. ${misfit} ${MISFIT_ADVICE}`)
      patch.footprint = fp
      changes.push(`footprint ${fp}`)
    }
    if (input.classes !== undefined) {
      if (!Array.isArray(input.classes) || !input.classes.every((n) => typeof n === "string")) return fail(project, "classes must be a list of names")
      const names = [...new Set((input.classes as string[]).map((n) => n.trim()).filter(Boolean))]
      patch.classes = names.length ? names : undefined
      changes.push(names.length ? `classes ${names.join(", ")}` : "no classes")
    }
    // Every unit of a part has its designator.
    const severalUnits = !!part && unitCount(part) > 1
    let newRef: string | null = null
    if (typeof input.new_ref === "string" && input.new_ref.trim() && input.new_ref.trim() !== c.ref) {
      newRef = input.new_ref.trim()
      if (findByRef(project, newRef)) return fail(project, `Designator ${newRef} is already used`)
      changes.push(`renamed to ${newRef}`)
    }
    if (Object.keys(patch).length) next = updateComponent(next, c.id, patch)
    // The units of a part share its properties and its designator.
    if (severalUnits) {
      if (patch.props) for (const x of group) if (x.id !== c.id) next = updateComponent(next, x.id, { props: { ...x.props, ...props } })
    }
    // Every part is renamed the same way, so the board data keyed by a net name made up from its pins follows the new name.
    if (newRef) next = renameReference(next, c.id, newRef)
    if (rotation !== null) {
      next = rotateComponent(next, c.id, rotation)
      changes.push(`rotated to ${rotation}°`)
    }

    // Mirror is set as the symbol has it: take the old one off, then put the new one on.
    let mirrored = false
    if (input.mirror !== undefined) {
      const target = mirrorOf(input.mirror)
      const now = next.components.find((x) => x.id === c.id)?.sch.mirror
      if (target !== now) {
        for (const axis of [now, target]) {
          if (!axis) continue
          const r = mirrorSelection(next, { components: [c.id] }, axis)
          if (!r.ok) return fail(project, r.message)
          next = r.project
        }
        mirrored = true
        changes.push(target ? `mirrored ${target === "x" ? "top to bottom" : "left to right"}` : "mirror taken off")
      }
    }

    // Fields: show or hide one, move it.
    const fields = Array.isArray(input.fields) ? (input.fields as { name: string; hidden?: boolean; x?: number; y?: number; angle?: 0 | 90; size?: number }[]) : []
    if (fields.length) {
      const known = [...new Set([...Object.keys(part?.fieldPlaces ?? {}), ...Object.keys(c.fields ?? {})])]
      if (!known.length) return fail(project, `${c.ref}'s reference and value are part of its symbol: they cannot be hidden or moved`)
      for (const f of fields) {
        const name = known.find((k) => k.toLowerCase() === f.name.trim().toLowerCase())
        if (!name) return fail(project, `${c.ref} has no field ${f.name}. Its fields: ${known.join(", ")}`)
        const was = fieldPlaceOf(c, part!, name)
        const place: Partial<FieldPlace> = {}
        if (f.hidden !== undefined) place.hidden = f.hidden ? true : undefined
        if (f.x !== undefined || f.y !== undefined) {
          place.x = round((f.x ?? c.sch.x + (was?.x ?? 0)) - c.sch.x)
          place.y = round((f.y ?? c.sch.y + (was?.y ?? 0)) - c.sch.y)
        }
        if (f.angle !== undefined) place.angle = f.angle
        if (f.size !== undefined) place.size = f.size
        if (!Object.keys(place).length) continue
        next = setFieldPlace(next, c.id, name, place)
        changes.push(`${name} ${[f.hidden === undefined ? "" : f.hidden ? "hidden" : "shown", f.x !== undefined || f.y !== undefined ? "moved" : "", f.angle !== undefined ? `turned to ${f.angle}°` : "", f.size !== undefined ? `size ${f.size}` : ""].filter(Boolean).join(", ")}`)
      }
    }
    // The part's flags, KiCad's: do not populate, in the BOM, on the board, in the position file, board only, virtual. Each unit of a part carries them.
    const wanted: Record<string, boolean | false> = {}
    for (const [key, flag, inverted] of FLAG_INPUTS) {
      const v = input[key]
      if (typeof v === "boolean") wanted[flag] = inverted ? !v : v
    }
    if (Object.keys(wanted).length) {
      if ((wanted.boardOnly !== undefined || wanted.virtual !== undefined) && !isPhysical(part)) return fail(project, `${c.ref} is not a part on the board, so it is not board only or virtual`)
      const beforeFlags = next
      for (const g of group) next = setFlags(next, g.id, wanted)
      for (const [key, flag, inverted] of FLAG_INPUTS) {
        if (wanted[flag] !== undefined) changes.push(`${FLAG_NAMES[key]} ${(inverted ? !wanted[flag] : wanted[flag]) ? "on" : "off"}`)
      }
      const copper = copperRemovedNote(beforeFlags, next)
      if (copper) changes.push(`left the board: ${copper}`)
    }
    if (!changes.length) return ok(project, `No changes for ${c.ref}`, `No changes for ${c.ref}`)

    // A move, a turn or a new rail can land the part's pins on other nets. Every edit that changes
    // what sits where is checked before and after, like connect, and refused if it joins nets.
    const newRail = part?.powerNet && patch.props ? patch.props.net?.trim() || part.powerNet : null
    const railChanged = !!part?.powerNet && newRail !== (c.props.net?.trim() || part.powerNet)
    const redrawn = mirrored || Object.keys(variant).length > 0
    if (moveTo || rotation !== null || railChanged || redrawn) {
      const before = getConnectivity(project)
      const after = getConnectivity(next)
      const allowed = new Set<string>()
      if (railChanged && newRail) {
        for (const p of schematicPins(c)) allowed.add(pinGroup(before, { componentId: c.id, pin: p.pin }))
        for (const n of before.nets) if (n.name === newRail) allowed.add(n.id)
        allowed.add(`net:${newRail}`)
      }
      const problems = moveProblems(project, next, before, after, allowed, { netsChange: railChanged })
      if (problems.length) {
        const what = [moveTo && `moving ${c.ref} to (${moveTo.x}, ${moveTo.y})`, rotation !== null && `rotating ${c.ref} to ${rotation}°`, redrawn && `changing how ${c.ref} is drawn`, railChanged && `putting ${c.ref} on net ${newRail}`]
          .filter(Boolean)
          .join(" and ")
        const advice = redrawn && !moveTo && rotation === null ? "Move the wires off the pins that change first, or leave the symbol as it is." : suggestFit(project, c, moveTo, rotation, allowed, railChanged)
        return fail(project, `Not changed: ${what}: ${problems.join("; ")}. Nothing was changed. ${advice}`)
      }
      const lost = connectionsLost(project, next, before, after)
      if (lost.length) {
        const note = ` Note: ${lost.slice(0, 3).join("; ")}. Reconnect them with connect.`
        return ok(next, `Updated ${c.ref}: ${changes.join("; ")}.${note}`, `Updated ${c.ref}: ${changes.join("; ")}`)
      }
    }
    return ok(next, `Updated ${c.ref}: ${changes.join("; ")}`, `Updated ${c.ref}: ${changes.join("; ")}`)
  },
}

/** Where a refused move or turn would have fit, tried against the same check; says so when nothing near works. */
function suggestFit(project: Project, c: ComponentInstance, moveTo: { x: number; y: number } | null, rotation: Rotation | null, allowed: ReadonlySet<string>, netsChange: boolean) {
  const before = getConnectivity(project)
  const clean = (n: Project) => moveProblems(project, n, before, getConnectivity(n), allowed, { netsChange }).length === 0
  const turn = (n: Project, rot: Rotation | null) => (rot === null ? n : rotateComponent(n, c.id, rot))
  if (rotation !== null && !moveTo) {
    const other = ROTATIONS.find((r) => r !== c.sch.rot && r !== rotation && clean(turn(project, r as Rotation)))
    if (other !== undefined) return `Rotation ${other} works where it is (checked).`
  }
  const spot = findSafeSpot({
    project,
    id: c.id,
    target: moveTo ?? { x: c.sch.x, y: c.sch.y },
    rot: rotation ?? c.sch.rot,
    build: (at) => turn(moveComponent(project, c.id, at), rotation),
    accepts: clean,
  })
  if (spot) return `It fits at x=${spot.x}, y=${spot.y}${rotation !== null ? ` with rotation ${rotation}` : ""} (checked).`
  return `No spot near it was clear either. Leave ${c.ref} where it is, or remove_component it and add it again where you want it (its wires go with it).`
}

const removeComponentTool: ToolSpec = {
  name: "remove_component",
  description:
    "Delete a component together with the wires and net labels attached only to its pins. Pins of other parts that hung from those wires are reported when they come loose. A part with several units goes with all of them unless placed_unit names one.",
  input_schema: {
    type: "object",
    properties: {
      ref: { type: "string" },
      placed_unit: { type: "integer" },
    },
    required: ["ref"],
  },
  run: (project, input) => {
    const first = findByRef(project, input.ref)
    if (!first) return fail(project, `No component ${String(input.ref)}`)
    const group = unitGroup(project, first)
    let targets = group
    if (input.placed_unit !== undefined) {
      const one = pickSymbol(project, input)
      if (typeof one === "string") return fail(project, one)
      targets = [one]
    }
    const c = partSymbol(targets)
    const pins = targets.flatMap((t) => schematicPins(t).map((p) => p.pos))
    const attached = project.wires.filter((w) => {
      const ends = [w.points[0], w.points[w.points.length - 1]]
      return ends.some((e) => pins.some((p) => samePoint(p, e)))
    })
    const attachedIds = new Set(attached.map((w) => w.id))
    const remaining = project.wires.filter((w) => !attachedIds.has(w.id))
    const orphanLabels = project.labels.filter((l) => {
      const onRemoved = attached.some((w) => w.points.some((p) => samePoint(p, l)))
      const onRemaining = remaining.some((w) => w.points.some((p) => samePoint(p, l)))
      return onRemoved && !onRemaining
    })
    const next = removeItems(project, {
      components: targets.map((t) => t.id),
      wires: [...attachedIds],
      labels: orphanLabels.map((l) => l.id),
    })
    // Taking a part out of a wire others hang from cuts them loose; say so rather than leave it to Checks.
    const lost = connectionsLost(project, next, getConnectivity(project), getConnectivity(next))
    const note = lost.length ? ` Note: ${lost.slice(0, 3).join("; ")}. Reconnect them with connect.` : ""
    if (group.length > 1) {
      const what = targets.length > 1 ? `${c.ref} (all ${targets.length} units)` : `unit ${targets[0].unit ?? 1} of ${c.ref}`
      const stays = targets.length < group.length ? ` Units still on the sheet: ${listUnits(group.filter((x) => !targets.includes(x)))}.` : ""
      return ok(next, `Removed ${what} and ${attached.length} attached wire(s).${stays}${note}`, `Removed ${what} (${describePart(c)})`)
    }
    return ok(next, `Removed ${c.ref} and ${attached.length} attached wire(s).${note}`, `Removed ${c.ref} (${describePart(c)})`)
  },
}

/**
 * Plans a connection on one project. Only the nets of the pins asked for (and the named one) may
 * change; anything else a wire or label lands on is a short nobody asked for, so that way of
 * drawing it is dropped (`plan.allowed` is what may join).
 */
function connectPlanFor(project: Project, refs: PinRef[], netName: string, through?: PinRef) {
  const before = getConnectivity(project)
  const netOf = pinNetNames(project)
  const nameFor = () => {
    // A name someone chose beats one connect made up; a made-up one beats starting another.
    const names = refs.map((r) => netOf(r.componentId, r.pin)).filter((n): n is string => !!n && !n.startsWith("Net-("))
    const existing = names.find((n) => !AUTO_NET_NAME.test(n)) ?? names[0]
    // A project named as KiCad names its nets shows `/SDA` for a net a local label `SDA` names: a label joins it by that text.
    if (existing) return project.netNames ? labelTextFor(before.nets, existing) : existing
    const taken = new Set(before.nets.map((n) => n.name))
    let i = 1
    while (taken.has(`NET${i}`)) i++
    return `NET${i}`
  }
  // `through` is a pin of a net a made-up name belongs to: it is labelled too (its net already carries that name, by no label), with a
  // global label in a project named as KiCad names its nets, so the net keeps the exact name and a later call by that name finds it.
  const plan = planConnect(project, before, refs, {
    netName: project.netNames && netName ? labelTextFor(before.nets, netName) : netName,
    nameFor,
    netOf: (r) => netOf(r.componentId, r.pin),
    ...(through ? { through, labelGlobal: !!project.netNames } : {}),
  })
  return { before, plan }
}

const connectTool: ToolSpec = {
  name: "connect",
  description:
    "Connect pins into one net. Pins are \"REF.PIN\" using a pin number or name (\"R1.2\", \"U1.VCC\"); one-pin parts can be given by ref alone (\"#PWR1\"). With net_name every pin gets a net label of that name (labels and power/ground ports with the same name are the same net, e.g. \"GND\", \"3V3\"). Without net_name, two pins get a drawn wire (or labels when a wire would run over other pins) and three or more get a shared auto-named label. Use net_name for supplies, buses and nets that leave the block; join neighbouring pins on a path (a resistor into a pin, a driver's output to its connector) without it, two at a time, so they are wired. A connect never joins other nets: a label is bent or moved around whatever is in its way, and pins that still cannot be reached are left out and named in the reply, with the rest connected. If no pin can be connected nothing is changed.",
  input_schema: {
    type: "object",
    properties: {
      pins: { type: "array", items: { type: "string" }, minItems: 1 },
      net_name: { type: "string" },
      sheet: SHEET_PROPERTY,
    },
    required: ["pins"],
  },
  run: (project, input) => {
    const specs = (input.pins as string[]).map((s) => s.trim()).filter(Boolean)
    const givenName = typeof input.net_name === "string" ? input.net_name.trim() : ""
    if (specs.length < (givenName ? 1 : 2)) return fail(project, "Give at least two pins, or one pin with net_name")
    const refs: PinRef[] = []
    const bad: string[] = []
    const unplaced: string[] = []
    for (const spec of specs) {
      const r = resolvePin(project, spec)
      if ("ref" in r) refs.push(r.ref)
      else if ("unplaced" in r) unplaced.push(r.unplaced)
      else bad.push(r.unknown)
    }
    if (bad.length || unplaced.length) return fail(project, [bad.length ? `Unknown pin ${bad.join("; ")}` : "", ...unplaced].filter(Boolean).join(". "))
    const unique = refs.filter((r, i) => refs.findIndex((x) => x.componentId === r.componentId && x.pin === r.pin) === i)
    const netOf = pinNetNames(project)
    // A name no label gives (`Net-(R3-Pad2)`, the editor `Net-(R1-2)`) changes as the sheet changes. On a net that has it now, join that
    // net through one of its own pins and label the net with that exact name, so it keeps it; with no net that has it, refuse: a label of it
    // would start another net.
    const netName = givenName
    let through: PinRef | undefined
    if (givenName) {
      const nets = getConnectivity(project).nets
      const existing = nets.find((n) => n.name === givenName && !n.named && !n.label && !n.power)
      if (existing) {
        const asked = unique.map((r) => pinLabel(project, r)).join(", ")
        if (unique.every((r) => existing.pins.some((p) => p.componentId === r.componentId && p.pin === r.pin))) return ok(project, `${asked} already on ${givenName}`, `${asked} already on ${givenName}`)
        through = existing.pins.find((p) => !unique.some((r) => r.componentId === p.componentId && r.pin === p.pin))
        if (!through) return ok(project, `${asked} already on ${givenName}`, `${asked} already on ${givenName}`)
        unique.push(through)
      } else if (isAutoNetName(givenName) && !nets.some((n) => n.name === givenName)) {
        return fail(project, `No net is called ${givenName} now: names nothing gives change as the sheet changes. Read get_design, or connect to a pin of that net.`)
      }
    }
    const labels = unique.map((r) => pinLabel(project, r))

    if (!netName && unique.length === 2) {
      const [a, b] = unique
      const na = netOf(a.componentId, a.pin)
      if (na && na === netOf(b.componentId, b.pin)) {
        return ok(project, `${labels.join(" and ")} are already connected on ${na}`, `${labels.join(", ")} already on ${na}`)
      }
    }

    const { before, plan } = connectPlanFor(project, unique, netName, through)
    const wireNote = plan.wireNote ? ` A drawn wire was not used: ${plan.wireNote}.` : ""
    const reasons = (p: ConnectPlan) => p.failed.map((f) => `${pinLabel(project, f.ref)}: ${f.why}`).join("; ")
    const advice = (p: ConnectPlan) => (p.failed.length ? ` ${nextStep(project, unique, netName, p.failed[0].ref)}` : "")

    if (plan.onNet.length < (netName ? 1 : 2)) {
      return fail(
        project,
        `Did not connect ${labels.join(", ")}${plan.name ? ` on ${plan.name}` : ""}. ${reasons(plan) || plan.wireNote}. Nothing was changed.${advice(plan)}${wireNote && plan.failed.length ? "" : wireNote}`,
      )
    }

    // Belt and braces: the plan was judged against an index of the drawing; judge the result itself.
    const planned = plan.project
    const next = rekeyAutoNets(project, planned)
    const after = getConnectivity(planned)
    const joined = unrequestedMerges(planned, before, after, new Set([...plan.allowed, ...aliasGroups(project, before, unique)]))
    if (joined.length) {
      return fail(project, `Did not connect ${labels.join(", ")}: it would join ${joined.join("; ")}. Nothing was changed.`)
    }

    const finalNet = pinNetNames(next)(plan.onNet[0].componentId, plan.onNet[0].pin)
    // What happened, said as it happened: only when the pin of that net was labelled (a pin left out is named below).
    const joinedNote =
      through && plan.onNet.some((r) => r.componentId === through!.componentId && r.pin === through!.pin)
        ? ` "${givenName}" was a name made up for a net no label names, so the pins were joined to that net through ${pinLabel(project, through)}, which is now labelled ${givenName}${project.netNames ? " (a global label)" : ""} and keeps that name.`
        : ""
    const there = plan.onNet.map((r) => pinLabel(project, r)).join(", ")
    if (plan.failed.length) {
      const text = `Partly connected: ${there} are${finalNet ? ` on ${finalNet}` : " together"}. NOT connected: ${reasons(plan)}.${advice(plan)}${wireNote}`
      return ok(next, text, `Connected ${there}${finalNet ? ` on ${finalNet}` : ""}; ${plan.failed.length} pin(s) left out`)
    }
    return ok(
      next,
      `Connected ${labels.join(", ")}${finalNet ? ` on ${finalNet}` : ""}.${wireNote}${joinedNote}`,
      `Connected ${labels.join(", ")}${finalNet ? ` on ${finalNet}` : ""}`,
    )
  },
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** "2 wires, 1 label and 1 port", or "" for none. */
function wiringList(c: { wires: number; labels: number; ports: number }): string {
  const kinds = [c.wires && plural(c.wires, "wire"), c.labels && plural(c.labels, "label"), c.ports && plural(c.ports, "port")].filter((k): k is string => !!k)
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}` : (kinds[0] ?? "")
}

/** "Deleted 2 wires and 1 label, and cut 1 wire short", or "" for nothing. */
function takenText(all: Taken[]): string {
  const c = all.map(takenCount).reduce((a, b) => ({ wires: a.wires + b.wires, shortened: a.shortened + b.shortened, labels: a.labels + b.labels, ports: a.ports + b.ports }), { wires: 0, shortened: 0, labels: 0, ports: 0 })
  const list = wiringList(c)
  if (!c.shortened) return list && `Deleted ${list}`
  return list ? `Deleted ${list}, and cut ${plural(c.shortened, "wire")} short` : `Cut ${plural(c.shortened, "wire")} short`
}

/**
 * Pins other than `asked` that an edit took off the nets they were on: what was left of each net
 * split in two, or one pin left on no net, as connectionsLost says it. A port the edit deleted is
 * not a pin cut off.
 */
function alsoCut(project: Project, next: Project, asked: Set<string>): string[] {
  const before = getConnectivity(project)
  const after = getConnectivity(next)
  const nowOn = pinNetNames(next)
  const alive = new Set(next.components.map((c) => c.id))
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of before.pinNet) {
    if (asked.has(key) || !alive.has(key.slice(0, key.lastIndexOf(":")))) continue
    byNet.set(netId, [...(byNet.get(netId) ?? []), key])
  }
  const out: string[] = []
  for (const [netId, pins] of byNet) {
    const net = before.nets.find((n) => n.id === netId)
    if (!net || (!net.named && net.pins.length < 2)) continue
    const groups = new Map<string, string[]>()
    for (const key of pins) {
      const g = after.pinNet.get(key) ?? `solo:${key}`
      groups.set(g, [...(groups.get(g) ?? []), key])
    }
    const [main, ...rest] = [...groups.values()].sort((a, b) => b.length - a.length)
    const ref = (key: string) => ({ componentId: key.slice(0, key.lastIndexOf(":")), pin: key.slice(key.lastIndexOf(":") + 1) })
    const lost = rest.length ? rest.flat() : main.filter((key) => !nowOn(ref(key).componentId, ref(key).pin))
    if (lost.length) out.push(`${[...new Set(lost.map((key) => pinLabel(project, ref(key))))].join(", ")} no longer on ${net.name}`)
  }
  return out
}

/** Every island of drawing that reaches no part, gone, except any whose going would cut a pin off (labels of two names on one wire join their nets). */
function removeLoose(project: Project): { project: Project; taken: Taken[]; kept: number } {
  const islands = looseIslands(project)
  const cuts = (a: Project, b: Project) => connectionsLost(a, b, getConnectivity(a), getConnectivity(b)).length > 0
  const all = { wires: islands.flatMap((i) => i.wires), labels: islands.flatMap((i) => i.labels), ports: islands.flatMap((i) => i.ports), pieces: [] }
  const whole = withoutTaken(project, all)
  if (!cuts(project, whole)) return { project: whole, taken: islands, kept: 0 }
  let at = project
  const taken: Taken[] = []
  for (const island of islands) {
    const next = withoutTaken(at, island)
    if (cuts(at, next)) continue
    at = next
    taken.push(island)
  }
  return { project: at, taken, kept: islands.length - taken.length }
}

/**
 * No-connect flags on pins, as the Inspector's pin list sets them (`ComponentInstance.nc`): a pin left
 * open on purpose, which Checks then doesn't report. Users asked Sakura to "put an x on all the unused
 * pins" and got red crosses drawn over the sheet, since no tool set one (November 2026).
 */
const noConnectTool: ToolSpec = {
  name: "set_no_connect",
  description:
    "Mark pins as left unconnected on purpose (a no-connect flag, the cross on the pin), so Checks stops reporting them; clear true takes the flag off. For a chip's unused pins, a connector's spare contacts, a module's pins you don't use. Refused for a pin that is wired to anything: remove_wiring it first.",
  input_schema: {
    type: "object",
    properties: {
      pins: { type: "array", items: { type: "string" }, minItems: 1, description: "Pins as REF.PIN, e.g. [\"U1.5\", \"U1.NC\"]" },
      clear: { type: "boolean", description: "true: take the flags off these pins" },
    },
    required: ["pins"],
  },
  run: (project, input) => {
    const clear = input.clear === true
    const conn = getConnectivity(project)
    const marks = new Map<string, Set<string>>()
    const said: string[] = []
    const refused: string[] = []
    for (const raw of input.pins as string[]) {
      const ref = resolvePinSpec(project, raw)
      if (!ref) {
        refused.push(`${raw} (no such pin)`)
        continue
      }
      const c = project.components.find((x) => x.id === ref.componentId)!
      const net = conn.nets.find((n) => n.id === conn.pinNet.get(pinKey(c.id, ref.pin)))
      if (!clear && net && (net.named || net.pins.length > 1)) {
        refused.push(`${c.ref}.${ref.pin} (on ${net.name})`)
        continue
      }
      const set = marks.get(c.id) ?? new Set(c.nc ?? [])
      if (clear) set.delete(ref.pin)
      else set.add(ref.pin)
      marks.set(c.id, set)
      said.push(`${c.ref}.${ref.pin}`)
    }
    if (!said.length) return fail(project, `No pin was ${clear ? "cleared" : "marked"}: ${refused.join(", ")}. ${clear ? "" : "A pin that is wired is connected, not left open: remove_wiring it first if it should be."}`.trim())
    const next = {
      ...project,
      updatedAt: Date.now(),
      components: project.components.map((c) => {
        const set = marks.get(c.id)
        return set ? { ...c, nc: set.size ? [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : undefined } : c
      }),
    }
    const left = refused.length ? ` Not ${clear ? "cleared" : "marked"}: ${refused.join(", ")}${clear ? "" : ", which are wired"}.` : ""
    return ok(next, `${clear ? "Took the no-connect flag off" : "Marked as not connected"}: ${said.join(", ")}.${left}`, `${clear ? "Cleared" : "Set"} no-connect on ${said.length} pin${said.length === 1 ? "" : "s"}`)
  },
}

const removeWiringTool: ToolSpec = {
  name: "remove_wiring",
  description:
    "Delete wiring on the schematic; it never joins nets. pins takes each pin off its net: the wire from the pin to its first junction, label or other pin goes, with labels and power or ground ports on the pin and a label or port that wire leaves on nothing. A wire straight to another pin cuts that pin off too, and the reply says so. loose deletes every wire, label and port that reaches no part's pin (what tidy_schematic says it kept), except drawing that joins two nets by name.",
  input_schema: {
    type: "object",
    properties: {
      pins: { type: "array", items: { type: "string" }, description: '"REF.PIN", as for connect' },
      loose: { type: "boolean" },
      sheet: SHEET_PROPERTY,
    },
  },
  run: (project, input) => {
    const specs = Array.isArray(input.pins) ? input.pins.map((s) => String(s).trim()).filter(Boolean) : []
    const loose = input.loose === true
    if (!specs.length && !loose) return fail(project, "Say what to delete: pins, to take those pins off their nets, or loose true, for the wiring that reaches no part.")
    const refs: PinRef[] = []
    const bad: string[] = []
    const unplaced: string[] = []
    for (const spec of specs) {
      const r = resolvePin(project, spec)
      if ("ref" in r) refs.push(r.ref)
      else if ("unplaced" in r) unplaced.push(r.unplaced)
      else bad.push(r.unknown)
    }
    if (bad.length || unplaced.length) return fail(project, [bad.length ? `Unknown pin ${bad.join("; ")}` : "", ...unplaced].filter(Boolean).join(". "))

    let next = project
    const said: string[] = []
    if (refs.length) {
      let taken = wiringAt(project, refs)
      next = withoutTaken(project, taken)
      // What is left of a wire cut short ends where the cut was, which can be on a pin the wire only
      // passed over (not connected to it) or where another wire's end met its side: that would join
      // them. Deleting whole wires joins nothing, so those wires go whole instead.
      if (taken.pieces.length && unrequestedMerges(next, getConnectivity(project), getConnectivity(next), new Set()).length) {
        taken = { ...taken, pieces: [] }
        next = withoutTaken(project, taken)
      }
      const was = pinNetNames(project)
      const now = pinNetNames(next)
      const where = refs.map((r) => pinLabel(project, r)).join(", ")
      const done = takenText([taken])
      said.push(done ? `${done} at ${where}.` : `Nothing is drawn at ${where}.`)
      for (const r of refs) {
        const pin = pinLabel(project, r)
        const before = was(r.componentId, r.pin)
        const after = now(r.componentId, r.pin)
        if (!before) said.push(`${pin} was on no net.`)
        else if (!after) said.push(`${pin} is off ${before}.`)
        else said.push(`${pin} is still on ${after}: it touches another pin directly, or joins it by its name (a hidden power pin).`)
      }
      const cut = alsoCut(project, next, new Set(refs.map((r) => pinKey(r.componentId, r.pin))))
      if (cut.length) said.push(`Also cut off: ${cut.slice(0, 4).join("; ")}${cut.length > 4 ? `; and ${cut.length - 4} more` : ""}. Reconnect what should stay with connect.`)
    }
    if (loose) {
      const r = removeLoose(next)
      next = r.project
      const done = takenText(r.taken)
      said.push(done ? `${done} that reached no part.` : "No wiring on the sheet reaches no part.")
      if (r.kept) said.push(`Kept ${plural(r.kept, "piece")} that ${r.kept === 1 ? "joins" : "join"} two nets by name: deleting ${r.kept === 1 ? "it" : "them"} would split those nets.`)
    }
    const summary = refs.length ? `Removed wiring at ${refs.map((r) => pinLabel(project, r)).join(", ")}` : "Removed loose wiring"
    return ok(next, said.join(" "), next === project ? "Nothing to remove" : summary)
  },
}

/**
 * What to do about a pin that could not be connected: a spot for its part, found by trying the
 * move and the connection again, or else the honest way out.
 */
function nextStep(project: Project, refs: PinRef[], netName: string, blocked: PinRef) {
  const c = project.components.find((x) => x.id === blocked.componentId)
  if (!c) return ""
  const before = getConnectivity(project)
  const spot = findSafeSpot({
    project,
    id: c.id,
    target: { x: c.sch.x, y: c.sch.y },
    rot: c.sch.rot,
    build: (at) => moveComponent(project, c.id, at),
    accepts: (n) => {
      if (moveProblems(project, n, before, getConnectivity(n), new Set()).length) return false
      return connectPlanFor(n, refs, netName).plan.failed.length === 0
    },
    tries: 8,
  })
  if (spot) return `Moving ${c.ref} to x=${spot.x}, y=${spot.y} with update_component clears it (checked); then connect again.`
  return `No spot near ${c.ref} fixes it. Connect through another pin of that net instead, or remove the part that is in the way.`
}

const runChecksTool: ToolSpec = {
  name: "run_checks",
  description:
    "Run electrical and PCB checks against the design rules: unconnected pins, electrical mistakes (an LED with no series resistor, a two-pin part with both pins on one net, a pin that only reaches a label no other pin has), shorts, clearance, unrouted connections, parts off the board, trace width, drill size and annular ring, hole spacing, copper too near the edge, vias in pads and floating copper; and project parts whose pinout or footprint wasn't built from or checked against supplier data.",
  input_schema: { type: "object", properties: {} },
  run: (project) => {
    const conn = getConnectivity(project)
    const pcb = getPcbAnalysis(project)
    const erc = splitIgnored(getErc(project), project.ignoredChecks)
    const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
    const unplaced = resolvedComponents(project).filter((c) => onBoard(c) && !c.pcb.placed)
    const lines: string[] = []
    // A project from KiCad that ignores KiCad's pin_not_connected rule is not told of open pins, as its Checks panel is not.
    const openPins = unconnectedPinSeverity(project) ? conn.unconnectedPins : []
    if (openPins.length) {
      lines.push(
        `Unconnected pins (${openPins.length}): ${openPins
          .slice(0, 40)
          .map((p) => `${refOf.get(p.componentId)}.${p.name === p.pin ? p.pin : `${p.pin}/${p.name}`}`)
          .join(", ")}`,
      )
    }
    if (erc.active.length) {
      // A project from KiCad gives each finding the severity its project file sets for KiCad's rule; a project drawn here has warnings only.
      if (erc.active.some((f) => f.severity)) {
        lines.push(`Electrical (${erc.active.length}, at the severities the KiCad project sets):`)
        for (const f of erc.active.slice(0, 25)) lines.push(`- ${f.severity ?? "warning"}: ${f.message}`)
      } else {
        lines.push(`Electrical (${erc.active.length} warning(s); they don't block fabrication, but each is likely a mistake):`)
        for (const f of erc.active.slice(0, 25)) lines.push(`- ${f.message}`)
      }
    }
    // Said even when everything else passes, so the model doesn't go looking for them.
    const ignoredNote = erc.ignored.length
      ? `${erc.ignored.length} electrical warning(s) ignored by the user (${erc.ignored.map((f) => f.subject).join(", ")}): don't try to fix those warnings.`
      : ""
    if (unplaced.length) lines.push(`${unplaced.length} part(s) not placed on the PCB yet; layout_pcb places them.`)
    const violations = pcb.violations.filter((v) => !(unplaced.length && (v.kind === "overlap" || v.kind === "outside-board")))
    const counts = new Map<string, number>()
    for (const v of violations) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1)
    if (counts.size) lines.push(`PCB: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`)
    for (const v of violations.filter((x) => x.kind !== "unrouted").slice(0, 25)) lines.push(`- ${v.severity}: ${v.message}`)
    // Which connections, by their pins: a count alone sent Sakura moving parts at random to find the one that was open.
    if (pcb.ratsnest.length && counts.has("unrouted")) {
      const netName = new Map(conn.nets.map((n) => [n.id, n.name]))
      lines.push(`- unrouted: ${openList(project, pcb, pcb.ratsnest.map((r) => ({ net: netName.get(r.netId) ?? r.netId, netId: r.netId, a: r.a, b: r.b })), 15)}`)
    }
    const parts = partFindings(project)
    if (parts.length) {
      lines.push(`Parts (${parts.length}):`)
      for (const f of parts.slice(0, 12)) lines.push(`- ${f.severity}: ${f.message}`)
    }
    if (!lines.length) return ok(project, ["All checks pass.", ignoredNote].filter(Boolean).join(" "), "Checks pass")
    if (ignoredNote) lines.push(ignoredNote)
    const errors = violations.filter((v) => v.severity === "error").length
    const partErrors = parts.filter((f) => f.severity === "error").length
    return ok(
      project,
      lines.join("\n"),
      `Checks: ${openPins.length} unconnected pin(s), ${errors} PCB error(s)${erc.active.length ? `, ${erc.active.length} electrical warning(s)` : ""}${parts.length ? `, ${parts.length} part warning(s)${partErrors ? ` (${partErrors} pinout error(s))` : ""}` : ""}`,
    )
  },
}

/**
 * What layout and routing say when the only parts the sheet has are symbols with no footprint (a schematic
 * imported without its board): they cannot be placed, so neither tool has anything to do, and both say
 * why and what to do. Null for every other design.
 */
export function noFootprintAdvice(project: Project): string | null {
  const bare = project.components.filter((c) => {
    const part = findPart(c.partId)
    return !!part && isSchematicPart(part) && !isPhysical(part) && !part.unitOf
  })
  if (!bare.length || resolvedComponents(project).some((c) => onBoard(c))) return null
  return `No part has a footprint yet (${bare.length} part${bare.length > 1 ? "s" : ""} came from a KiCad schematic imported without its board), so there is nothing to place or route. Import the .kicad_pcb together with the schematic, or ask the user which footprints the parts take.`
}

/**
 * What layout and routing say when every part that has a footprint is marked not on the board (`on_board` false):
 * there is nothing to place. Null when some footprinted part is on the board, or none has a footprint.
 */
export function noneOnBoardAdvice(project: Project): string | null {
  const footprinted = resolvedComponents(project).filter((c) => !!c.footprint && isPhysical(findPart(c.partId)))
  if (!footprinted.length || footprinted.some((c) => onBoard(c))) return null
  return `No part is on the board: all ${footprinted.length} part${footprinted.length > 1 ? "s" : ""} with a footprint are marked not on the board (on_board false). Set on_board true with update_component for the parts that belong on it.`
}

const layoutPcbTool: ToolSpec = {
  name: "layout_pcb",
  description:
    "Place components on the PCB, decoupling capacitors beside the supply pins they serve and a switching regulator's or LDO's input, output, inductor, bootstrap and feedback parts at its pins. By default only parts not yet placed; relayout_all re-packs every part that isn't locked, clears unlocked traces and vias, and stitches the copper pours again.",
  input_schema: { type: "object", properties: { relayout_all: { type: "boolean" } } },
  run: (project, input) => {
    const all = input.relayout_all === true
    const next = all ? repackPcb(project) : autoPlacePcb(project)
    const old = new Map(project.components.map((c) => [c.id, c.pcb]))
    const moved = new Set(next.components.filter((c) => JSON.stringify(c.pcb) !== JSON.stringify(old.get(c.id))).map((c) => c.id))
    if (!moved.size) {
      const advice = noFootprintAdvice(project) ?? noneOnBoardAdvice(project)
      if (advice) return fail(project, advice)
    }
    if (!moved.size) return ok(project, all ? "No part can move: every part is locked or held by locked traces." : "Every part is already placed on the PCB.", "PCB already laid out")
    const b = next.board
    const outside = getPcbAnalysis(next).violations.filter((v) => v.kind === "outside-board").length
    const hint = outside ? ` ${outside} part(s) did not fit on the ${b.width}x${b.height} mm board: tell the user, and enlarge it with set_board only if they say its size may change.` : ""
    // X20: parts that do not sit in the placement area that holds them (an area too small for them, or a part locked outside it).
    const out = placementProblems(next).map((p) => p.component.ref)
    const areaHint = out.length ? ` ${out.length} part(s) are outside their placement area (${out.slice(0, 8).join(", ")}${out.length > 8 ? " and more" : ""}): make it bigger with set_pour and its id, or unlock them.` : ""
    const caps = decouplingSummary(next, moved)
    const capNote = caps.total ? ` ${caps.near} of ${caps.total} decoupling capacitor(s) placed within 2 mm of their chip's supply pin.` : ""
    const stages = stageGaps(next)
      .map((s) => `${s.chipRef} ${s.kind} stage: ${s.gaps.slice(0, 6).map((g) => `${g.label} ${g.gap.toFixed(1)} mm`).join(", ")}.`)
      .join(" ")
    const stageNote = stages ? ` ${stages} Fine-tune with place_parts.` : ""
    const copper = repackCopper(project, next)
    const clearNote = copper.traces || copper.vias ? " Unlocked traces and vias were cleared; route again with route_pcb." : ""
    const stitchNote = copper.stitchedBefore || copper.stitchedAfter ? ` Pour stitching vias were placed again on the new layout (${copper.stitchedBefore} before, ${copper.stitchedAfter} now).` : ""
    return ok(next, `Placed ${moved.size} part(s) on the ${b.width}x${b.height} mm board.${capNote}${stageNote}${hint}${areaHint}${clearNote}${stitchNote}`, `Placed ${moved.size} part(s) on the PCB`)
  },
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** What `get_design` says of a board's outline: nothing for a rectangle; its edge and cutouts as text, and when it is not closed. */
function outlineReport(b: Project["board"]) {
  if (!b.outline) return {}
  const state = outlineState(b)
  const cuts = cutoutTexts(b)
  return {
    outline: edgeText(b) || undefined,
    ...(cuts.length ? { cutouts: cuts.map((c) => c.text) } : {}),
    ...(state !== "closed" ? { outline_state: state === "missing" ? "missing: the board has no outline, so it cannot be fabricated" : "not closed: an edge ends in the open, so it cannot be fabricated" } : {}),
  }
}

/** Where the board is, for a refusal about a place on it: x and y in mm, as get_design and add_cutouts use them. */
function boardExtent(project: Project): string {
  const pts = explicitPaths(project).flatMap((p) => flattenPath(p))
  if (!pts.length) return `the board is ${project.board.width} by ${project.board.height} mm`
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const r = (n: number) => Math.round(n * 100) / 100
  return `the board spans x ${r(Math.min(...xs))} to ${r(Math.max(...xs))} and y ${r(Math.min(...ys))} to ${r(Math.max(...ys))} mm`
}

/** The outline edits of set_board, or the sentence that says why they cannot be made. */
function shapeBoard(project: Project, input: Record<string, unknown>): { project: Project; changed: string[] } | string {
  let next = project
  const changed: string[] = []
  // Cutouts are removed by the numbers the board had when the call was made, before a new outline replaces its paths.
  if (input.remove_cutouts !== undefined) {
    const list = input.remove_cutouts
    if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n))) return "remove_cutouts must be whole numbers"
    const cuts = cutoutTexts(next.board)
    if (list.some((n) => n < 0 || n >= cuts.length)) return cuts.length ? `remove_cutouts counts from 0 to ${cuts.length - 1}, as get_design lists the cutouts` : `The board has no cutouts to remove (${boardExtent(next)})`
    const gone = new Set(list.map((n) => cuts[n].path))
    next = setOutlinePaths(
      next,
      next.board.outline!.paths.filter((_, i) => !gone.has(i)),
    )
    changed.push(`${gone.size} cutout${gone.size === 1 ? "" : "s"} removed`)
  }
  if (input.outline !== undefined) {
    if (typeof input.outline !== "string") return "outline must be text, or \"rect\""
    if (input.outline.trim().toLowerCase() === "rect") {
      next = resetOutline(next)
      changed.push("rectangle outline")
    } else {
      const parsed = parseOutlineText(input.outline)
      if ("error" in parsed) return parsed.error
      const paths = joinPaths(parsed.paths)
      if (!paths.some((p) => p.closed)) return "The outline needs at least one closed shape: end it with Z, or bring its end back to its start"
      const crossing = outlineCrossingProblem(paths)
      if (crossing) return crossing
      next = setOutlinePaths(next, paths)
      changed.push(`outline of ${paths.length} shape${paths.length === 1 ? "" : "s"}`)
    }
  }
  if (input.add_cutouts !== undefined) {
    if (typeof input.add_cutouts !== "string") return "add_cutouts must be text"
    const parsed = parseOutlineText(input.add_cutouts)
    if ("error" in parsed) return parsed.error
    const loops = parsed.paths.filter((p) => p.closed)
    if (loops.length !== parsed.paths.length) return "A cutout must be a closed shape: end it with Z"
    const g = outlineGeometry({ outline: { paths: explicitPaths(next) } })
    for (const loop of loops) {
      const pts = flattenPath(loop)
      const edges = pts.map((q, i) => [q, pts[(i + 1) % pts.length]] as const)
      if (!g || !g.rings.length || !pts.every((q) => g.contains(q)) || edges.some(([a, c]) => g.nearestToSegment(a, c, 1e-9) <= 1e-9)) return `A cutout must lie wholly inside the board, clear of its edge and of the other cutouts (${boardExtent(next)}; coordinates are absolute, not from a corner)`
    }
    const added = addOutlinePaths(next, loops)
    if (added.crossing) return added.crossing
    next = added.project
    changed.push(`${loops.length} cutout${loops.length === 1 ? "" : "s"} added`)
  }
  return { project: next, changed }
}

/** Copper layers beyond the two, and the via kinds in use: nothing for a plain two-layer board. */
function layersReport(project: Project) {
  const stack = copperLayers(project.board)
  const named = project.board.stack?.copper.some((c) => c.label)
  const kinds: Record<string, number> = {}
  for (const v of project.vias) if (v.kind) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1
  return {
    ...(stack.length > 2 || named ? { copper_layers: stack.map((l) => (project.board.stack?.copper[stack.indexOf(l)]?.label ? `${l}=${project.board.stack.copper[stack.indexOf(l)].label}` : l)) } : {}),
    ...(Object.keys(kinds).length ? { via_kinds: kinds } : {}),
  }
}

const setBoardTool: ToolSpec = {
  name: "set_board",
  description:
    "Set the board: size in mm (width and height together), thickness, corner radius, copper weight, surface finish, mask and silkscreen colours, corner mounting holes. Only the fields given change. Any shape: outline and add_cutouts are text of shapes in mm, y up: M x y (start), L x y, A mx my x y (arc through mx my to the end), O cx cy r (circle), S x1 y1 x2 y2 width (slot), Z (close); a shape inside another is a cutout. outline \"rect\" restores the rectangle; remove_cutouts counts from 0 as get_design lists them.",
  input_schema: {
    type: "object",
    properties: {
      width: { type: "number" },
      height: { type: "number" },
      thickness: { type: "number", enum: BOARD_THICKNESSES, description: "Finished thickness in mm" },
      corner_radius: { type: "number" },
      copper_oz: { type: "integer", enum: [1, 2], description: "Outer copper weight; 2 oz for high current" },
      copper_layers: { type: "integer", description: "Even, 2 to 32; fewer deletes what is on the layers that go" },
      finish: { type: "string", enum: SURFACE_FINISHES.map((f) => f.value) },
      mask_color: { type: "string", description: "Solder mask colour as #rrggbb; green is #1f6b3a" },
      silk_color: { type: "string", description: "Silkscreen colour as #rrggbb" },
      mounting_holes: { type: "string", enum: ["none", ...MOUNTING_HOLE_PRESETS.map((h) => h.id)] },
      outline: { type: "string", description: "The board's shape as text, or \"rect\"" },
      add_cutouts: { type: "string", description: "Cutouts to add, inside the board" },
      remove_cutouts: { type: "array", items: { type: "integer" }, description: "Cutouts to remove, by number" },
    },
  },
  run: (project, input) => {
    const b = { ...project.board }
    const changed: string[] = []
    const shaped = input.outline !== undefined || input.add_cutouts !== undefined || input.remove_cutouts !== undefined
    const ownOutline = !!project.board.outline?.paths.length
    if (ownOutline && input.outline !== "rect" && (input.width !== undefined || input.height !== undefined || input.corner_radius !== undefined || (input.mounting_holes !== undefined && !project.board.outline?.seed))) {
      return fail(project, "The board has an outline of its own, so its size follows it and it has no corner radius or corner holes: pass outline \"rect\" to go back to a rectangle first")
    }
    if (input.width !== undefined || input.height !== undefined) {
      // One side given keeps the other: "make it 60 mm wide" was refused for want of a height (14 times).
      const width = input.width === undefined ? b.width : Number(input.width)
      const height = input.height === undefined ? b.height : Number(input.height)
      if (!(width >= 5 && width <= 500 && height >= 5 && height <= 500)) {
        return fail(project, "Board width and height must be between 5 and 500 mm")
      }
      b.width = round(width, 2)
      b.height = round(height, 2)
      changed.push(`${b.width}x${b.height} mm`)
    }
    if (input.thickness !== undefined) {
      b.thickness = Number(input.thickness)
      changed.push(`${b.thickness} mm thick`)
    }
    if (input.corner_radius !== undefined) {
      const r = Number(input.corner_radius)
      if (!(r >= 0 && r <= Math.min(b.width, b.height) / 2)) return fail(project, "corner_radius must be between 0 and half the board's shorter side")
      b.cornerRadius = round(r, 2)
      changed.push(`${b.cornerRadius} mm corners`)
    }
    let layered: Project | null = null
    if (input.copper_layers !== undefined) {
      const n = Number(input.copper_layers)
      if (!Number.isInteger(n) || n < 2 || n > 32 || n % 2) return fail(project, "copper_layers must be an even whole number from 2 to 32")
      if (n !== copperLayers(project.board).length) {
        const res = setCopperLayerCount(project, n)
        layered = res.project
        changed.push(`${n} copper layers`)
      }
    }
    if (input.copper_oz !== undefined) {
      b.copperWeight = input.copper_oz === 2 ? 2 : 1
      changed.push(`${b.copperWeight} oz copper`)
    }
    if (input.finish !== undefined) {
      b.finish = input.finish as SurfaceFinish
      changed.push(SURFACE_FINISHES.find((f) => f.value === b.finish)!.label)
    }
    for (const [key, field, what] of [["mask_color", "maskColor", "mask"], ["silk_color", "silkColor", "silkscreen"]] as const) {
      const v = input[key]
      if (v === undefined) continue
      if (typeof v !== "string" || !HEX_COLOR.test(v)) return fail(project, `${key} must be a #rrggbb colour`)
      b[field] = v.toLowerCase()
      changed.push(`${what} ${b[field]}`)
    }
    if (input.mounting_holes !== undefined) {
      const preset = MOUNTING_HOLE_PRESETS.find((h) => h.id === input.mounting_holes)
      b.mountingHoles = preset?.holes ?? null
      changed.push(preset ? `${preset.label} mounting holes` : "no mounting holes")
    }
    let next: Project = { ...project, updatedAt: Date.now(), board: b }
    if (layered) next = { ...layered, board: { ...layered.board, ...b, stack: layered.board.stack }, updatedAt: Date.now() }
    if (shaped) {
      const shapedTo = shapeBoard(next, input)
      if (typeof shapedTo === "string") return fail(project, shapedTo)
      next = shapedTo.project
      changed.push(...shapedTo.changed)
    }
    if (!changed.length) return fail(project, "Give at least one board property to change")
    const lost = mountingHoles(project.board).length > 0 && mountingHoles(next.board).length === 0 && !!next.board.mountingHoles
    const lostNote = lost ? " The corner mounting holes were removed with the rectangle; add holes back as parts, or give mounting_holes again once outline is \"rect\"." : ""
    return ok(next, `Board: ${changed.join(", ")}.${lostNote}`, `Board set: ${changed.join(", ")}`)
  },
}

/** The rules a model reads back, in millimetres with the tool's own names. */
function ruleSummary(r: DesignRules, project?: Project) {
  return {
    fab_capability: matchCapability(r)?.id ?? "custom",
    trace_width: r.traceWidth,
    min_trace_width: r.minTraceWidth,
    preferred_widths: r.preferredWidths,
    clearance: r.clearance,
    edge_clearance: r.edgeClearance,
    hole_clearance: r.holeClearance,
    via_diameter: r.viaDiameter,
    via_drill: r.viaDrill,
    min_drill: r.minDrill,
    min_annular_ring: r.minAnnularRing,
    ...(r.minViaDiameter !== undefined ? { min_via_diameter: r.minViaDiameter } : {}),
    via_in_pad: r.viaInPad,
    tent_vias: r.tentVias,
    pour_clearance: r.pourClearance,
    thermal_relief: r.thermalRelief,
    ...(r.thermalGap !== undefined ? { thermal_gap: r.thermalGap } : {}),
    net_widths: r.netWidths,
    ...netClassSummary(r),
    ...(project && r.clearanceRules?.length ? { clearance_rules: clearanceRuleRows(project) } : {}),
  }
}

/** Most nets a class lists in full for the model; a power class on a big board can have hundreds. */
const CLASS_NETS_SHOWN = 24

/**
 * Net classes and the rules that go with them, for a board that has any (a board drawn here has none and says nothing new): each class with
 * only the sizes it sets, in the tool's names, the nets it lists (the first few, with the count) and its patterns. Two nets are checked at
 * the larger of their classes' clearances, and a class's width and via size are what new traces, vias and route_pcb use on its nets.
 */
function netClassSummary(r: DesignRules) {
  const out: Record<string, unknown> = {}
  const classes = r.netClasses ?? []
  if (classes.length) {
    out.net_classes = classes.map((c) => ({
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(c.clearance !== undefined ? { clearance: c.clearance } : {}),
      ...(c.traceWidth !== undefined ? { trace_width: c.traceWidth } : {}),
      ...(c.viaDiameter !== undefined ? { via_diameter: c.viaDiameter } : {}),
      ...(c.viaDrill !== undefined ? { via_drill: c.viaDrill } : {}),
      ...(c.diffPairWidth !== undefined ? { diff_pair_width: c.diffPairWidth } : {}),
      ...(c.diffPairGap !== undefined ? { diff_pair_gap: c.diffPairGap } : {}),
      nets: c.nets.length > CLASS_NETS_SHOWN ? [...c.nets.slice(0, CLASS_NETS_SHOWN), `... ${c.nets.length - CLASS_NETS_SHOWN} more`] : c.nets,
      ...(c.patterns?.length ? { patterns: c.patterns } : {}),
    }))
  }
  const d = r.defaultClass
  if (d) out.default_class = { ...(d.name ? { name: d.name } : {}), ...(d.description ? { description: d.description } : {}), ...(d.diffPairWidth !== undefined ? { diff_pair_width: d.diffPairWidth } : {}), ...(d.diffPairGap !== undefined ? { diff_pair_gap: d.diffPairGap } : {}) }
  if (r.viaSizes?.length) out.via_sizes = r.viaSizes.map((v) => `${v.diameter}/${v.drill}`)
  if (r.minViaDrill !== undefined) out.min_via_drill = r.minViaDrill
  if (r.minClearance !== undefined) out.min_clearance = r.minClearance
  if (r.maskMinWidth !== undefined) out.mask_min_width = r.maskMinWidth
  if (r.pasteRatio !== undefined) out.paste_ratio = r.pasteRatio
  if (r.maxError !== undefined) out.max_error = r.maxError
  return out
}

/** Length rules the tool sets, with the range each accepts in mm. */
const LENGTH_RULES: [string, keyof DesignRules, number, number][] = [
  ["trace_width", "traceWidth", 0.05, 10],
  ["min_trace_width", "minTraceWidth", 0.05, 10],
  ["clearance", "clearance", 0.05, 5],
  ["edge_clearance", "edgeClearance", 0, 5],
  ["hole_clearance", "holeClearance", 0, 5],
  ["via_diameter", "viaDiameter", 0.2, 5],
  ["via_drill", "viaDrill", 0.1, 3],
  ["min_drill", "minDrill", 0.05, 3],
  ["min_annular_ring", "minAnnularRing", 0, 2],
  ["mask_expansion", "maskExpansion", 0, 1],
  ["paste_expansion", "pasteExpansion", -1, 1],
  ["pour_clearance", "pourClearance", 0.05, 5],
  ["pour_min_width", "pourMinWidth", 0.05, 5],
  ["thermal_spoke_width", "thermalSpokeWidth", 0.1, 5],
]

const setRulesTool: ToolSpec = {
  name: "set_design_rules",
  description:
    "Set the board's design rules, lengths in millimetres. fab_capability applies a fab's limits (min trace width, clearance, drill, annular ring, edge and hole clearance) first; the other fields then override single rules. New traces and vias, the autorouter, pours, checks and the Gerbers all follow them. Per-net trace widths stay as they are.",
  input_schema: {
    type: "object",
    properties: {
      fab_capability: { type: "string", enum: FAB_CAPABILITIES.map((f) => f.id), description: FAB_CAPABILITIES.map((f) => `${f.id}: ${f.name}`).join("; ") },
      ...Object.fromEntries(LENGTH_RULES.map(([key]) => [key, { type: "number" }])),
      preferred_widths: { type: "array", items: { type: "number" }, minItems: 1 },
      via_in_pad: { type: "boolean" },
      tent_vias: { type: "boolean" },
      thermal_relief: { type: "string", enum: THERMAL_RELIEF_OPTIONS.map((o) => o.value), description: "relief-tht: spokes on through-hole pads; relief: on every pad; direct: solid" },
      thermal_spokes: { type: "integer", enum: [2, 4] },
      thermal_spoke_angle: { type: "integer", enum: [0, 45] },
      thermal_gap: {
        type: "number",
        description: "The ring round a pad joined to a pour by spokes; the pour clearance by default. Narrow it when pour_clearance is wide, or the ring outgrows the copper round a pad and the spokes reach nothing. 0: back to the default",
      },
    },
  },
  run: (project, input) => {
    let rules = { ...project.rules }
    const changed: string[] = []
    if (input.fab_capability !== undefined) {
      const cap = FAB_CAPABILITIES.find((f) => f.id === input.fab_capability)!
      rules = applyCapability(rules, cap)
      changed.push(`${cap.name} limits`)
    }
    for (const [key, field, min, max] of LENGTH_RULES) {
      if (input[key] === undefined) continue
      const v = Number(input[key])
      if (!(v >= min && v <= max)) return fail(project, `${key} must be between ${min} and ${max} mm`)
      ;(rules[field] as number) = round(v, 4)
      changed.push(`${key} ${v}`)
    }
    if (input.preferred_widths !== undefined) {
      const widths = (input.preferred_widths as number[]).filter((w) => w > 0 && w <= 10)
      if (!widths.length) return fail(project, "preferred_widths needs at least one width above 0")
      rules.preferredWidths = [...new Set(widths.map((w) => round(w, 4)))].sort((a, c) => a - c)
      changed.push(`preferred widths ${rules.preferredWidths.join(", ")}`)
    }
    for (const [key, field] of [["via_in_pad", "viaInPad"], ["tent_vias", "tentVias"]] as const) {
      if (input[key] === undefined) continue
      rules[field] = input[key] === true
      changed.push(`${key} ${rules[field]}`)
    }
    if (input.thermal_relief !== undefined) {
      rules.thermalRelief = input.thermal_relief as DesignRules["thermalRelief"]
      changed.push(`thermal relief ${rules.thermalRelief}`)
    }
    if (input.thermal_spokes !== undefined) rules.thermalSpokes = input.thermal_spokes === 2 ? 2 : 4
    if (input.thermal_spoke_angle !== undefined) rules.thermalSpokeAngle = input.thermal_spoke_angle === 45 ? 45 : 0
    if (input.thermal_spokes !== undefined || input.thermal_spoke_angle !== undefined) changed.push(`${rules.thermalSpokes} spokes at ${rules.thermalSpokeAngle === 45 ? 45 : 90}°`)
    if (input.thermal_gap !== undefined) {
      const v = Number(input.thermal_gap)
      if (v === 0) {
        delete rules.thermalGap
        changed.push("thermal gap back to the pour clearance")
      } else if (!(v >= 0.05 && v <= 5)) return fail(project, "thermal_gap must be between 0.05 and 5 mm, or 0 for the pour clearance")
      else {
        rules.thermalGap = round(v, 4)
        changed.push(`thermal_gap ${v}`)
      }
    }
    if (!changed.length) return fail(project, "Give at least one rule to change")
    if (rules.traceWidth < rules.minTraceWidth) return fail(project, `trace_width ${rules.traceWidth} is below min_trace_width ${rules.minTraceWidth}`)
    if (rules.viaDrill >= rules.viaDiameter) return fail(project, "via_drill must be smaller than via_diameter")
    const next = { ...project, updatedAt: Date.now(), rules }
    const analysis = getPcbAnalysis(next)
    const errors = analysis.violations.filter((v) => v.severity === "error" && v.kind !== "unrouted").length
    const after = errors ? ` The board now has ${errors} check error(s); run_checks lists them.` : ""
    const missed = [...new Set(next.zones.filter((z) => z.net && !z.keepout).map((z) => z.net))].map((net) => pourMissNote(next, analysis, net)).join("")
    return ok(next, `Design rules: ${changed.join(", ")}.${after}${missed}`, `Design rules set: ${changed.join(", ")}`)
  },
}

/**
 * What to tell the model about connections route_pcb left open: each by its pins, and what is left to try. The router has already
 * routed the board several ways (orders, via costs, fine-pitch escapes, a rip-up and repair) and kept the best, and the same layout
 * and rules give the same result, so clearing the routing and running it again only repeats it. What changes the result is the layout
 * near the named pins (a part moved even 0.1 mm), the rules, or drawing the connection by hand. It used to say that connections at
 * fine-pitch pads were "not a shortage of room, so spreading the parts out will not fix it", which on a user's USB-C bridge was wrong:
 * moving one capacitor was what opened the channel.
 */
export function unroutedAdvice(res: AutorouteResult, project?: Project, analysis?: PcbAnalysis): string {
  const fine = Math.min(res.finePitchOpen, res.remaining)
  const rest = res.remaining - fine
  const named = project && analysis && res.open?.length ? `: ${openList(project, analysis, res.open)}` : "."
  const parts = [` ${res.remaining} connection(s) could not be routed${named}`]
  if (res.tries > 1) parts.push(` The router routed the board ${res.tries} ways (in other orders and with other via costs, then a rip-up and repair) and kept the best.`)
  if (fine) {
    const where = ` ${fine} of them end at fine-pitch pads (pads less than 0.7 mm apart, as on a USB-C receptacle or a QFN).`
    if (res.finePitchTried === null) {
      // The retry did not run: the pads leave no room for even a minimum-width trace at these rules, or time ran out.
      parts.push(
        `${where} The fine-pitch retry (escape stubs and thinner traces) did not run to the end: at this clearance and minimum trace width a trace cannot leave those pads, or the time ran out.` +
          " To go on: set_design_rules for a finer fab class (smaller minimum trace width and clearance) if the board's fab can make it, set_clearance_rule with ref for that part alone when its own land puts its pads closer than the board's clearance, or use place_parts to turn the part so its pads face open board.",
      )
    } else {
      parts.push(
        `${where} It tried short escape stubs from those pads and traces down to ${res.finePitchTried} mm, the board's minimum trace width (supply nets and nets with a width set keep theirs away from the pads), escaping in alternate directions.` +
          " What is in the way is copper of other connections beside those pins, so the layout there decides it: use place_parts to move or turn a part at those pins, or a part beside them, even by a few tenths of a millimetre, then route_pcb with clear true; draw_trace the connection from pin to pin; set_design_rules for a finer fab class if the board's fab can make it; or, if none fits, tell the user to route those connections by hand.",
      )
    }
  }
  if (rest) {
    parts.push(` ${rest} other connection(s) may be short of room: move parts apart with place_parts (or, if the user allows a bigger board, set_board), then route_pcb with clear true; or route_pcb nets [those nets] for them alone.`)
  }
  parts.push(" Do not clear_routing and run route_pcb again on the same layout: the same layout and rules give the same result, so change the layout, the rules or the board first.")
  return parts.join("")
}

/**
 * What to say about nets routed narrower than their width: where, by the pins of each connection and the stretch that is thin. The router
 * holds such a net at its width wherever it fits and necks down only for the stretch that has no room (a neck out of a pad smaller than the
 * width, or out of a fine-pitch row, is none), and it has already tried other orders, so routing it first changes nothing; drawing that
 * stretch at the width, or making room at it, does. It used to say "VBUS (1 at 0.25 mm, not 0.4 mm)" and nothing of where, and the
 * whole connection was thin: an assistant reported it after every route for an evening and moved parts at random to fix it.
 */
export function narrowedAdvice(res: AutorouteResult, project?: Project, analysis?: PcbAnalysis): string {
  if (!res.narrowed?.length) return ""
  const where =
    project && analysis && res.narrowed.every((n) => n.spans?.length)
      ? narrowList(project, analysis, res.narrowed)
      : res.narrowed.map((n) => `${n.net} (${n.widths.length} at ${[...new Set(n.widths)].sort((a, b) => b - a).map((w) => `${w} mm`).join(" or ")}, not ${n.width} mm)`).join("; ")
  const first = res.narrowed[0]?.spans?.[0]
  const hint = project && analysis && first ? drawHint(project, analysis, first) : ""
  const whole = res.narrowed.some((n) => n.spans?.some((sp) => sp.length >= sp.total - 0.05))
  return (
    ` Narrower than their net's width, for want of room at that width: ${where}.` +
    `${whole ? " A connection narrower all the way had room for no more anywhere along it." : " Everywhere else these nets are at their width."} Where it carries current: draw_trace that connection from pin to pin at the width${hint}, or make room at that stretch with place_parts (or set_board), then route_pcb with clear true. A stretch of a few tenths of a millimetre beside a small pad carries what the pad does; say how long it is when you tell the user rather than calling the net too thin.`
  )
}

const routePcbTool: ToolSpec = {
  name: "route_pcb",
  description:
    "Autoroute open connections on every copper layer, changing layer by through vias. One call routes every net: nets with a width (set_net_width) and supplies keep it wherever it fits and neck down only where there is no room, and while anything is open or narrower the router routes the board other ways and keeps the best. So never route nets in calls of their own; priority puts some first. clear takes up the unlocked routing first (route from scratch). The answer names each open connection and narrowed stretch by its pins. Poured nets' pads join the pour; stitching is redone. Lay out the PCB first.",
  input_schema: {
    type: "object",
    properties: {
      nets: { type: "array", items: { type: "string" }, description: "Only these nets; every net when omitted" },
      priority: { type: "array", items: { type: "string" }, description: "Nets routed first, in this order" },
      clear: { type: "boolean", description: "Take up unlocked traces and vias (of nets, if given) first" },
      optimize: { type: "boolean", description: "Use the whole time limit for fewer vias and less track" },
    },
  },
  run: (project, input) => {
    if (!resolvedComponents(project).some((c) => c.pcb.placed && onBoard(c))) {
      return fail(project, noFootprintAdvice(project) ?? noneOnBoardAdvice(project) ?? "No parts are on the PCB yet; run layout_pcb first")
    }
    const names = (key: string) => (Array.isArray(input[key]) ? [...new Set((input[key] as unknown[]).map((n) => String(n).trim()).filter(Boolean))] : [])
    const asked = names("nets")
    const first = names("priority")
    const named = getConnectivity(project).nets.filter((n) => n.pins.length > 0)
    const missing = [...asked, ...first].filter((name) => !named.some((n) => n.name === name))
    if (missing.length) {
      return fail(project, `No net named ${[...new Set(missing)].join(", ")}. Nets: ${named.filter((n) => n.named).map((n) => n.name).slice(0, 20).join(", ") || "none named yet"}.`)
    }
    const idOf = (name: string) => named.find((n) => n.name === name)!.id
    const ids = asked.length ? asked.map(idOf) : undefined
    const of = asked.length ? ` of ${asked.join(", ")}` : ""
    // From scratch: the unlocked copper of what is routed goes first, as clear_routing would take it (stitching vias and blind, buried and
    // micro vias stay: the router makes through vias only, and stitching is redone after routing).
    let start = project
    let cleared = ""
    if (input.clear === true) {
      const analysis = getPcbAnalysis(project)
      const want = (net: string | null | undefined) => !ids || (!!net && ids.includes(net))
      const traces = project.traces.filter((t) => !t.locked && want(analysis.traceNet.get(t.id)))
      const vias = project.vias.filter((v) => !v.locked && !v.net && v.kind === undefined && want(analysis.viaNet.get(v.id)))
      if (traces.length || vias.length) {
        start = removeCopper(project, new Set(traces.map((t) => t.id)), new Set(vias.map((v) => v.id)))
        cleared = `Cleared ${traces.length} trace(s) and ${vias.length} via(s) first. `
      }
    }
    const res = routeAroundStitching(start, (p) => autoroute(p, { ...(ids && { nets: ids }), ...(first.length && { order: first.map(idOf) }), ...(input.optimize === true && { optimize: true }) }))
    if (!res.routed && !res.remaining) return ok(start, `${cleared}Every connection${of} is already routed.`, "Nothing to route")
    const analysis = getPcbAnalysis(res.project)
    // Asked for some nets only, the router makes no fine-pitch retry (it would route the others first), so that is not yet tried.
    const unrouted = !res.remaining
      ? ""
      : ids && res.finePitchOpen
        ? ` ${res.remaining} connection(s)${of} could not be routed: ${openList(res.project, analysis, res.open)}. ${res.finePitchOpen} of them at fine-pitch pads: route_pcb with no nets retries those with escape stubs and thinner traces.`
        : unroutedAdvice(res, res.project, analysis)
    const tail = narrowedAdvice(res, res.project, analysis) + unrouted
    const rest = ids ? analysis.ratsnest.filter((r) => !ids.includes(r.netId)).length : 0
    const tries = res.tries > 1 && !res.remaining && !res.narrowed?.length ? ` (the best of ${res.tries} routings)` : ""
    return ok(
      res.project,
      `${cleared}Routed ${res.routed} connection(s)${of} with ${res.addedTraces} trace(s) and ${res.addedVias} via(s)${tries}.${tail}${rest ? ` ${rest} connection(s) of other nets are still open: route_pcb routes them.` : ""}`,
      res.remaining ? `Routed ${res.routed}${of}, ${res.remaining} left` : `Routed ${res.routed} connections${of}`,
    )
  },
}

const pourTool: ToolSpec = {
  name: "set_pour",
  description:
    "Add or remove a copper pour (filled zone) for a net on a copper layer, usually GND on both layers. Pours connect same-net pads and keep clearance from other nets. With stitch, also tie the top and bottom pours of the net together with a grid of vias; do that after routing so the vias do not block traces. With polygon, the pour covers only that shape; with keepout, the shape keeps those things out and has no net. With places the shape is a placement area: those parts must sit inside it, and layout_pcb and place_parts keep them there. get_design lists zones by id.",
  input_schema: {
    type: "object",
    properties: {
      net: { type: "string", description: "Net name, e.g. GND" },
      layer: { type: "string", description: "top, bottom, both, or in1, in2, ..." },
      remove: { type: "boolean", description: "Remove the pour instead of adding it" },
      stitch: { type: "boolean", description: "Add stitching vias between the top and bottom pours of this net" },
      polygon: { type: "array", items: { type: "number" }, description: "Corners x1, y1, x2, y2, ... in mm, three or more" },
      keepout: { type: "array", items: { type: "string", enum: ["tracks", "vias", "pads", "pour", "parts"] } },
      priority: { type: "integer", description: "Higher wins where polygons overlap" },
      places: { type: "string", description: "sheet:/Power/, class:NAME or group:NAME; empty removes" },
      id: { type: "string", description: "Change or remove the zone with this id" },
    },
    required: ["layer"],
  },
  run: (project, input) => {
    if (input.polygon !== undefined || input.id !== undefined || input.keepout !== undefined || input.places !== undefined) return polygonZone(project, input)
    if (typeof input.net !== "string" || !input.net.trim()) return fail(project, "Say which net to pour")
    const net = String(input.net).trim()
    const stackIds = copperLayers(project.board) as string[]
    if (input.layer !== "both" && !stackIds.includes(String(input.layer))) return fail(project, `layer must be both or one of ${stackIds.join(", ")}`)
    const layers = (input.layer === "both" ? ["top", "bottom"] : [input.layer]) as CopperLayer[]
    if (input.remove === true) {
      const zones = project.zones.filter((z) => !(isWholeBoardPour(z) && z.net === net && (layers as readonly string[]).includes(z.layer)))
      // Removing by net takes only the whole-board pours; a polygon zone on the net is taken out by its id.
      const polygons = project.zones.filter((z) => !isWholeBoardPour(z) && !z.keepout && z.net === net && zoneLayers(z).some((l) => (layers as readonly string[]).includes(l)))
      const named = polygons.length ? ` ${polygons.length === 1 ? "A polygon zone is" : `${polygons.length} polygon zones are`} on ${net} (id ${polygons.map((z) => z.id).join(", ")}) and stay${polygons.length === 1 ? "s" : ""}: remove ${polygons.length === 1 ? "it" : "each"} with set_pour and its id and remove true.` : ""
      if (zones.length === project.zones.length) return fail(project, polygons.length ? `There is no whole-board ${net} pour on ${input.layer}.${named}` : `There is no ${net} pour on ${input.layer}`)
      // Stitching only makes sense while the net is poured on both layers.
      return ok(removeStitching({ ...project, zones }, net), `Removed the ${net} pour on ${input.layer}.${named}`, `Removed ${net} pour`)
    }
    if (!getConnectivity(project).nets.some((n) => n.name === net && n.pins.length > 0)) {
      return fail(project, `No pins are on a net named ${net}`)
    }
    const add = layers.filter((l) => !project.zones.some((z) => isWholeBoardPour(z) && z.net === net && z.layer === l))
    const next = add.length ? { ...project, updatedAt: Date.now(), zones: [...project.zones, ...add.map((layer) => ({ id: uid("z"), net, layer }))] } : project
    const poured = add.length ? `Poured ${net} on ${add.join(" and ")}` : `${net} is already poured on ${input.layer}`
    if (input.stitch === true) {
      const res = stitchVias(next, net)
      const missed = pourMissNote(res.project, getPcbAnalysis(res.project), net)
      if (!res.added) return ok(res.project, `${poured}. No stitching vias fit: ${net} needs solid pours on both layers away from parts.${missed}`, "No stitching vias fit")
      return ok(res.project, `${poured}. Added ${res.added} stitching vias.${missed}`, `Stitched ${net} with ${res.added} vias`)
    }
    return ok(next, `${poured}.${pourMissNote(next, getPcbAnalysis(next), net)}`, poured)
  },
}

/** set_pour with a polygon, a keepout or an id: a zone of its own shape, added, changed or removed. */
function polygonZone(project: Project, input: Record<string, unknown>): ToolOutcome {
  const stackIds = copperLayers(project.board) as string[]
  if (input.layer !== "both" && !stackIds.includes(String(input.layer))) return fail(project, `layer must be both or one of ${stackIds.join(", ")}`)
  const layers = input.layer === "both" ? (["top", "bottom"] as CopperLayer[]) : ([input.layer as CopperLayer] as CopperLayer[])
  const nums = Array.isArray(input.polygon) ? (input.polygon as unknown[]) : null
  if (nums && (nums.length < 6 || nums.length % 2 || !nums.every((n) => typeof n === "number" && Number.isFinite(n)))) return fail(project, "polygon needs x, y pairs: at least three corners")
  const points = nums ? Array.from({ length: nums.length / 2 }, (_, i) => ({ x: nums[2 * i] as number, y: nums[2 * i + 1] as number })) : null
  const flags = Array.isArray(input.keepout) ? (input.keepout as string[]) : null
  const keepout = flags ? Object.fromEntries(flags.map((f) => [f === "parts" ? "footprints" : f, true])) : undefined
  const priority = typeof input.priority === "number" ? Math.max(0, Math.round(input.priority)) : undefined
  const net = typeof input.net === "string" ? input.net.trim() : ""
  // X20: a placement area holds the parts of a sheet, a class or a group; an empty target takes the placement off.
  const where = input.places === undefined ? undefined : parsePlaces(project, input.places)
  if (typeof where === "string") return fail(project, where)
  if (typeof input.id === "string") {
    const z = project.zones.find((x) => x.id === input.id)
    if (!z) return fail(project, `There is no zone with id ${input.id}`)
    if (z.locked) return fail(project, "That zone is locked")
    if (input.remove === true) return ok(removeZones(project, [z.id]), "Removed the zone.", "Removed zone")
    let next = project
    if (points) {
      if (!z.outline) return fail(project, "That pour covers the whole board; remove it and add a polygon instead")
      const made = makeZone(points)
      if (!made) return fail(project, "That polygon has no area")
      next = { ...next, zones: next.zones.map((x) => (x.id === z.id ? { ...x, outline: made.outline } : x)) }
    }
    if (net && !z.keepout && !getConnectivity(next).nets.some((n) => n.name === net && n.pins.length > 0)) return fail(project, `No pins are on a net named ${net}`)
    if (where !== undefined && !z.keepout) return fail(project, "Only a keepout or placement area holds parts: add a new polygon with places")
    next = updateZone(next, z.id, { ...(net && !z.keepout ? { net } : {}), layers, ...(priority !== undefined ? { priority: priority || undefined } : {}), ...(where !== undefined ? { placement: where ?? undefined } : {}) })
    const changedNet = next.zones.find((x) => x.id === z.id)?.net
    const missed = changedNet && !z.keepout ? pourMissNote(next, getPcbAnalysis(next), changedNet) : ""
    return ok(next, `Changed the zone.${where ? placementTail(next, z.id) : ""}${missed}`, where ? "Changed placement area" : "Changed zone")
  }
  if (!points) return fail(project, "Give the polygon's corners")
  const rule = keepout ?? (where ? {} : undefined)
  if (!rule && !getConnectivity(project).nets.some((n) => n.name === net && n.pins.length > 0)) return fail(project, `No pins are on a net named ${net}`)
  const made = makeZone(points, { layers, net, priority, keepout: rule })
  if (!made) return fail(project, "That polygon has no area")
  const zone = where ? { ...made, placement: where } : made
  const next = addZone(project, zone)
  const missed = rule ? "" : pourMissNote(next, getPcbAnalysis(next), net)
  const what = where ? `a placement area for ${placementWords(where)}` : keepout ? "a keepout" : `Poured ${net}`
  return ok(next, `${where || keepout ? `Added ${what}` : what} in a polygon of ${points.length} corners (id ${zone.id}).${where ? placementTail(next, zone.id) : ""}${missed}`, where ? "Added placement area" : keepout ? "Added keepout" : `Poured ${net} in a polygon`)
}

/** `sheet:/Power/`, `class:Power` or `group:Front end` as a placement; null for an empty one (it takes the placement off); the sentence that says why it cannot be one. */
function parsePlaces(project: Project, raw: unknown): ZonePlacement | null | string {
  if (typeof raw !== "string") return "places must be text: sheet:/Power/, class:NAME or group:NAME"
  const text = raw.trim()
  if (text === "" || text.toLowerCase() === "none") return null
  const m = /^(sheet|class|group)\s*:\s*(.*)$/i.exec(text)
  if (!m || m[2].trim() === "") return "places is sheet:/Power/, class:NAME or group:NAME"
  const by = m[1].toLowerCase() as ZonePlacement["by"]
  const name = m[2].trim()
  if (by === "sheet") {
    const r = resolveSheet(project, name)
    if ("use" in r) return { by, name: r.use.human }
    // A board brought in with no schematic names the sheet of each part; that is the only sheet it knows.
    if (project.components.some((c) => c.sheetPath === name)) return { by, name }
    return r.error
  }
  return { by, name }
}

/** What a new or changed placement area does: how many parts it picks and which sit outside, and how to bring them in. */
function placementTail(project: Project, id: string): string {
  const z = project.zones.find((x) => x.id === id)
  if (!z?.placement || z.placement.off) return ""
  const r = areaReport(project, z)
  if (!r.picked) return ` No placed part is picked yet${z.placement.by === "class" ? " (give parts the class with update_component classes)" : ""}.`
  return ` It picks ${r.picked} placed part${r.picked === 1 ? "" : "s"}${r.outside.length ? `; outside it: ${r.outside.slice(0, 12).join(", ")}${r.outside.length > 12 ? " and more" : ""}. Move them in with place_parts (it keeps them inside) or layout_pcb with relayout_all` : ", all inside"}.`
}

/**
 * What get_design says of the variants (KiCad 10's, on a schematic or a board), only for a project that has any: the one shown (every flag and value above is as it makes it) and, for each,
 * what it changes on which parts.
 */
function variantsReport(project: Project) {
  const names = variantNames(project)
  if (!names.length) return undefined
  const shown = activeVariant(project)
  return {
    shown: shown ?? "none: the parts as they are",
    list: names.map((name) => {
      const description = project.variants?.list.find((v) => v.name === name)?.description
      const parts = project.components.flatMap((c) => (c.variants?.[name] ? [{ ref: c.ref, changes: variantWords(c.variants[name]) }] : []))
      return { name, ...(description ? { description } : {}), parts }
    }),
  }
}

/** What get_design says of the zones, only for a project that has a polygon or a keepout: nothing for the editor's own pours alone. */
function zonesReport(project: Project) {
  if (!project.zones.some((z) => z.outline) && !hasPartZones(project)) return undefined
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  // The zones inside parts come last, each with the part it belongs to.
  return withPartZones(project).zones.map((z) => {
    const area = z.placement ? areaReport(project, z) : null
    return {
      id: z.id,
      ...(z.part ? { part: refOf.get(z.part) } : {}),
      ...(z.net ? { net: z.net } : {}),
      layers: [...zoneLayers(z), ...(z.other ?? [])].join("+"),
      ...(z.keepout && !(z.placement && keepoutFlags(z).length === 0) ? { keepout: keepoutFlags(z).map((f) => (f === "footprints" ? "parts" : f)).join("+") || "rules only" } : {}),
      // X20: whose parts a placement area holds (what places takes), and which of them sit outside it.
      ...(z.placement ? { places: `${z.placement.by}:${z.placement.name}${z.placement.off ? " (off)" : ""}`, ...(area!.outside.length ? { parts_outside: area!.outside } : {}) } : {}),
      ...(z.priority ? { priority: z.priority } : {}),
      ...(z.outline ? { polygon: outlinePoints(z).slice(0, 40).flatMap((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]) } : { whole_board: true }),
    }
  })
}

/**
 * The blocks a request made or changed: new blocks, blocks whose parts changed, and blocks holding
 * a part added, moved or edited since the request began. A new connection to a part already there
 * doesn't count: `connect` drew it, and the user's drawing around it stays as it is.
 */
export function changedBlocks(start: Project, now: Project): SchematicBlock[] {
  const before = new Map(start.components.map((c) => [c.id, c]))
  const blocksBefore = new Map((start.blocks ?? []).map((b) => [b.id, b]))
  const changed = (c: ComponentInstance) => {
    const old = before.get(c.id)
    return !old || old.partId !== c.partId || JSON.stringify(old.props) !== JSON.stringify(c.props) || JSON.stringify(old.sch) !== JSON.stringify(c.sch)
  }
  const byId = new Map(now.components.map((c) => [c.id, c]))
  return (now.blocks ?? []).filter((block) => {
    const old = blocksBefore.get(block.id)
    if (!old || [...old.components].sort().join(" ") !== [...block.components].sort().join(" ")) return true
    return block.components.some((id) => {
      const c = byId.get(id)
      return !!c && changed(c)
    })
  })
}

const tidyTool: ToolSpec = {
  name: "tidy_schematic",
  description:
    "Arrange the schematic the way an engineer would draw it: blocks in reading order by signal flow (power in and inputs on the left, regulation, the controller in the middle, peripherals and outputs on the right), each laid out about its main part with its small parts beside the pins they serve, short wires inside a block, chips and connectors wired to each other where they meet point to point, a net label wherever a net leaves its block and on each piece of a named net, power ports above and ground below. It never changes what is connected and is one undo step. Give blocks to tidy just those blocks, each where it is. With no blocks it tidies the whole sheet when the sheet was empty at the start of this request or whole_sheet is true (parts in no block are then gathered into a block named OTHER), and otherwise only the blocks made or changed in this request, so the rest of the drawing stays as the user drew it. A block it can't lay out is left exactly as drawn while the others are tidied, and the reply names it and says why.",
  input_schema: {
    type: "object",
    properties: {
      blocks: { type: "array", items: { type: "string" }, description: "Names of the blocks to tidy, each where it is" },
      whole_sheet: { type: "boolean", description: "Tidy the whole sheet: only when the user asks for it, or the sheet was empty before this request" },
      sheet: SHEET_PROPERTY,
    },
  },
  run: (project, input, _prepared, context = {}) => {
    const names = Array.isArray(input.blocks) ? input.blocks.map((n) => String(n).trim()).filter(Boolean) : []
    // Null for the whole sheet.
    let targets: SchematicBlock[] | null = null
    if (names.length) {
      const missing = names.filter((n) => !findBlock(project, n))
      if (missing.length) return fail(project, `No block ${missing.join(", ")}. Blocks: ${blockNames(project)}`)
      targets = [...new Map(names.map((n) => findBlock(project, n)!).map((b) => [b.id, b])).values()]
    } else if (input.whole_sheet !== true && context.standalone && project.components.some((c) => isSchematicPart(findPart(c.partId)))) {
      // An assistant over MCP: each call is a request of its own, so what it made is for it to say.
      return fail(
        project,
        "Nothing was tidied: say what to tidy. Give blocks, the blocks you made or changed, or whole_sheet true if the sheet was empty when the user asked or they asked for the whole sheet. Each call here is a request of its own, so tidy_schematic can't tell what you made.",
      )
    } else if (input.whole_sheet !== true && context.start && context.start.components.some((c) => isSchematicPart(findPart(c.partId)))) {
      targets = changedBlocks(context.start, project)
      if (!targets.length) {
        return fail(
          project,
          "Nothing made or changed in this request is in a block, so nothing was tidied. Group new parts with group_parts first, or pass whole_sheet if the user asked for the whole sheet.",
        )
      }
    }
    let next = project
    const said: string[] = []
    const heads: string[] = []
    const renamed: Record<string, string> = {}
    // A block that can't be tidied is left as it was drawn, and the others are tidied all the same;
    // the whole sheet keeps such a block itself and says so.
    const left: string[] = []
    let loose = 0
    const all = targets ?? [undefined]
    for (const target of all) {
      const blockId = target?.id
      const r = tidySchematic(next, { blockId })
      if (!r.ok) {
        if (!target || all.length === 1) return fail(project, [r.message, ...r.problems.slice(0, 3)].join(" "))
        const why = r.problems.length && r.message.startsWith("Tidy couldn't find room") ? r.problems[0].replace(/^Tidy: /, "") : r.message.replace(/\.$/, "")
        left.push(`Kept ${target.name} as it was drawn: ${why}.`)
        continue
      }
      next = r.project
      said.push(r.message)
      loose += r.loose.wires + r.loose.labels + r.loose.ports
      // The first sentence: what was tidied.
      const end = r.message.indexOf(". ")
      heads.push(end < 0 ? r.message : r.message.slice(0, end + 1))
      // And a block the whole sheet kept as drawn.
      for (const k of r.kept ?? []) heads.push(`Kept ${k.block} as it was drawn.`)
      Object.assign(renamed, r.renamed)
    }
    if (!said.length) return fail(project, left.join(" "))
    const pairs = Object.entries(renamed)
    const named = pairs.length ? ` Unnamed nets that needed labels were named: ${pairs.map(([a, b]) => `${a} is now ${b}`).join(", ")}.` : ""
    for (const l of left) heads.push(l.slice(0, l.indexOf(":")) + ".")
    const unwanted = loose ? ["If what reaches no part isn't wanted, remove_wiring loose deletes it."] : []
    return ok(next, [said.join(" ") + named, ...left, ...unwanted].join(" "), heads.join(" "))
  },
}

const [addHierLabelTool, wireSheetPinTool] = sheetWiringTools(connectTool)
// A net with no name is renamed by putting a label on it, which is connect's to draw, on the sheet of its pins.
const editNet = editNetTool((project, input) => runSpec(connectTool, project, input, undefined, {}))

export const TOOL_SPECS: ToolSpec[] = [
  getDesign,
  getWiringTool,
  searchPartsTool,
  findPartTool,
  getPartDataTool,
  readDatasheetTool,
  ...WEB_TOOLS,
  createPartTool,
  verifyPartsTool,
  addComponentTool,
  updateComponentTool,
  removeComponentTool,
  connectTool,
  removeWiringTool,
  noConnectTool,
  drawWiringTool,
  editNet,
  ...sheetEditTools,
  addHierLabelTool,
  wireSheetPinTool,
  groupPartsTool,
  editBlockTool,
  arrangeBlocksTool,
  tidyTool,
  ...drawingToolSpecs,
  runChecksTool,
  lookTool,
  layoutPcbTool,
  routePcbTool,
  pourTool,
  setBoardTool,
  setRulesTool,
  ...pcbToolSpecs,
  ...VERSION_TOOLS,
]

const specByName = new Map(TOOL_SPECS.map((t) => [t.name, t]))

export interface FunctionTool {
  type: "function"
  function: { name: string; description: string; parameters: JsonSchema }
}

/** Tool definitions in the Chat Completions format; inputs are validated before running. */
export const TOOL_DEFINITIONS: FunctionTool[] = TOOL_SPECS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))

/** Validate a value against the small JSON Schema subset used by the tool definitions. */
export function validateInput(schema: JsonSchema, value: unknown, path = "input"): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${path} must be one of ${schema.enum.join(", ")}`
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number`
    case "integer":
      return Number.isInteger(value) ? null : `${path} must be an integer`
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} needs at least ${schema.minItems} items`
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateInput(schema.items, value[i], `${path}[${i}]`)
          if (err) return err
        }
      }
      return null
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`
      const obj = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (obj[key] !== undefined) continue
        // Fields this object doesn't have are ignored, so say which were given: `view` passed for `target` was the commonest miss.
        const unknown = schema.properties ? Object.keys(obj).filter((k) => !(k in schema.properties!)) : []
        return `${path}.${key} is required${unknown.length ? ` (${unknown.join(", ")} ${unknown.length > 1 ? "aren't fields" : "isn't a field"} here; the fields are ${Object.keys(schema.properties!).join(", ")})` : ""}`
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties?.[key]
        if (prop) {
          const err = validateInput(prop, v, `${path}.${key}`)
          if (err) return err
        } else if (typeof schema.additionalProperties === "object") {
          const err = validateInput(schema.additionalProperties, v, `${path}.${key}`)
          if (err) return err
        } else if (schema.additionalProperties === false) {
          // Refused rather than dropped: a misspelt field (`hole` for `drill`) would otherwise draw something else without a word.
          return `${path}.${key} is not a field here; use ${Object.keys(schema.properties ?? {}).join(", ")}`
        }
      }
      return null
    }
  }
}

/**
 * Validate and run one tool call on the project alone, with no lookups: a tool that would look a
 * part up runs as it does with no supplier available (create_part from memory, find_part
 * refusing). Never throws; failures come back as error results. The copilot uses `executeTool`,
 * and Clean up with AI this, with the request's `start` in `context`.
 */
/** The sheet a connection is on, from the parts its pins name: the one they all share. */
function sheetOfPins(project: Project, input: ToolInput): string | { error: string } | undefined {
  const refs = Array.isArray(input.pins) ? input.pins.map((s) => String(s).trim().split(".")[0]).filter(Boolean) : []
  const insts = new Set<string>()
  for (const r of refs) {
    const c = findByRef(project, r)
    if (c) insts.add(c.inst ?? "")
  }
  if (insts.size === 1) return [...insts][0]
  if (insts.size > 1) return { error: `Those pins are on different sheets (${[...insts].map((i) => useAt(project, i).human).join(", ")}). A net crosses sheets through a sheet pin and a hierarchical label, or a global label on each sheet: connect on one sheet, or give sheet.` }
  return undefined
}

const SHEET_BUILDERS = new Set(["add_component", "group_parts", "edit_block", "arrange_blocks", "draw", "draw_wiring", "get_wiring"])

/** A tool with a sheet runs on that sheet alone; the others on the project. */
function runSpec(spec: ToolSpec, project: Project, input: ToolInput, prepared: unknown, ctx: ToolContext): ToolOutcome {
  if (spec.name === "connect") return onSheet(spec, project, input, prepared, ctx, (p) => sheetOfPins(p, input))
  // The blocks' own sheet when they name one, else the sheet the editor shows: it was refused for want of a sheet seven times in a
  // week. With no editor (an assistant over MCP) and no blocks to go by, it still asks which sheet rather than tidy the root.
  if (spec.name === "tidy_schematic") return onSheet(spec, project, input, prepared, ctx, (p) => {
    const named = Array.isArray(input.blocks) ? input.blocks.map(String) : []
    const sheets = new Set(named.map((n) => findBlock(p, n)).filter((b) => b !== undefined).map((b) => b.inst ?? ""))
    if (sheets.size === 1) return [...sheets][0]
    if (!ctx.sheet) return undefined
    const r = shownUse(p, ctx)
    return "error" in r ? r : r.use.path
  })
  if (spec.name === "remove_wiring") return onSheet(spec, project, input, prepared, ctx, (p) => {
    if (Array.isArray(input.pins) && input.pins.length) return sheetOfPins(p, input)
    const r = shownUse(p, ctx)
    return "error" in r ? r : r.use.path
  })
  // What is built on a sheet goes on the one named, or the one the editor shows; get_wiring reads that one.
  if (SHEET_BUILDERS.has(spec.name)) return onSheet(spec, project, input, prepared, ctx, (p) => { const r = shownUse(p, ctx); return "error" in r ? r : r.use.path })
  const out = spec.run(project, input, prepared, ctx)
  // A part edited or removed on a sheet used more than once is edited in every use.
  return out.project === project || !isHierarchical(project) ? out : { ...out, project: syncEdited(project, out.project) }
}

/** Names assistants reach for in place of a tool's own field, and the field each means: renamed before a call is checked. */
const ALIASES: Record<string, Record<string, string>> = {
  look: { view: "target" },
  group_parts: { name: "block" },
  find_part: { q: "query", search: "query", part: "query" },
  search_parts: { q: "query", search: "query" },
  get_design: { ref: "refs" },
  web_search: { q: "query" },
  read_web_page: { link: "url" },
}

/**
 * A call's input as the tool takes it: aliases renamed (`ALIASES`), and for the tools that read a part
 * by its supplier number, a placed part named by `ref` or `part_id` turned into the number it was built
 * from. Assistants asked get_part_data and read_datasheet about "U1" and were refused seven times.
 */
export function normalizeInput(project: Project, name: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const spec = specByName.get(name)
  const props = spec?.input_schema.properties ?? {}
  let out = input as Record<string, unknown>
  for (const [alias, field] of Object.entries(ALIASES[name] ?? {})) {
    if (out[alias] === undefined || out[field] !== undefined || alias in props) continue
    const { [alias]: value, ...rest } = out
    out = { ...rest, [field]: field === "refs" && typeof value === "string" ? [value] : value }
  }
  if ((name === "get_part_data" || name === "read_datasheet") && out.lcsc === undefined && out.database_id === undefined && out.name === undefined && out.url === undefined) {
    const ref = typeof out.ref === "string" ? out.ref.trim() : ""
    const partId = typeof out.part_id === "string" ? out.part_id.trim() : (ref && project.components.find((c) => c.ref === ref)?.partId) || ""
    const part = partId ? project.parts?.find((p) => p.id === partId) : undefined
    if (part) {
      const { ref: _r, part_id: _p, ...rest } = out
      const lcsc = part.source?.supplier?.lcsc ?? part.source?.check?.lcsc ?? part.props?.lcsc
      out = lcsc ? { ...rest, lcsc } : name === "read_datasheet" ? { ...rest, name: part.props?.mpn ?? part.name } : out
    }
  }
  return out
}

export function runTool(project: Project, name: string, rawInput: unknown, context: ToolContext = {}): ToolOutcome {
  const spec = specByName.get(name)
  if (!spec) return fail(project, `Unknown tool ${name}`)
  const input = normalizeInput(project, name, rawInput)
  const err = validateInput(spec.input_schema, input ?? {})
  if (err) return fail(project, `Invalid input: ${err}`)
  try {
    return runSpec(spec, project, (input ?? {}) as ToolInput, undefined, context)
  } catch (e) {
    return fail(project, e instanceof Error ? e.message : String(e))
  }
}

/**
 * Validate and run one tool call, awaiting its lookups first. The change is then made to the
 * project as `latest` returns it at that moment, not to `start`, so an edit the user made during
 * a lookup is kept. `base` is the project the change was made to, or null when the project was
 * closed meanwhile and nothing was applied. Never throws.
 */
export async function executeTool(
  start: Project,
  latest: () => Project | null,
  name: string,
  input: unknown,
  ctx: ToolContext = {},
): Promise<ToolOutcome & { base: Project | null }> {
  const spec = specByName.get(name)
  if (!spec) return { ...fail(start, `Unknown tool ${name}`), base: start }
  input = normalizeInput(start, name, input)
  const err = validateInput(spec.input_schema, input ?? {})
  if (err) return { ...fail(start, `Invalid input: ${err}`), base: start }
  const args = (input ?? {}) as ToolInput
  const stopped = () => ({ ...fail(start, "Stopped before the change was made."), base: null })
  if (ctx.signal?.aborted) return stopped()
  try {
    const prepared = spec.prepare ? await spec.prepare(start, args, ctx) : undefined
    // A lookup that ended because of Stop answers with an error of its own: don't make a change on it.
    if (ctx.signal?.aborted) return stopped()
    const base = latest()
    if (!base || base.id !== start.id) return { ...fail(start, "The project was closed, so this change was not applied."), base: null }
    return { ...runSpec(spec, base, args, prepared, ctx), base }
  } catch (e) {
    if (ctx.signal?.aborted) return stopped()
    return { ...fail(start, e instanceof Error ? e.message : String(e)), base: start }
  }
}

/** Short present-tense label shown while a tool runs. */
export function toolActivityLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as ToolInput
  switch (name) {
    case "get_design":
      return "Reading the design"
    case "search_parts":
      return `Searching parts for "${String(i.query ?? "")}"`
    case "find_part":
      return `Looking up "${String(i.query ?? "")}" at the supplier`
    case "get_part_data":
      return `Reading ${String(i.lcsc ?? "a part")}'s pins and land`
    case "read_datasheet": {
      const what = i.section ? `${String(i.section)}` : i.page ? `page ${String(i.page)}` : "overview"
      return `Reading the datasheet of ${String(i.lcsc ?? i.name ?? "a part")} (${what})`
    }
    case "create_part":
      return `Creating ${String(i.name ?? i.lcsc ?? "a part")}`
    case "verify_parts":
      return "Checking project parts against supplier data"
    case "add_component":
      return `Adding ${String(i.part_id ?? "a part")}`
    case "update_component":
      return `Updating ${String(i.ref ?? "a part")}`
    case "remove_component":
      return `Removing ${String(i.ref ?? "a part")}`
    case "connect":
      return `Connecting ${Array.isArray(i.pins) ? i.pins.join(", ") : "pins"}`
    case "remove_wiring":
      return Array.isArray(i.pins) && i.pins.length ? `Removing the wiring at ${i.pins.join(", ")}` : "Removing loose wiring"
    case "set_no_connect":
      return Array.isArray(i.pins) ? `Marking ${i.pins.length} pin${i.pins.length === 1 ? "" : "s"} not connected` : "Marking pins not connected"
    case "get_wiring":
      return `Reading the wiring${typeof i.block === "string" ? ` of ${i.block}` : ""}`
    case "draw_wiring":
      return "Drawing wires and labels"
    case "edit_net":
      return typeof i.rename_to === "string" ? `Renaming ${String(i.net ?? "a net")} to ${i.rename_to}` : `Editing the net ${String(i.net ?? "")}`
    case "look":
      return `Looking at the ${i.target === "pcb" ? "PCB" : i.target === "3d" ? "3D board" : "schematic"}`
    case "group_parts":
      return `Grouping parts into ${String(i.block ?? "a block")}`
    case "edit_block":
      return `Editing block ${String(i.block ?? "")}`
    case "arrange_blocks":
      return "Arranging the blocks"
    case "tidy_schematic":
      return Array.isArray(i.blocks) && i.blocks.length ? `Tidying ${i.blocks.map(String).join(", ")}` : "Tidying the schematic"
    case "add_sheet":
      return `Adding the sheet ${String(i.name ?? i.reuse ?? "")}`.trim()
    case "edit_sheet":
      return `${i.delete === true ? "Deleting" : "Editing"} the sheet ${String(i.sheet ?? "")}`.trim()
    case "add_hier_label":
      return `Taking ${String(i.name ?? "a net")} out of ${String(i.sheet ?? "a sheet")}`
    case "wire_sheet_pin":
      return `Wiring the pin ${String(i.pin ?? "")} of ${String(i.sheet ?? "a sheet")}`
    case "show_sheet":
      return `Showing the sheet ${String(i.sheet ?? "")}`
    case "propose_blocks":
      return "Planning the blocks"
    case "run_checks":
      return "Running checks"
    case "layout_pcb":
      return "Placing parts on the PCB"
    case "set_board":
      return "Setting up the board"
    case "set_design_rules":
      return "Setting the design rules"
    case "route_pcb":
      return Array.isArray(i.nets) && i.nets.length ? `Routing ${i.nets.map(String).join(", ")}` : "Routing the board"
    case "set_pour":
      return `Pouring ${String(i.net ?? "copper")}`
    case "save_version":
      return `Saving the version "${String(i.name ?? "")}"`
    case "list_versions":
      return "Reading the version history"
    case "restore_version":
      return "Restoring a version"
    case "undo":
      return typeof i.steps === "number" && i.steps > 1 ? `Undoing ${i.steps} changes` : "Undoing the last change"
    default:
      return drawingToolLabel(name, i) ?? pcbToolLabel(name, i) ?? webToolLabel(name, i) ?? name
  }
}

/**
 * What Sakura is doing, in a word or two with nothing of the user's text in it, for the people on
 * the project with them (shown beside their face and cursor, `store/presence.ts`).
 */
export function toolPhase(name: string): string {
  switch (name) {
    case "get_design":
    case "get_wiring":
    case "look":
    case "read_datasheet":
    case "read_web_page":
      return "Reading"
    case "web_search":
      return "Searching the web"
    case "set_3d_model":
      return "Editing parts"
    case "search_parts":
    case "find_part":
    case "get_part_data":
    case "create_part":
    case "verify_parts":
      return "Finding parts"
    case "add_component":
    case "update_component":
    case "remove_component":
      return "Editing parts"
    case "connect":
    case "remove_wiring":
    case "set_no_connect":
    case "draw_wiring":
    case "edit_net":
      return "Wiring"
    case "group_parts":
    case "edit_block":
    case "arrange_blocks":
    case "propose_blocks":
      return "Grouping"
    case "tidy_schematic":
      return "Tidying"
    case "run_checks":
      return "Checking"
    case "layout_pcb":
    case "place_parts":
      return "Placing parts"
    case "route_pcb":
    case "clear_routing":
    case "set_net_width":
    case "set_net_class":
    case "set_clearance_rule":
    case "draw_trace":
      return "Routing"
    case "list_versions":
      return "Reading"
    case "save_version":
      return "Saving a version"
    case "restore_version":
    case "undo":
      return "Going back"
    default:
      return "Working"
  }
}
