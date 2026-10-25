import { shapeLayerInfo } from "../model/shapeLayers"
import { textLayerKind, type WorldText } from "../model/texts"
import { common, layerGroups, MIXED } from "./shapeInspector"

// What the Inspector shows for texts: pure functions, so they are tested without a browser.

export interface TextFacts {
  count: number
  kind: string | typeof MIXED
  layer: string | typeof MIXED
  size: number | typeof MIXED
  w: number | typeof MIXED
  thickness: number | typeof MIXED
  bold: boolean | typeof MIXED
  italic: boolean | typeof MIXED
  mirror: boolean | typeof MIXED
  knockout: boolean | typeof MIXED
  locked: boolean | typeof MIXED
  hide: boolean | typeof MIXED
  upright: boolean | typeof MIXED
  hj: -1 | 0 | 1 | typeof MIXED
  vj: -1 | 0 | 1 | typeof MIXED
  spacing: number | typeof MIXED
  rot: number | typeof MIXED
  /** Every text belongs to a part. */
  allPart: boolean
  anyBox: boolean
}

const KIND_NAMES: Record<string, string> = { board: "Board text", reference: "Reference", value: "Value", user: "Part text" }

export function textFacts(texts: WorldText[]): TextFacts {
  const kinds = [...new Set(texts.map((t) => KIND_NAMES[t.kind]))]
  return {
    count: texts.length,
    kind: kinds.length === 1 ? kinds[0] : MIXED,
    layer: common(texts.map((t) => t.layer)) ?? "",
    size: common(texts.map((t) => t.size)) ?? 0,
    w: common(texts.map((t) => t.w)) ?? 0,
    thickness: common(texts.map((t) => t.thickness)) ?? 0,
    bold: common(texts.map((t) => t.bold)) ?? false,
    italic: common(texts.map((t) => t.italic)) ?? false,
    mirror: common(texts.map((t) => t.mirror)) ?? false,
    knockout: common(texts.map((t) => t.knockout)) ?? false,
    locked: common(texts.map((t) => t.locked)) ?? false,
    hide: common(texts.map((t) => t.hidden)) ?? false,
    upright: common(texts.map((t) => t.upright)) ?? false,
    hj: common(texts.map((t) => t.hj)) ?? 0,
    vj: common(texts.map((t) => t.vj)) ?? 0,
    spacing: common(texts.map((t) => t.spacing)) ?? 1,
    rot: common(texts.map((t) => t.rot)) ?? 0,
    allPart: texts.every((t) => t.kind !== "board"),
    anyBox: texts.some((t) => !!t.box),
  }
}

/** The layers a text can be on, grouped for a picker: the drawing layers and the board's edge. */
export function textLayerGroups(current: string[] = []) {
  const groups = layerGroups(current)
  groups.push({ label: "Board", layers: [{ name: "Edge.Cuts", label: "Board edge" }] })
  return groups
}

export const isCopperText = (layer: string) => textLayerKind(layer) === "copper"
export const textLayerLabel = (name: string) => (name === "Edge.Cuts" ? "Board edge" : (shapeLayerInfo(name)?.label ?? name))

/** The row a text has in a part's list: what it shows, trimmed. */
export function textRowText(t: WorldText, shown: string): string {
  const head = t.kind === "reference" ? "Reference" : t.kind === "value" ? "Value" : "Text"
  const body = shown.replace(/\s+/g, " ").trim()
  return `${head}${body ? `: ${body.length > 24 ? `${body.slice(0, 23)}...` : body}` : ""}${t.hidden ? " (hidden)" : ""}`
}
