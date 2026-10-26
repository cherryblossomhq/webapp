import { emptyBox, expandBox, round, snap, type Box } from "../lib/geometry"
import { blockFrames, componentTextBoxes, findBlock } from "../model/blocks"
import {
  addDrawings,
  CORNER_RADII,
  DRAWING_COLORS,
  drawingBounds,
  drawingKind,
  LINE_DASHES,
  LINE_WEIGHTS,
  moveDrawing,
  removeDrawings,
  reorderDrawings,
  rotateDrawing,
  TEXT_SIZES,
  updateDrawings,
  type NewDrawing,
} from "../model/drawings"
import { schematicBounds } from "../model/instances"
import { SCH_GRID } from "../model/symbols"
import type { DrawingColor, DrawingStyle, DrawingText, LineDash, LineWeight, Project, SchematicDrawing, Vec2 } from "../model/types"
import { SHEET_ARG } from "./sheetTools"
import { fail, ok, type JsonSchema, type ToolInput, type ToolSpec } from "./toolKit"

// The copilot's drawing tools: titles, notes, callouts, arrows and boxes on the schematic, the same
// drawings the user makes with the toolbar's drawing tools (`model/drawings.ts`), so Sakura can
// dress a sheet as well as a person can and edit what either of them drew.

const snapSch = (n: number) => round(snap(n, SCH_GRID))
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const SIZE_BY_NAME = new Map<string, number>(TEXT_SIZES.map((s) => [s.id, s.size]))
const sizeName = (size: number) => TEXT_SIZES.find((s) => s.size === size)?.id ?? String(size)
const RADIUS_BY_NAME = new Map<string, number>(CORNER_RADII.map((c) => [c.id, c.radius]))
const ARROWS = ["none", "start", "end", "both"]

const POINT: JsonSchema = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }

/** The style fields both tools take. */
const STYLE_PROPS: Record<string, JsonSchema> = {
  color: { type: "string", enum: DRAWING_COLORS, description: "Line or text colour; ink (the sheet's text colour) by default" },
  fill: { type: "string", enum: [...DRAWING_COLORS, "none"], description: "A soft tint inside a closed shape or behind a text; none by default" },
  weight: { type: "string", enum: LINE_WEIGHTS, description: "Line weight; medium by default" },
  dash: { type: "string", enum: LINE_DASHES, description: "solid by default" },
}

/** The text, line and box fields both tools take. */
const SHAPE_PROPS: Record<string, JsonSchema> = {
  text: { type: "string", description: "text: what it says; \\n starts a new line" },
  size: { type: "string", enum: TEXT_SIZES.map((s) => s.id), description: `text: ${TEXT_SIZES.map((s) => `${s.id} ${s.size}`).join(", ")} units tall; normal by default` },
  align: { type: "string", enum: ["left", "center", "right"], description: "text: which end of its lines x is at; left by default" },
  bold: { type: "boolean" },
  italic: { type: "boolean" },
  mono: { type: "boolean", description: "text: in the monospace face, for part numbers and values" },
  border: { type: "boolean", description: "text: an outline around it, for a note" },
  rotation: { type: "integer", enum: [0, 90], description: "text: 90 reads upwards" },
  width: { type: "number", description: "rect" },
  height: { type: "number", description: "rect" },
  corners: { type: "string", enum: CORNER_RADII.map((c) => c.id), description: "rect: square (none) by default" },
  points: { type: "array", items: POINT, minItems: 2, description: "line: its corners in order" },
  closed: { type: "boolean", description: "line: join the last point to the first, a polygon" },
  arrows: { type: "string", enum: ARROWS, description: "line: arrowheads on an open line" },
  ...STYLE_PROPS,
}

const SHAPE: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["text", "line", "rect"] },
    x: { type: "number", description: "text: the top of its first line, at its left end (or middle, or right end, by align). rect: the lower-left corner" },
    y: { type: "number" },
    around: {
      type: "array",
      items: { type: "string" },
      description: 'rect: draw around these designators or block names (["U1", "C3"], ["3.3V POWER"]) instead of giving x, y, width and height',
    },
    padding: { type: "number", description: "With around: room between the shape and what it surrounds; 0.3 by default" },
    ...SHAPE_PROPS,
  },
  required: ["type"],
}

