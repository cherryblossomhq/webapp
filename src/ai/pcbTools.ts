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
import {
  addNetClass,
  assignNet,
  classIndex,
  classValuesOfClass,
  DEFAULT_CLASS_NAME,
  defaultClassName,
  findClearanceRule,
  removeClearanceRule,
  removeNetClass,
  setClassField,
  setClassPatterns,
  setClearanceRule,
  type ClassField,
} from "../model/netClasses"
import { addTrace, addVia, netTraceWidth, resolvePinSpec, updateComponent } from "../model/ops"
import { pourMissNote } from "../model/pourReach"
import { copperLayers } from "../model/stack"
import { addBoardText, removeBoardTexts, updateBoardTexts } from "../model/textOps"
import { isKicadText, isTextLayer, textLayerKind } from "../model/texts"
import { defaultTextStyle } from "../editor/pcb/textEditing"
import { copperOn, removeCopper } from "../model/boardCopper"
import { pointPadDistance, segmentPadDistance } from "../model/pcb"
import { areaNames, areasOfPart, nearestInAreas, partInAreas } from "../model/placementAreas"
import { findNearSpot, inflateBox, type NearAnchor } from "../model/placeNear"
import { matchCapability } from "../model/rules"
import type { ClearanceRule, ComponentInstance, CopperLayer, PcbSide, Project, Vec2 } from "../model/types"
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
  // two nets keep the larger of their classes' clearances (a board with no classes: the rules' one), or a clearance rule's for them or the pad's part
  const classes = classIndex(now.rules)
  const netNames = new Map(sch.nets.map((n) => [n.id, n.name]))
  const clearanceBetween = (a: string | null, b: string | null, part: string) => classes.pair(a ? (netNames.get(a) ?? null) : null, b ? (netNames.get(b) ?? null) : null, null, part)
  const parts = now.components.filter((c) => refs.includes(c.ref) && c.pcb.placed)
  const pads = parts.flatMap((c) => pcbPads(c).map((pad) => ({ pad, net: pad.pin ? sch.pinNet.get(pinKey(c.id, pad.pin)) ?? null : null })))
  const traces = new Set<string>()
  const vias = new Set<string>()
  for (const t of now.traces) {
    if (t.locked) continue
    const net = analysis.traceNet.get(t.id) ?? null
    for (const { pad, net: padNet } of pads) {
      if (!pad.layers.includes(t.layer) || (net !== null && net === padNet)) continue
      const clearance = clearanceBetween(net, padNet, pad.componentId)
      if (t.points.slice(1).some((p, i) => segmentPadDistance(t.points[i], p, pad) - t.width / 2 < clearance - 1e-6)) traces.add(t.id)
    }
  }
  for (const v of now.vias) {
    if (v.locked || v.net) continue
    const net = analysis.viaNet.get(v.id) ?? null
    for (const { pad, net: padNet } of pads) {
      const d = pointPadDistance(v, pad) - v.diameter / 2
      const clearance = clearanceBetween(net, padNet, pad.componentId)
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

/**
 * Problems a part standing where it is has: sticking out, or on a mounting hole. Over another part is the overlap check's to say,
 * once every part has moved (`Checks now report`), by the turned courtyard: the box around a part at 72 degrees overlapped
 * neighbours the part did not, and the call said so where Checks did not.
 */
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

lock: true pins a part so layout_pcb, dragging and re-packing leave it. A locked part is refused unless the same entry says lock: false. A part a placement area holds is kept inside it (moved to the nearest spot, and said). List parts others are placed near first: each entry sees the ones before it. Existing traces are kept as they are, like dragging a part in the editor, and the result says how many ended on the old pad positions; clear_traces: true removes those unlocked ones, and route_pcb routes them again. The result gives where each part landed and the pad gap to the pin it was put beside.`,
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

      // X20: a part a placement area holds stays inside it: a spot outside is moved to the nearest one inside, and said; one that cannot fit is refused.
      const moves = pos.x !== c.pcb.x || pos.y !== c.pcb.y || pos.rot !== c.pcb.rot || pos.side !== c.pcb.side
      const held = moves ? areasOfPart(next, c, undefined, pos.side) : []
      if (held.length && !partInAreas(c, held, pos)) {
        const fit = nearestInAreas(c, held, pos)
        if (!fit) {
          refused.push(`${c.ref}: it does not fit inside ${areaNames(held)}; make the area bigger (set_pour with its id)`)
          continue
        }
        notes.push(`kept inside ${areaNames(held)}: (${mm(pos.x)}, ${mm(pos.y)}) is outside it, so it is at (${mm(fit.x)}, ${mm(fit.y)})`)
        pos = { ...pos, x: fit.x, y: fit.y }
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

// ---------- set_net_class ----------

/** The sizes a class sets through the tool, with the range each takes in mm. */
const CLASS_SIZES: [string, ClassField, number, number][] = [
  ["clearance", "clearance", 0, 10],
  ["trace_width", "traceWidth", 0.05, 10],
  ["via_diameter", "viaDiameter", 0.2, 5],
  ["via_drill", "viaDrill", 0.1, 3],
]

/** The named nets with pins, and a sentence that points to the near ones for a name that is not one of them. */
function netNames(project: Project) {
  const named = getConnectivity(project).nets.filter((n) => n.pins.length > 0)
  const has = (name: string) => named.some((n) => n.name === name)
  const hint = (name: string) => {
    const near = named.filter((n) => n.name.toLowerCase().includes(name.toLowerCase())).slice(0, 3)
    return near.length ? ` Did you mean ${near.map((n) => n.name).join(", ")}?` : ` Nets: ${named.filter((n) => n.named).map((n) => n.name).slice(0, 12).join(", ") || "none named yet"}.`
  }
  return { named, has, hint }
}

/** Check errors of these kinds an edit brought that the board did not have, as their messages: what a hand edit by a tool may not leave behind. */
const errorsAdded = (before: Project, after: Project, kinds: readonly string[]) => newErrors(errorCounts(before, kinds), errorCounts(after, kinds))

/** The errors that copper put down by hand may not bring: anything that shorts, crowds or leaves the board. */
const COPPER_ERRORS = ["short", "clearance", "edge-clearance", "outside-board", "hole-clearance", "keepout", "via-in-pad", "trace-width"]

const setNetClassTool: PcbToolSpec = {
  name: "set_net_class",
  description:
    "Make, change or remove a net class: nets with their own clearance to every other net, trace width and via size, as KiCad's. Two nets keep the larger of their classes' clearances, so a Mains class at 2.5 mm holds its nets 2.5 mm from the rest while those keep the board's. Routing, pours and checks follow it: clear_routing and route_pcb its nets after a change. A size left out is Default's (the design rules); a width from set_net_width wins.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "e.g. Mains; made if new" },
      nets: { type: "array", items: { type: "string" } },
      remove_nets: { type: "array", items: { type: "string" }, description: "Back to Default" },
      patterns: { type: "array", items: { type: "string" }, description: "Net name patterns (* and ?), replacing its own" },
      ...Object.fromEntries(CLASS_SIZES.map(([key]) => [key, { type: "number" }])),
      reset: { type: "array", items: { type: "string", enum: CLASS_SIZES.map(([key]) => key) }, description: "Sizes back to Default" },
      remove: { type: "boolean" },
    },
    required: ["name"],
  },
  run: (project, input) => {
    const name = String(input.name ?? "").trim()
    if (!name) return fail(project, "Name the class")
    let rules = project.rules
    if (name === DEFAULT_CLASS_NAME || name === defaultClassName(rules)) return fail(project, `${name} is the design rules themselves: change its sizes with set_design_rules`)
    const existing = (rules.netClasses ?? []).find((c) => c.name === name) ?? (rules.netClasses ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase())
    const cls = existing?.name ?? name
    if (input.remove === true) {
      if (!existing) return fail(project, `There is no net class ${name}`)
      const next = { ...project, updatedAt: Date.now(), rules: removeNetClass(rules, cls) }
      return ok(next, `Removed the net class ${cls}; its nets are in Default again. clear_routing and route_pcb to re-route them.`, `Removed net class ${cls}`)
    }
    const { has, hint } = netNames(project)
    const nets = ((input.nets ?? []) as string[]).map((n) => n.trim()).filter(Boolean)
    const out = ((input.remove_nets ?? []) as string[]).map((n) => n.trim()).filter(Boolean)
    const problems = [...nets, ...out].filter((n) => !has(n)).map((n) => `no net named ${n}.${hint(n)}`)
    for (const [key, , min, max] of CLASS_SIZES) {
      if (input[key] === undefined) continue
      const v = Number(input[key])
      if (!(v >= min && v <= max)) problems.push(`${key} must be between ${min} and ${max} mm`)
    }
    if (problems.length) return fail(project, `Nothing was changed. ${problems.join(" ")}`)

    if (!existing) rules = addNetClass(rules, cls)
    for (const [key, field] of CLASS_SIZES) if (input[key] !== undefined) rules = setClassField(rules, cls, field, round(Number(input[key]), 4))
    for (const key of (input.reset ?? []) as string[]) {
      const field = CLASS_SIZES.find(([k]) => k === key)?.[1]
      if (field) rules = setClassField(rules, cls, field, undefined)
    }
    if (Array.isArray(input.patterns)) rules = setClassPatterns(rules, cls, input.patterns as string[])
    for (const n of nets) rules = assignNet(rules, n, cls)
    for (const n of out) if (rules.netClasses?.find((c) => c.name === cls)?.nets.includes(n)) rules = assignNet(rules, n, null)
    const v = classValuesOfClass(rules, cls)
    if (v.viaDrill >= v.viaDiameter) return fail(project, `Nothing was changed. The class's via drill (${len(v.viaDrill)} mm) must be smaller than its via diameter (${len(v.viaDiameter)} mm)`)

    const next = { ...project, updatedAt: Date.now(), rules }
    const index = classIndex(rules)
    const members = getConnectivity(next).nets.filter((n) => n.pins.length > 0 && index.classOf(n.name)?.name === cls).map((n) => n.name)
    const own = rules.netClasses!.find((c) => c.name === cls)!
    const size = (field: ClassField, label: string) => `${label} ${len(v[field] as number)} mm${own[field] === undefined ? " (Default's)" : ""}`
    const analysis = getPcbAnalysis(next)
    const errors = analysis.violations.filter((x) => x.severity === "error" && x.kind !== "unrouted").length
    const missed = [...new Set(next.zones.filter((z) => z.net && !z.keepout).map((z) => z.net))].map((net) => pourMissNote(next, analysis, net)).join("")
    return ok(
      next,
      `Net class ${cls}${existing ? "" : " made"}: ${size("clearance", "clearance")}, ${size("traceWidth", "trace width")}, ${size("viaDiameter", "via")}/${len(v.viaDrill)} mm. Nets in it: ${members.join(", ") || "none yet"}. Two nets keep the larger of their classes' clearances; traces already down keep their place, so clear_routing them and route_pcb.${errors ? ` The board now has ${errors} check error(s); run_checks lists them.` : ""}${missed}`,
      `${existing ? "Changed" : "Made"} net class ${cls}`,
    )
  },
}

