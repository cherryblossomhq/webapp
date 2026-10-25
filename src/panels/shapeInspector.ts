import { SHAPE_NAMES, isClosedShape, shapeBox } from "../model/shapes"
import { SHAPE_LAYERS, shapeLayerInfo, type ShapeLayerKind } from "../model/shapeLayers"
import { parseShapeId } from "../model/shapeItems"
import type { BoardShape, Project, ShapeDash } from "../model/types"

// What the Inspector shows for drawings: pure functions, so they are tested without a browser.

export const MIXED = "__mixed" as const

/** The value every item has, or MIXED when they differ (an empty list has none: undefined). */
export function common<T>(values: T[]): T | typeof MIXED | undefined {
  if (!values.length) return undefined
  return values.every((v) => v === values[0]) ? values[0] : MIXED
}

export const DASH_OPTIONS: { value: ShapeDash | ""; label: string }[] = [
  { value: "", label: "Solid" },
  { value: "dash", label: "Dash" },
  { value: "dot", label: "Dot" },
  { value: "dash_dot", label: "Dash and dot" },
  { value: "dash_dot_dot", label: "Dash dot dot" },
]

const KIND_ORDER: ShapeLayerKind[] = ["silk", "mask", "paste", "fab", "courtyard", "adhesive", "user", "copper"]
const KIND_LABELS: Record<ShapeLayerKind, string> = {
  copper: "Copper",
  silk: "Silkscreen",
  mask: "Solder mask",
  paste: "Paste",
  fab: "Fabrication",
  courtyard: "Courtyard",
  adhesive: "Adhesive",
  user: "User",
}

export interface LayerGroup {
  label: string
  layers: { name: string; label: string }[]
}

/** The layer picker's options grouped by kind. A layer that is not one of KiCad's but is on a drawing is listed first, so it shows. */
export function layerGroups(current: string[] = []): LayerGroup[] {
  const groups: LayerGroup[] = []
  const unusual = [...new Set(current)].filter((l) => !shapeLayerInfo(l))
  if (unusual.length) groups.push({ label: "Other", layers: unusual.map((name) => ({ name, label: name })) })
  for (const kind of KIND_ORDER) {
    const layers = SHAPE_LAYERS.filter((l) => l.kind === kind).map((l) => ({ name: l.name, label: l.label }))
    if (layers.length) groups.push({ label: KIND_LABELS[kind], layers })
  }
  return groups
}

export const layerLabel = (name: string) => shapeLayerInfo(name)?.label ?? name
export const isCopperLayer = (name: string) => shapeLayerInfo(name)?.kind === "copper"

export interface ShapeFacts {
  count: number
  /** "Line", or "Mixed" when the selection has several kinds. */
  type: string
  layer: string | typeof MIXED
  width: number | typeof MIXED
  dash: ShapeDash | "" | typeof MIXED
  fill: boolean | typeof MIXED
  locked: boolean | typeof MIXED
  net: string | typeof MIXED
  /** The fill switch only applies when every drawing can be filled. */
  allClosed: boolean
  anyCopper: boolean
  /** The box of all of them together, or null for none. */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null
}

export function shapeFacts(shapes: BoardShape[]): ShapeFacts {
  const types = [...new Set(shapes.map((s) => SHAPE_NAMES[s.type]))]
  let box: ShapeFacts["box"] = null
  for (const s of shapes) {
    const b = shapeBox(s)
    box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b
  }
  return {
    count: shapes.length,
    type: types.length === 1 ? types[0] : types.length ? "Mixed" : "",
    layer: (common(shapes.map((s) => s.layer)) ?? "") as string,
    width: (common(shapes.map((s) => s.width)) ?? 0) as number,
    dash: (common(shapes.map((s) => s.dash ?? "")) ?? "") as ShapeFacts["dash"],
    fill: (common(shapes.map((s) => !!s.fill)) ?? false) as boolean | typeof MIXED,
    locked: (common(shapes.map((s) => !!s.locked)) ?? false) as boolean | typeof MIXED,
    net: (common(shapes.map((s) => s.net ?? "")) ?? "") as string,
    allClosed: shapes.length > 0 && shapes.every(isClosedShape),
    anyCopper: shapes.some((s) => isCopperLayer(s.layer)),
    box,
  }
}

/** A drawing in a list: its kind and where it is drawn. */
export const shapeRowText = (s: BoardShape) => `${SHAPE_NAMES[s.type]}, ${layerLabel(s.layer)}`

/** The board drawings among selection ids, in selection order, those that still exist. */
export function selectedGraphicIds(project: Project, selection: string[]): string[] {
  const have = new Set((project.graphics ?? []).map((g) => g.id))
  return selection.flatMap((id) => {
    const p = parseShapeId(id)
    return p?.kind === "board" && have.has(p.graphic) ? [p.graphic] : []
  })
}

/** The land drawings of one part among selection ids: the indices that exist in the part's own land. */
export function selectedLandIndices(selection: string[], componentId: string, count: number): number[] {
  return [...new Set(selection.flatMap((id) => {
    const p = parseShapeId(id)
    return p?.kind === "land" && p.component === componentId && p.index >= 0 && p.index < count ? [p.index] : []
  }))].sort((a, b) => a - b)
}

/**
 * When the selection is only `s:` ids of one part, the part. The Inspector then opens that part's
 * panel with those drawings picked, rather than a count.
 */
export function landSelectionOwner(selection: string[]): string | null {
  if (!selection.length) return null
  let owner: string | null = null
  for (const id of selection) {
    const p = parseShapeId(id)
    if (p?.kind !== "land") return null
    if (owner !== null && owner !== p.component) return null
    owner = p.component
  }
  return owner
}

/** How many parts are drawn with this land. */
export const landUsers = (project: Project, land: string) => project.components.filter((c) => c.footprint === land).length

/** A typed offset in millimetres, or null when it is not a finite number (a comma is a decimal point). */
export function parseOffset(text: string): number | null {
  const t = text.trim().replace(",", ".")
  if (t === "") return 0
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** "12.3 x 4.5" for a box, in the unit's text. */
export const sizeText = (box: NonNullable<ShapeFacts["box"]>, fmt: (mm: number) => string) => `${fmt(box.maxX - box.minX)} x ${fmt(box.maxY - box.minY)}`
