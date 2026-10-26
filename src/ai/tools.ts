import { boxesOverlap, round, samePoint, snap } from "../lib/geometry"
import { pinKey } from "../model/connectivity"
import { isValidFootprint } from "../model/footprints"
import { isPhysical, powerNetName, schematicBounds, schematicPins, valueText } from "../model/instances"
import { uid } from "../lib/id"
import { removeStitching, routeAroundStitching, stitchVias } from "../model/stitch"
import { autoroute, type AutorouteResult } from "../model/autoroute"
import { blockPorts, readingOrder } from "../model/blockPorts"
import { netInfo } from "../model/tidy/nets"
import { tidySchematic } from "../model/tidy"
import { decouplingSummary } from "../model/decoupling"
import { pcbToolLabel, pcbToolSpecs } from "./pcbTools"
import { stageGaps } from "../model/powerStage"
import { projectPartDefs } from "../model/customParts"
import { findPart } from "../model/library"
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
import { SCH_GRID } from "../model/symbols"
import { MOUNTING_HOLE_PRESETS, SURFACE_FINISHES } from "../model/board"
import { applyCapability, BOARD_THICKNESSES, FAB_CAPABILITIES, matchCapability, THERMAL_RELIEF_OPTIONS } from "../model/rules"
import type { ComponentInstance, DesignRules, PinRef, Project, Rotation, SchematicBlock, SurfaceFinish } from "../model/types"
import { getConnectivity, getErc, getPcbAnalysis } from "../store/analysis"
import { splitIgnored } from "../model/erc"
import { lookTool } from "./lookTool"
import { readDatasheetTool } from "./datasheetTool"
import { createPartTool, findPartTool, getPartDataTool, verifyPartsTool } from "./partTools"
import { designDrawings, drawingToolLabel, drawingToolSpecs } from "./drawingTools"
import { fail, ok, pinList, stringProps, type JsonSchema, type ToolContext, type ToolInput, type ToolOutcome, type ToolSpec } from "./toolKit"

export type { JsonSchema, ToolContext, ToolInput, ToolOutcome } from "./toolKit"

const ROTATIONS = [0, 90, 180, 270]
const snapSch = (n: number) => round(snap(n, SCH_GRID))

const findByRef = (project: Project, ref: unknown) =>
  typeof ref === "string" ? project.components.find((c) => c.ref.toLowerCase() === ref.trim().toLowerCase()) : undefined

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

function pinHelp(project: Project, spec: string) {
  const ref = spec.split(".")[0]
  const c = findByRef(project, ref)
  if (!c) return `"${spec}": no component ${ref}`
  const part = findPart(c.partId)
  return `"${spec}": ${c.ref} has pins ${part?.pins.map((p) => (p.name === p.number ? p.number : `${p.number}/${p.name}`)).join(", ")}`
}

// ---------- Tools ----------

