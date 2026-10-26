import type { BoardDef, BoardStack, CopperLayer, CopperLayerType, PadDef, StackCopper, StackRow, Via, ViaKind } from "./types"

// X1: the board's copper layers. A layer is named by its place in the stack (`top`, `in1`, `in2`..., `bottom`), a board has two to 32 of
// them (`BoardDef.stack`), and a board with no stack has the two outer layers every board drawn in the editor has. Everything that
// has to know "which layers" asks here, so that a project drawn in the editor, with no stack, is read exactly as it always was.

/** KiCad's own limit: a board has 2 to 32 copper layers. */
export const MAX_COPPER_LAYERS = 32

const OUTER: readonly CopperLayer[] = Object.freeze(["top", "bottom"] as CopperLayer[])

const cache = new WeakMap<BoardStack, readonly CopperLayer[]>()

/** The id of the copper layer at a place in a stack of `count` layers: `top`, then `in1`..., then `bottom`. */
export const layerAt = (index: number, count: number): CopperLayer => (index <= 0 ? "top" : index >= count - 1 ? "bottom" : (`in${index}` as CopperLayer))

/** The copper layers of a board from the front to the back; two for a board with no stack. The array is shared: do not change it. */
export function copperLayers(board: { stack?: BoardStack }): readonly CopperLayer[] {
  const stack = board.stack
  if (!stack) return OUTER
  let hit = cache.get(stack)
  if (!hit) {
    const n = Math.max(2, stack.copper.length)
    hit = Object.freeze(Array.from({ length: n }, (_, i) => layerAt(i, n)))
    cache.set(stack, hit)
  }
  return hit
}

export const copperCount = (board: { stack?: BoardStack }) => copperLayers(board).length

/** Whether a layer is one of the layers between the two outer ones. */
export const isInner = (layer: CopperLayer): boolean => layer !== "top" && layer !== "bottom"

/** The inner layers of a board, front to back; none for a board of two layers. */
export const innerLayers = (board: { stack?: BoardStack }): readonly CopperLayer[] => copperLayers(board).slice(1, -1)

/** A layer's place in the stack, 0 at the front; -1 for one the board does not have. */
export const layerIndex = (board: { stack?: BoardStack }, layer: CopperLayer): number => copperLayers(board).indexOf(layer)

/** The inner layer's number in its id (`in3` is 3); 0 for an outer layer. */
export const innerNumber = (layer: CopperLayer): number => (isInner(layer) ? Number(layer.slice(2)) : 0)

/** Whether a value reads as a copper layer's id, whatever board it is on (`in1` to `in30`). */
export const isCopperLayerId = (v: unknown): v is CopperLayer => v === "top" || v === "bottom" || (typeof v === "string" && /^in([1-9]|[12]\d|30)$/.test(v))

/** Whether a string is the id of a layer a stack of `count` layers has. */
export const isLayerOf = (id: unknown, count: number): id is CopperLayer => {
  if (id === "top" || id === "bottom") return true
  if (typeof id !== "string" || !/^in[1-9]\d*$/.test(id)) return false
  return Number(id.slice(2)) <= count - 2
}

/** KiCad's own name for a layer: `F.Cu`, `In1.Cu`, `B.Cu`. */
export const kicadLayerName = (layer: CopperLayer): string => (layer === "top" ? "F.Cu" : layer === "bottom" ? "B.Cu" : `In${layer.slice(2)}.Cu`)

/** The layer for KiCad's own name (`F.Cu`, `In4.Cu`, `B.Cu`), whatever the board has; null for a name that is not a copper layer's. */
export function layerOfKicadName(name: string): CopperLayer | null {
  if (name === "F.Cu") return "top"
  if (name === "B.Cu") return "bottom"
  const m = /^In([1-9]\d*)\.Cu$/.exec(name)
  return m && Number(m[1]) <= MAX_COPPER_LAYERS - 2 ? (`in${m[1]}` as CopperLayer) : null
}

/** What a layer is called in the editor: the name the user gave it, else `Top`, `Bottom` or `Inner 3`. */
export function layerLabel(board: { stack?: BoardStack }, layer: CopperLayer): string {
  const i = layerIndex(board, layer)
  const given = i >= 0 ? board.stack?.copper[i]?.label : undefined
  if (given) return given
  return layer === "top" ? "Top" : layer === "bottom" ? "Bottom" : `Inner ${layer.slice(2)}`
}

