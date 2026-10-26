import { layerAt, layerOfKicadName } from "../../stack"
import type { BoardStack, CopperLayer, CopperLayerType, StackCopper, StackRow } from "../../types"
import type { KicadBoard, KicadStackupRow } from "./types"

// X1: the board's copper layers. KiCad names the copper layers in the layer table in stack order, first the front layer and last the back one (the
// parser takes the position, not the name: `cu[0]` is `F.Cu` and the last is `B.Cu`, parseLayers, 9.0.0 `:1938-1962`), and an item says which layer
// it is on by that row's name. A board of an old release can name its layers anything (`Front`, `Comp.`, `Ground`), so the project keeps the
// position, and what a person named a layer is its label (the table's fourth word), which is what KiCad shows too.

export interface LayerMap {
  /** The board's copper layers, front to back. */
  ids: CopperLayer[]
  count: number
  /** The layer a name stands for, or null for a name that is not a copper layer's. KiCad's own names (`F.Cu`, `B.Cu`, `In3.Cu`) are taken too when the table does not use them for something else. */
  of: (name: string) => CopperLayer | null
}

export function layerMapOf(board: Pick<KicadBoard, "copper" | "copperLayerCount">): LayerMap {
  const names = board.copper.names
  const count = Math.max(2, names.length || board.copperLayerCount || 2)
  const ids = Array.from({ length: count }, (_, i) => layerAt(i, count))
  const byName = new Map<string, CopperLayer>()
  names.forEach((n, i) => {
    if (!byName.has(n)) byName.set(n, layerAt(i, names.length))
  })
  return {
    ids,
    count,
    of(name) {
      const exact = byName.get(name)
      if (exact) return exact
      const std = layerOfKicadName(name)
      if (std === "top" || std === "bottom") return std
      return std && ids.includes(std) ? std : null
    },
  }
}

/**
 * The layers a list of layer names puts something on: `*.Cu` is every copper layer of the board, `F&B.Cu` the two outer ones, any other name its own
 * layer; names that are not copper are left out. In stack order, each once.
 */
export function layersOfNames(map: LayerMap, names: readonly string[]): CopperLayer[] {
  const out = new Set<CopperLayer>()
  for (const n of names) {
    if (n === "*.Cu") for (const l of map.ids) out.add(l)
    else if (n === "F&B.Cu") {
      out.add("top")
      out.add("bottom")
    } else {
      const l = map.of(n)
      if (l) out.add(l)
    }
  }
  return map.ids.filter((l) => out.has(l))
}

const TYPES = new Set<string>(["signal", "power", "mixed", "jumper"])

const finish = (s: string | undefined): BoardStack["finish"] => (s === undefined ? undefined : s)

/** A stackup row as the project holds it. */
function stackRow(r: KicadStackupRow): StackRow {
  const out: StackRow = { name: r.name, type: r.type }
  if (r.thickness !== undefined) out.thickness = r.thickness
  if (r.locked) out.locked = true
  if (r.material !== undefined) out.material = r.material
  if (r.epsilonR !== undefined) out.epsilonR = r.epsilonR
  if (r.lossTangent !== undefined) out.lossTangent = r.lossTangent
  if (r.color !== undefined) out.color = r.color
  if (r.model !== undefined) out.model = r.model
  if (r.specFreq !== undefined) out.specFreq = r.specFreq
  if (r.sub.length) {
    out.sub = r.sub.map((sub) => {
      const { locked, ...rest } = sub
      return { ...rest, ...(locked ? { locked: true as const } : {}) }
    })
  }
  return out
}

/**
 * The board's stack (`BoardDef.stack`): the copper layers with the names a person gave them and what each is for, and the stackup. Absent for a board
 * of two plain signal layers with no stackup, which is every board drawn in the editor. What is held is what the file says, exactly.
 */
export function buildStack(board: KicadBoard): BoardStack | undefined {
  const rows = board.layers.filter((l) => TYPES.has(l.type))
  const copper: StackCopper[] = rows.map((r) => {
    const c: StackCopper = {}
    if (r.userName !== undefined && r.userName !== "") c.label = r.userName
    if (r.type !== "signal") c.type = r.type as CopperLayerType
    return c
  })
  while (copper.length < 2) copper.push({})
  const sk = board.stackup
  const plain = copper.length === 2 && copper.every((c) => !c.label && !c.type) && !sk
  if (plain) return undefined
  const stack: BoardStack = { copper }
  if (sk) {
    if (sk.rows.length) stack.rows = sk.rows.map(stackRow)
    const f = finish(sk.finish)
    if (f !== undefined) stack.finish = f
    if (sk.edgePlating !== undefined) stack.edgePlating = sk.edgePlating
    if (sk.dielectricConstraints !== undefined) stack.dielectricConstraints = sk.dielectricConstraints
    if (sk.edgeConnector === "yes" || sk.edgeConnector === "bevelled") stack.edgeConnector = sk.edgeConnector
    if (sk.castellated !== undefined) stack.castellated = sk.castellated
  }
  return stack
}
