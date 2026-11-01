import { boxesOverlap, normBox, pointOnSegment, round, samePoint, type Box } from "../lib/geometry"
import { blockFrames, blockOf, findBlock } from "../model/blocks"
import { bareName, pinKey, type SchematicConnectivity } from "../model/connectivity"
import { powerNetName, schematicBounds, schematicPins } from "../model/instances"
import { findPart } from "../model/library"
import { pinText, schematicEditProblems } from "../model/merges"
import { findNet, isMadeUpName, renameNet, renameTargetProblem, setNetStyle } from "../model/netEdit"
import { addLabel, addWire } from "../model/ops"
import type { NetStyle, Project, Rotation, Vec2 } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { segmentCrossesBox } from "./vision/measure"
import { SHEET_ARG, SHEET_PROPERTY } from "./sheetTools"
import { fail, ok, type JsonSchema, type ToolInput, type ToolOutcome, type ToolSpec } from "./toolKit"

// The schematic by its coordinates. `connect` decides where a wire or label goes, which is what most
// requests want; an assistant matching one block to another, or joining a wire onto a wire, needs
// to say where: `get_wiring` reads the pins' ends and what is drawn, `draw_wiring` draws exactly
// what it is given, checked so it joins only what its ends and labels touch, and `edit_net`
// renames a net, or chooses how Tidy draws it, without redrawing anything.

const SIDES = ["right", "up", "left", "down"] as const
type Side = (typeof SIDES)[number]
const sideOf = (rot: Rotation): Side => SIDES[(((rot / 90) % 4) + 4) % 4]
const rotOf = (side: Side): Rotation => (SIDES.indexOf(side) * 90) as Rotation
const xy = (p: Vec2) => `(${round(p.x, 3)}, ${round(p.y, 3)})`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A net's name for a reply, or null for a net that is only a pin or a stub. */
function netName(conn: SchematicConnectivity, id: string | undefined): string | null {
  const net = id ? conn.nets.find((n) => n.id === id) : undefined
  return net && (net.named || net.pins.length > 1) ? net.name : null
}

// ---------- get_wiring ----------

const POINT: JsonSchema = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }

const AREA: JsonSchema = {
  type: "object",
  properties: { min_x: { type: "number" }, min_y: { type: "number" }, max_x: { type: "number" }, max_y: { type: "number" } },
  required: ["min_x", "min_y", "max_x", "max_y"],
  description: "A rectangle",
}

/**
 * The most get_wiring answers at once, in characters: about 10k tokens, where Claude Code starts
 * warning about a tool's output (it cuts one off at 25k by default). A whole sheet grows with the
 * board (a dense 41-part board's was 32k characters), and one block of it stays well under.
 */
export const WIRING_BUDGET = 30_000

const inBox = (p: Vec2, b: Box) => p.x >= b.minX - 1e-6 && p.x <= b.maxX + 1e-6 && p.y >= b.minY - 1e-6 && p.y <= b.maxY + 1e-6