/** The style a call asks for, with `none` read as no fill. */
function styleFrom(input: ToolInput): DrawingStyle & { fill?: DrawingColor } {
  const style: DrawingStyle = {}
  if (typeof input.color === "string") style.color = input.color as DrawingColor
  if (typeof input.fill === "string" && input.fill !== "none") style.fill = input.fill as DrawingColor
  if (typeof input.weight === "string") style.weight = input.weight as LineWeight
  if (typeof input.dash === "string") style.dash = input.dash as LineDash
  return style
}

/** The box around parts and blocks, by designator or block name, or the names it doesn't know. */
function boxAround(project: Project, names: string[], padding: number): Box | string {
  const b = emptyBox()
  const missing: string[] = []
  const add = (box: Box) => {
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
  }
  const frames = new Map(blockFrames(project).map((f) => [f.id, f.box]))
  for (const raw of names) {
    const name = raw.trim()
    const c = project.components.find((x) => x.ref.toLowerCase() === name.toLowerCase())
    const block = c ? undefined : findBlock(project, name)
    if (c) {
      add(schematicBounds(c))
      componentTextBoxes(c).forEach(add)
    } else if (block && frames.has(block.id)) add(frames.get(block.id)!)
    else missing.push(name)
  }
  if (missing.length) return `No part or block ${missing.join(", ")}`
  const floor = (n: number) => round(Math.floor(n / SCH_GRID + 1e-6) * SCH_GRID)
  const ceil = (n: number) => round(Math.ceil(n / SCH_GRID - 1e-6) * SCH_GRID)
  return { minX: floor(b.minX - padding), minY: floor(b.minY - padding), maxX: ceil(b.maxX + padding), maxY: ceil(b.maxY + padding) }
}

/** One shape of a `draw` call as a drawing, or what is wrong with it. */
function shapeFrom(project: Project, s: ToolInput, at: string): NewDrawing | string {
  const style = styleFrom(s)
  if (s.type === "text") {
    const text = typeof s.text === "string" ? s.text.replace(/\s+$/, "") : ""
    if (!text.trim()) return `${at}: a text needs text`
    if (num(s.x) === undefined || num(s.y) === undefined) return `${at}: a text needs x and y`
    return {
      type: "text",
      text,
      x: snapSch(s.x as number),
      y: snapSch(s.y as number),
      size: SIZE_BY_NAME.get(String(s.size ?? "normal")) ?? SIZE_BY_NAME.get("normal")!,
      ...(typeof s.align === "string" && { align: s.align as DrawingText["align"] }),
      bold: s.bold === true,
      italic: s.italic === true,
      mono: s.mono === true,
      border: s.border === true,
      ...(s.rotation === 90 && { rot: 90 as const }),
      ...style,
    }
  }
  if (s.type === "line") {
    const points = Array.isArray(s.points) ? (s.points as Vec2[]).map((p) => ({ x: snapSch(p.x), y: snapSch(p.y) })) : []
    if (points.length < 2) return `${at}: a line needs at least two points`
    const closed = s.closed === true && points.length > 2
    return {
      type: "line",
      points,
      ...(closed && { closed: true }),
      ...(!closed && typeof s.arrows === "string" && s.arrows !== "none" && { arrows: s.arrows as "start" | "end" | "both" }),
      ...style,
    }
  }
  if (s.type === "rect") {
    let box: Box
    if (Array.isArray(s.around) && s.around.length) {
      const found = boxAround(project, s.around as string[], num(s.padding) ?? 0.3)
      if (typeof found === "string") return `${at}: ${found}`
      box = found
    } else {
      const [x, y, w, h] = [num(s.x), num(s.y), num(s.width), num(s.height)]
      if (x === undefined || y === undefined || w === undefined || h === undefined) return `${at}: a ${s.type} needs x, y, width and height, or around`
      if (!(w > 0 && h > 0)) return `${at}: width and height must be above 0`
      box = { minX: snapSch(x), minY: snapSch(y), maxX: snapSch(x + w), maxY: snapSch(y + h) }
    }
    const width = round(Math.max(SCH_GRID, box.maxX - box.minX))
    const height = round(Math.max(SCH_GRID, box.maxY - box.minY))
    const radius = RADIUS_BY_NAME.get(String(s.corners ?? "none"))
    return { type: "rect", x: box.minX, y: box.minY, width, height, ...(radius && { radius }), ...style }
  }
  return `${at}: unknown type ${String(s.type)}`
}