/** What a layer is for; a signal layer unless it says otherwise. */
export function layerType(board: { stack?: BoardStack }, layer: CopperLayer): CopperLayerType {
  const i = layerIndex(board, layer)
  return (i >= 0 ? board.stack?.copper[i]?.type : undefined) ?? "signal"
}

/**
 * The layer a part's own layer is on once the part is on the other side of the board (KiCad's `FlipLayer`): the outer layers swap, and on a board of
 * four or more layers the inner ones swap end for end (`in1` of 4 is `in2`); on a board of three the one inner layer stays.
 */
export function flipLayer(layer: CopperLayer, count: number): CopperLayer {
  if (layer === "top") return "bottom"
  if (layer === "bottom") return "top"
  if (count < 4) return layer
  const k = innerNumber(layer)
  return `in${Math.min(count - 2, Math.max(1, count - 1 - k))}` as CopperLayer
}

/** The layers a layer list names in the board's order, each once, with those the board does not have left out. */
export function inStackOrder(board: { stack?: BoardStack }, layers: Iterable<CopperLayer>): CopperLayer[] {
  const have = new Set(layers)
  return copperLayers(board).filter((l) => have.has(l))
}

// ---------- vias ----------

/** `through` for a via that reaches every layer, else its kind. */
export const viaKind = (via: Pick<Via, "kind">): "through" | ViaKind => via.kind ?? "through"

/** Whether a via runs the whole stack. */
export const isThroughVia = (via: Pick<Via, "kind">): boolean => via.kind === undefined

/**
 * The copper layers a via has copper on (its pad and its barrel), in stack order: every layer for a through via, the layers from `from` to
 * `to` for any other. A via whose ends the board does not have (a board that lost layers) reaches the layers it does.
 */
export function viaLayers(board: { stack?: BoardStack }, via: Pick<Via, "kind" | "from" | "to">): CopperLayer[] {
  const all = copperLayers(board)
  if (via.kind === undefined || via.from === undefined || via.to === undefined) return all as CopperLayer[]
  const a = all.indexOf(via.from)
  const b = all.indexOf(via.to)
  if (a < 0 || b < 0) return all as CopperLayer[]
  return all.slice(Math.min(a, b), Math.max(a, b) + 1) as CopperLayer[]
}

/** Whether a via has copper on a layer. */
export function viaOnLayer(board: { stack?: BoardStack }, via: Pick<Via, "kind" | "from" | "to">, layer: CopperLayer): boolean {
  return via.kind === undefined ? true : viaLayers(board, via).includes(layer)
}

/** The diameter of a via's copper on a layer: its own, unless a via stack gives the layer another. */
export function viaDiameterOn(via: Pick<Via, "diameter" | "stack">, layer: CopperLayer): number {
  const s = via.stack
  if (!s || layer === "top") return via.diameter
  if ("layers" in s) return s.layers[layer] ?? via.diameter
  if (layer === "bottom") return s.back
  return s.inner
}

/** The largest copper of a via on any layer it is on. */
export function viaMaxDiameter(via: Pick<Via, "diameter" | "stack">): number {
  const s = via.stack
  if (!s) return via.diameter
  if ("layers" in s) return Math.max(via.diameter, ...Object.values(s.layers).filter((n): n is number => typeof n === "number"))
  return Math.max(via.diameter, s.inner, s.back)
}

/** Which kind a span of layers is on a board: through when it reaches both outer layers, blind with one outer end, buried with none. */
export function spanKind(board: { stack?: BoardStack }, from: CopperLayer, to: CopperLayer): "through" | "blind" | "buried" {
  const all = copperLayers(board)
  const a = all.indexOf(from)
  const b = all.indexOf(to)
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (lo === 0 && hi === all.length - 1) return "through"
  return lo === 0 || hi === all.length - 1 ? "blind" : "buried"
}