// ---------- set_clearance_rule ----------

/** The project's clearance rules as the model reads them: by net names, or by the part's designator. */
export function clearanceRuleRows(project: Project): Record<string, unknown>[] {
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  return (project.rules.clearanceRules ?? []).map((r) =>
    r.nets ? { nets: r.nets, clearance: r.clearance } : { ref: refOf.get(r.component!) ?? "a part no longer in the design", clearance: r.clearance },
  )
}

/** A clearance rule in words: "L and N at 1.5 mm", "K1's pads at 1 mm". */
const ruleWords = (project: Project, r: ClearanceRule) =>
  r.nets ? `${r.nets[0]} and ${r.nets[1]} at ${len(r.clearance)} mm` : `${project.components.find((c) => c.id === r.component)?.ref ?? "a removed part"}'s pads at ${len(r.clearance)} mm`

/** The finest clearance a rule may set: the board's minimum when it has one, else what the finest fab class makes (or the rules' own clearance, if that is finer). */
const ruleFloor = (project: Project) => project.rules.minClearance ?? Math.min(0.1, project.rules.clearance)

const setClearanceRuleTool: PcbToolSpec = {
  name: "set_clearance_rule",
  description:
    "Give one pair of nets (nets: two names), or one part's pads against copper of every other net (ref), a clearance of their own that replaces what the net classes and the board give, smaller or larger, as KiCad's custom rules do: a relay, fuse holder or connector whose own pins sit closer than a Mains class or the board's clearance allows, or two nets to keep further apart than their classes say. Where several rules apply to two pieces of copper, the largest does; never below the board's minimum clearance. Routing, pours and checks follow it: clear_routing and route_pcb the nets after a change. remove takes a rule away; with neither nets nor ref it lists the rules.",
  input_schema: {
    type: "object",
    properties: {
      nets: { type: "array", items: { type: "string" }, minItems: 2, description: "The two nets, e.g. [\"L\", \"N\"]" },
      ref: { type: "string", description: "A part whose pads keep this clearance from every other net, e.g. K1" },
      clearance: { type: "number", description: "mm" },
      remove: { type: "boolean" },
    },
  },
  run: (project, input) => {
    const list = (q: Project = project) => {
      const rows = (q.rules.clearanceRules ?? []).map((r) => ruleWords(q, r))
      return rows.length ? `Clearance rules: ${rows.join("; ")}.` : "There are no clearance rules: every pair of nets keeps the larger of their classes' clearances."
    }
    const netsIn = Array.isArray(input.nets) ? (input.nets as string[]).map((n) => String(n).trim()).filter(Boolean) : null
    const ref = typeof input.ref === "string" ? input.ref.trim() : ""
    if (!netsIn && !ref) return ok(project, list(), "Listed clearance rules")
    if (netsIn && ref) return fail(project, "Give nets or ref, not both: a rule is for one pair of nets or for one part's pads")
    let target: Pick<ClearanceRule, "nets" | "component">
    let what: string
    if (netsIn) {
      if (netsIn.length !== 2) return fail(project, `nets is two net names, not ${netsIn.length}`)
      if (netsIn[0] === netsIn[1]) return fail(project, `${netsIn[0]} twice: a rule is between two different nets`)
      const { has, hint } = netNames(project)
      // A rule whose net is gone (deleted, or renamed by hand) is still removed by the names the list gives.
      const removing = input.remove === true && !!findClearanceRule(project.rules.clearanceRules, { nets: [netsIn[0], netsIn[1]] })
      const unknown = removing ? [] : netsIn.filter((n) => !has(n))
      if (unknown.length) return fail(project, `Nothing was changed. ${unknown.map((n) => `No net named ${n}.${hint(n)}`).join(" ")}`)
      target = { nets: [netsIn[0], netsIn[1]] }
      what = `${netsIn[0]} and ${netsIn[1]}`
    } else {
      const c = project.components.find((x) => x.ref === ref && onBoard(x) && isPhysical(findPart(x.partId))) ?? project.components.find((x) => x.ref === ref)
      if (!c) return fail(project, `No part ${ref}`)
      target = { component: c.id }
      what = `${ref}'s pads`
    }
    if (input.remove === true) {
      if (!findClearanceRule(project.rules.clearanceRules, target)) return fail(project, `There is no clearance rule for ${what}. ${list()}`)
      const next = { ...project, updatedAt: Date.now(), rules: removeClearanceRule(project.rules, target) }
      return ok(next, `Removed the clearance rule for ${what}: their classes' clearances apply again. clear_routing and route_pcb what was routed by it. ${list(next)}`, `Removed the clearance rule for ${what}`)
    }
    const clearance = Number(input.clearance)
    if (input.clearance === undefined || !Number.isFinite(clearance)) return fail(project, "Give clearance in mm, or remove true")
    const floor = ruleFloor(project)
    if (clearance < floor - 1e-9 || clearance > 20) {
      return fail(
        project,
        `Nothing was changed. ${len(clearance)} mm is ${clearance > 20 ? "more than 20 mm" : `below the ${len(floor)} mm ${project.rules.minClearance !== undefined ? "minimum clearance of the board" : "the finest fab class makes"}`}.`,
      )
    }
    const was = classIndex(removeClearanceRule(project.rules, target))
    const classGives = target.nets ? ` (their classes give ${len(was.pair(target.nets[0], target.nets[1]))} mm)` : ""
    const next = { ...project, updatedAt: Date.now(), rules: setClearanceRule(project.rules, { ...target, clearance: round(clearance, 4) }) }
    const analysis = getPcbAnalysis(next)
    const errors = analysis.violations.filter((x) => x.severity === "error" && x.kind !== "unrouted").length
    const missed = [...new Set(next.zones.filter((z) => z.net && !z.keepout).map((z) => z.net))].map((net) => pourMissNote(next, analysis, net)).join("")
    return ok(
      next,
      `Clearance rule: ${what} at ${len(clearance)} mm${classGives}${target.component ? `, from copper of every other net, in place of the classes'` : ""}. Copper already down keeps its place: clear_routing the nets near it and route_pcb.${errors ? ` The board has ${errors} check error(s); run_checks lists them.` : ""}${missed} ${list(next)}`,
      `Clearance rule for ${what}: ${len(clearance)} mm`,
    )
  },
}