export const getWiringTool: ToolSpec = {
  name: "get_wiring",
  description:
    "Read the schematic by coordinates (schematic units, y up): pin ends with the way each faces and its net, wires' points and nets, labels with the way their text runs, ports, junctions and block frames. Give block or area for part of the sheet. For draw_wiring, or to line a drawing up with another.",
  input_schema: {
    type: "object",
    properties: { block: { type: "string", description: "Only inside this block's frame" }, area: AREA, sheet: SHEET_PROPERTY },
  },
  run: (project, input) => {
    let box: Box | null = null
    if (typeof input.block === "string" && input.block.trim()) {
      const block = findBlock(project, input.block)
      if (!block) return fail(project, `No block ${input.block}. Blocks: ${(project.blocks ?? []).map((b) => b.name).join(", ") || "none"}`)
      box = blockFrames(project).find((f) => f.id === block.id)?.box ?? null
      if (!box) return fail(project, `${block.name} has no parts on this sheet, so it has no frame.`)
    } else if (input.area) {
      const a = input.area as { min_x: number; min_y: number; max_x: number; max_y: number }
      box = { minX: Math.min(a.min_x, a.max_x), minY: Math.min(a.min_y, a.max_y), maxX: Math.max(a.min_x, a.max_x), maxY: Math.max(a.min_y, a.max_y) }
    }
    const inside = (p: Vec2) => !box || inBox(p, box)
    const conn = getConnectivity(project)
    const pins: { pin: string; x: number; y: number; faces: Side; net: string | null }[] = []
    const ports: { ref: string; net: string; x: number; y: number }[] = []
    for (const c of project.components) {
      const part = findPart(c.partId)
      for (const p of schematicPins(c)) {
        if (p.hidden || !inside(p.pos)) continue
        const key = pinKey(c.id, p.pin)
        if (part?.powerNet) ports.push({ ref: c.ref, net: powerNetName(c, part) ?? "", x: p.pos.x, y: p.pos.y })
        else pins.push({ pin: pinText(project, key), x: p.pos.x, y: p.pos.y, faces: p.dir, net: netName(conn, conn.pinNet.get(key)) })
      }
    }
    const wires = project.wires
      .filter((w) => !box || w.points.some((p, i) => inBox(p, box!) || (i > 0 && boxesOverlap(normBox(w.points[i - 1], p), box!))))
      .map((w) => ({ net: netName(conn, conn.wireNet.get(w.id)), points: w.points.map((p) => [p.x, p.y]) }))
    const labels = project.labels.filter((l) => inside(l)).map((l) => ({ name: l.name, x: l.x, y: l.y, side: sideOf(l.rot) }))
    const junctions = conn.junctions.filter(inside).map((p) => [p.x, p.y])
    const frames = blockFrames(project)
      .filter((f) => !box || boxesOverlap(f.box, box))
      .map((f) => ({ block: f.name, min_x: f.box.minX, min_y: f.box.minY, max_x: f.box.maxX, max_y: f.box.maxY }))
    const out = {
      ...(box ? { area: { min_x: box.minX, min_y: box.minY, max_x: box.maxX, max_y: box.maxY } } : {}),
      pins,
      wires,
      labels,
      ports,
      ...(junctions.length ? { junctions } : {}),
      ...(frames.length ? { frames } : {}),
    }
    const text = JSON.stringify(out)
    if (text.length > WIRING_BUDGET) {
      // Too much for one answer: the frames, to ask again for a block or an area of the sheet.
      const all = blockFrames(project).map((f) => ({ block: f.name, min_x: f.box.minX, min_y: f.box.minY, max_x: f.box.maxX, max_y: f.box.maxY }))
      const why = `${plural(pins.length, "pin")} and ${plural(wires.length, "wire")} are too many for one answer. Ask again with block, or with an area of the sheet.`
      return { ...ok(project, JSON.stringify({ too_big: why, ...(all.length ? { frames: all } : {}) }), "Too much wiring for one answer"), empty: true }
    }
    return ok(project, text, `Read the wiring${typeof input.block === "string" ? ` of ${input.block}` : box ? " of an area" : ""} (${plural(pins.length, "pin")}, ${plural(wires.length, "wire")})`)
  },
}

// ---------- draw_wiring ----------

/** What sits at a point of the sheet as it is: pins, wire corners and sides, labels, by the net each is on; `except` a wire of its own. */
function touchedAt(project: Project, conn: SchematicConnectivity, p: Vec2, except?: string): { groups: Set<string>; what: string[] } {
  const groups = new Set<string>()
  const what: string[] = []
  for (const c of project.components) {
    const part = findPart(c.partId)
    for (const pin of schematicPins(c)) {
      if (!samePoint(pin.pos, p)) continue
      const key = pinKey(c.id, pin.pin)
      groups.add(conn.pinNet.get(key) ?? `solo:${key}`)
      what.push(part?.powerNet ? `the ${powerNetName(c, part)} port ${c.ref}` : pinText(project, key))
    }
  }
  for (const w of project.wires) {
    if (w.id === except || !w.points.some((q, i) => samePoint(q, p) || (i > 0 && pointOnSegment(p, w.points[i - 1], q)))) continue
    const id = conn.wireNet.get(w.id)
    groups.add(id ?? `wire:${w.id}`)
    const name = netName(conn, id)
    what.push(name ? `a wire of ${name}` : "a wire")
  }
  for (const l of project.labels) {
    if (!samePoint(l, p)) continue
    groups.add(conn.labelNet.get(l.id) ?? `label:${l.id}`)
    what.push(`the label ${l.name}`)
  }
  return { groups, what: [...new Set(what)] }
}

