import { boxesOverlap, normalizeAngle, pointSegmentDistance, round, type Box } from "../lib/geometry"
import { isInner } from "../model/stack"
import { resolvedComponents } from "../model/ruleAreas"
import { boardObstacles, exitCorridors } from "../model/autoplace"
import { boxOnBoard, outlineGeometry } from "../model/outline"
import { mountingHoles } from "../model/board"
import { pinKey } from "../model/connectivity"
import { padGap } from "../model/decoupling"
import { isPhysical, pcbCourtyard, pcbPads, type WorldPad } from "../model/instances"
import { findPart } from "../model/library"
import { classIndex } from "../model/netClasses"
import { netTraceWidth, resolvePinSpec, updateComponent } from "../model/ops"
import { copperOn, removeCopper } from "../model/boardCopper"
import { pointPadDistance, segmentPadDistance } from "../model/pcb"
import { findNearSpot, inflateBox, type NearAnchor } from "../model/placeNear"
import { matchCapability } from "../model/rules"
import type { ComponentInstance, PcbSide, Project } from "../model/types"
import { getConnectivity, getPcbAnalysis } from "../store/analysis"
import type { JsonSchema, ToolOutcome } from "./tools"
import { onBoard } from "../model/partFlags"

// The copilot's PCB hands: put, turn, flip and lock parts, set a net's trace width, clear copper.
// Kept apart from tools.ts, which wires these in with `...pcbToolSpecs`; this file imports only
// types from it, so the two don't depend on each other at run time.

interface PcbToolSpec {
  name: string
  description: string
  input_schema: JsonSchema & { type: "object" }
  run: (project: Project, input: Record<string, unknown>) => ToolOutcome
}

const ok = (project: Project, result: string, summary: string): ToolOutcome => ({ project, result, summary, isError: false })
const fail = (project: Project, message: string): ToolOutcome => ({ project, result: `Error: ${message}`, summary: message, isError: true })

/** The part with this reference: of the symbols of a part with several units, the one that is on the board. */
const findByRef = (project: Project, ref: unknown) => {
  if (typeof ref !== "string") return undefined
  const same = project.components.filter((c) => c.ref.toLowerCase() === ref.trim().toLowerCase())
  return same.find((c) => !findPart(c.partId)?.unitOf) ?? same[0]
}

const mm = (n: number) => n.toFixed(2)
/** A gap in mm: two decimals, three when it is tiny so a near miss doesn't read as "0.00". */
const gapMm = (n: number) => (n > 0 && n < 0.005 ? n.toFixed(3) : n.toFixed(2))
/** A width as written: 0.8, 1, 0.125. */
const len = (n: number) => String(Number(n.toFixed(3)))

/** Courtyard to the courtyards around it when a part is put beside a pin (mm). */
const SPACING = 0.25
/** How far from the pin a part is looked for (mm); beyond it the placement fails rather than land far away. */
const NEAR_REACH = 6
const DEFAULT_MAX_GAP = 1

// ---------- Copper that a move leaves behind ----------

/**
 * Unlocked routed copper, whatever net, that touches or crowds one of these parts' pads where they now
 * stand: a trace or via of another net, or any via sitting in a pad. Copper the move leaves behind
 * that would short or break clearance, and no longer reaches the pads it was routed to anyway.
 */
function conflictingCopper(before: Project, now: Project, refs: string[]) {
  const sch = getConnectivity(now)
  const analysis = getPcbAnalysis(before)
  // two nets keep the larger of their classes' clearances (a board with no classes: the rules' one)
  const classes = classIndex(now.rules)
  const netNames = new Map(sch.nets.map((n) => [n.id, n.name]))
  const clearanceBetween = (a: string | null, b: string | null) => classes.pair(a ? (netNames.get(a) ?? null) : null, b ? (netNames.get(b) ?? null) : null)
  const parts = now.components.filter((c) => refs.includes(c.ref) && c.pcb.placed)
  const pads = parts.flatMap((c) => pcbPads(c).map((pad) => ({ pad, net: pad.pin ? sch.pinNet.get(pinKey(c.id, pad.pin)) ?? null : null })))
  const traces = new Set<string>()
  const vias = new Set<string>()
  for (const t of now.traces) {
    if (t.locked) continue
    const net = analysis.traceNet.get(t.id) ?? null
    for (const { pad, net: padNet } of pads) {
      if (!pad.layers.includes(t.layer) || (net !== null && net === padNet)) continue
      const clearance = clearanceBetween(net, padNet)
      if (t.points.slice(1).some((p, i) => segmentPadDistance(t.points[i], p, pad) - t.width / 2 < clearance - 1e-6)) traces.add(t.id)
    }
  }
  for (const v of now.vias) {
    if (v.locked || v.net) continue
    const net = analysis.viaNet.get(v.id) ?? null
    for (const { pad, net: padNet } of pads) {
      const d = pointPadDistance(v, pad) - v.diameter / 2
      const clearance = clearanceBetween(net, padNet)
      if (d < -1e-6 || (d < clearance - 1e-6 && (net === null || net !== padNet))) vias.add(v.id)
    }
  }
  return { traces, vias }
}

