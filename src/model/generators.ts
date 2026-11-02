import { leafMembers } from "./boardObjects"
import type { GenValue, PcbGenerator, PcbGroup, Project, Vec2 } from "./types"

// X21: a generated item (a tuning pattern, a via stack, via stitching) is a group that remembers where it was laid out (`origin`, `end`, `base_line`, `outline`, `hops`: points of the board). When the group is moved
// or turned as a whole those points go with it, so the pattern can still be tuned again where it now is; a member moved alone leaves them (KiCad does the same: the generator follows only its own `Move`).

const r6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0

/** A generator with every point it holds mapped by `f`. The same object when it holds none. */
function mapGenerator(gen: PcbGenerator, f: (p: Vec2) => Vec2): PcbGenerator {
  let changed = false
  const props: Record<string, GenValue> = {}
  for (const [k, v] of Object.entries(gen.props)) {
    if (typeof v === "object" && "xy" in v) {
      const p = f({ x: v.xy[0], y: v.xy[1] })
      props[k] = { xy: [r6(p.x), r6(p.y)] }
      changed = true
    } else if (typeof v === "object" && "pts" in v) {
      props[k] = { pts: v.pts.map(([x, y]): [number, number] => {
        const p = f({ x, y })
        return [r6(p.x), r6(p.y)]
      }) }
      changed = true
    } else props[k] = v
  }
  return changed ? { ...gen, props } : gen
}

/**
 * The project with the generated items whose members were all among `moved` carried by `f`. `moved` is the ids of what a move or turn really took (a locked member is not in it, so a pattern with one stays).
 * The same project when there is no generated item or none of them went.
 */
export function carryGenerators(project: Project, moved: ReadonlySet<string>, f: (p: Vec2) => Vec2): Project {
  const groups = project.groups
  if (!groups?.some((g) => g.gen)) return project
  let changed = false
  const next = groups.map((g): PcbGroup => {
    if (!g.gen) return g
    const leaves = leafMembers(project, g)
    if (!leaves.length || !leaves.every((id) => moved.has(id))) return g
    const gen = mapGenerator(g.gen, f)
    if (gen === g.gen) return g
    changed = true
    return { ...g, gen }
  })
  return changed ? { ...project, groups: next } : project
}
