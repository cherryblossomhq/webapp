import { emptyBox, expandBox, type Box } from "../../lib/geometry"
import { isPhysical, pcbCourtyard, schematicBounds } from "../../model/instances"
import { findPart } from "../../model/library"
import { blockFrames } from "../../model/blocks"
import { drawingBounds } from "../../model/drawings"
import { labelBox } from "../../model/labels"
import type { Project } from "../../model/types"

// Which part of a design a picture shows: all of it, some parts, what the user has selected, or
// a rectangle. Pure, and the same boxes the renderers and the numbers use.

export type ViewKind = "schematic" | "pcb"

export interface FrameRequest {
  refs?: string[]
  selection?: boolean
  region?: { x: number; y: number; width: number; height: number }
}

export interface Framed {
  box: Box
  /** What the picture shows, in words: "the whole sheet", "R1, R2 and U1". */
  what: string
  /** A sentence of trouble, or empty: unknown refs, nothing selected. */
  problem: string
}

/** Margin around the thing shown, as a share of its size, and the least it gets (world units). */
const MARGIN = { schematic: { share: 0.12, least: 0.5 }, pcb: { share: 0.08, least: 2 } }
/** The smallest box a picture may show, so one part is not blown up to fill a screen. */
const LEAST_SIZE = { schematic: 3, pcb: 12 }

const sizeOf = (b: Box) => ({ w: b.maxX - b.minX, h: b.maxY - b.minY })

function grow(box: Box, kind: ViewKind): Box {
  const m = MARGIN[kind]
  const { w, h } = sizeOf(box)
  const pad = Math.max(m.least, Math.max(w, h) * m.share)
  const out = { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad }
  // Keep a lone part from being blown up to a whole picture.
  const least = LEAST_SIZE[kind]
  const cx = (out.minX + out.maxX) / 2
  const cy = (out.minY + out.maxY) / 2
  const ow = out.maxX - out.minX
  const oh = out.maxY - out.minY
  if (ow < least) {
    out.minX = cx - least / 2
    out.maxX = cx + least / 2
  }
  if (oh < least) {
    out.minY = cy - least / 2
    out.maxY = cy + least / 2
  }
  return out
}

/** Widen a box to the picture's aspect ratio (width over height), around its middle. */
export function matchAspect(box: Box, aspect: number): Box {
  const { w, h } = sizeOf(box)
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  if (w / h < aspect) {
    const nw = h * aspect
    return { minX: cx - nw / 2, maxX: cx + nw / 2, minY: box.minY, maxY: box.maxY }
  }
  const nh = w / aspect
  return { minX: box.minX, maxX: box.maxX, minY: cy - nh / 2, maxY: cy + nh / 2 }
}

/** Everything drawn on the sheet: symbols, wires, labels, block frames and drawings. Null for an empty sheet. */
export function schematicContent(project: Project): Box | null {
  const b = emptyBox()
  const boxes = [
    ...project.components.map((c) => schematicBounds(c)),
    ...project.labels.map(labelBox),
    ...blockFrames(project).map((f) => f.box),
    ...(project.drawings ?? []).map(drawingBounds),
  ]
  for (const box of boxes) {
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
  }
  for (const w of project.wires) for (const p of w.points) expandBox(b, p)
  return Number.isFinite(b.minX) ? b : null
}