const boxText = (b: Box) => `x ${round(b.minX, 2)} to ${round(b.maxX, 2)}, y ${round(b.minY, 2)} to ${round(b.maxY, 2)}`

/** A drawing in a line: its id, what it is and where, so it can be edited later. */
function describe(d: SchematicDrawing): string {
  const what = d.type === "text" ? `Text "${d.text.length > 40 ? `${d.text.slice(0, 40)}...` : d.text}"` : drawingKind(d)
  return `${d.id} ${what} over ${boxText(drawingBounds(d))}`
}

/** Drawings as get_design reports them, small per drawing. */
export function designDrawings(project: Project) {
  return (project.drawings ?? []).map((d) => {
    const b = drawingBounds(d)
    const style = { ...(d.color && { color: d.color }), ...(d.fill && { fill: d.fill }), ...(d.weight && { weight: d.weight }), ...(d.dash && { dash: d.dash }) }
    const box = { min_x: round(b.minX, 2), min_y: round(b.minY, 2), max_x: round(b.maxX, 2), max_y: round(b.maxY, 2) }
    if (d.type === "text") {
      const flags = { ...(d.align && { align: d.align }), ...(d.bold && { bold: true }), ...(d.italic && { italic: true }), ...(d.mono && { mono: true }), ...(d.border && { border: true }), ...(d.rot && { rotation: d.rot }) }
      return { id: d.id, type: d.type, text: d.text, x: d.x, y: d.y, size: sizeName(d.size), ...flags, ...style, box }
    }
    if (d.type === "line") return { id: d.id, type: d.type, points: d.points, ...(d.closed && { closed: true }), ...(d.arrows && { arrows: d.arrows }), ...style }
    return { id: d.id, type: d.type, x: d.x, y: d.y, width: d.width, height: d.height, ...(d.radius && { corners: CORNER_RADII.find((c) => c.radius === d.radius)?.id ?? "small" }), ...style }
  })
}

const drawTool: ToolSpec = {
  name: "draw",
  description:
    "Draw on the schematic, as the user does with the toolbar's drawing tools: text (a sheet title, a note, a callout), lines and arrows, polygons and rectangles. Drawings are graphics only: they connect nothing, and blocks already frame their parts. Schematic units, y up, on a 0.1 grid. Several shapes in one call; each result gives the drawing's id for edit_drawings.",
  input_schema: {
    type: "object",
    properties: { shapes: { type: "array", items: SHAPE, minItems: 1 }, sheet: SHEET_ARG },
    required: ["shapes"],
  },
  run: (project, input) => {
    const shapes = input.shapes as ToolInput[]
    const made: NewDrawing[] = []
    const problems: string[] = []
    shapes.forEach((s, i) => {
      const d = shapeFrom(project, s, `shapes[${i}]`)
      if (typeof d === "string") problems.push(d)
      else made.push(d)
    })
    if (problems.length) return fail(project, `Nothing was drawn. ${problems.join("; ")}`)
    const { project: next, added } = addDrawings(project, made)
    const kinds = added.map((d) => drawingKind(d).toLowerCase())
    return ok(next, `Drew ${added.length}: ${added.map(describe).join("; ")}.`, `Drew ${kinds.length === 1 ? `a ${kinds[0]}` : `${kinds.length} drawings (${[...new Set(kinds)].join(", ")})`}`)
  },
}