const getDesign: ToolSpec = {
  name: "get_design",
  description:
    "Read the open project: every component (real parts only; power and ground symbols are listed apart as power_symbols and are not counted) with its part id, value, footprint, schematic position and each pin's net, plus the net list, the schematic's blocks with their parts and frames, its drawings (texts, lines and shapes, with their ids), board size and a check summary. Call this before editing an existing design.",
  input_schema: { type: "object", properties: {} },
  run: (project) => {
    const netOf = pinNetNames(project)
    const conn = getConnectivity(project)
    const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
    const pcb = getPcbAnalysis(project)
    // A power or ground symbol is a drawing of a net, not a part on the board: counting it as a
    // component made one 19-part board read as 24, 45 and 47 components as symbols were drawn.
    const isSymbol = (c: ComponentInstance) => !!findPart(c.partId)?.powerNet
    const components = project.components.filter((c) => !isSymbol(c)).map((c) => {
      const part = findPart(c.partId)
      const base = {
        ref: c.ref,
        part: c.partId,
        name: part?.name ?? c.partId,
        value: valueText(c, part) || undefined,
        x: c.sch.x,
        y: c.sch.y,
        rotation: c.sch.rot,
      }
      if (!isPhysical(part)) return base
      return {
        ...base,
        footprint: c.footprint,
        props: c.props,
        // Where it stands on the PCB (mm, y up): enough to reason about placement, small per part.
        ...(c.pcb.placed && { pcb: { x: round(c.pcb.x, 2), y: round(c.pcb.y, 2), rot: c.pcb.rot, side: c.pcb.side, ...(c.pcb.locked && { locked: true }) } }),
        pins: (part?.pins ?? []).map((p) => ({ pin: p.number, name: p.name, net: netOf(c.id, p.number) })),
      }
    })
    const powerSymbols = project.components.filter(isSymbol).map((c) => ({
      ref: c.ref,
      net: powerNetName(c) ?? undefined,
      x: c.sch.x,
      y: c.sch.y,
      rotation: c.sch.rot,
    }))
    const nets = conn.nets
      .filter((n) => n.named || n.pins.length > 1)
      .map((n) => ({ name: n.name, pins: n.pins.map((p) => `${refOf.get(p.componentId)}.${p.pin}`) }))
    const erc = splitIgnored(getErc(project), project.ignoredChecks)
    const frames = new Map(blockFrames(project).map((f) => [f.id, f.box]))
    const info = project.blocks?.length ? netInfo(project) : null
    const order = info && readingOrder(project, info)
    const blocks = (project.blocks ?? []).map((b) => {
      const box = frames.get(b.id)
      const ports = blockPorts(project, b.id, info!, order!)
      return {
        name: b.name,
        parts: b.components.map((id) => refOf.get(id)),
        ...(box && { frame: { min_x: box.minX, min_y: box.minY, max_x: box.maxX, max_y: box.maxY } }),
        ...(ports.length && { ports: ports.map((p) => ({ net: p.name, direction: p.direction, ...(p.group && { group: p.group }) })) }),
      }
    })
    const drawings = designDrawings(project)
    const design = {
      project: project.name,
      board_mm: { width: project.board.width, height: project.board.height, thickness: project.board.thickness, center_x: project.board.x, center_y: project.board.y },
      design_rules_mm: ruleSummary(project.rules),
      components,
      power_symbols: powerSymbols,
      nets,
      ...(blocks.length ? { blocks } : {}),
      ...(drawings.length ? { drawings } : {}),
      checks: {
        unconnected_pins: conn.unconnectedPins.length,
        electrical_warnings: erc.active.length,
        electrical_ignored_by_user: erc.ignored.length,
        pcb_errors: pcb.violations.filter((v) => v.severity === "error").length,
        pcb_warnings: pcb.violations.filter((v) => v.severity === "warning").length,
        unplaced_on_pcb: project.components.filter((c) => isPhysical(findPart(c.partId)) && !c.pcb.placed).length,
      },
    }
    return ok(project, JSON.stringify(design), `Read the design (${components.length} components, ${nets.length} nets)`)
  },
}

/** Components by designator, or an error naming the ones the design doesn't have. */
function componentsByRef(project: Project, refs: string[]): ComponentInstance[] | string {
  const found = refs.map((r) => findByRef(project, r))
  const missing = refs.filter((_, i) => !found[i])
  return missing.length ? `No component ${missing.join(", ")}` : (found as ComponentInstance[])
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
    const from = moved.length ? ` Moved out of their old blocks: ${moved.map((c) => `${c.ref} (${blockOf(project, c.id)!.name})`).join(", ")}.` : ""
    return ok(
      next,
      `Block ${block.name} holds ${block.components.map((id) => refOf.get(id)).join(", ")}.${from}`,
      `Grouped ${found.map((c) => c.ref).join(", ")} into ${block.name}`,
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
      if (delta.x || delta.y) {
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
      changes.push(`took out ${found.map((c) => c.ref).join(", ")}${gone ? ", which left it empty, so it is gone" : ""}`)
    }
    if (!changes.length) return fail(project, "Give new_name, move_by, remove_refs or ungroup")
    const text = `Block ${block.name}: ${changes.join("; ")}`
    return ok(next, `${text}.`, text)
  },
}

const searchPartsTool: ToolSpec = {
  name: "search_parts",
  description:
    "Search the part library and this project's own parts by name, function, MPN, value or package (e.g. \"3v3 regulator\", \"10k 0603\", \"mosfet\", \"6 pin header\"). Returns part ids, pins, footprints and default properties, plus the properties and footprint the query named (suggested_props, suggested_footprint) to pass to add_component. An empty query lists every part.",
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
        `No parts match "${query}". Try a broader term, or, if the user wants a specific part the library doesn't have, make it with create_part.`,
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
      ? `No part matches every word of "${query}"; these are the closest. If none fits, make the part with create_part.\n`
      : ""
    return ok(project, partial + JSON.stringify(rows), `Searched parts for "${query}" (${hits.length} found)`)
  },
}

