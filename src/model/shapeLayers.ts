// The layers a drawing can be on, by KiCad's names (`F.SilkS`, `B.Mask`, `User.7`...), and what each
// one is for. Copper is `F.Cu`, `B.Cu` and, on a board of more than two copper layers (X1), `In1.Cu` to
// `In30.Cu`; the board's edge (`Edge.Cuts`) is the outline and not a drawing layer here.

export type ShapeLayerKind = "copper" | "silk" | "mask" | "paste" | "fab" | "courtyard" | "adhesive" | "user"

export interface ShapeLayerInfo {
  name: string
  kind: ShapeLayerKind
  /** Which side of the board the layer is on, or null for a layer that has none (the user layers). */
  side: "top" | "bottom" | null
  label: string
}

const SIDED: [string, ShapeLayerKind, string][] = [
  ["F.Cu", "copper", "Top copper"],
  ["B.Cu", "copper", "Bottom copper"],
  ["F.SilkS", "silk", "Top silkscreen"],
  ["B.SilkS", "silk", "Bottom silkscreen"],
  ["F.Mask", "mask", "Top solder mask"],
  ["B.Mask", "mask", "Bottom solder mask"],
  ["F.Paste", "paste", "Top paste"],
  ["B.Paste", "paste", "Bottom paste"],
  ["F.Fab", "fab", "Top fabrication"],
  ["B.Fab", "fab", "Bottom fabrication"],
  ["F.CrtYd", "courtyard", "Top courtyard"],
  ["B.CrtYd", "courtyard", "Bottom courtyard"],
  ["F.Adhes", "adhesive", "Top adhesive"],
  ["B.Adhes", "adhesive", "Bottom adhesive"],
]

const PLAIN_USER: [string, string][] = [
  ["Dwgs.User", "Drawings"],
  ["Cmts.User", "Comments"],
  ["Eco1.User", "Eco 1"],
  ["Eco2.User", "Eco 2"],
  ["Margin", "Margin"],
]

/** KiCad's `User.1` to `User.45`. */
export const USER_LAYER_COUNT = 45

const table = new Map<string, ShapeLayerInfo>()
for (const [name, kind, label] of SIDED) table.set(name, { name, kind, side: name.startsWith("F.") ? "top" : "bottom", label })
for (const [name, label] of PLAIN_USER) table.set(name, { name, kind: "user", side: null, label })
for (let i = 1; i <= USER_LAYER_COUNT; i++) table.set(`User.${i}`, { name: `User.${i}`, kind: "user", side: null, label: `User ${i}` })
/** KiCad's `In1.Cu` to `In30.Cu`: the copper layers between the two outer ones. A board has the first of them it has copper layers for. */
export const INNER_COPPER_COUNT = 30
for (let i = 1; i <= INNER_COPPER_COUNT; i++) table.set(`In${i}.Cu`, { name: `In${i}.Cu`, kind: "copper", side: null, label: `Inner ${i} copper` })

/** Every layer a drawing can be on, in the order a layer picker lists them. */
export const SHAPE_LAYERS: ShapeLayerInfo[] = [...table.values()]

/** What a layer is, or null for a name that is not one of KiCad's drawing layers (the board's edge among them). */
export const shapeLayerInfo = (name: string): ShapeLayerInfo | null => table.get(name) ?? null

export const isShapeLayer = (name: string) => table.has(name)

/**
 * The layer a drawing on `name` is on once its part is on the other side of the board: `F.SilkS` is `B.SilkS`, a user layer stays, and on a board of
 * `copperLayers` copper layers (four or more) `In1.Cu` is its mirror in the stack (KiCad's `FlipLayer`, layer_id.cpp: of four, `In1.Cu` and `In2.Cu` swap).
 * The count is required, so no caller can forget it (a board of two or three layers keeps an inner layer).
 */
export function flipShapeLayer(name: string, copperLayers: number): string {
  if (name.startsWith("F.")) return `B.${name.slice(2)}`
  if (name.startsWith("B.")) return `F.${name.slice(2)}`
  const m = /^In(\d+)\.Cu$/.exec(name)
  if (m && copperLayers >= 4) {
    const k = Number(m[1])
    return `In${Math.min(copperLayers - 2, Math.max(1, copperLayers - 1 - k))}.Cu`
  }
  return name
}

/** The side of a layer that has one. */
export const layerSide = (name: string): "top" | "bottom" | null => table.get(name)?.side ?? null