type Segment = [Vec2, Vec2]
const horizontal = ([a, b]: Segment) => Math.abs(a.y - b.y) < 1e-6
const segmentsOf = (points: Vec2[]): Segment[] => points.slice(1).map((p, i) => [points[i], p])

/** Two straight segments on one line that share more than a point. */
function runAlong(s: Segment, t: Segment): boolean {
  if (horizontal(s) !== horizontal(t)) return false
  const axis = horizontal(s) ? "x" : "y"
  const across = horizontal(s) ? "y" : "x"
  if (Math.abs(s[0][across] - t[0][across]) > 1e-6) return false
  const lo = Math.max(Math.min(s[0][axis], s[1][axis]), Math.min(t[0][axis], t[1][axis]))
  const hi = Math.min(Math.max(s[0][axis], s[1][axis]), Math.max(t[0][axis], t[1][axis]))
  return hi - lo > 1e-4
}

interface LabelIn {
  name: string
  x: number
  y: number
  side?: Side
}

/** The way a label's text runs from a point by default: the way a pin there faces, else away from the wire that ends there, else right. */
function defaultSide(project: Project, p: Vec2): Side {
  for (const c of project.components) for (const pin of schematicPins(c)) if (samePoint(pin.pos, p)) return pin.dir
  for (const w of project.wires) {
    const n = w.points.length
    const [from, end] = samePoint(w.points[n - 1], p) ? [w.points[n - 2], w.points[n - 1]] : samePoint(w.points[0], p) ? [w.points[1], w.points[0]] : [null, null]
    if (!from || !end) continue
    return Math.abs(end.x - from.x) > Math.abs(end.y - from.y) ? (end.x > from.x ? "right" : "left") : end.y > from.y ? "up" : "down"
  }
  return "right"
}