const editDrawingsTool: ToolSpec = {
  name: "edit_drawings",
  description:
    "Change, move, turn, reorder or delete drawings on the schematic by id (get_design lists them, with the user's): their text, size, position, points, style or arrows. Fields that don't apply to a drawing's type are left alone. move_by shifts them; order front draws them over other drawings, back under.",
  input_schema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, minItems: 1 },
      remove: { type: "boolean", description: "Delete them" },
      move_by: { ...POINT, description: "Shift them by x and y units" },
      x: { type: "number", description: "text and rect: put it here (as in draw)" },
      y: { type: "number" },
      rotate: { type: "boolean", description: "A quarter turn anticlockwise about each one's middle" },
      order: { type: "string", enum: ["front", "back"] },
      ...SHAPE_PROPS,
    },
    required: ["ids"],
  },
  run: (project, input) => {
    const ids = [...new Set((input.ids as string[]).map((id) => id.trim()))]
    const all = project.drawings ?? []
    const missing = ids.filter((id) => !all.some((d) => d.id === id))
    if (missing.length) {
      const known = all.slice(0, 12).map((d) => d.id).join(", ")
      return fail(project, `No drawing ${missing.join(", ")}. ${all.length ? `Drawings: ${known}${all.length > 12 ? ", ..." : ""}` : "The schematic has no drawings yet."}`)
    }
    if (input.remove === true) {
      return ok(removeDrawings(project, ids), `Deleted ${ids.length} drawing(s): ${ids.join(", ")}.`, `Deleted ${ids.length} drawing(s)`)
    }
    const style = styleFrom(input)
    const edit = (d: SchematicDrawing): SchematicDrawing => {
      let n: SchematicDrawing = { ...d, ...style }
      if (input.fill === "none") n.fill = undefined
      if (n.type === "text") {
        if (typeof input.text === "string" && input.text.trim()) n.text = input.text.replace(/\s+$/, "")
        if (typeof input.size === "string" && SIZE_BY_NAME.has(input.size)) n.size = SIZE_BY_NAME.get(input.size)!
        if (typeof input.align === "string") n.align = input.align as DrawingText["align"]
        for (const k of ["bold", "italic", "mono", "border"] as const) if (typeof input[k] === "boolean") n[k] = input[k] as boolean
        if (input.rotation === 0 || input.rotation === 90) n.rot = input.rotation
      } else if (n.type === "line") {
        if (Array.isArray(input.points) && input.points.length >= 2) n.points = (input.points as Vec2[]).map((p) => ({ x: snapSch(p.x), y: snapSch(p.y) }))
        if (typeof input.closed === "boolean") n.closed = input.closed && n.points.length > 2
        if (typeof input.arrows === "string") n.arrows = input.arrows === "none" ? undefined : (input.arrows as "start" | "end" | "both")
      } else {
        const w = num(input.width)
        const h = num(input.height)
        if (w !== undefined && w > 0) n.width = Math.max(SCH_GRID, snapSch(w))
        if (h !== undefined && h > 0) n.height = Math.max(SCH_GRID, snapSch(h))
        if (n.type === "rect" && typeof input.corners === "string") n.radius = RADIUS_BY_NAME.get(input.corners) || undefined
      }
      if (n.type !== "line" && (num(input.x) !== undefined || num(input.y) !== undefined)) {
        n = { ...n, x: num(input.x) !== undefined ? snapSch(input.x as number) : n.x, y: num(input.y) !== undefined ? snapSch(input.y as number) : n.y }
      }
      if (input.move_by) {
        const by = input.move_by as Vec2
        n = moveDrawing(n, { x: snapSch(by.x), y: snapSch(by.y) })
      }
      if (input.rotate === true) n = rotateDrawing(n)
      return JSON.stringify(n) === JSON.stringify(d) ? d : n
    }
    let next = updateDrawings(project, ids, edit)
    if (typeof input.order === "string") next = reorderDrawings(next, ids, input.order as "front" | "back")
    if (next === project) return ok(project, `No changes to ${ids.join(", ")}: the fields given don't apply to ${ids.length > 1 ? "them" : "it"} or are what ${ids.length > 1 ? "they have" : "it has"} already.`, "No drawing changes")
    const after = ids.map((id) => next.drawings!.find((d) => d.id === id)!)
    return ok(next, `Changed ${after.length}: ${after.map(describe).join("; ")}.`, `Changed ${after.length} drawing(s)`)
  },
}

export const drawingToolSpecs: ToolSpec[] = [drawTool, editDrawingsTool]

/** Short present-tense label shown while a drawing tool runs; null for other tools. */
export function drawingToolLabel(name: string, input: ToolInput): string | null {
  if (name === "draw") {
    const shapes = Array.isArray(input.shapes) ? (input.shapes as ToolInput[]) : []
    const text = shapes.find((s) => s.type === "text" && typeof s.text === "string")?.text as string | undefined
    return text ? `Writing "${text.split("\n")[0].slice(0, 32)}" on the schematic` : "Drawing on the schematic"
  }
  if (name === "edit_drawings") return input.remove === true ? "Deleting drawings" : "Editing drawings"
  return null
}