const addComponentTool: ToolSpec = {
  name: "add_component",
  description:
    "Add a part to the schematic. Position is in schematic units on a 0.1 grid (y up); omit x/y to place it in free space right of the existing parts and their labels (a part dropped onto another part's pins is refused). Returns the new reference designator.",
  input_schema: {
    type: "object",
    properties: {
      part_id: { type: "string", description: "Part id from search_parts, e.g. \"resistor\"" },
      ref: { type: "string", description: "Optional designator, e.g. \"R5\"" },
      props: {
        type: "object",
        description: "Properties such as {\"resistance\": \"4.7k\"} or {\"net\": \"3V3\"} for power ports",
        additionalProperties: { type: "string" },
      },
      footprint: { type: "string", description: "Footprint name, e.g. \"0805\"; defaults to the part's first footprint" },
      x: { type: "number" },
      y: { type: "number" },
      rotation: { type: "integer", enum: ROTATIONS },
    },
    required: ["part_id"],
  },
  run: (project, input) => {
    const partId = String(input.part_id)
    const part = findPart(partId)
    if (!part) return fail(project, `Unknown part "${partId}".${partSuggestions(project, partId)}`)
    const props = stringProps(input.props)
    if (!props) return fail(project, "props must be an object of string values")
    const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : undefined
    if (ref && findByRef(project, ref)) return fail(project, `Designator ${ref} is already used`)
    const footprint = typeof input.footprint === "string" && input.footprint.trim() ? input.footprint.trim() : undefined
    if (footprint && !part.footprints.includes(footprint) && !isValidFootprint(footprint)) {
      return fail(project, `Unknown footprint "${footprint}". ${part.name} supports: ${part.footprints.join(", ") || "none"}`)
    }
    const rot = (typeof input.rotation === "number" ? input.rotation : 0) as Rotation
    const spot = freeSchematicSpot(project, part, rot)
    const x = typeof input.x === "number" ? snapSch(input.x) : spot.x
    const y = typeof input.y === "number" ? snapSch(input.y) : spot.y
    const { project: next, component } = addComponent(project, partId, { ref, props, footprint, sch: { x, y, rot } })

    // A part dropped onto drawn pins, wires or labels would join their nets without anyone asking.
    const before = getConnectivity(project)
    const own = new Set(schematicPins(component).map((p) => pinGroup(before, { componentId: component.id, pin: p.pin })))
    const rail = part.powerNet ? [`net:${component.props.net?.trim() || part.powerNet}`] : []
    const joined = schematicEditProblems(project, next, before, getConnectivity(next), new Set([...own, ...rail]))
    if (joined.length) {
      return fail(
        project,
        `Not added: ${part.name} at (${x}, ${y}) would connect ${joined.join("; ")}. Pick another x/y, or leave them out to place it in free space.`,
      )
    }
    const box = schematicBounds(component)
    const over = project.components.filter((c) => boxesOverlap(box, schematicBounds(c))).map((c) => c.ref)
    const note = over.length ? ` Note: it overlaps ${over.join(", ")}; update_component can move it (a move that would join nets is refused, and says where it fits).` : ""
    return ok(
      next,
      `Added ${component.ref} (${part.name}) at (${x}, ${y}). Pins: ${pinList(part.pins)}${note}`,
      `Added ${component.ref} (${describePart(component)})`,
    )
  },
}