/** A via that joins `a` and `b` as the stack's order has it: `from` the nearer the front. */
export function viaBetween(board: { stack?: BoardStack }, a: CopperLayer, b: CopperLayer, micro = false): Pick<Via, "kind" | "from" | "to"> {
  const all = copperLayers(board)
  const [from, to] = all.indexOf(a) <= all.indexOf(b) ? [a, b] : [b, a]
  const k = spanKind(board, from, to)
  if (k === "through" && !micro) return {}
  return { kind: micro ? "micro" : k === "through" ? "blind" : k, from, to }
}

// ---------- pads ----------

/**
 * The inner layers a pad has copper on, for a board's inner layers seen from the part's own side (a part on the bottom has them turned over by
 * `flipLayer`): what the pad says, else every inner layer of a through-hole pad whose copper is on both sides, else none.
 */
export function padInnerLayers(pad: Pick<PadDef, "layer" | "plated" | "layers">, inner: readonly CopperLayer[], bothSides: boolean): CopperLayer[] {
  const given = pad.layers?.inner
  if (given) return inner.filter((l) => given.includes(l))
  return pad.layer === "through" && bothSides ? [...inner] : []
}

// ---------- building a stack ----------

/** A stack of `count` signal layers with no stackup rows. */
export function plainStack(count: number): BoardStack {
  return { copper: Array.from({ length: count }, (): StackCopper => ({})) }
}

/**
 * The board with `count` copper layers, keeping the names and types of the layers it has (the new ones are signal layers, inserted before the back
 * layer). The stackup rows are dropped when the count changes, for they would describe another board. A count of two with nothing else to say is
 * the board with no stack.
 */
export function withCopperCount(board: BoardDef, count: number): BoardDef {
  const n = Math.max(2, Math.min(MAX_COPPER_LAYERS, Math.round(count)))
  const have = board.stack?.copper ?? [{}, {}]
  if (n === have.length) return board
  const copper = have.slice(0, -1).slice(0, n - 1)
  while (copper.length < n - 1) copper.push({})
  copper.push(have[have.length - 1] ?? {})
  const { rows: _rows, ...rest } = board.stack ?? { copper }
  const stack: BoardStack = { ...rest, copper }
  const { stack: _old, ...plain } = board
  if (n === 2 && !stack.finish && !stack.edgePlating && !stack.dielectricConstraints && !stack.edgeConnector && !stack.castellated && copper.every((c) => !c.label && !c.type)) return plain
  return { ...plain, stack }
}

// ---------- the stackup ----------

/** KiCad's own standard rows for a board of `count` copper layers: the silkscreen, paste and mask each side, 35 micrometre copper, 1.6 mm over all. */
export function defaultStackup(count: number, thickness = 1.6): StackRow[] {
  const n = Math.max(2, Math.min(MAX_COPPER_LAYERS, count))
  const copper = 0.035
  const mask = 0.01
  const dielectrics = n - 1
  // The inner layers' copper is thinner (17.5 micrometres, half an ounce) on a board of four or more.
  const inner = n > 2 ? 0.0175 : 0.035
  const outerTotal = 2 * copper + (n - 2) * inner + 2 * mask
  const each = Math.max(0.01, (thickness - outerTotal) / dielectrics)
  const rows: StackRow[] = [
    { name: "F.SilkS", type: "Top Silk Screen", material: "Not specified" },
    { name: "F.Paste", type: "Top Solder Paste" },
    { name: "F.Mask", type: "Top Solder Mask", thickness: mask, material: "Not specified", epsilonR: 3.3, lossTangent: 0 },
    { name: "F.Cu", type: "copper", thickness: copper },
  ]
  for (let i = 1; i <= dielectrics; i++) {
    rows.push({ name: `dielectric ${i}`, type: i === 1 && n === 2 ? "core" : i % 2 === 1 ? "prepreg" : "core", thickness: Math.round(each * 1e4) / 1e4, material: "FR4", epsilonR: 4.5, lossTangent: 0.02 })
    if (i < dielectrics) rows.push({ name: `In${i}.Cu`, type: "copper", thickness: inner })
  }
  rows.push({ name: "B.Cu", type: "copper", thickness: copper }, { name: "B.Mask", type: "Bottom Solder Mask", thickness: mask, material: "Not specified", epsilonR: 3.3, lossTangent: 0 }, { name: "B.Paste", type: "Bottom Solder Paste" }, { name: "B.SilkS", type: "Bottom Silk Screen", material: "Not specified" })
  return rows
}

