import { MAX_COPPER_LAYERS } from "./stack"
import type { BoardStack, CopperLayerType, StackCopper, StackRow } from "./types"

// X1: the board's stack as a stored project holds it, read back field by field. A stack that does not read is dropped (the board has its two
// layers), one that reads partly keeps what reads; nothing here is stored differently from how it is held in memory, except that an absent
// field is the default.

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

const TYPES = new Set<CopperLayerType>(["signal", "power", "mixed", "jumper"])
const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined)

type SubRow = NonNullable<StackRow["sub"]>[number]

function readFields(raw: Json): SubRow {
  const out: SubRow = {}
  if (finite(raw.thickness) && raw.thickness >= 0) out.thickness = raw.thickness
  if (raw.locked === true) out.locked = true
  const material = text(raw.material)
  if (material !== undefined) out.material = material
  if (finite(raw.epsilonR)) out.epsilonR = raw.epsilonR
  if (finite(raw.lossTangent)) out.lossTangent = raw.lossTangent
  const color = text(raw.color, 40)
  if (color !== undefined) out.color = color
  if (raw.model === "constant" || raw.model === "djordjevic_sarkar") out.model = raw.model
  if (finite(raw.specFreq)) out.specFreq = raw.specFreq
  return out
}

function readRow(raw: unknown): StackRow | null {
  if (!isObject(raw)) return null
  const name = text(raw.name)
  const type = typeof raw.type === "string" ? raw.type.slice(0, 80) : ""
  if (name === undefined) return null
  const row: StackRow = { name, type, ...readFields(raw) }
  if (Array.isArray(raw.sub)) {
    const sub = raw.sub.filter(isObject).map(readFields)
    if (sub.length) row.sub = sub
  }
  return row
}

/** The stack a stored board holds; undefined for one that has none or does not read. */
export function normalizeStack(raw: unknown): BoardStack | undefined {
  if (!isObject(raw) || !Array.isArray(raw.copper)) return undefined
  const n = raw.copper.length
  if (n < 2 || n > MAX_COPPER_LAYERS) return undefined
  const copper = raw.copper.map((c): StackCopper => {
    if (!isObject(c)) return {}
    const out: StackCopper = {}
    const label = text(c.label, 120)
    if (label !== undefined) out.label = label
    if (typeof c.type === "string" && TYPES.has(c.type as CopperLayerType) && c.type !== "signal") out.type = c.type as CopperLayerType
    return out
  })
  const stack: BoardStack = { copper }
  if (Array.isArray(raw.rows)) {
    const rows = raw.rows.slice(0, 128).map(readRow).filter((r): r is StackRow => r !== null)
    if (rows.length) stack.rows = rows
  }
  const finish = text(raw.finish, 80)
  if (finish !== undefined) stack.finish = finish
  if (raw.edgePlating === true || raw.edgePlating === false) stack.edgePlating = raw.edgePlating
  if (raw.dielectricConstraints === true || raw.dielectricConstraints === false) stack.dielectricConstraints = raw.dielectricConstraints
  if (raw.edgeConnector === "yes" || raw.edgeConnector === "bevelled") stack.edgeConnector = raw.edgeConnector
  return stack
}