const updateComponentTool: ToolSpec = {
  name: "update_component",
  description:
    "Change a component's properties, footprint, designator, rotation or schematic position. Moving or rotating keeps the part's connections: wires stretch, and the net labels, power symbols and branch wires that hang off its pins alone go with it. A move, rotation or net change that would join nets nobody asked to join, park a pin under another net's wire, or cut any pin off its net is refused and changes nothing; the reply names the pins and says where the part does fit.",
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
    },
    required: ["ref"],
  },
  run: (project, input) => {
    const c = findByRef(project, input.ref)
    if (!c) return fail(project, `No component ${String(input.ref)}`)
    const part = findPart(c.partId)
    const props = stringProps(input.props)
    if (!props) return fail(project, "props must be an object of string values")
    const changes: string[] = []
    let next = project

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
      patch.footprint = fp
      changes.push(`footprint ${fp}`)
    }
    if (typeof input.new_ref === "string" && input.new_ref.trim() && input.new_ref.trim() !== c.ref) {
      const newRef = input.new_ref.trim()
      if (findByRef(project, newRef)) return fail(project, `Designator ${newRef} is already used`)
      patch.ref = newRef
      changes.push(`renamed to ${newRef}`)
    }
    if (Object.keys(patch).length) next = updateComponent(next, c.id, patch)
    if (rotation !== null) {
      next = rotateComponent(next, c.id, rotation)
      changes.push(`rotated to ${rotation}°`)
    }
    if (!changes.length) return ok(project, `No changes for ${c.ref}`, `No changes for ${c.ref}`)

    // A move, a turn or a new rail can land the part's pins on other nets. Every edit that changes
    // what sits where is checked before and after, like connect, and refused if it joins nets.
    const newRail = part?.powerNet && patch.props ? patch.props.net?.trim() || part.powerNet : null
    const railChanged = !!part?.powerNet && newRail !== (c.props.net?.trim() || part.powerNet)
    if (moveTo || rotation !== null || railChanged) {
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
        const what = [moveTo && `moving ${c.ref} to (${moveTo.x}, ${moveTo.y})`, rotation !== null && `rotating ${c.ref} to ${rotation}°`, railChanged && `putting ${c.ref} on net ${newRail}`]
          .filter(Boolean)
          .join(" and ")
        return fail(project, `Not changed: ${what}: ${problems.join("; ")}. Nothing was changed. ${suggestFit(project, c, moveTo, rotation, allowed, railChanged)}`)
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
    "Delete a component together with the wires and net labels attached only to its pins. Pins of other parts that hung from those wires are reported when they come loose.",
  input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  run: (project, input) => {
    const c = findByRef(project, input.ref)
    if (!c) return fail(project, `No component ${String(input.ref)}`)
    const pins = schematicPins(c).map((p) => p.pos)
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
      components: [c.id],
      wires: [...attachedIds],
      labels: orphanLabels.map((l) => l.id),
    })
    // Taking a part out of a wire others hang from cuts them loose; say so rather than leave it to Checks.
    const lost = connectionsLost(project, next, getConnectivity(project), getConnectivity(next))
    const note = lost.length ? ` Note: ${lost.slice(0, 3).join("; ")}. Reconnect them with connect.` : ""
    return ok(next, `Removed ${c.ref} and ${attached.length} attached wire(s).${note}`, `Removed ${c.ref} (${describePart(c)})`)
  },
}

/**
 * Plans a connection on one project. Only the nets of the pins asked for (and the named one) may
 * change; anything else a wire or label lands on is a short nobody asked for, so that way of
 * drawing it is dropped (`plan.allowed` is what may join).
 */
function connectPlanFor(project: Project, refs: PinRef[], netName: string) {
  const before = getConnectivity(project)
  const netOf = pinNetNames(project)
  const nameFor = () => {
    // A name someone chose beats one connect made up; a made-up one beats starting another.
    const names = refs.map((r) => netOf(r.componentId, r.pin)).filter((n): n is string => !!n && !n.startsWith("Net-("))
    const existing = names.find((n) => !AUTO_NET_NAME.test(n)) ?? names[0]
    if (existing) return existing
    const taken = new Set(before.nets.map((n) => n.name))
    let i = 1
    while (taken.has(`NET${i}`)) i++
    return `NET${i}`
  }
  const plan = planConnect(project, before, refs, { netName, nameFor, netOf: (r) => netOf(r.componentId, r.pin) })
  return { before, plan }
}

