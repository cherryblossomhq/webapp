import type { Box } from "../src/lib/geometry"
import { blockFrames, componentTextBoxes } from "../src/model/blocks"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicBounds, schematicPins } from "../src/model/instances"
import { labelBox } from "../src/model/labels"
import { findPart } from "../src/model/library"
import type { Project, Vec2 } from "../src/model/types"

// What a tidied schematic is held to, measured from the project alone: nothing drawn over
// anything else, no wires of two nets crossing, everything on the grid, and every block's frame
// around its parts and clear of the others. Shared by the Tidy tests and the probes.

type Tagged = { box: Box; what: string; owner: string; kind: "body" | "text" | "label" | "port" | "frame" }

const shrink = (b: Box, d: number): Box => ({ minX: b.minX + d, minY: b.minY + d, maxX: b.maxX - d, maxY: b.maxY - d })
const overlap = (a: Box, b: Box) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY

/** Where the drawing of a part sits: its symbol pulled in from its pins' ends. */
function bodyBox(c: Project["components"][number]): Box {
  return shrink(schematicBounds(c), 0.02)
}

export function drawnBoxes(p: Project): Tagged[] {
  const out: Tagged[] = []
  for (const c of p.components) {
    const part = findPart(c.partId)
    const port = !!part?.powerNet
    out.push({ box: bodyBox(c), what: `${c.ref} ${port ? "port" : "body"}`, owner: c.id, kind: port ? "port" : "body" })
    for (const t of componentTextBoxes(c)) out.push({ box: t, what: `${c.ref} text`, owner: c.id, kind: port ? "port" : "text" })
  }
  for (const l of p.labels) out.push({ box: labelBox(l), what: `label ${l.name}`, owner: l.id, kind: "label" })
  return out
}

/** Pairs of things drawn over each other: symbols, text, labels and ports. */
export function overlaps(p: Project): string[] {
  const boxes = drawnBoxes(p)
  const out: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.owner === b.owner) continue
      if (overlap(shrink(a.box, 0.005), shrink(b.box, 0.005))) out.push(`${a.what} / ${b.what}`)
    }
  }
  return out
}

type Seg = { a: Vec2; b: Vec2; net: string; id: string }

function segments(p: Project): Seg[] {
  const conn = computeConnectivity(p)
  const out: Seg[] = []
  for (const w of p.wires) {
    const net = conn.wireNet.get(w.id) ?? w.id
    for (let i = 0; i < w.points.length - 1; i++) out.push({ a: w.points[i], b: w.points[i + 1], net, id: w.id })
  }
  return out
}

const segBox = (s: Seg): Box => ({ minX: Math.min(s.a.x, s.b.x), minY: Math.min(s.a.y, s.b.y), maxX: Math.max(s.a.x, s.b.x), maxY: Math.max(s.a.y, s.b.y) })

/** Wires of different nets that cross or touch, and wires drawn through text, symbols or labels. */
export function wireProblems(p: Project): { crossings: string[]; through: string[] } {
  const segs = segments(p)
  const crossings: string[] = []
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]
      const t = segs[j]
      if (s.net === t.net) continue
      const a = segBox(s)
      const b = segBox(t)
      if (a.minX <= b.maxX + 1e-6 && a.maxX >= b.minX - 1e-6 && a.minY <= b.maxY + 1e-6 && a.maxY >= b.minY - 1e-6) crossings.push(`${s.net} x ${t.net}`)
    }
  }
  const through: string[] = []
  for (const t of drawnBoxes(p)) {
    const inner = shrink(t.box, 0.012)
    if (inner.maxX <= inner.minX || inner.maxY <= inner.minY) continue
    for (const s of segs) {
      const b = segBox(s)
      if (b.minX < inner.maxX && b.maxX > inner.minX && b.minY < inner.maxY && b.maxY > inner.minY) through.push(`${s.net} through ${t.what}`)
    }
  }
  return { crossings, through }
}

const onGrid = (v: number) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6

/** Anything off the 0.1 grid, and wires that aren't across or up and down. */
export function offGrid(p: Project): string[] {
  const out: string[] = []
  for (const c of p.components) if (!onGrid(c.sch.x) || !onGrid(c.sch.y)) out.push(`${c.ref} at ${c.sch.x}, ${c.sch.y}`)
  for (const w of p.wires) {
    for (const q of w.points) if (!onGrid(q.x) || !onGrid(q.y)) out.push(`wire ${w.id} at ${q.x}, ${q.y}`)
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i]
      const b = w.points[i + 1]
      if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) out.push(`wire ${w.id} slants`)
    }
  }
  for (const l of p.labels) if (!onGrid(l.x) || !onGrid(l.y)) out.push(`label ${l.name} at ${l.x}, ${l.y}`)
  for (const f of blockFrames(p)) for (const v of [f.box.minX, f.box.minY, f.box.maxX, f.box.maxY]) if (!onGrid(v)) out.push(`frame ${f.name}`)
  return out
}

/** Frames that overlap, and parts, labels and wires of a block outside its frame. */
export function frameProblems(p: Project): string[] {
  const frames = blockFrames(p)
  const out: string[] = []
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) if (overlap(frames[i].box, frames[j].box)) out.push(`${frames[i].name} / ${frames[j].name}`)
  }
  const byId = new Map(p.components.map((c) => [c.id, c]))
  const within = (b: Box, f: Box) => b.minX >= f.minX - 1e-6 && b.maxX <= f.maxX + 1e-6 && b.minY >= f.minY - 1e-6 && b.maxY <= f.maxY + 1e-6
  for (const f of frames) {
    for (const id of f.contents.components) {
      const c = byId.get(id)
      if (c && !within(schematicBounds(c), f.box)) out.push(`${c.ref} outside ${f.name}`)
    }
    // Nothing of another block, and nothing loose, inside a frame.
    for (const c of p.components) {
      if (f.contents.components.includes(c.id)) continue
      if (overlap(shrink(schematicBounds(c), 0.01), f.box)) out.push(`${c.ref} inside ${f.name}`)
    }
  }
  return out
}

/** Every check at once, as counts and the first few findings. */
export function tidyReport(p: Project) {
  const ov = overlaps(p)
  const wp = wireProblems(p)
  const grid = offGrid(p)
  const frames = frameProblems(p)
  return { overlaps: ov, crossings: wp.crossings, through: wp.through, grid, frames }
}

/** Pins of physical parts that sit on a wire of another net without being its end. */
export function pinsOnWires(p: Project): string[] {
  const out: string[] = []
  const conn = computeConnectivity(p)
  for (const c of p.components) {
    for (const pin of schematicPins(c)) {
      const net = conn.pinNet.get(`${c.id}:${pin.pin}`)
      for (const w of p.wires) {
        if (conn.wireNet.get(w.id) === net) continue
        for (let i = 0; i < w.points.length - 1; i++) {
          const b = segBox({ a: w.points[i], b: w.points[i + 1], net: "", id: "" })
          if (pin.pos.x >= b.minX - 1e-6 && pin.pos.x <= b.maxX + 1e-6 && pin.pos.y >= b.minY - 1e-6 && pin.pos.y <= b.maxY + 1e-6) out.push(`${c.ref}.${pin.pin}`)
        }
      }
    }
  }
  return out
}
