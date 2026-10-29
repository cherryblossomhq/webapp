import { mountingHoles } from "../board"
import { getFootprint, registerProjectFootprints } from "../footprints"
import type { ComponentInstance, Project } from "../types"
import type { KicadFootprint } from "./board/types"

// A board the editor wrote has its corner mounting holes as four footprints (KiCad has no setting for them: they are footprints), each marked with a property of its own. When
// the four are the board's corner holes exactly (the places the editor puts them for the board's size, one drill, one ring) they are the editor's mounting holes again, as
// the board's setting; otherwise they are four parts like any other footprint of a KiCad board.

/** The property the editor's export writes on each corner mounting hole. */
export const MOUNTING_HOLE_MARK = "Cherry Blossom mounting hole"

export const isMarkedHole = (fp: Pick<KicadFootprint, "props">) => fp.props.some((p) => p.key === MOUNTING_HOLE_MARK)

export interface Restored {
  project: Project
  /** The footprints that are the board's mounting holes again, and no longer parts. */
  restored: ReadonlySet<KicadFootprint>
}

/** The marked footprints as the board's own corner holes, when they are exactly those; else nothing changes. */
export function restoreMountingHoles(project: Project, marked: { fp: KicadFootprint; component: ComponentInstance }[]): Restored {
  const none = { project, restored: new Set<KicadFootprint>() }
  if (marked.length !== 4 || project.board.mountingHoles || project.board.outline) return none
  registerProjectFootprints(project)
  const pads = marked.map((m) => getFootprint(m.component.footprint).pads)
  const hole = pads[0]?.[0]
  if (!hole || pads.some((p) => p.length !== 1 || !p[0].holeDiameter || p[0].holeDiameter !== hole.holeDiameter || p[0].width !== hole.width || p[0].height !== hole.height)) return none
  const b = project.board
  const first = marked[0].component.pcb
  const inset = Math.round((b.width / 2 - Math.abs(first.x - b.x)) * 1e4) / 1e4
  const config = { drill: hole.holeDiameter!, diameter: hole.width, inset }
  const corners = mountingHoles({ ...b, mountingHoles: config })
  const placed = marked.map((m) => m.component.pcb)
  if (corners.length !== 4 || !corners.every((c) => placed.some((p) => Math.abs(p.x - c.x) <= 0.01 && Math.abs(p.y - c.y) <= 0.01))) return none
  const gone = new Set(marked.map((m) => m.component.id))
  const components = project.components.filter((c) => !gone.has(c.id))
  const used = new Set(components.map((c) => c.partId))
  const lands = new Set(components.map((c) => c.footprint))
  const parts = project.parts?.filter((s) => used.has(s.id) || (components.some((c) => c.footprint === s.footprint)))
  const footprints = project.footprints?.filter((f) => lands.has(f.name))
  const models = project.models?.filter((m) => used.has(m.part))
  return {
    project: { ...project, components, board: { ...b, mountingHoles: config }, parts: parts?.length ? parts : undefined, footprints: footprints?.length ? footprints : undefined, models: models?.length ? models : undefined },
    restored: new Set(marked.map((m) => m.fp)),
  }
}