const connectTool: ToolSpec = {
  name: "connect",
  description:
    "Connect pins into one net. Pins are \"REF.PIN\" using a pin number or name (\"R1.2\", \"U1.VCC\"); one-pin parts can be given by ref alone (\"#PWR1\"). With net_name every pin gets a net label of that name (labels and power/ground ports with the same name are the same net, e.g. \"GND\", \"3V3\"). Without net_name, two pins get a drawn wire (or labels when a wire would run over other pins) and three or more get a shared auto-named label. A connect never joins other nets: a label is bent or moved around whatever is in its way, and pins that still cannot be reached are left out and named in the reply, with the rest connected. If no pin can be connected nothing is changed.",
  input_schema: {
    type: "object",
    properties: {
      pins: { type: "array", items: { type: "string" }, minItems: 1 },
      net_name: { type: "string" },
    },
    required: ["pins"],
  },
  run: (project, input) => {
    const specs = (input.pins as string[]).map((s) => s.trim()).filter(Boolean)
    const netName = typeof input.net_name === "string" ? input.net_name.trim() : ""
    if (specs.length < (netName ? 1 : 2)) return fail(project, "Give at least two pins, or one pin with net_name")
    const refs: PinRef[] = []
    const bad: string[] = []
    for (const spec of specs) {
      const r = resolveSpec(project, spec)
      if (r) refs.push(r)
      else bad.push(pinHelp(project, spec))
    }
    if (bad.length) return fail(project, `Unknown pin ${bad.join("; ")}`)
    const unique = refs.filter((r, i) => refs.findIndex((x) => x.componentId === r.componentId && x.pin === r.pin) === i)
    const netOf = pinNetNames(project)
    const labels = unique.map((r) => pinLabel(project, r))

    if (!netName && unique.length === 2) {
      const [a, b] = unique
      const na = netOf(a.componentId, a.pin)
      if (na && na === netOf(b.componentId, b.pin)) {
        return ok(project, `${labels.join(" and ")} are already connected on ${na}`, `${labels.join(", ")} already on ${na}`)
      }
    }

    const { before, plan } = connectPlanFor(project, unique, netName)
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
    const next = plan.project
    const after = getConnectivity(next)
    const joined = unrequestedMerges(next, before, after, plan.allowed)
    if (joined.length) {
      return fail(project, `Did not connect ${labels.join(", ")}: it would join ${joined.join("; ")}. Nothing was changed.`)
    }

    const finalNet = pinNetNames(next)(plan.onNet[0].componentId, plan.onNet[0].pin)
    const there = plan.onNet.map((r) => pinLabel(project, r)).join(", ")
    if (plan.failed.length) {
      const text = `Partly connected: ${there} are${finalNet ? ` on ${finalNet}` : " together"}. NOT connected: ${reasons(plan)}.${advice(plan)}${wireNote}`
      return ok(next, text, `Connected ${there}${finalNet ? ` on ${finalNet}` : ""}; ${plan.failed.length} pin(s) left out`)
    }
    return ok(
      next,
      `Connected ${labels.join(", ")}${finalNet ? ` on ${finalNet}` : ""}.${wireNote}`,
      `Connected ${labels.join(", ")}${finalNet ? ` on ${finalNet}` : ""}`,
    )
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
    const unplaced = project.components.filter((c) => isPhysical(findPart(c.partId)) && !c.pcb.placed)
    const lines: string[] = []
    if (conn.unconnectedPins.length) {
      lines.push(
        `Unconnected pins (${conn.unconnectedPins.length}): ${conn.unconnectedPins
          .slice(0, 40)
          .map((p) => `${refOf.get(p.componentId)}.${p.name === p.pin ? p.pin : `${p.pin}/${p.name}`}`)
          .join(", ")}`,
      )
    }
    if (erc.active.length) {
      lines.push(`Electrical (${erc.active.length} warning(s); they don't block fabrication, but each is likely a mistake):`)
      for (const f of erc.active.slice(0, 25)) lines.push(`- ${f.message}`)
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
      `Checks: ${conn.unconnectedPins.length} unconnected pin(s), ${errors} PCB error(s)${erc.active.length ? `, ${erc.active.length} electrical warning(s)` : ""}${parts.length ? `, ${parts.length} part warning(s)${partErrors ? ` (${partErrors} pinout error(s))` : ""}` : ""}`,
    )
  },
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
    if (!moved.size) return ok(project, all ? "No part can move: every part is locked or held by locked traces." : "Every part is already placed on the PCB.", "PCB already laid out")
    const b = next.board
    const outside = getPcbAnalysis(next).violations.filter((v) => v.kind === "outside-board").length
    const hint = outside ? ` ${outside} part(s) did not fit on the ${b.width}x${b.height} mm board; enlarge it with set_board.` : ""
    const caps = decouplingSummary(next, moved)
    const capNote = caps.total ? ` ${caps.near} of ${caps.total} decoupling capacitor(s) placed within 2 mm of their chip's supply pin.` : ""
    const stages = stageGaps(next)
      .map((s) => `${s.chipRef} ${s.kind} stage: ${s.gaps.slice(0, 6).map((g) => `${g.label} ${g.gap.toFixed(1)} mm`).join(", ")}.`)
      .join(" ")
    const stageNote = stages ? ` ${stages} Fine-tune with place_parts.` : ""
    const copper = repackCopper(project, next)
    const clearNote = copper.traces || copper.vias ? " Unlocked traces and vias were cleared; route again with route_pcb." : ""
    const stitchNote = copper.stitchedBefore || copper.stitchedAfter ? ` Pour stitching vias were placed again on the new layout (${copper.stitchedBefore} before, ${copper.stitchedAfter} now).` : ""
    return ok(next, `Placed ${moved.size} part(s) on the ${b.width}x${b.height} mm board.${capNote}${stageNote}${hint}${clearNote}${stitchNote}`, `Placed ${moved.size} part(s) on the PCB`)
  },
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const setBoardTool: ToolSpec = {
  name: "set_board",
  description:
    "Set the board: outline size in millimetres (width and height together), thickness, corner radius, copper weight, surface finish, solder mask and silkscreen colours, and corner mounting holes. Only the fields given change.",
  input_schema: {
    type: "object",
    properties: {
      width: { type: "number" },
      height: { type: "number" },
      thickness: { type: "number", enum: BOARD_THICKNESSES, description: "Finished thickness in mm" },
      corner_radius: { type: "number" },
      copper_oz: { type: "integer", enum: [1, 2], description: "Outer copper weight; 2 oz for high current" },
      finish: { type: "string", enum: SURFACE_FINISHES.map((f) => f.value) },
      mask_color: { type: "string", description: "Solder mask colour as #rrggbb; green is #1f6b3a" },
      silk_color: { type: "string", description: "Silkscreen colour as #rrggbb" },
      mounting_holes: { type: "string", enum: ["none", ...MOUNTING_HOLE_PRESETS.map((h) => h.id)] },
    },
  },
  run: (project, input) => {
    const b = { ...project.board }
    const changed: string[] = []
    if (input.width !== undefined || input.height !== undefined) {
      if (input.height === undefined) return fail(project, "input.height is required with input.width")
      if (input.width === undefined) return fail(project, "input.width is required with input.height")
      const width = Number(input.width)
      const height = Number(input.height)
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
    if (!changed.length) return fail(project, "Give at least one board property to change")
    const next = { ...project, updatedAt: Date.now(), board: b }
    return ok(next, `Board: ${changed.join(", ")}.`, `Board set: ${changed.join(", ")}`)
  },
}

/** The rules a model reads back, in millimetres with the tool's own names. */
function ruleSummary(r: DesignRules) {
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
    via_in_pad: r.viaInPad,
    tent_vias: r.tentVias,
    pour_clearance: r.pourClearance,
    thermal_relief: r.thermalRelief,
    net_widths: r.netWidths,
  }
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
    if (!changed.length) return fail(project, "Give at least one rule to change")
    if (rules.traceWidth < rules.minTraceWidth) return fail(project, `trace_width ${rules.traceWidth} is below min_trace_width ${rules.minTraceWidth}`)
    if (rules.viaDrill >= rules.viaDiameter) return fail(project, "via_drill must be smaller than via_diameter")
    const next = { ...project, updatedAt: Date.now(), rules }
    const errors = getPcbAnalysis(next).violations.filter((v) => v.severity === "error" && v.kind !== "unrouted").length
    const after = errors ? ` The board now has ${errors} check error(s); run_checks lists them.` : ""
    return ok(next, `Design rules: ${changed.join(", ")}.${after}`, `Design rules set: ${changed.join(", ")}`)
  },
}