// ---------- draw_trace ----------

const drawTraceTool: PcbToolSpec = {
  name: "draw_trace",
  description:
    "Draw a trace by hand on one copper layer through points (mm, y up), at the net's width unless width is given, locked so routing keeps it. It must touch its net's copper (start on a pad's centre, a via or a trace of it) and is refused if it would short, crowd other copper or leave the board. via_at_end ends it on a via, to go on on another layer.",
  input_schema: {
    type: "object",
    properties: {
      net: { type: "string" },
      points: { type: "array", items: { type: "number" }, minItems: 4, description: "x1, y1, x2, y2, ..." },
      layer: { type: "string", description: "top (default), bottom, in1, ..." },
      width: { type: "number" },
      via_at_end: { type: "boolean" },
    },
    required: ["net", "points"],
  },
  run: (project, input) => {
    const net = String(input.net ?? "").trim()
    const { named, has, hint } = netNames(project)
    if (!has(net)) return fail(project, `No net named ${net}.${hint(net)}`)
    const nums = input.points as unknown[]
    if (nums.length % 2 || !nums.every((n) => typeof n === "number" && Number.isFinite(n))) return fail(project, "points needs x, y pairs: at least two points")
    const points: Vec2[] = Array.from({ length: nums.length / 2 }, (_, i) => ({ x: nums[2 * i] as number, y: nums[2 * i + 1] as number }))
    const layers = copperLayers(project.board) as string[]
    const layer = (typeof input.layer === "string" ? input.layer : "top") as CopperLayer
    if (!layers.includes(layer)) return fail(project, `layer must be one of ${layers.join(", ")}`)
    const rules = project.rules
    const width = typeof input.width === "number" ? round(input.width, 4) : netTraceWidth(rules, net)
    if (!(width >= rules.minTraceWidth - 1e-9)) return fail(project, `${width} mm is below the ${len(rules.minTraceWidth)} mm minimum trace width of the design rules`)
    if (width > 10) return fail(project, `${width} mm is wider than 10 mm`)
    const drawn = addTrace(project, { layer, width, points, locked: true })
    if (!drawn.trace) return fail(project, "Those points make no trace: give two different points or more")
    let next = drawn.project
    const end = drawn.trace.points[drawn.trace.points.length - 1]
    if (input.via_at_end === true) next = { ...addVia(next, end, { locked: true, net }).project }
    const after = getPcbAnalysis(next)
    const netId = named.find((n) => n.name === net)!.id
    const on = after.traceNet.get(drawn.trace.id)
    if (on === "short") return fail(project, `Not drawn: it would short ${net} to another net. ${errorsAdded(project, next, ["short"]).slice(0, 3).join(" ")}`)
    if (on !== netId) return fail(project, `Not drawn: it touches no copper of ${net}${on ? "" : " (nothing at all)"}. Start or end it on a pad's centre, a via or a trace of ${net}.`)
    const bad = errorsAdded(project, next, COPPER_ERRORS)
    if (bad.length) return fail(project, `Not drawn: ${bad.slice(0, 4).join(" ")}${bad.length > 4 ? ` And ${bad.length - 4} more.` : ""} Move its points clear, or narrow it.`)
    const open = (a: typeof after) => a.ratsnest.filter((r) => r.netId === netId).length
    const length = drawn.trace.points.reduce((sum, p, i, all) => (i ? sum + Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) : 0), 0)
    const left = open(after)
    return ok(
      next,
      `Drew a ${len(width)} mm trace of ${net} on ${layer}, ${mm(length)} mm long (id ${drawn.trace.id}), locked${input.via_at_end === true ? `, with a via at (${end.x}, ${end.y})` : ""}. ${net} has ${left ? `${left} open connection(s) left` : "no open connections left"}.`,
      `Drew a ${len(width)} mm trace of ${net}`,
    )
  },
}

