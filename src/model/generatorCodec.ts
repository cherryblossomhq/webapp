import { isCopperLayerId } from "./stack"
import type { GenValue, PcbGenerator, Via } from "./types"
import { readProtection } from "./viaCodec"

// X21: a generated item as it is stored (the object after a group's flags, see `dimCodec.ts`) and as it reads back: every property valid or the whole item gone, since a pattern with a property missing would be tuned wrong.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const pair = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])

function readValue(v: unknown): GenValue | null {
  if (finite(v) || typeof v === "boolean" || typeof v === "string") return v
  if (!isObject(v)) return null
  if ("xy" in v) return pair(v.xy) ? { xy: [v.xy[0], v.xy[1]] } : null
  if ("pts" in v) return Array.isArray(v.pts) && v.pts.every(pair) ? { pts: v.pts.map((p): [number, number] => [p[0], p[1]]) } : null
  if ("cells" in v) return Array.isArray(v.cells) && v.cells.every(pair) ? { cells: v.cells.map((p): [number, number] => [p[0], p[1]]) } : null
  return null
}

/** A stored generator, or undefined when it does not read. */
export function readGenerator(raw: unknown): PcbGenerator | undefined {
  if (!isObject(raw) || typeof raw.kind !== "string" || !raw.kind || !isCopperLayerId(raw.layer) || !isObject(raw.props)) return undefined
  const props: Record<string, GenValue> = {}
  for (const [k, v] of Object.entries(raw.props)) {
    const value = readValue(v)
    if (value === null) return undefined
    props[k] = value
  }
  const out: PcbGenerator = { kind: raw.kind, layer: raw.layer, props }
  if (raw.templates !== undefined) {
    if (!Array.isArray(raw.templates)) return undefined
    const templates: NonNullable<PcbGenerator["templates"]> = []
    for (const t of raw.templates) {
      if (!isObject(t) || typeof t.name !== "string" || !isObject(t.via) || !finite(t.via.x) || !finite(t.via.y) || !finite(t.via.diameter) || !finite(t.via.drill)) return undefined
      const protect = readProtection(t.via.protect)
      if (protect === null) return undefined
      templates.push({ name: t.name, via: { ...(t.via as Omit<Via, "id">), ...(protect ? { protect } : {}) } })
    }
    if (templates.length) out.templates = templates
  }
  return out
}