/**
 * What to tell the model about connections route_pcb left open. Connections at fine-pitch pads are
 * not a space problem: the router has already tried stubs and thinner traces, so moving parts apart
 * or a bigger board changes nothing for them. And the same layout, rules and time give the same
 * result, so clearing the routing and running it again only repeats it. Hand routing is offered
 * only once the fine-pitch retry has run and failed.
 */
export function unroutedAdvice(res: AutorouteResult): string {
  const fine = Math.min(res.finePitchOpen, res.remaining)
  const rest = res.remaining - fine
  const parts = [` ${res.remaining} connection(s) could not be routed.`]
  if (fine) {
    const where = ` ${fine} of them end at fine-pitch pads (pads less than 0.7 mm apart, as on a USB-C receptacle or a QFN).`
    if (res.finePitchTried === null) {
      // The retry did not run: the pads leave no room for even a minimum-width trace at these rules, or time ran out.
      parts.push(
        `${where} The fine-pitch retry (escape stubs and thinner traces) did not run to the end: at this clearance and minimum trace width a trace cannot leave those pads, or the time ran out. This is not a shortage of room, so spreading the parts out or enlarging the board will not fix it.` +
          " To go on: set_design_rules for a finer fab class (smaller minimum trace width and clearance) if the board's fab can make it, or use place_parts to turn the part so its pads face open board.",
      )
    } else {
      parts.push(
        `${where} The router already tried short escape stubs from those pads and traces thinner than the default, down to ${res.finePitchTried} mm, the board's minimum trace width (supply nets and nets with a width set keep theirs away from the pads), escaping in alternate directions, and one rip-up of the copper beside them. This is not a shortage of room, so spreading the parts out or enlarging the board will not fix it.` +
          " To go on: use place_parts to move or turn the fine-pitch part so its pads face open board, set_design_rules for a finer fab class (smaller minimum trace width and clearance) if the board's fab can make it, or, if neither fits, tell the user to route those connections by hand.",
      )
    }
  }
  if (rest) {
    parts.push(` ${rest} other connection(s) may be short of room: move parts apart with place_parts or enlarge the board with set_board, then run route_pcb.`)
  }
  parts.push(" Do not clear_routing and run route_pcb again on the same layout: the same layout and rules give the same result, so change the layout, the rules or the board first.")
  return parts.join("")
}