/** The board outline and every placed part's courtyard, so a part off the board is in the picture. */
export function pcbContent(project: Project): Box {
  const bd = project.board
  const b: Box = { minX: bd.x - bd.width / 2, maxX: bd.x + bd.width / 2, minY: bd.y - bd.height / 2, maxY: bd.y + bd.height / 2 }
  for (const c of project.components) {
    const cy = c.pcb.placed && isPhysical(findPart(c.partId)) ? pcbCourtyard(c) : null
    if (!cy) continue
    expandBox(b, { x: cy.minX, y: cy.minY })
    expandBox(b, { x: cy.maxX, y: cy.maxY })
  }
  return b
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`)
const SHOWN = 6

function refsText(refs: string[]) {
  return refs.length > SHOWN ? `${list(refs.slice(0, SHOWN))} and ${refs.length - SHOWN} more` : list(refs)
}

/** `selection` holds the editor's selection ids: `c:` parts, `w:` wires, `l:` labels, `b:` blocks, `d:` drawings, `t:` traces, `v:` vias. */
export function frame(project: Project, kind: ViewKind, req: FrameRequest, selection: string[] = []): Framed {
  const whole = (): Framed => {
    if (kind === "pcb") return { box: grow(pcbContent(project), kind), what: "the whole board", problem: "" }
    const content = schematicContent(project)
    return content ? { box: grow(content, kind), what: "the whole sheet", problem: "" } : { box: { minX: -2, maxX: 2, minY: -1.5, maxY: 1.5 }, what: "an empty sheet", problem: "" }
  }

  if (req.region) {
    const { x, y, width, height } = req.region
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return { ...whole(), problem: "region needs a positive width and height." }
    }
    return {
      box: { minX: x, minY: y, maxX: x + width, maxY: y + height },
      what: `the region x ${x} to ${x + width}, y ${y} to ${y + height}${kind === "pcb" ? " mm" : ""}`,
      problem: "",
    }
  }

  const b = emptyBox()
  const names: string[] = []
  const missing: string[] = []
  const add = (box: Box | null) => {
    if (!box) return false
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
    return true
  }
  const partBox = (id: string) => {
    const c = project.components.find((x) => x.id === id)
    if (!c) return false
    if (kind === "schematic") return add(schematicBounds(c))
    return add(c.pcb.placed && isPhysical(findPart(c.partId)) ? pcbCourtyard(c) : null)
  }

  if (req.refs?.length) {
    for (const raw of req.refs) {
      const c = project.components.find((x) => x.ref.toLowerCase() === raw.trim().toLowerCase())
      if (!c) missing.push(raw)
      else if (partBox(c.id)) names.push(c.ref)
      else missing.push(`${c.ref} (not placed on the PCB)`)
    }
  } else if (req.selection) {
    for (const id of selection) {
      const [type, ...rest] = id.split(":")
      const key = rest.join(":")
      if (type === "c" && partBox(key)) names.push(project.components.find((x) => x.id === key)?.ref ?? key)
      else if (kind === "schematic" && type === "w") {
        const w = project.wires.find((x) => x.id === key)
        if (w) for (const p of w.points) expandBox(b, p)
      } else if (kind === "schematic" && type === "l") {
        const l = project.labels.find((x) => x.id === key)
        if (l) add(labelBox(l))
      } else if (kind === "schematic" && type === "d") {
        const d = project.drawings?.find((x) => x.id === key)
        if (d) add(drawingBounds(d))
      } else if (kind === "schematic" && type === "b") {
        const f = blockFrames(project).find((x) => x.id === key)
        if (f) add(f.box)
      } else if (kind === "pcb" && type === "t") {
        const t = project.traces.find((x) => x.id === key)
        if (t) for (const p of t.points) expandBox(b, p)
      } else if (kind === "pcb" && type === "v") {
        const v = project.vias.find((x) => x.id === key)
        if (v) expandBox(b, { x: v.x, y: v.y }, v.diameter)
      }
    }
    if (!Number.isFinite(b.minX)) return { ...whole(), problem: `Nothing is selected in the ${kind === "pcb" ? "PCB" : "schematic"}, so this shows the whole view.` }
  } else {
    return whole()
  }

  const problem = missing.length ? `Not shown: ${missing.join(", ")}.` : ""
  if (!Number.isFinite(b.minX)) return { ...whole(), problem: `${problem} Showing the whole view.`.trim() }
  const bySelection = !req.refs?.length
  const what = bySelection ? (names.length ? `the selection (${refsText(names)})` : "the selection") : refsText(names)
  return { box: grow(b, kind), what, problem }
}