// ---------- pcb_text ----------

const pcbTextTool: PcbToolSpec = {
  name: "pcb_text",
  description:
    "Put text on the board, as the PCB editor's text tool does (a connector's A, B, C, a board name, a version): x, y its middle, size its height, 1 mm by default. layer F.SilkS by default, B.SilkS (mirrored), F.Fab or copper (F.Cu, B.Cu), which may not touch another net. With id (get_design lists board texts), change, move or remove it.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      size: { type: "number" },
      layer: { type: "string" },
      rotation: { type: "number", description: "Degrees counter-clockwise" },
      id: { type: "string" },
      remove: { type: "boolean" },
    },
  },
  run: (project, input) => {
    const id = typeof input.id === "string" ? input.id.trim().replace(/^x:/, "") : ""
    const layer = typeof input.layer === "string" ? input.layer.trim() : undefined
    if (layer !== undefined && (!isTextLayer(layer) || layer === "Edge.Cuts")) return fail(project, `${layer} is not a layer for text: F.SilkS, B.SilkS, F.Fab, B.Fab, F.Cu, B.Cu, ...`)
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
    const size = num(input.size)
    if (size !== undefined && !(size >= 0.3 && size <= 20)) return fail(project, "size must be between 0.3 and 20 mm")
    let next: Project
    let what: string
    if (id) {
      const t = (project.texts ?? []).find((x) => x.id === id && isKicadText(x))
      if (!t) return fail(project, `There is no board text ${id}; get_design lists them`)
      if (input.remove === true) return ok(removeBoardTexts(project, [id]), `Removed the text "${t.text}".`, "Removed a board text")
      const to = layer ?? t.layer!
      next = updateBoardTexts(project, [id], {
        ...(typeof input.text === "string" ? { text: input.text } : {}),
        ...(num(input.x) !== undefined ? { x: num(input.x) } : {}),
        ...(num(input.y) !== undefined ? { y: num(input.y) } : {}),
        ...(size !== undefined ? { size, w: null, thickness: defaultTextStyle(to).thickness * (size / defaultTextStyle(to).size) } : {}),
        ...(layer !== undefined ? { layer, mirror: layer.startsWith("B.") } : {}),
        ...(num(input.rotation) !== undefined ? { rot: num(input.rotation) } : {}),
      })
      what = `Changed the text "${typeof input.text === "string" ? input.text : t.text}" (id ${id})`
    } else {
      const text = typeof input.text === "string" ? input.text : ""
      if (!text.trim()) return fail(project, "Give the text")
      if (num(input.x) === undefined || num(input.y) === undefined) return fail(project, "Give x and y, the text's middle")
      const on = layer ?? "F.SilkS"
      const style = defaultTextStyle(on)
      const height = size ?? style.size
      const made = addBoardText(project, { layer: on, text, x: num(input.x)!, y: num(input.y)!, rot: num(input.rotation) ?? 0, size: height, thickness: round(style.thickness * (height / style.size), 4), ...(on.startsWith("B.") ? { mirror: true as const } : {}) })
      next = made.project
      what = `Put "${text}" on ${on} at (${num(input.x)}, ${num(input.y)}), ${len(height)} mm tall (id ${made.text.id})`
    }
    const onCopper = textLayerKind(layer ?? (project.texts ?? []).find((x) => x.id === id)?.layer ?? "F.SilkS") === "copper"
    if (onCopper) {
      const bad = errorsAdded(project, next, COPPER_ERRORS)
      if (bad.length) return fail(project, `Not placed: ${bad.slice(0, 3).join(" ")} Move it clear of other copper, or put it on silkscreen.`)
    }
    return ok(next, `${what}.`, id ? "Changed a board text" : "Added a board text")
  },
}

export const pcbToolSpecs: PcbToolSpec[] = [placePartsTool, setNetWidthTool, setNetClassTool, setClearanceRuleTool, clearRoutingTool, drawTraceTool, pcbTextTool]

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
    case "set_net_class":
      return `${input.remove === true ? "Removing" : "Setting"} the net class ${String(input.name ?? "")}`.trim()
    case "set_clearance_rule": {
      const what = Array.isArray(input.nets) ? (input.nets as unknown[]).map(String).join(" and ") : typeof input.ref === "string" ? `${input.ref}'s pads` : ""
      return what ? `${input.remove === true ? "Removing" : "Setting"} the clearance between ${what}` : "Reading the clearance rules"
    }
    case "draw_trace":
      return `Drawing a trace of ${String(input.net ?? "a net")}`
    case "pcb_text":
      return input.remove === true ? "Removing a board text" : typeof input.text === "string" ? `Putting "${input.text}" on the board` : "Changing a board text"
    default:
      return null
  }
}