const routePcbTool: ToolSpec = {
  name: "route_pcb",
  description:
    "Autoroute every open ratsnest connection on two layers with vias, keeping existing traces. Lay out the PCB first. Pads of poured nets drop a via into the pour. Stitching vias are stitched again after routing.",
  input_schema: { type: "object", properties: {} },
  run: (project) => {
    if (!project.components.some((c) => c.pcb.placed && isPhysical(findPart(c.partId)))) {
      return fail(project, "No parts are on the PCB yet; run layout_pcb first")
    }
    const res = routeAroundStitching(project, (p) => autoroute(p))
    if (!res.routed && !res.remaining) return ok(project, "Every connection is already routed.", "Nothing to route")
    const tail = res.remaining ? unroutedAdvice(res) : ""
    return ok(
      res.project,
      `Routed ${res.routed} connection(s) with ${res.addedTraces} trace(s) and ${res.addedVias} via(s).${tail}`,
      res.remaining ? `Routed ${res.routed}, ${res.remaining} left` : `Routed ${res.routed} connections`,
    )
  },
}

const pourTool: ToolSpec = {
  name: "set_pour",
  description:
    "Add or remove a copper pour (filled zone) for a net on a copper layer, usually GND on both layers. Pours connect same-net pads and keep clearance from other nets. With stitch, also tie the top and bottom pours of the net together with a grid of vias; do that after routing so the vias do not block traces.",
  input_schema: {
    type: "object",
    properties: {
      net: { type: "string", description: "Net name, e.g. GND" },
      layer: { type: "string", enum: ["top", "bottom", "both"] },
      remove: { type: "boolean", description: "Remove the pour instead of adding it" },
      stitch: { type: "boolean", description: "Add stitching vias between the top and bottom pours of this net" },
    },
    required: ["net", "layer"],
  },
  run: (project, input) => {
    const net = String(input.net).trim()
    const layers = input.layer === "both" ? (["top", "bottom"] as const) : ([input.layer as "top" | "bottom"] as const)
    if (input.remove === true) {
      const zones = project.zones.filter((z) => !(z.net === net && (layers as readonly string[]).includes(z.layer)))
      if (zones.length === project.zones.length) return fail(project, `There is no ${net} pour on ${input.layer}`)
      // Stitching only makes sense while the net is poured on both layers.
      return ok(removeStitching({ ...project, zones }, net), `Removed the ${net} pour on ${input.layer}.`, `Removed ${net} pour`)
    }
    if (!getConnectivity(project).nets.some((n) => n.name === net && n.pins.length > 0)) {
      return fail(project, `No pins are on a net named ${net}`)
    }
    const add = layers.filter((l) => !project.zones.some((z) => z.net === net && z.layer === l))
    const next = add.length ? { ...project, updatedAt: Date.now(), zones: [...project.zones, ...add.map((layer) => ({ id: uid("z"), net, layer }))] } : project
    const poured = add.length ? `Poured ${net} on ${add.join(" and ")}` : `${net} is already poured on ${input.layer}`
    if (input.stitch === true) {
      const res = stitchVias(next, net)
      if (!res.added) return ok(res.project, `${poured}. No stitching vias fit: ${net} needs solid pours on both layers away from parts.`, "No stitching vias fit")
      return ok(res.project, `${poured}. Added ${res.added} stitching vias.`, `Stitched ${net} with ${res.added} vias`)
    }
    return ok(next, `${poured}.`, poured)
  },
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
    "Arrange the schematic the way an engineer would draw it: blocks in reading order by signal flow (power in and inputs on the left, regulation, the controller in the middle, peripherals and outputs on the right), each laid out about its main part with its small parts beside the pins they serve, short wires inside a block, a net label wherever a net leaves its block, power ports above and ground below. It never changes what is connected and is one undo step. Give blocks to tidy just those blocks, each where it is. With no blocks it tidies the whole sheet when the sheet was empty at the start of this request or whole_sheet is true (parts in no block are then gathered into a block named OTHER), and otherwise only the blocks made or changed in this request, so the rest of the drawing stays as the user drew it. A block it can't lay out is left exactly as drawn while the others are tidied, and the reply names it and says why.",
  input_schema: {
    type: "object",
    properties: {
      blocks: { type: "array", items: { type: "string" }, description: "Names of the blocks to tidy, each where it is" },
      whole_sheet: { type: "boolean", description: "Tidy the whole sheet: only when the user asks for it, or the sheet was empty before this request" },
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
    } else if (input.whole_sheet !== true && context.start && context.start.components.some((c) => isPhysical(findPart(c.partId)))) {
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
    return ok(next, [said.join(" ") + named, ...left].join(" "), heads.join(" "))
  },
}

export const TOOL_SPECS: ToolSpec[] = [
  getDesign,
  searchPartsTool,
  findPartTool,
  getPartDataTool,
  readDatasheetTool,
  createPartTool,
  verifyPartsTool,
  addComponentTool,
  updateComponentTool,
  removeComponentTool,
  connectTool,
  groupPartsTool,
  editBlockTool,
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
        if (obj[key] === undefined) return `${path}.${key} is required`
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties?.[key]
        if (prop) {
          const err = validateInput(prop, v, `${path}.${key}`)
          if (err) return err
        } else if (typeof schema.additionalProperties === "object") {
          const err = validateInput(schema.additionalProperties, v, `${path}.${key}`)
          if (err) return err
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
export function runTool(project: Project, name: string, input: unknown, context: ToolContext = {}): ToolOutcome {
  const spec = specByName.get(name)
  if (!spec) return fail(project, `Unknown tool ${name}`)
  const err = validateInput(spec.input_schema, input ?? {})
  if (err) return fail(project, `Invalid input: ${err}`)
  try {
    return spec.run(project, (input ?? {}) as ToolInput, undefined, context)
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
    return { ...spec.run(base, args, prepared, ctx), base }
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
    case "look":
      return `Looking at the ${i.target === "pcb" ? "PCB" : i.target === "3d" ? "3D board" : "schematic"}`
    case "group_parts":
      return `Grouping parts into ${String(i.block ?? "a block")}`
    case "edit_block":
      return `Editing block ${String(i.block ?? "")}`
    case "tidy_schematic":
      return Array.isArray(i.blocks) && i.blocks.length ? `Tidying ${i.blocks.map(String).join(", ")}` : "Tidying the schematic"
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
      return "Routing the board"
    case "set_pour":
      return `Pouring ${String(i.net ?? "copper")}`
    default:
      return drawingToolLabel(name, i) ?? pcbToolLabel(name, i) ?? name
  }
}