/** Errors the checks report that these kinds add up to, as text, with how many of each. */
function errorCounts(project: Project, kinds: readonly string[]) {
  const counts = new Map<string, number>()
  for (const v of getPcbAnalysis(project).violations) {
    if (v.severity !== "error" || !kinds.includes(v.kind)) continue
    const key = `${v.kind}|${v.message}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
/** Messages of the errors in `after` beyond those in `before`. */
function newErrors(before: Map<string, number>, after: Map<string, number>) {
  const out: string[] = []
  for (const [key, n] of after) if (n > (before.get(key) ?? 0)) out.push(key.slice(key.indexOf("|") + 1))
  return out
}

// ---------- place_parts ----------

const DIRECTIONS = ["left", "right", "above", "below"] as const
type Direction = (typeof DIRECTIONS)[number]

interface PlacementItem {
  ref: string
  x?: number
  y?: number
  dx?: number
  dy?: number
  near?: string
  pin?: string
  direction?: Direction
  max_gap_mm?: number
  rotation?: number
  side?: PcbSide
  lock?: boolean
}

/** Check kinds a move must not make worse. */
const CHECKED = ["short", "clearance", "via-in-pad"] as const

const pinName = (c: ComponentInstance, pin: string) => {
  const n = findPart(c.partId)?.pins.find((p) => p.number === pin)?.name
  return `${c.ref}.${n && n !== pin ? n : pin}`
}

const boardBox = (p: Project): Box => ({
  minX: p.board.x - p.board.width / 2,
  maxX: p.board.x + p.board.width / 2,
  minY: p.board.y - p.board.height / 2,
  maxY: p.board.y + p.board.height / 2,
})

/** Problems a part standing where it is has: sticking out, on a mounting hole, or over another part. */
function standingProblems(project: Project, c: ComponentInstance): string[] {
  const box = pcbCourtyard(c)
  if (!box) return []
  const out: string[] = []
  const board = boardBox(project)
  const shape = outlineGeometry(project.board)
  if (box.minX < board.minX || box.maxX > board.maxX || box.minY < board.minY || box.maxY > board.maxY || (shape && !boxOnBoard(shape, box))) out.push("sticks out of the board outline")
  for (const h of mountingHoles(project.board)) {
    const r = h.diameter / 2
    if (boxesOverlap(box, { minX: h.x - r, maxX: h.x + r, minY: h.y - r, maxY: h.y + r })) out.push("covers a mounting hole")
  }
  const shrink = (b: Box): Box => ({ minX: b.minX + 0.05, maxX: b.maxX - 0.05, minY: b.minY + 0.05, maxY: b.maxY - 0.05 })
  const over = project.components
    .filter((o) => o.id !== c.id && o.pcb.placed && o.pcb.side === c.pcb.side)
    .filter((o) => {
      const ob = pcbCourtyard(o)
      return !!ob && boxesOverlap(shrink(box), shrink(ob))
    })
    .map((o) => o.ref)
  if (over.length) out.push(`overlaps ${over.join(", ")}`)
  return out
}

const sideIsBlocked = (o: ComponentInstance, side: PcbSide) => o.pcb.side === side || pcbPads(o).some((p) => p.layers.length > 1)

const placePartsTool: PcbToolSpec = {
  name: "place_parts",
  description: `Move, turn, flip and lock parts on the PCB, one or many in one call (one undo step). It changes the PCB only; update_component's x and y move the schematic. Board coordinates are millimetres with y up; get_design gives each part's PCB position and the board's centre.

Per part, give one of:
- near: a pin like "U1.VIN" (or a part, "U1") to put it beside. It lands in the nearest clear spot, turned whichever way keeps its pin closest, on that part's side, clear of courtyards, holes and fine-pitch pin exits. Its other pins that share a net with pads of that part (a capacitor's ground pin and the chip's ground pin) are kept close too. pin names which of this part's pins should touch it; max_gap_mm (default 1) is the pad-to-pad gap you want, direction (left, right, above, below) which side of the pin to prefer.
- x and y: absolute position of the part's origin. No clearance search; problems are reported.
- dx and dy: move by that much from where it is.
- or none of those, with rotation (degrees counter-clockwise, any angle), side (top, bottom) or lock alone.

lock: true pins a part so layout_pcb, dragging and re-packing leave it. A locked part is refused unless the same entry says lock: false. List parts others are placed near first: each entry sees the ones before it. Existing traces are kept as they are, like dragging a part in the editor, and the result says how many ended on the old pad positions; clear_traces: true removes those unlocked ones, and route_pcb routes them again. The result gives where each part landed and the pad gap to the pin it was put beside.`,
  input_schema: {
    type: "object",
    properties: {
      placements: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Designator of the part to move, e.g. \"C1\"" },
            near: { type: "string", description: "Pin to put the part beside, \"U1.VIN\" or \"U1.8\"; a bare ref puts it beside that part" },
            pin: { type: "string", description: "Which pin of this part should touch near; defaults to the pin on the same net" },
            direction: { type: "string", enum: [...DIRECTIONS], description: "Which side of near to prefer" },
            max_gap_mm: { type: "number", description: "Pad-to-pad gap wanted, default 1" },
            x: { type: "number", description: "Absolute board X in mm" },
            y: { type: "number", description: "Absolute board Y in mm, up is positive" },
            dx: { type: "number", description: "Move right by this many mm" },
            dy: { type: "number", description: "Move up by this many mm" },
            rotation: { type: "number", description: "Degrees counter-clockwise, any angle" },
            side: { type: "string", enum: ["top", "bottom"] },
            lock: { type: "boolean", description: "true pins the part, false releases it (and lets it move in this entry)" },
          },
          required: ["ref"],
        },
      },
      clear_traces: { type: "boolean", description: "Also remove the unlocked traces and vias that touched the moved parts' old pads" },
    },
    required: ["placements"],
  },
  run: (project, input) => {
    const items = (input.placements as PlacementItem[]).map((it) => (typeof it.rotation === "number" && Number.isFinite(it.rotation) ? { ...it, rotation: normalizeAngle(it.rotation) } : it))
    const clearTraces = input.clear_traces === true
    let next = project
    const lines: string[] = []
    const refused: string[] = []
    const moved: string[] = []
    const stale = { lockedTraces: 0, lockedVias: 0 }
    const staleTraces = new Set<string>()
    const staleVias = new Set<string>()
    const removedTraces = new Set<string>()
    const removedVias = new Set<string>()

    for (const item of items) {
      const c = findByRef(next, item.ref)
      const part = c && findPart(c.partId)
      if (!c || !part) {
        refused.push(`${String(item.ref)}: no such component`)
        continue
      }
      if (item.rotation !== undefined && (typeof item.rotation !== "number" || !Number.isFinite(item.rotation))) {
        refused.push(`${c.ref}: rotation must be a number of degrees, counter-clockwise (got ${String(item.rotation)})`)
        continue
      }
      if (!isPhysical(part) || !c.footprint) {
        refused.push(`${c.ref}: has no footprint, so it is not on the PCB`)
        continue
      }
      if (!onBoard(resolvedComponents(next).find((x) => x.id === c.id) ?? c)) {
        refused.push(`${c.ref} is not on the board (on_board false)`)
        continue
      }
      const modes = [item.near !== undefined, item.x !== undefined || item.y !== undefined, item.dx !== undefined || item.dy !== undefined].filter(Boolean).length
      if (modes > 1) {
        refused.push(`${c.ref}: give one of near, x and y, or dx and dy`)
        continue
      }
      const wantsMove = modes > 0 || (item.rotation !== undefined && item.rotation !== c.pcb.rot) || (item.side !== undefined && item.side !== c.pcb.side)
      if (c.pcb.locked && item.lock !== false && wantsMove) {
        refused.push(`${c.ref}: locked, so it stays at (${mm(c.pcb.x)}, ${mm(c.pcb.y)}); pass lock: false for it to release and move it`)
        continue
      }
      if (!wantsMove && item.lock === undefined) {
        refused.push(`${c.ref}: nothing to change; give near, x and y, dx and dy, rotation, side or lock`)
        continue
      }
      if (!c.pcb.placed && item.near === undefined && !(item.x !== undefined && item.y !== undefined)) {
        refused.push(`${c.ref}: is not on the PCB yet; give near, or both x and y, or run layout_pcb first`)
        continue
      }

      // Copper as it stands now, before this part moves.
      const attached = copperOn(next, [c])
      let pos = { x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot, side: c.pcb.side }
      const notes: string[] = []

      if (item.near !== undefined) {
        const found = placeNear(next, c, item, attached)
        if ("error" in found) {
          refused.push(`${c.ref}: ${found.error}`)
          continue
        }
        pos = found.pos
        notes.push(...found.notes)
      } else if (item.x !== undefined || item.y !== undefined) {
        pos = { ...pos, x: item.x ?? c.pcb.x, y: item.y ?? c.pcb.y, rot: item.rotation ?? c.pcb.rot, side: item.side ?? c.pcb.side }
      } else if (item.dx !== undefined || item.dy !== undefined) {
        pos = { ...pos, x: c.pcb.x + (item.dx ?? 0), y: c.pcb.y + (item.dy ?? 0), rot: item.rotation ?? c.pcb.rot, side: item.side ?? c.pcb.side }
      } else {
        pos = { ...pos, rot: item.rotation ?? c.pcb.rot, side: item.side ?? c.pcb.side }
      }

      const lock = item.lock === undefined ? c.pcb.locked : item.lock || undefined
      next = updateComponent(next, c.id, { pcb: { x: round(pos.x, 2), y: round(pos.y, 2), rot: pos.rot, side: pos.side, placed: true, locked: lock } })
      const now = next.components.find((x) => x.id === c.id)!
      moved.push(c.ref)

      const movedAway = pos.x !== c.pcb.x || pos.y !== c.pcb.y || pos.rot !== c.pcb.rot || pos.side !== c.pcb.side || !c.pcb.placed
      if (movedAway) {
        const free = attached.traces.filter((t) => !t.locked)
        const freeVias = attached.vias.filter((v) => !v.locked)
        if (clearTraces) {
          free.forEach((t) => removedTraces.add(t.id))
          freeVias.forEach((v) => removedVias.add(v.id))
        } else {
          free.forEach((t) => staleTraces.add(t.id))
          freeVias.forEach((v) => staleVias.add(v.id))
        }
        stale.lockedTraces += attached.traces.length - free.length
        stale.lockedVias += attached.vias.length - freeVias.length
      }
      notes.push(...standingProblems(next, now))
      const where = `(${mm(now.pcb.x)}, ${mm(now.pcb.y)}) rot ${now.pcb.rot} ${now.pcb.side}`
      lines.push(`${c.ref}: ${where}${lock ? ", locked" : ""}${notes.length ? `; ${notes.join("; ")}` : ""}`)
    }

    if (!moved.length) return fail(project, `Nothing was changed. ${refused.join(" ")}`)
    if (clearTraces && (removedTraces.size || removedVias.size)) next = removeCopper(next, removedTraces, removedVias)
    // Unlocked copper the move left standing where a moved pad now is would short or crowd it, and
    // no longer reaches the pads it was routed to: remove it instead of leaving a short.
    const bad = conflictingCopper(project, next, moved)
    if (bad.traces.size || bad.vias.size) next = removeCopper(next, bad.traces, bad.vias)
    const gone = (ids: Set<string>, now: { id: string }[]) => [...ids].filter((id) => now.some((x) => x.id === id)).length
    const staleLeft = { traces: gone(staleTraces, next.traces), vias: gone(staleVias, next.vias) }
    const tail: string[] = []
    const conflictTraces = [...bad.traces].filter((id) => !removedTraces.has(id)).length
    const conflictVias = [...bad.vias].filter((id) => !removedVias.has(id)).length
    // One summary of the unlocked copper: what the move removed, and what it left that no longer reaches its pad.
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
    const copperText = (traces: number, vias: number) => [traces ? plural(traces, "trace") : "", vias ? plural(vias, "via") : ""].filter(Boolean).join(" and ")
    const removed = { traces: removedTraces.size + conflictTraces, vias: removedVias.size + conflictVias }
    const left = clearTraces ? { traces: 0, vias: 0 } : staleLeft
    const summary: string[] = []
    if (removed.traces || removed.vias) summary.push(`removed ${copperText(removed.traces, removed.vias)} that touched the old pads or would have shorted`)
    if (left.traces || left.vias) summary.push(`left ${copperText(left.traces, left.vias)} that no longer ${left.traces + left.vias === 1 ? "reaches its" : "reach their"} pad (run route_pcb or clear_traces)`)
    if (summary.length) tail.push(`${summary.join("; ").replace(/^./, (ch) => ch.toUpperCase())}.`)
    if (stale.lockedTraces || stale.lockedVias) {
      tail.push(`${stale.lockedTraces} locked trace(s) and ${stale.lockedVias} locked via(s) touched the old pads and stay; they no longer reach the moved parts.`)
    }
    // Whatever the move leaves wrong is reported with its numbers; a short is refused, since nothing may leave one silently.
    const fresh = newErrors(errorCounts(project, CHECKED), errorCounts(next, CHECKED))
    // A short that copper makes goes away with the copper; one that stays is two pads on each other, which the
    // overlap check below reports. Only the first is refused.
    const bare = errorCounts({ ...next, traces: [], vias: [] }, CHECKED)
    const shorts = fresh.filter((m) => m.startsWith("Short") && !bare.has(`short|${m}`))
    if (shorts.length) {
      return fail(
        project,
        `Nothing was changed: the move would leave ${shorts.slice(0, 4).join("; ")}, from locked copper or the pads themselves. Unlock or clear_routing that copper, pick another spot, or use another rotation. ${refused.length ? `Not changed: ${refused.join("; ")}` : ""}`.trim(),
      )
    }
    const after = getPcbAnalysis(next).violations.filter(
      (v) => (v.kind === "overlap" || v.kind === "outside-board") && moved.some((r) => v.message.split(" ").includes(r)),
    )
    const reported = [...new Set([...fresh, ...after.map((v) => v.message)])]
    if (reported.length) tail.push(`Checks now report: ${reported.slice(0, 6).join("; ")}.`)
    const refusedText = refused.length ? `\nNot changed: ${refused.join("; ")}` : ""
    return ok(next, `${lines.join("\n")}${tail.length ? `\n${tail.join(" ")}` : ""}${refusedText}`, `Placed ${moved.join(", ")} on the PCB${refused.length ? ` (${refused.length} refused)` : ""}`)
  },
}

/** Resolve "U1.VIN" or "U1" to a placed part and the pads on it that count. */
function placeNear(
  project: Project,
  c: ComponentInstance,
  item: PlacementItem,
  attached: ReturnType<typeof copperOn>,
): { pos: { x: number; y: number; rot: number; side: PcbSide }; notes: string[] } | { error: string } {
  const spec = String(item.near).trim()
  const dot = spec.indexOf(".")
  const target = findByRef(project, dot < 0 ? spec : spec.slice(0, dot))
  if (!target) return { error: `near "${spec}": no component ${dot < 0 ? spec : spec.slice(0, dot)}` }
  if (target.id === c.id) return { error: "can't be put beside itself" }
  const targetPart = findPart(target.partId)
  if (!isPhysical(targetPart) || !target.pcb.placed) return { error: `${target.ref} is not on the PCB yet, so there is nothing to be beside; run layout_pcb or place it first` }
  const sch = getConnectivity(project)
  const netOf = (id: string, pin: string) => sch.pinNet.get(pinKey(id, pin))
  let targetPin: string | null = null
  if (dot >= 0) {
    const ref = resolvePinSpec(project, spec)
    if (!ref || ref.componentId !== target.id) {
      return { error: `near "${spec}": ${target.ref} ${targetPart!.pins.length ? `has pins ${targetPart!.pins.map((p) => (p.name === p.number ? p.number : `${p.number}/${p.name}`)).join(", ")}` : "has no pins"}` }
    }
    targetPin = ref.pin
  }
  const part = findPart(c.partId)!
  const targetPads = pcbPads(target).filter((p) => p.pin !== null)
  const primaryPads = targetPin ? targetPads.filter((p) => p.pin === targetPin) : targetPads
  if (!primaryPads.length) return { error: `${target.ref} has no pad for ${spec}` }

  // The pin of this part that should touch: named, else the one on the same net, else the first.
  let ownPin: string | undefined
  if (item.pin !== undefined) {
    const ref = resolvePinSpec(project, `${c.ref}.${item.pin}`)
    if (!ref) return { error: `pin "${item.pin}": ${c.ref} ${part.pins.length ? `has pins ${part.pins.map((p) => (p.name === p.number ? p.number : `${p.number}/${p.name}`)).join(", ")}` : "has no pins"}` }
    ownPin = ref.pin
  } else {
    const wanted = new Set(primaryPads.map((p) => (p.pin ? netOf(target.id, p.pin) : undefined)).filter((n): n is string => !!n))
    ownPin = part.pins.find((p) => {
      const n = netOf(c.id, p.number)
      return !!n && wanted.has(n)
    })?.number
    ownPin ??= part.pins[0]?.number
  }
  if (!ownPin) return { error: "has no pins" }

  const anchors: NearAnchor[] = [{ pin: ownPin, targets: primaryPads, weight: 1 }]
  // Its other pins on nets the target has pads on stay close too.
  for (const p of part.pins) {
    if (p.number === ownPin) continue
    const net = netOf(c.id, p.number)
    if (!net || net === netOf(c.id, ownPin)) continue
    const same = targetPads.filter((t) => t.pin && netOf(target.id, t.pin) === net)
    if (same.length) anchors.push({ pin: p.number, targets: same, weight: 0.5 })
  }

  const side: PcbSide = item.side ?? target.pcb.side
  // Courtyards that stand where this part would, on its side or through the board, and copper that stays.
  const dropped = new Set(attached.traces.map((t) => t.id))
  const droppedVias = new Set(attached.vias.map((v) => v.id))
  const obstacles = boardObstacles({
    ...project,
    traces: project.traces.filter((t) => !dropped.has(t.id) || t.locked),
    vias: project.vias.filter((v) => !droppedVias.has(v.id) || v.locked),
  })
  const others = resolvedComponents(project)
    .filter((o) => o.id !== c.id && o.pcb.placed && onBoard(o) && sideIsBlocked(o, side))
    .map((o) => pcbCourtyard(o))
    .filter((b): b is Box => !!b)
    .map((b) => inflateBox(b, SPACING))
  const exempt = new Set(anchors.map((a) => netOf(c.id, a.pin)).filter((n): n is string => !!n))
  const corridors = exitCorridors(target, (pin) => netOf(target.id, pin), exempt)
  const edge = Math.max(project.rules.edgeClearance, 0.3)
  const board = boardBox(project)
  const keepIn = { minX: board.minX + edge, maxX: board.maxX - edge, minY: board.minY + edge, maxY: board.maxY - edge }
  const centre = { x: primaryPads.reduce((s, p) => s + p.x, 0) / primaryPads.length, y: primaryPads.reduce((s, p) => s + p.y, 0) / primaryPads.length }
  const direction = item.direction
  const penalty = direction
    ? (at: { x: number; y: number }) => {
        const wrong =
          (direction === "left" && at.x > centre.x) || (direction === "right" && at.x < centre.x) || (direction === "above" && at.y < centre.y) || (direction === "below" && at.y > centre.y)
        return wrong ? 3 : 0
      }
    : undefined

  const spot = findNearSpot(c, anchors, {
    side,
    rotations: item.rotation === undefined ? undefined : [item.rotation],
    blocked: [...others, ...corridors, ...obstacles],
    keepIn,
    reach: NEAR_REACH,
    penalty,
  })
  if (!spot) return { error: `no clear spot within ${NEAR_REACH} mm of ${spec}: the courtyards, holes, copper and pin exits around it are in the way. Move something aside first, try the other side, or enlarge the board` }

  let placed: ComponentInstance = { ...c, pcb: { ...c.pcb, x: spot.x, y: spot.y, rot: spot.rot, side: spot.side, placed: true } }
  const notes: string[] = []
  const gapsOf = (part: ComponentInstance, a: NearAnchor) => {
    let best: { gap: number; pad: WorldPad } | null = null
    for (const p of pcbPads(part).filter((x) => x.pin === a.pin)) for (const t of a.targets as WorldPad[]) if (!best || padGap(p, t) < best.gap) best = { gap: padGap(p, t), pad: t }
    return best
  }
  const cost = (part: ComponentInstance) => anchors.reduce((sum, a) => sum + a.weight * (gapsOf(part, a)?.gap ?? Infinity), 0)
  // Already as close as the search can get, and standing clear: stay put rather than shuffle to a worse spot
  // (copper that stays can make the search's best spot worse than where the part already is).
  if (c.pcb.placed && c.pcb.side === side && !direction && (item.rotation === undefined || item.rotation === c.pcb.rot) && cost(c) <= cost(placed) + 1e-6 && !standingProblems(project, c).length) {
    placed = c
  }
  const gapTo = (a: NearAnchor) => gapsOf(placed, a)
  const pieces = anchors.flatMap((a) => {
    const g = gapTo(a)
    return g ? [`${gapMm(g.gap)} mm from ${pinName(target, g.pad.pin!)} (${pinName(placed, a.pin)})`] : []
  })
  notes.push(pieces.join(", "))
  if (placed === c) notes.push("already as close as it can get, so it stays")
  const wanted = item.max_gap_mm ?? DEFAULT_MAX_GAP
  const first = gapTo(anchors[0])
  if (first && first.gap > wanted + 1e-6) notes.push(`NOT within the ${len(wanted)} mm asked; the closest clear spot is ${gapMm(first.gap)} mm away, so move what is in the way or pick another side`)
  return { pos: { x: placed.pcb.x, y: placed.pcb.y, rot: placed.pcb.rot, side: placed.pcb.side }, notes }
}

// ---------- set_net_width ----------

const MAX_WIDTH = 10

const setNetWidthTool: PcbToolSpec = {
  name: "set_net_width",
  description:
    "Set the trace width of nets, in millimetres: the Inspector's net list does the same. Use it for supply and power-stage nets (VIN, SW, VOUT, GND) before route_pcb; the autorouter and hand routing use it for new traces on that net. A pad narrower than the width is left by a short neck as wide as the pad; a connection with no room for the width at all goes in narrower, and route_pcb says which. Widths below the design rules' minimum trace width are refused. Existing traces keep their width: clear_routing the net, then route_pcb. widths maps net names to widths; reset lists nets to return to the default width.",
  input_schema: {
    type: "object",
    properties: {
      widths: { type: "object", description: "Net name to trace width in mm, e.g. {\"VIN\": 0.8, \"SW\": 1}", additionalProperties: { type: "number" } },
      reset: { type: "array", items: { type: "string" }, description: "Nets that go back to the default trace width" },
    },
  },
  run: (project, input) => {
    const widths = (input.widths ?? {}) as Record<string, number>
    const reset = (input.reset ?? []) as string[]
    if (!Object.keys(widths).length && !reset.length) return fail(project, "Give widths (net name to mm) or reset (net names)")
    const conn = getConnectivity(project)
    const named = conn.nets.filter((n) => n.pins.length > 0)
    const find = (name: string) => named.find((n) => n.name === name)
    const hint = (name: string) => {
      const near = named.filter((n) => n.name.toLowerCase() === name.toLowerCase() || n.name.toLowerCase().includes(name.toLowerCase())).slice(0, 3)
      return near.length ? ` Did you mean ${near.map((n) => n.name).join(", ")}?` : ` Nets: ${named.filter((n) => n.named).map((n) => n.name).slice(0, 12).join(", ") || "none named yet"}.`
    }
    const rules = project.rules
    const cap = matchCapability(rules)
    const problems: string[] = []
    for (const [name, w] of Object.entries(widths)) {
      if (!find(name)) problems.push(`no net named ${name}.${hint(name)}`)
      else if (!(w >= rules.minTraceWidth - 1e-9)) {
        problems.push(
          `${name}: ${w} mm is below the ${len(rules.minTraceWidth)} mm minimum trace width of the design rules (${cap ? `${cap.name} class` : "custom rules"}). Use ${len(rules.minTraceWidth)} mm or more, or change the fab class with set_design_rules`,
        )
      } else if (w > MAX_WIDTH) problems.push(`${name}: ${w} mm is wider than ${MAX_WIDTH} mm`)
    }
    for (const name of reset) if (!find(name) && rules.netWidths?.[name] === undefined) problems.push(`no net named ${name}.${hint(name)}`)
    if (problems.length) return fail(project, `Nothing was changed. ${problems.join(" ")}`)

    const netWidths = { ...rules.netWidths }
    const lines: string[] = []
    const analysis = getPcbAnalysis(project)
    const widthOf = (net: string) => netTraceWidth(rules, net)
    for (const [name, w] of Object.entries(widths)) {
      const width = round(w, 4)
      const before = widthOf(name)
      netWidths[name] = width
      const id = find(name)!.id
      const traces = project.traces.filter((t) => analysis.traceNet.get(t.id) === id && Math.abs(t.width - width) > 1e-6)
      const pads = project.components
        .flatMap((c) => (c.pcb.placed ? pcbPads(c) : []))
        .filter((p) => p.pin && !p.holeDiameter && conn.pinNet.get(pinKey(p.componentId, p.pin)) === id)
      const narrow = pads.filter((p) => Math.min(p.width, p.height) < width - 1e-6)
      const notes: string[] = []
      if (narrow.length) notes.push(`${narrow.length} pad(s) are narrower, down to ${mm(Math.min(...narrow.map((p) => Math.min(p.width, p.height))))} mm; traces into them neck down to the pad's width at the pad`)
      if (traces.length) notes.push(`${traces.length} existing trace(s) keep their width; clear_routing this net and run route_pcb to use the new one`)
      lines.push(`${name}: ${len(width)} mm (was ${len(before)}${rules.netWidths?.[name] === undefined ? ", the default" : ""})${notes.length ? `; ${notes.join("; ")}` : ""}`)
    }
    for (const name of reset) {
      if (name in widths) continue
      if (rules.netWidths?.[name] === undefined) {
        lines.push(`${name}: already at the default ${len(rules.traceWidth)} mm`)
        continue
      }
      delete netWidths[name]
      const fallback = netTraceWidth({ ...rules, netWidths: undefined }, name)
      lines.push(fallback === rules.traceWidth ? `${name}: back to the default ${len(rules.traceWidth)} mm` : `${name}: back to the width of its net class, ${len(fallback)} mm`)
    }
    const changed = Object.keys(widths).length + reset.filter((n) => !(n in widths) && rules.netWidths?.[n] !== undefined).length
    if (!changed) return ok(project, lines.join("\n"), "No net widths changed")
    const next = { ...project, updatedAt: Date.now(), rules: { ...rules, netWidths } }
    return ok(next, `${lines.join("\n")}\nRe-routing stays with route_pcb.`, `Set trace width on ${Object.keys(widths).concat(reset.filter((n) => !(n in widths))).join(", ")}`)
  },
}

