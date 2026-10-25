import { boxesOverlap, round, snap } from "../lib/geometry"
import { schematicBounds } from "./instances"
import { findPart } from "./library"
import { freeSchematicSpot } from "./ops"
import { SCH_GRID } from "./symbols"
import type { Project, Rotation, Vec2 } from "./types"

/** Room a suggested spot leaves around other parts. */
const MARGIN = 0.3

/**
 * A place for part `id`, as near to `target` as possible, where `accepts` is satisfied by the
 * project after the move (`build`). Every spot it offers has been tried, so it is safe to say.
 * The spots are rings around the target, then the free space to the right of everything; spots on
 * top of another part are skipped without being tried. Null when none of `tries` works.
 */
export function findSafeSpot(args: {
  project: Project
  id: string
  target: Vec2
  rot: Rotation
  build: (at: Vec2) => Project
  accepts: (next: Project) => boolean
  tries?: number
}): Vec2 | null {
  const { project, id, target, rot, build, accepts, tries = 16 } = args
  const c = project.components.find((x) => x.id === id)
  if (!c) return null
  const others = project.components.filter((x) => x.id !== id)
  const spots = new Map<string, Vec2>()
  const add = (x: number, y: number) => {
    const p = { x: round(snap(x, SCH_GRID)), y: round(snap(y, SCH_GRID)) }
    spots.set(`${p.x},${p.y}`, p)
  }
  // Rings round where it was asked to go and round where it is: a part tied in by wires fits best near home.
  for (const centre of [target, c.sch]) {
    for (let r = 0.5; r <= 6; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        add(centre.x + Math.cos(a) * r, centre.y + Math.sin(a) * r)
      }
    }
  }
  const dist = (p: Vec2) => Math.hypot(p.x - target.x, p.y - target.y)
  const ordered = [...spots.values()].sort((a, b) => dist(a) - dist(b))
  const rest = freeSchematicSpot({ ...project, components: others }, findPart(c.partId), rot)
  ordered.push(rest)

  let tried = 0
  for (const spot of ordered) {
    if (spot.x === c.sch.x && spot.y === c.sch.y) continue
    const box = schematicBounds({ ...c, sch: { ...c.sch, x: spot.x, y: spot.y, rot } })
    const grown = { minX: box.minX - MARGIN, maxX: box.maxX + MARGIN, minY: box.minY - MARGIN, maxY: box.maxY + MARGIN }
    if (others.some((o) => boxesOverlap(grown, schematicBounds(o)))) continue
    if (accepts(build(spot))) return spot
    if (++tried >= tries) break
  }
  return null
}
