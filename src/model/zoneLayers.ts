import { SHAPE_LAYERS, shapeLayerInfo } from "./shapeLayers"

// The layers a zone can be on besides copper (X29): KiCad's mask, paste, silkscreen, fabrication, courtyard, adhesive and user layers, and the board's edge. A zone is held with
// the names KiCad writes, in this order, so two zones on the same layers say them the same way.

/** The non-copper layers a zone may be on, in the order a layer picker lists them. */
export const OTHER_LAYER_ORDER: readonly string[] = [...SHAPE_LAYERS.filter((l) => l.kind !== "copper").map((l) => l.name), "Edge.Cuts"]

/** The non-copper layers the editor has a Gerber for. */
export const PLOTTED_LAYERS = /^[FB]\.(Mask|Paste|SilkS)$|^Edge\.Cuts$/

const known = new Set(OTHER_LAYER_ORDER)

/** Whether a name is a layer a zone may be on besides copper. */
export const isOtherZoneLayer = (name: unknown): name is string => typeof name === "string" && known.has(name)

/** The names in the table's order, each once, with the ones that are no such layer left out. */
export const orderedOtherLayers = (names: readonly string[]): string[] => OTHER_LAYER_ORDER.filter((n) => names.includes(n))

/** The layer a zone with only these layers is anchored to: the side of its first layer, the top for a layer with none. */
export const anchorSide = (names: readonly string[]): "top" | "bottom" => (names.length && shapeLayerInfo(names[0])?.side === "bottom" ? "bottom" : "top")

/** What the editor draws a layer's zones in, by the layer's kind. */
export const otherLayerKind = (name: string) => (name === "Edge.Cuts" ? "edge" : (shapeLayerInfo(name)?.kind ?? "user"))