// ---------- clear_routing ----------

const clearRoutingTool: PcbToolSpec = {
  name: "clear_routing",
  description:
    "Delete copper: traces and vias that are not pour stitching. With no arguments, every unlocked one. nets limits it to those nets, refs to copper touching those parts' pads. Locked copper (drawn by hand) stays unless include_locked is true. Use it before route_pcb after moving parts or changing a net's width, so the traces are made again. Inner-layer traces and blind, buried, micro or inner-joining vias stay (the router cannot remake them).",
  input_schema: {
    type: "object",
    properties: {
      nets: { type: "array", items: { type: "string" } },
      refs: { type: "array", items: { type: "string" } },
      include_locked: { type: "boolean" },
    },
  },
  run: (project, input) => {
    const nets = (input.nets ?? []) as string[]
    const refs = (input.refs ?? []) as string[]
    const conn = getConnectivity(project)
    const analysis = getPcbAnalysis(project)
    const ids = new Set<string>()
    for (const name of nets) {
      const net = conn.nets.find((n) => n.name === name && n.pins.length > 0)
      if (!net) return fail(project, `No net named ${name}`)
      ids.add(net.id)
    }
    const parts: ComponentInstance[] = []
    for (const ref of refs) {
      const c = findByRef(project, ref)
      if (!c) return fail(project, `No component ${ref}`)
      parts.push(c)
    }
    const onParts = parts.length ? copperOn(project, parts) : null
    const wanted = <T extends { id: string }>(item: T, netOf: Map<string, string | null>, touching: T[] | undefined) => {
      if (!nets.length && !refs.length) return true
      return (nets.length > 0 && ids.has(netOf.get(item.id) ?? "")) || (touching?.some((t) => t.id === item.id) ?? false)
    }
    const includeLocked = input.include_locked === true
    // Inner layers are not the router's (X1): what is on them, and what joins it, is the user's.
    const innerSegments = analysis.items.filter((it) => it.kind === "segment" && it.layers.some(isInner))
    const joinsInner = (v: Project["vias"][number]) => innerSegments.some((it) => it.kind === "segment" && it.box.minX <= v.x + v.diameter / 2 && it.box.maxX >= v.x - v.diameter / 2 && it.box.minY <= v.y + v.diameter / 2 && it.box.maxY >= v.y - v.diameter / 2 && pointSegmentDistance(v, it.a, it.b) <= it.width / 2 + v.diameter / 2 + 1e-6)
    const traces = project.traces.filter((t) => !isInner(t.layer) && wanted(t, analysis.traceNet, onParts?.traces) && (includeLocked || !t.locked))
    const vias = project.vias.filter((v) => !v.net && v.kind === undefined && !joinsInner(v) && wanted(v, analysis.viaNet, onParts?.vias) && (includeLocked || !v.locked))
    const lockedKept = includeLocked ? 0 : project.traces.filter((t) => t.locked && wanted(t, analysis.traceNet, onParts?.traces)).length
    if (!traces.length && !vias.length) {
      return ok(project, `There is no ${includeLocked ? "" : "unlocked "}copper to clear${nets.length || refs.length ? " there" : ""}.`, "No copper to clear")
    }
    const next = removeCopper(project, new Set(traces.map((t) => t.id)), new Set(vias.map((v) => v.id)))
    const kept = lockedKept ? ` ${lockedKept} locked trace(s) stay.` : ""
    return ok(next, `Removed ${traces.length} trace(s) and ${vias.length} via(s).${kept} Pour stitching vias stay. route_pcb routes the connections again.`, `Cleared ${traces.length} traces and ${vias.length} vias`)
  },
}

export const pcbToolSpecs: PcbToolSpec[] = [placePartsTool, setNetWidthTool, clearRoutingTool]

/** Activity labels of these tools, for the transcript. */
export function pcbToolLabel(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "place_parts": {
      const refs = Array.isArray(input.placements) ? (input.placements as { ref?: unknown }[]).map((p) => String(p.ref ?? "")).filter(Boolean) : []
      return `Placing ${refs.length ? refs.slice(0, 4).join(", ") + (refs.length > 4 ? "..." : "") : "parts"} on the PCB`
    }
    case "set_net_width":
      return `Setting trace width on ${Object.keys((input.widths ?? {}) as object).join(", ") || "nets"}`
    case "clear_routing":
      return "Clearing routing"
    default:
      return null
  }
}