export const drawWiringTool: ToolSpec = {
  name: "draw_wiring",
  description:
    "Draw wires through given points and net labels at given points (schematic units, y up; read them with get_wiring), when where they go matters; otherwise use connect. Segments are horizontal or vertical. A wire joins only what its two ends touch (a pin end, a wire's corner or side, a label), a label what it sits on; it never joins two named nets, leaves a pin under another net's wire or runs along a drawn wire. Anything wrong refuses the whole call.",
  input_schema: {
    type: "object",
    properties: {
      wires: { type: "array", items: { type: "array", items: POINT }, description: "Each wire's points in order, corners included" },
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, x: { type: "number" }, y: { type: "number" }, side: { type: "string", enum: [...SIDES], description: "Way the text runs; default away from what it is on" } },
          required: ["name", "x", "y"],
        },
        description: "Each on a pin end or a wire",
      },
      sheet: SHEET_ARG,
    },
  },
  run: (project, input) => {
    const wires = (Array.isArray(input.wires) ? (input.wires as Vec2[][]) : []).map((w) => w.map((p) => ({ x: round(p.x), y: round(p.y) })))
    const labels = (Array.isArray(input.labels) ? (input.labels as LabelIn[]) : []).map((l) => ({ ...l, name: l.name.trim(), x: round(l.x), y: round(l.y) }))
    if (!wires.length && !labels.length) return fail(project, "Give wires, labels or both.")
    for (const [i, w] of wires.entries()) {
      if (w.length < 2) return fail(project, `Wire ${i + 1} has ${w.length} point; a wire needs two at least.`)
      for (const [a, b] of segmentsOf(w)) {
        if (samePoint(a, b)) return fail(project, `Wire ${i + 1} has the point ${xy(a)} twice in a row.`)
        if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6)
          return fail(project, `Wire ${i + 1} runs on a slant from ${xy(a)} to ${xy(b)}: add a corner at ${xy({ x: b.x, y: a.y })} or ${xy({ x: a.x, y: b.y })}.`)
      }
    }
    for (const l of labels) if (!l.name) return fail(project, `The label at ${xy(l)} has no name.`)

    const before = getConnectivity(project)
    // What the call asks to join: the nets at each wire's two ends and under each label, and the nets each label names.
    const allowed = new Set<string>()
    const ends = wires.map((w) => [w[0], w[w.length - 1]].map((p) => touchedAt(project, before, p)))
    for (const e of ends.flat()) for (const g of e.groups) allowed.add(g)
    for (const l of labels) {
      for (const g of touchedAt(project, before, l).groups) allowed.add(g)
      for (const n of before.nets) if (n.named && (n.name === l.name || bareName(n) === l.name)) allowed.add(n.id)
    }

    const problems: string[] = []
    const drawn = project.wires.flatMap((w) => segmentsOf(w.points).map((s) => ({ s, net: netName(before, before.wireNet.get(w.id)) })))
    for (const [i, w] of wires.entries()) {
      for (const s of segmentsOf(w)) {
        const along = drawn.find((d) => runAlong(s, d.s))
        if (along) problems.push(`wire ${i + 1} would run along a wire${along.net ? ` of ${along.net}` : ""} from ${xy(s[0])} to ${xy(s[1])}`)
      }
    }
    let next = project
    const ids: string[] = []
    for (const w of wires) {
      const added = addWire(next, w)
      next = added.project
      ids.push(added.wire?.id ?? "")
    }
    const labelIds: string[] = []
    for (const l of labels) {
      const added = addLabel(next, l.name, l, rotOf(l.side ?? defaultSide(next, l)))
      next = added.project
      labelIds.push(added.label.id)
    }
    const after = getConnectivity(next)
    for (const l of labels) {
      // A label joins what it sits on: on nothing (not even a wire drawn here) it names nothing.
      if (!touchedAt(next, after, l).what.some((w) => !w.startsWith("the label "))) problems.push(`the label ${l.name} at ${xy(l)} is on no pin end or wire`)
    }
    problems.push(...schematicEditProblems(project, next, before, after, allowed))
    if (problems.length) return fail(project, `Nothing was drawn: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`)

    // What each end touches once everything is drawn: a wire or label of this call counts too.
    const reached = wires.map((w, i) => [w[0], w[w.length - 1]].map((p) => touchedAt(next, after, p, ids[i])))
    const said: string[] = []
    for (const [i, w] of wires.entries()) {
      const [a, b] = reached[i].map((e) => (e.what.length ? e.what.join(" and ") : "nothing"))
      const net = netName(after, after.wireNet.get(ids[i]))
      const through = project.components.filter((c) => !findPart(c.partId)?.powerNet).filter((c) => {
        const inner = schematicBounds(c)
        const box = { minX: inner.minX + 0.06, minY: inner.minY + 0.06, maxX: inner.maxX - 0.06, maxY: inner.maxY - 0.06 }
        return segmentsOf(w).some(([p, q]) => segmentCrossesBox(p, q, box))
      })
      said.push(`Wire ${i + 1} from ${xy(w[0])} at ${a} to ${xy(w[w.length - 1])} at ${b}${net ? `, on ${net}` : ""}${through.length ? `; it runs through the body of ${through.map((c) => c.ref).join(", ")}` : ""}.`)
    }
    for (const [i, l] of labels.entries()) {
      const net = netName(after, after.labelNet.get(labelIds[i]))
      said.push(`Label ${l.name} at ${xy(l)}${net && net !== l.name ? `, on ${net}` : ""}.`)
    }
    const dangling = reached.flat().filter((e) => !e.what.length).length
    if (dangling) said.push(`${plural(dangling, "wire end")} touch${dangling === 1 ? "es" : ""} nothing yet: put a label there or draw on to a pin.`)
    const summary = [wires.length && plural(wires.length, "wire"), labels.length && plural(labels.length, "label")].filter(Boolean).join(" and ")
    return ok(next, said.join(" "), `Drew ${summary}`)
  },
}

// ---------- edit_net ----------

const STYLE_WORDS: Record<NetStyle, string> = { label: "net labels", port: "power or ground ports" }

/** `connect` as Sakura calls it, on the sheet of its pins: how a net with no name gets one. */
export type ConnectRunner = (project: Project, input: ToolInput) => ToolOutcome

export function editNetTool(connect: ConnectRunner): ToolSpec {
  return {
    name: "edit_net",
    description:
      'Rename a net keeping its wires: every label and power port giving its name takes the new one, and pours, widths and net classes follow (an unnamed net gets a label on one pin). Or set how tidy_schematic draws it: draw_as "label" (net labels even for a supply, e.g. VBUS through a fuse), "port" (power or ground ports), "auto" (Tidy decides). Tidy its blocks to redraw it.',
    input_schema: {
      type: "object",
      properties: {
        net: { type: "string", description: "Its name now" },
        rename_to: { type: "string" },
        draw_as: { type: "string", enum: ["label", "port", "auto"] },
      },
      required: ["net"],
    },
    run: (project, input) => {
      const asked = String(input.net).trim()
      const renameTo = typeof input.rename_to === "string" ? input.rename_to.trim() : undefined
      const drawAs = input.draw_as as NetStyle | "auto" | undefined
      if (renameTo === undefined && drawAs === undefined) return fail(project, "Give rename_to, draw_as or both.")
      const conn = getConnectivity(project)
      const net = findNet(conn, asked)
      if (!net) {
        const names = conn.nets.filter((n) => n.named).map((n) => n.name)
        return fail(project, `No net is called ${asked}. Named nets: ${names.slice(0, 30).join(", ") || "none"}${names.length > 30 ? ", ..." : ""}`)
      }
      let next = project
      const said: string[] = []
      let name = net.named ? bareName(net) : null
      if (renameTo !== undefined) {
        if (net.named) {
          const r = renameNet(project, net.name, renameTo)
          if ("error" in r) return fail(project, r.error)
          next = r.project
          name = renameTo
          const what = [r.labels && plural(r.labels, "label"), r.ports && plural(r.ports, "power port")].filter(Boolean).join(" and ")
          said.push(r.project === project ? `${net.name} is already called that.` : `Renamed ${net.name} to ${r.net}: ${what}.`)
        } else {
          // A net nobody named gets its name from a label, which connect puts on one of its pins; checked first,
          // since connect with another net's name would join the two.
          const problem = renameTargetProblem(project, conn, net, renameTo)
          if (problem) return fail(project, problem)
          const pin = net.pins.find((p) => !findPart(project.components.find((c) => c.id === p.componentId)?.partId ?? "")?.powerNet)
          const c = pin && project.components.find((x) => x.id === pin.componentId)
          if (!pin || !c) return fail(project, `${net.name} has no pin to put a label on.`)
          const out = connect(project, { pins: [`${c.ref}.${pin.pin}`], net_name: renameTo })
          if (out.isError) return fail(project, `${net.name} had no name, and a label of ${renameTo} could not be put on ${c.ref}.${pin.pin}: ${out.result.replace(/^Error: /, "")}`)
          next = out.project
          name = renameTo
          said.push(`${net.name} had no name: ${out.result}`)
        }
      }
      if (drawAs !== undefined) {
        if (!name || isMadeUpName(name)) return fail(project, `${net.name} has no name of its own, and Tidy names a net it labels as it likes. Name it with rename_to as well.`)
        // Tidy keeps a net a local or hierarchical label names as labels, whatever is chosen: a port would name it on every sheet.
        const kind = findNet(getConnectivity(next), name)?.label?.kind
        if (drawAs === "port" && (kind === "local" || kind === "hierarchical"))
          return fail(project, `${name} is named by a ${kind} label, which names it on its sheet only, so Tidy keeps it as labels: a port would name it on every sheet.`)
        next = setNetStyle(next, name, drawAs === "auto" ? null : drawAs)
        const pinsOn = net.pins.map((p) => blockOf(next, p.componentId)?.name).filter((b): b is string => !!b)
        const blocks = [...new Set(pinsOn)]
        const redraw = blocks.length ? ` Tidy the blocks it is in to redraw it: ${blocks.join(", ")}.` : ""
        said.push(drawAs === "auto" ? `Tidy decides how to draw ${name} again.${redraw}` : `Tidy draws ${name} with ${STYLE_WORDS[drawAs]} from now on.${redraw}`)
      }
      const summary = [renameTo !== undefined && `Renamed ${net.name} to ${renameTo}`, drawAs !== undefined && (drawAs === "auto" ? `Left ${name} to Tidy` : `${name} drawn with ${STYLE_WORDS[drawAs]}`)].filter(Boolean).join("; ")
      return ok(next, said.join(" "), summary)
    },
  }
}
