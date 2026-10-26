import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  boxContains,
  boxesOverlap,
  emptyBox,
  expandBox,
  normBox,
  orthogonalElbow,
  pointInBox,
  pointSegmentDistance,
  round,
  roundPoint,
  samePoint,
  snapPoint,
  type Box,
} from "../../lib/geometry"
import { BLOCK_TITLE, blockFrames, createBlock, framesDuringDrag, nextBlockName, renameBlock, type BlockFrame } from "../../model/blocks"
import {
  addDrawings,
  BOX_HANDLE_SIDES,
  constrain45,
  dragHandle,
  drawingBounds,
  drawingHandles,
  hitDrawing,
  LINE_HEIGHT,
  removeDrawings,
  rotateDrawing,
  textBox,
  updateDrawings,
} from "../../model/drawings"
import { pinKey } from "../../model/connectivity"
import { labelBox } from "../../model/labels"
import { findPart } from "../../model/library"
import { schematicBounds, schematicPins, type WorldPin } from "../../model/instances"
import {
  addLabel,
  addWire,
  dragPlan,
  moveSchematicItems,
  nextRef,
  removeItems,
  type RubberBand,
} from "../../model/ops"
import { guardDrop, pasteItems, placeComponent, rotateSelection, type Clipboard } from "../../model/schematicEdit"
import { SCH_GRID, SCH_TEXT } from "../../model/symbols"
import type { DrawingText, NetLabel, Project, Rotation, SchematicDrawing, Vec2 } from "../../model/types"
import { getConnectivity } from "../../store/analysis"
import { projectApi, useProjectStore } from "../../store/projectStore"
import { PART_MIME, readPreset, selectionIds, uiApi, useUi, type SchTool } from "../../store/uiStore"
import { useSch } from "../theme"
import { hasTextSelection, isTyping, toScreen, Viewport, WorldText, type ViewTransform, type ViewportHandle, type ViewportPointerEvent } from "../viewport"
import { groupSelected, ungroupSelected } from "./blockActions"
import { selectedItems } from "./clipboard"
import { DrawingSelection, DrawingView } from "./DrawingView"
import { onTidy, startTidy, viewForBlock } from "./tidyAction"
import { ComponentSymbol, SymbolBody } from "./SymbolView"

type Hit =
  | { type: "pin"; pin: WorldPin }
  | { type: "component"; id: string }
  | { type: "label"; id: string }
  | { type: "wire"; id: string; point: Vec2 }
  | { type: "drawing"; id: string }
  | { type: "block"; id: string }

type BoxTool = Extract<SchTool, "rect" | "block">

type Mode =
  | { kind: "idle" }
  | { kind: "marquee"; start: Vec2; current: Vec2; additive: boolean }
  | { kind: "drag"; start: Vec2; ids: { components: string[]; labels: string[]; wires: string[]; drawings: string[] }; picked: string[]; bands: RubberBand[]; moved: boolean }
  | { kind: "wire"; points: Vec2[]; horizontalFirst: boolean; fromDrag: boolean; startScreen: Vec2 }
  /** A line being drawn corner by corner, or dragged out in one go. */
  | { kind: "line"; points: Vec2[]; fromDrag: boolean; startScreen: Vec2 }
  /** A rectangle or a block's area being dragged out; `pressed` is false between the two clicks of click-click. */
  | { kind: "box"; shape: BoxTool; start: Vec2; current: Vec2; pressed: boolean }
  /** A grab handle of the selected drawing being dragged. */
  | { kind: "handle"; id: string; index: number; base: SchematicDrawing; moved: boolean }

/** Text being typed in place: a new text, one being edited, or a block's name. */
type Editing = { kind: "text"; id: string | null; at: Vec2; value: string } | { kind: "block"; id: string; value: string }

const DRAW_TOOLS = new Set<SchTool>(["block", "text", "line", "rect"])

const TOOL_KEYS: Record<string, SchTool> = { v: "select", w: "wire", l: "label", b: "block", p: "line" }

function contentBounds(p: Project): Box | null {
  const b = emptyBox()
  for (const c of p.components) {
    const sb = schematicBounds(c)
    expandBox(b, { x: sb.minX, y: sb.minY })
    expandBox(b, { x: sb.maxX, y: sb.maxY })
  }
  for (const w of p.wires) for (const pt of w.points) expandBox(b, pt)
  for (const l of p.labels) {
    const lb = labelBox(l)
    expandBox(b, { x: lb.minX, y: lb.minY })
    expandBox(b, { x: lb.maxX, y: lb.maxY })
  }
  for (const box of [...blockFrames(p).map((f) => f.box), ...(p.drawings ?? []).map(drawingBounds)]) {
    expandBox(b, { x: box.minX, y: box.minY })
    expandBox(b, { x: box.maxX, y: box.maxY })
  }
  return Number.isFinite(b.minX) ? b : null
}

/** On a block's frame line, give or take `tol`. */
const onFrame = (p: Vec2, b: Box, tol: number) =>
  pointInBox(p, b, tol) && !pointInBox(p, { minX: b.minX + tol, minY: b.minY + tol, maxX: b.maxX - tol, maxY: b.maxY - tol })

function hitTest(p: Project, at: Vec2, tol: number, pinTol: number): Hit | null {
  for (const c of p.components) {
    for (const pin of schematicPins(c)) {
      if (Math.hypot(pin.pos.x - at.x, pin.pos.y - at.y) <= pinTol) return { type: "pin", pin }
    }
  }
  for (let i = p.labels.length - 1; i >= 0; i--) {
    if (pointInBox(at, labelBox(p.labels[i]), tol * 0.5)) return { type: "label", id: p.labels[i].id }
  }
  for (let i = p.wires.length - 1; i >= 0; i--) {
    const w = p.wires[i]
    for (let s = 0; s < w.points.length - 1; s++) {
      if (pointSegmentDistance(at, w.points[s], w.points[s + 1]) <= tol) return { type: "wire", id: w.id, point: at }
    }
  }
  // A block is picked up by its title or its frame line, never by the empty space inside it. Its
  // title is looked at before the parts, so a part drawn under the title does not take the drag.
  const frames = blockFrames(p)
  for (let i = frames.length - 1; i >= 0; i--) {
    if (pointInBox(at, frames[i].titleBox)) return { type: "block", id: frames[i].id }
  }
  for (let i = p.components.length - 1; i >= 0; i--) {
    if (pointInBox(at, schematicBounds(p.components[i]), tol * 0.3)) return { type: "component", id: p.components[i].id }
  }
  // Drawings under the circuit, the topmost first; a frame drawn empty is clicked through.
  const drawings = p.drawings ?? []
  for (let i = drawings.length - 1; i >= 0; i--) if (hitDrawing(drawings[i], at, tol)) return { type: "drawing", id: drawings[i].id }
  for (let i = frames.length - 1; i >= 0; i--) {
    if (onFrame(at, frames[i].box, tol)) return { type: "block", id: frames[i].id }
  }
  return null
}

const HIT_PREFIX = { component: "c", label: "l", wire: "w", drawing: "d", block: "b" } as const

const hitId = (h: Hit | null) => (!h ? null : h.type === "pin" ? `c:${h.pin.componentId}` : `${HIT_PREFIX[h.type]}:${h.id}`)

let clipboard: Clipboard | null = null

/** Paste or duplicate, with a note on the canvas instead when it would have changed what the sheet's pins connect to. */
function pasteOnSheet(clip: Clipboard, offset: Vec2, what: string) {
  uiApi().clearNotice() // what was said about the last edit is not about this one
  const res = pasteItems(projectApi().project!, clip, offset, what, { conn: getConnectivity })
  if (!res.ok) {
    uiApi().showNotice(res.message)
    return
  }
  projectApi().commit(() => res.project)
  uiApi().select(res.selection)
}

export function SchematicEditor() {
  const sch = useSch()
  const project = useProjectStore((s) => s.project)!
  const selection = useUi((s) => s.selection)
  const tool = useUi((s) => s.schTool)
  const placing = useUi((s) => s.placing)
  const highlightNet = useUi((s) => s.highlightNet)
  const focusRequest = useUi((s) => s.focusRequest)
  const drawDefaults = useUi((s) => s.drawDefaults)
  const vpRef = useRef<ViewportHandle>(null)
  const [mode, setMode] = useState<Mode>({ kind: "idle" })
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [cursor, setCursor] = useState<Vec2 | null>(null)
  const [hover, setHover] = useState<Hit | null>(null)
  const [hoverHandle, setHoverHandle] = useState<number | null>(null)
  const [labelDraft, setLabelDraft] = useState<{ at: Vec2; screen: Vec2; rot: Rotation; name: string } | null>(null)
  const [editing, setEditingState] = useState<Editing | null>(null)
  // The edit being typed, read by the commit so a blur and an Enter can't both commit it.
  const editingRef = useRef<Editing | null>(null)
  const setEditing = (ed: Editing | null) => {
    editingRef.current = ed
    setEditingState(ed)
  }
  // Where the label tool was pressed. Its name box opens on release: opened on the press, the
  // focus the browser gives the canvas right after it would blur the box, which closes it.
  const labelPress = useRef<{ at: Vec2; screen: Vec2; rot: Rotation } | null>(null)
  const shiftRef = useRef(false)
  // When the last drawing was finished, so the double-click that finished a line doesn't also open it.
  const finishedAt = useRef(0)

  const conn = useMemo(() => getConnectivity(project), [project])
  const dragBase = useProjectStore((s) => s.transientBase)
  // During a drag the frames come from where things were when it began, so they aren't worked
  // out again for every step of the pointer.
  const frames = useMemo(() => {
    if (mode.kind !== "drag" || !dragBase) return blockFrames(project)
    const first = mode.ids.components[0]
    const from = dragBase.components.find((c) => c.id === first)?.sch
    const to = project.components.find((c) => c.id === first)?.sch
    const delta = from && to ? { x: round(to.x - from.x), y: round(to.y - from.y) } : { x: 0, y: 0 }
    return framesDuringDrag(dragBase, mode.ids.components, delta)
  }, [project, mode, dragBase])
  // Fit once on mount; later edits keep the user's view.
  const [fitBox] = useState(() => contentBounds(project) ?? { minX: -3, minY: -2, maxX: 3, maxY: 2 })

  // Another sheet shown is fitted to the window, as a project is when it is opened.
  const shownBefore = useRef(sheet)
  useEffect(() => {
    if (shownBefore.current === sheet) return
    shownBefore.current = sheet
    vpRef.current?.fit(contentBounds(shownProject(projectApi().project!, sheet)) ?? { minX: -3, minY: -2, maxX: 3, maxY: 2 })
  }, [sheet])

  const selected = useMemo(() => new Set(selection), [selection])
  const drawings = project.drawings ?? []

  useEffect(() => {
    const vp = vpRef.current
    if (focusRequest?.view !== "schematic" || !vp) return
    if (focusRequest.box) vp.frame(focusRequest.box, 140)
    else vp.centerOn(focusRequest, Math.max(vp.transform().scale, 140))
  }, [focusRequest])

  // A tidied sheet is a new drawing: show all of it. A tidied block may have moved to find room:
  // bring it into view when it isn't.
  useEffect(
    () =>
      onTidy((r) => {
        const vp = vpRef.current
        if (!r.changed || !vp) return
        if (r.whole) {
          const b = contentBounds(r.project)
          if (b) vp.fit(b)
          return
        }
        const frame = blockFrames(r.project).find((f) => f.id === r.blockId)?.box
        const el = vp.element()
        if (!frame || !el) return
        const view = viewForBlock(frame, vp.transform(), { width: el.clientWidth, height: el.clientHeight })
        if (view.kind === "center") vp.centerOn(view.at, view.scale)
        else if (view.kind === "fit") vp.fit(frame)
      }),
    [],
  )

  // Another tool leaves a line or a box half drawn.
  useEffect(() => {
    const m = modeRef.current
    if (m.kind === "line" || m.kind === "box") setMode({ kind: "idle" })
  }, [tool])

  const tolerances = () => {
    const s = vpRef.current?.transform().scale ?? 100
    return { tol: 6 / s, pinTol: 7 / s }
  }

  const activeNet = useMemo(() => {
    if (highlightNet) return highlightNet
    if (hover?.type === "wire") return conn.wireNet.get(hover.id) ?? null
    if (hover?.type === "pin") return conn.pinNet.get(pinKey(hover.pin.componentId, hover.pin.pin)) ?? null
    const wires = selectionIds(selection, "w")
    if (wires.length === 1) return conn.wireNet.get(wires[0]) ?? null
    return null
  }, [highlightNet, hover, conn, selection])

  // ---------- wire drawing ----------
  const finishWire = useCallback((points: Vec2[]) => {
    if (points.length >= 2) projectApi().commit((p) => addWire(p, points).project)
    setMode({ kind: "idle" })
  }, [])

  const wirePreview = (m: Extract<Mode, { kind: "wire" }>, to: Vec2) => {
    const last = m.points[m.points.length - 1]
    return orthogonalElbow(last, to, m.horizontalFirst)
  }

  const startWire = (from: Vec2, screen: Vec2, pin: WorldPin | null, fromDrag: boolean) => {
    const horizontalFirst = pin ? pin.dir === "left" || pin.dir === "right" : true
    setMode({ kind: "wire", points: [from], horizontalFirst, fromDrag, startScreen: screen })
  }

  const isTerminal = (p: Project, at: Vec2, exclude: Vec2[]) => {
    const { tol, pinTol } = tolerances()
    const h = hitTest(p, at, tol, pinTol)
    if (!h) return false
    if (h.type === "pin") return !exclude.some((e) => samePoint(e, h.pin.pos))
    if (h.type === "wire") return true
    if (h.type === "label") return true
    return false
  }

  const snapTarget = (world: Vec2): Vec2 => {
    const { tol, pinTol } = tolerances()
    const h = hitTest(project, world, tol, pinTol)
    if (h?.type === "pin") return h.pin.pos
    return snapPoint(world, SCH_GRID)
  }

  // ---------- drawing ----------
  /** Where a drawing tool puts a point: on the grid, or anywhere with Alt held. */
  const drawPoint = (e: ViewportPointerEvent) => ((e.native as React.PointerEvent).altKey ? roundPoint(e.world) : snapPoint(e.world, SCH_GRID))

  /** The next corner of a line, at 45° steps with Shift held. */
  const lineEnd = (m: Extract<Mode, { kind: "line" }>, to: Vec2) => (shiftRef.current ? constrain45(m.points[m.points.length - 1], to) : to)

  /** What a box tool has dragged out: a square with Shift held, on the side the drag went. */
  const boxOf = (m: Extract<Mode, { kind: "box" }>): Box => {
    let { x, y } = m.current
    if (shiftRef.current && m.shape !== "block") {
      const side = Math.max(Math.abs(x - m.start.x), Math.abs(y - m.start.y))
      x = round(m.start.x + Math.sign(x - m.start.x || 1) * side)
      y = round(m.start.y + Math.sign(y - m.start.y || 1) * side)
    }
    return normBox(m.start, { x, y })
  }

  /** A drawing just made is selected, and the tool goes back to select unless Shift asks for another. */
  const afterDrawing = (made: SchematicDrawing[]) => {
    finishedAt.current = performance.now()
    uiApi().select(made.map((d) => `d:${d.id}`))
    if (!shiftRef.current) uiApi().setSchTool("select")
  }

  const draw = (item: Parameters<typeof addDrawings>[1][number]) => {
    let made: SchematicDrawing[] = []
    projectApi().commit((p) => {
      const res = addDrawings(p, [item])
      made = res.added
      return res.project
    })
    afterDrawing(made)
  }

  const finishLine = useCallback((points: Vec2[], closed = false) => {
    setMode({ kind: "idle" })
    const pts = points.filter((pt, i) => i === 0 || !samePoint(pt, points[i - 1]))
    if (pts.length < 2) return
    draw({ type: "line", points: pts, ...(closed && pts.length > 2 && { closed: true }), ...uiApi().drawDefaults.shape })
  }, [])

  const finishBox = (m: Extract<Mode, { kind: "box" }>) => {
    setMode({ kind: "idle" })
    const box = boxOf(m)
    const p = projectApi().project!
    if (m.shape === "block") {
      // The parts whose middle is inside the box, as a block of their own named for the user to change.
      const inside = p.components.filter((c) => {
        const b = schematicBounds(c)
        return pointInBox({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, box)
      })
      if (!inside.length) {
        uiApi().showNotice("No block was made: drag the box around the parts to frame.")
        return
      }
      const { project: next, block } = createBlock(p, nextBlockName(p), inside.map((c) => c.id))
      if (!block) return
      finishedAt.current = performance.now()
      projectApi().commit(() => next)
      uiApi().select([`b:${block.id}`])
      uiApi().setSchTool("select")
      setEditing({ kind: "block", id: block.id, value: block.name })
      return
    }
    const width = round(box.maxX - box.minX)
    const height = round(box.maxY - box.minY)
    if (width < SCH_GRID / 2 || height < SCH_GRID / 2) return
    draw({ type: m.shape, x: box.minX, y: box.minY, width, height, ...uiApi().drawDefaults.shape })
  }

  /** Finish what is being typed in place. An emptied text is deleted. */
  const commitEditing = () => {
    const ed = editingRef.current
    setEditing(null)
    if (!ed) return
    if (ed.kind === "block") {
      projectApi().commit((p) => renameBlock(p, ed.id, ed.value))
      return
    }
    const text = ed.value.replace(/\s+$/, "")
    if (ed.id) {
      const id = ed.id
      projectApi().commit((p) => (text.trim() ? updateDrawings(p, [id], (d) => (d.type === "text" && d.text !== text ? { ...d, text } : d)) : removeDrawings(p, [id])))
      if (!text.trim()) uiApi().clearSelection()
      return
    }
    if (text.trim()) draw({ type: "text", x: ed.at.x, y: ed.at.y, text, ...uiApi().drawDefaults.text })
  }

  const editText = (d: DrawingText) => {
    uiApi().select([`d:${d.id}`])
    setEditing({ kind: "text", id: d.id, at: { x: d.x, y: d.y }, value: d.text })
  }

  /** The grab handle of the one selected drawing under the pointer. */
  const handleAt = (p: Project, at: Vec2): { id: string; index: number; base: SchematicDrawing } | null => {
    const sel = uiApi().selection
    if (sel.length !== 1 || !sel[0].startsWith("d:")) return null
    const d = p.drawings?.find((x) => x.id === sel[0].slice(2))
    if (!d) return null
    const r = 6 / (vpRef.current?.transform().scale ?? 100)
    const index = drawingHandles(d).findIndex((h) => Math.abs(h.x - at.x) <= r && Math.abs(h.y - at.y) <= r)
    return index < 0 ? null : { id: d.id, index, base: d }
  }

  // ---------- pointer handlers ----------
  const onPointerDown = (e: ViewportPointerEvent) => {
    const native = e.native as React.PointerEvent
    if (native.button !== 0) return
    if (labelDraft) return
    // A press outside the text being typed finishes it, and does nothing else.
    if (editing) {
      commitEditing()
      return
    }
    const world = e.world
    const snapped = snapTarget(world)
    const p = projectApi().project!
    const m = modeRef.current

    if (placing) {
      uiApi().clearNotice()
      const res = placeComponent(
        p,
        placing.partId,
        { sch: { ...snapPoint(world, SCH_GRID), rot: placing.rot }, props: placing.props, footprint: placing.footprint },
        { conn: getConnectivity },
      )
      // Dropped across two nets, the part would join them: say so and keep the part in hand.
      if (!res.ok) {
        uiApi().showNotice(res.message)
        return
      }
      projectApi().commit(() => res.project)
      uiApi().select([`c:${res.component.id}`])
      if (!native.shiftKey) uiApi().stopPlacing()
      return
    }

    if (m.kind === "wire") {
      const seg = wirePreview(m, snapped)
      const pts = [...m.points, ...seg.slice(1)]
      if (isTerminal(p, snapped, [m.points[0]]) || (m.points.length > 1 && samePoint(snapped, m.points[m.points.length - 1]))) {
        finishWire(pts)
      } else {
        setMode({ ...m, points: pts, fromDrag: false })
      }
      return
    }

    if (m.kind === "line") {
      const at = lineEnd(m, drawPoint(e))
      const first = m.points[0]
      // Back on the first corner closes the line into a polygon; the same corner twice ends it.
      if (m.points.length >= 3 && Math.hypot(at.x - first.x, at.y - first.y) <= tolerances().tol) finishLine(m.points, true)
      else if (samePoint(at, m.points[m.points.length - 1])) finishLine(m.points)
      else setMode({ ...m, points: [...m.points, at], fromDrag: false })
      return
    }

    if (m.kind === "box") {
      // As for a text: a block's second click opens its name field, which the press would take focus from.
      native.preventDefault()
      finishBox({ ...m, current: drawPoint(e) })
      return
    }

    if (tool === "label") {
      const { tol, pinTol } = tolerances()
      const h = hitTest(p, world, tol, pinTol)
      const at = h?.type === "pin" ? h.pin.pos : snapped
      const rot: Rotation = h?.type === "pin" ? (h.pin.dir === "left" ? 180 : h.pin.dir === "up" ? 90 : h.pin.dir === "down" ? 270 : 0) : 0
      labelPress.current = { at, screen: e.screen, rot }
      return
    }

    if (tool === "wire") {
      const { tol, pinTol } = tolerances()
      const h = hitTest(p, world, tol, pinTol)
      startWire(snapped, e.screen, h?.type === "pin" ? h.pin : null, false)
      return
    }

    if (tool === "text") {
      // The press would focus the canvas once its handlers are done, taking focus from the editor
      // this opens; cancelling it keeps the editor focused.
      native.preventDefault()
      // On a text, the text tool edits it rather than starting another on top of it.
      const { tol, pinTol } = tolerances()
      const h = hitTest(p, world, tol, pinTol)
      const d = h?.type === "drawing" ? p.drawings?.find((x) => x.id === h.id) : undefined
      if (d?.type === "text") editText(d)
      else setEditing({ kind: "text", id: null, at: drawPoint(e), value: "" })
      return
    }

    if (tool === "line") {
      setMode({ kind: "line", points: [drawPoint(e)], fromDrag: true, startScreen: e.screen })
      return
    }

    if (tool === "rect" || tool === "block") {
      const at = drawPoint(e)
      setMode({ kind: "box", shape: tool, start: at, current: at, pressed: true })
      return
    }

    // select tool
    const grab = handleAt(p, world)
    if (grab) {
      projectApi().beginTransient()
      setMode({ kind: "handle", ...grab, moved: false })
      return
    }
    const { tol, pinTol } = tolerances()
    const h = hitTest(p, world, tol, pinTol * 0.8)
    if (h?.type === "pin") {
      startWire(h.pin.pos, e.screen, h.pin, true)
      return
    }
    const id = hitId(h)
    if (!id) {
      if (!native.shiftKey) uiApi().clearSelection()
      setMode({ kind: "marquee", start: world, current: world, additive: native.shiftKey })
      return
    }
    let sel = uiApi().selection
    if (native.shiftKey) {
      uiApi().toggleSelect(id)
      return
    }
    if (!sel.includes(id)) {
      sel = [id]
      uiApi().select(sel)
    }
    // A selected block holds its parts, wires, labels and the drawings inside its frame. Dragging takes
    // along what hangs off a part's pins alone (power symbols, net label stubs), as a move by tool does.
    const picked = selectedItems(p, sel)
    const { ids, bands } = dragPlan(p, picked)
    projectApi().beginTransient()
    setMode({ kind: "drag", start: snapPoint(world, SCH_GRID), ids: { ...ids, drawings: picked.drawings }, picked: picked.components, bands, moved: false })
  }

  const onPointerMove = (e: ViewportPointerEvent) => {
    const world = e.world
    const m = modeRef.current
    const drawingNow = DRAW_TOOLS.has(tool) || m.kind === "line" || m.kind === "box" || m.kind === "handle"
    const at = drawingNow ? drawPoint(e) : snapTarget(world)
    setCursor(at)
    uiApi().setCursor(at)
    if (m.kind === "marquee") {
      setMode({ ...m, current: world })
      return
    }
    if (m.kind === "drag") {
      const to = snapPoint(world, SCH_GRID)
      const delta = { x: to.x - m.start.x, y: to.y - m.start.y }
      if (!m.moved && delta.x === 0 && delta.y === 0) return
      projectApi().setTransient((base) => moveSchematicItems(base, m.ids, delta, m.bands, getConnectivity(base)))
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "box") {
      setMode({ ...m, current: at })
      return
    }
    if (m.kind === "handle") {
      const next = dragHandle(m.base, m.index, at)
      projectApi().setTransient((base) => updateDrawings(base, [m.id], () => next))
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "idle" && !placing) {
      const grab = tool === "select" ? handleAt(project, world) : null
      setHoverHandle(grab ? grab.index : null)
      const { tol, pinTol } = tolerances()
      const h = grab ? null : hitTest(project, world, tol, pinTol * 0.8)
      setHover((prev) => (sameHit(prev, h) ? prev : h))
    }
  }

  const onPointerUp = (e: ViewportPointerEvent) => {
    const press = labelPress.current
    if (press) {
      labelPress.current = null
      if (e.native.type === "pointercancel") return
      const last = projectApi().project!.labels.at(-1)?.name ?? ""
      setLabelDraft({ ...press, name: bumpName(last) })
      return
    }
    const m = modeRef.current
    if (m.kind === "marquee") {
      const box = normBox(m.start, m.current)
      const ids: string[] = []
      for (const c of project.components) if (boxesOverlap(box, schematicBounds(c))) ids.push(`c:${c.id}`)
      for (const w of project.wires) if (w.points.some((pt) => pointInBox(pt, box))) ids.push(`w:${w.id}`)
      for (const l of project.labels) if (pointInBox(l, box)) ids.push(`l:${l.id}`)
      // Drawings only when the box takes them in whole, so a big frame behind everything isn't swept up.
      for (const d of drawings) if (boxContains(box, drawingBounds(d))) ids.push(`d:${d.id}`)
      for (const f of blockFrames(project)) if (boxContains(box, f.box)) ids.push(`b:${f.id}`)
      const base = m.additive ? uiApi().selection : []
      uiApi().select([...new Set([...base, ...ids])])
      setMode({ kind: "idle" })
      return
    }
    if (m.kind === "drag") {
      const { transientBase: start, project: dropped } = projectApi()
      if (m.moved && start && dropped) {
        // A drag changes where things are, not what is connected. Dropped where it would join or
        // cut nets, it goes back to where it started and the canvas says why.
        uiApi().clearNotice()
        const res = guardDrop(start, dropped, { components: m.picked }, { conn: getConnectivity })
        if (res.ok) projectApi().endTransient(() => res.project)
        else {
          projectApi().cancelTransient()
          uiApi().showNotice(res.message)
        }
      } else projectApi().cancelTransient()
      setMode({ kind: "idle" })
      return
    }
    if (m.kind === "handle") {
      if (m.moved) projectApi().endTransient()
      else projectApi().cancelTransient()
      setMode({ kind: "idle" })
      return
    }
    if (m.kind === "box") {
      if (!m.pressed) return
      // A press with no drag waits for a second click at the other corner.
      if (samePoint(m.start, m.current)) setMode({ ...m, pressed: false })
      else finishBox(m)
      return
    }
    if (m.kind === "line" && m.fromDrag) {
      const moved = Math.hypot(e.screen.x - m.startScreen.x, e.screen.y - m.startScreen.y) > 6
      if (!moved) setMode({ ...m, fromDrag: false })
      else finishLine([m.points[0], lineEnd(m, drawPoint(e))])
      return
    }
    if (m.kind === "wire" && m.fromDrag) {
      const moved = Math.hypot(e.screen.x - m.startScreen.x, e.screen.y - m.startScreen.y) > 6
      if (!moved) {
        setMode({ ...m, fromDrag: false })
        return
      }
      const to = snapTarget(e.world)
      finishWire([...m.points, ...wirePreview(m, to).slice(1)])
    }
  }

  const onDoubleClick = (e: ViewportPointerEvent) => {
    const m = modeRef.current
    if (m.kind === "wire") {
      finishWire(m.points)
      return
    }
    if (m.kind === "line") {
      finishLine(m.points)
      return
    }
    if (performance.now() - finishedAt.current < 500) return
    const { tol, pinTol } = tolerances()
    const h = hitTest(project, e.world, tol, pinTol * 0.5)
    if (h?.type === "label") {
      const l = project.labels.find((x) => x.id === h.id)
      if (l) {
        const name = window.prompt("Net label name", l.name)?.trim()
        if (name) projectApi().commit((p) => ({ ...p, labels: p.labels.map((x) => (x.id === l.id ? { ...x, name } : x)) }))
      }
    } else if (h?.type === "drawing") {
      const d = drawings.find((x) => x.id === h.id)
      if (d?.type === "text") editText(d)
      else {
        uiApi().select([`d:${h.id}`])
        uiApi().setSidePanel("inspector")
      }
    } else if (h?.type === "block" && frames.some((f) => f.id === h.id && pointInBox(e.world, f.titleBox))) {
      // A block's title is renamed where it is.
      const f = frames.find((x) => x.id === h.id)!
      uiApi().select([`b:${f.id}`])
      setEditing({ kind: "block", id: f.id, value: f.name })
    } else if (h?.type === "component" || h?.type === "block") {
      uiApi().select([hitId(h)!])
      uiApi().setSidePanel("inspector")
    }
  }

  const onDrop = (world: Vec2, data: DataTransfer) => {
    const partId = data.getData(PART_MIME)
    if (!partId || !findPart(partId)) return
    const preset = readPreset(data)
    uiApi().clearNotice()
    const res = placeComponent(projectApi().project!, partId, { sch: { ...snapPoint(world, SCH_GRID), rot: 0 }, ...preset }, { conn: getConnectivity })
    if (!res.ok) {
      uiApi().showNotice(res.message)
      return
    }
    projectApi().commit(() => res.project)
    uiApi().select([`c:${res.component.id}`])
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey
      if (isTyping(e) || labelDraft) return
      const mod = e.metaKey || e.ctrlKey
      const m = modeRef.current
      const sel = uiApi().selection
      const key = e.key.toLowerCase()

      if (key === "escape") {
        if (m.kind === "wire") finishWire(m.points)
        else if (m.kind === "line") finishLine(m.points)
        else if (m.kind === "box") setMode({ kind: "idle" })
        else if (uiApi().placing) uiApi().stopPlacing()
        else if (m.kind === "drag" || m.kind === "handle") {
          projectApi().cancelTransient()
          setMode({ kind: "idle" })
        } else {
          uiApi().clearSelection()
          uiApi().setSchTool("select")
          uiApi().setHighlightNet(null)
        }
        return
      }
      if (m.kind === "wire") {
        if (key === "backspace") {
          e.preventDefault()
          if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
          else setMode({ kind: "idle" })
        } else if (key === "/" || key === " ") {
          e.preventDefault()
          setMode({ ...m, horizontalFirst: !m.horizontalFirst })
        }
        return
      }
      if (m.kind === "line") {
        if (key === "backspace") {
          e.preventDefault()
          if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
          else setMode({ kind: "idle" })
        } else if (key === "enter") {
          e.preventDefault()
          finishLine(m.points)
        }
        return
      }
      if (m.kind === "box" || m.kind === "handle") return
      if (mod && (key === "a" || key === "c") && hasTextSelection()) return
      if (mod && key === "a") {
        e.preventDefault()
        const p = projectApi().project!
        uiApi().select([
          ...p.components.map((c) => `c:${c.id}`),
          ...p.wires.map((w) => `w:${w.id}`),
          ...p.labels.map((l) => `l:${l.id}`),
          ...(p.drawings ?? []).map((d) => `d:${d.id}`),
          ...(p.blocks ?? []).map((b) => `b:${b.id}`),
        ])
        return
      }
      if (mod && key === "g") {
        e.preventDefault()
        if (e.shiftKey) ungroupSelected()
        else groupSelected()
        return
      }
      if (mod && (key === "c" || key === "d")) {
        const p = projectApi().project!
        const clip: Clipboard = { project: p, ...selectedItems(p, sel), blocks: selectionIds(sel, "b") }
        if (!clip.components.length && !clip.wires.length && !clip.labels.length && !clip.drawings?.length) return
        e.preventDefault()
        clipboard = clip
        if (key === "d") pasteOnSheet(clip, { x: 0.5, y: -0.5 }, "duplicate")
        return
      }
      if (mod && key === "v" && clipboard) {
        e.preventDefault()
        const c = cursor
        const src = clipboard
        const firstDrawing = src.project.drawings?.find((d) => d.id === src.drawings?.[0])
        const anchor =
          src.project.components.find((x) => x.id === src.components[0])?.sch ??
          src.project.wires.find((w) => w.id === src.wires[0])?.points[0] ??
          (firstDrawing && (firstDrawing.type === "line" ? firstDrawing.points[0] : firstDrawing))
        const offset = c && anchor ? { x: round(c.x - anchor.x), y: round(c.y - anchor.y) } : { x: 0.5, y: -0.5 }
        pasteOnSheet(src, offset, "paste")
        return
      }
      if (mod) return

      // While placing, Shift is "place several" and R still turns the part.
      if (key === "r" && e.shiftKey && !uiApi().placing) {
        uiApi().setSchTool("rect")
        return
      }
      if (key === "r") {
        if (uiApi().placing) {
          uiApi().rotatePlacing()
          return
        }
        const comps = selectionIds(sel, "c")
        const labels = selectionIds(sel, "l")
        const drawn = selectionIds(sel, "d")
        if (!comps.length && !labels.length && !drawn.length) return
        // Turning moves pins, not connections: labels and wires follow them, or the turn is
        // refused with the reason on the canvas and nothing changes. Drawings just turn.
        uiApi().clearNotice()
        const base = projectApi().project!
        const res = comps.length || labels.length ? rotateSelection(base, { components: comps, labels }, { conn: getConnectivity }) : { ok: true as const, project: base }
        if (res.ok) {
          projectApi().commit(() => updateDrawings(res.project, drawn, rotateDrawing))
          if ("note" in res && res.note) uiApi().showNotice(res.note)
        } else uiApi().showNotice(res.message)
        return
      }
      if (key === "delete" || key === "backspace") {
        if (!sel.length) return
        e.preventDefault()
        projectApi().commit((p) =>
          removeItems(p, {
            components: selectionIds(sel, "c"),
            wires: selectionIds(sel, "w"),
            labels: selectionIds(sel, "l"),
            blocks: selectionIds(sel, "b"),
            drawings: selectionIds(sel, "d"),
          }),
        )
        uiApi().clearSelection()
        return
      }
      // T tidies; the Text tool is Shift+T, as the Rectangle is Shift+R.
      if (key === "t" && e.shiftKey) uiApi().setSchTool("text")
      else if (key === "t") startTidy()
      else if (TOOL_KEYS[key]) uiApi().setSchTool(TOOL_KEYS[key])
      else if (key === "f") {
        const b = contentBounds(projectApi().project!)
        if (b) vpRef.current?.fit(b)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKeyUp)
    }
  }, [finishWire, finishLine, labelDraft, cursor])

  // ---------- render ----------
  const placingPart = placing ? findPart(placing.partId) : null
  const single = selection.length === 1 && selection[0].startsWith("d:") ? drawings.find((d) => d.id === selection[0].slice(2)) : undefined
  const grabbed = mode.kind === "handle" ? mode.index : hoverHandle
  const handleCursor =
    grabbed === null || !single ? null : single.type === "line" ? "move" : (() => {
      const [sx, sy] = BOX_HANDLE_SIDES[grabbed] ?? [0, 0]
      return sx === 0 ? "ns-resize" : sy === 0 ? "ew-resize" : sx === sy ? "nesw-resize" : "nwse-resize"
    })()
  const cursorCss = placing
    ? "copy"
    : handleCursor
      ? handleCursor
      : tool === "text" || tool === "label"
        ? "text"
        : tool !== "select" || mode.kind === "wire" || mode.kind === "line" || mode.kind === "box"
          ? "crosshair"
          : hover?.type === "pin"
            ? "crosshair"
            : hover?.type === "block" || hover?.type === "drawing"
              ? "move"
              : "default"

  const highlightedPins = useMemo(() => {
    if (!activeNet) return []
    const out: Vec2[] = []
    for (const c of project.components) for (const pin of schematicPins(c)) if (conn.pinNet.get(pinKey(c.id, pin.pin)) === activeNet) out.push(pin.pos)
    return out
  }, [activeNet, project, conn])

  // What the line or box being drawn will be, in the style it will have.
  const draft: SchematicDrawing | null =
    mode.kind === "line" && cursor
      ? { id: "draft", type: "line", points: [...mode.points, lineEnd(mode, cursor)], ...drawDefaults.shape }
      : mode.kind === "box" && mode.shape !== "block"
        ? (() => {
            const b = boxOf(mode)
            return { id: "draft", type: mode.shape, x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, ...drawDefaults.shape }
          })()
        : null
  const closing = mode.kind === "line" && cursor && mode.points.length >= 3 && samePoint(lineEnd(mode, cursor), mode.points[0])

  return (
    <div className="absolute inset-0">
      <Viewport
        ref={vpRef}
        initialScale={110}
        minScale={12}
        maxScale={900}
        grid={SCH_GRID}
        gridColor={sch.grid}
        background={sch.paper}
        fitBox={fitBox}
        cursor={cursorCss}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onLeave={() => {
          setHover(null)
          setHoverHandle(null)
          uiApi().setCursor(null)
        }}
        onDrop={onDrop}
        overlay={(t) => (
          <>
            {mode.kind === "marquee" && (
              <div
                className="pointer-events-none absolute border border-select bg-select/10"
                style={{
                  left: Math.min(mode.start.x, mode.current.x) * t.scale + t.tx,
                  top: -Math.max(mode.start.y, mode.current.y) * t.scale + t.ty,
                  width: Math.abs(mode.current.x - mode.start.x) * t.scale,
                  height: Math.abs(mode.current.y - mode.start.y) * t.scale,
                }}
              />
            )}
            {editing && (
              <InPlaceEditor
                editing={editing}
                t={t}
                project={project}
                defaultSize={drawDefaults.text.size}
                frames={frames}
                onChange={(value) => setEditing({ ...editing, value })}
                onCommit={commitEditing}
                onCancel={() => setEditing(null)}
              />
            )}
          </>
        )}
      >
        {(t) => {
          const px = 1 / t.scale
          return (
            <>
              {/* Blocks, under everything they frame */}
              {frames.map((f) => (
                <BlockView
                  key={f.id}
                  frame={f}
                  selected={selected.has(`b:${f.id}`)}
                  hovered={hover?.type === "block" && hover.id === f.id}
                  renaming={editing?.kind === "block" && editing.id === f.id}
                  px={px}
                />
              ))}

              {/* Drawings, under the circuit and in their own order */}
              {drawings.map((d) => (
                <DrawingView key={d.id} drawing={d} px={px} hidden={editing?.kind === "text" && editing.id === d.id} />
              ))}

              {/* Net highlight halo */}
              {activeNet &&
                project.wires
                  .filter((w) => conn.wireNet.get(w.id) === activeNet)
                  .map((w) => (
                    <polyline
                      key={`h${w.id}`}
                      points={w.points.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke={sch.highlight}
                      strokeWidth={Math.max(0.08, 7 * px)}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
              {highlightedPins.map((p, i) => (
                <circle key={`hp${i}`} cx={p.x} cy={p.y} r={Math.max(0.045, 5 * px)} fill={sch.highlight} />
              ))}

              {/* Wires */}
              {project.wires.map((w) => (
                <polyline
                  key={w.id}
                  points={w.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={selected.has(`w:${w.id}`) ? sch.select : sch.wire}
                  strokeWidth={Math.max(sch.wireWidth, 1.4 * px)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {conn.junctions.map((j, i) => (
                <circle key={`j${i}`} cx={j.x} cy={j.y} r={0.04} fill={sch.junction} />
              ))}

              {/* Labels */}
              {project.labels.map((l) => (
                <LabelView key={l.id} label={l} selected={selected.has(`l:${l.id}`)} px={px} />
              ))}

              {/* Components */}
              {project.components.map((c) => {
                const isSel = selected.has(`c:${c.id}`)
                const b = schematicBounds(c)
                return (
                  <g key={c.id}>
                    {isSel && (
                      <rect
                        x={b.minX - 0.05}
                        y={b.minY - 0.05}
                        width={b.maxX - b.minX + 0.1}
                        height={b.maxY - b.minY + 0.1}
                        rx={0.04}
                        fill={sch.selectSoft}
                        stroke={sch.select}
                        strokeWidth={1.2 * px}
                      />
                    )}
                    {hover?.type === "component" && hover.id === c.id && !isSel && (
                      <rect
                        x={b.minX - 0.05}
                        y={b.minY - 0.05}
                        width={b.maxX - b.minX + 0.1}
                        height={b.maxY - b.minY + 0.1}
                        rx={0.04}
                        fill="none"
                        stroke={sch.select}
                        strokeOpacity={0.4}
                        strokeWidth={1 * px}
                      />
                    )}
                    <ComponentSymbol c={c} />
                  </g>
                )
              })}

              {/* Unconnected pins */}
              {conn.unconnectedPins.map((p) => (
                <circle
                  key={`u${p.componentId}${p.pin}`}
                  cx={p.pos.x}
                  cy={p.pos.y}
                  r={0.025}
                  fill={sch.paper}
                  stroke={sch.ink3}
                  strokeWidth={sch.stroke / 2}
                />
              ))}

              {/* No-connect crosses */}
              {conn.ncPins.map((p) => {
                const d = 0.06
                return (
                  <g key={`nc${p.componentId}${p.pin}`} stroke={sch.noConnect} strokeWidth={Math.max(sch.stroke, 1.4 * px)} strokeLinecap="round">
                    <line x1={p.pos.x - d} y1={p.pos.y - d} x2={p.pos.x + d} y2={p.pos.y + d} />
                    <line x1={p.pos.x - d} y1={p.pos.y + d} x2={p.pos.x + d} y2={p.pos.y - d} />
                  </g>
                )
              })}

              {/* Selected and hovered drawings, over the circuit so their outline shows */}
              {drawings.map((d) =>
                selected.has(`d:${d.id}`) ? (
                  <DrawingSelection key={`s${d.id}`} drawing={d} px={px} handles={selection.length === 1 && !(editing?.kind === "text" && editing.id === d.id)} />
                ) : hover?.type === "drawing" && hover.id === d.id && mode.kind === "idle" ? (
                  <DrawingSelection key={`s${d.id}`} drawing={d} px={px} handles={false} hovered />
                ) : null,
              )}

              {/* Hovered pin */}
              {hover?.type === "pin" && mode.kind === "idle" && (
                <circle cx={hover.pin.pos.x} cy={hover.pin.pos.y} r={Math.max(0.05, 5 * px)} fill="none" stroke={sch.pinHover} strokeWidth={1.5 * px} />
              )}

              {/* Wire in progress */}
              {mode.kind === "wire" && cursor && (
                <>
                  <polyline
                    points={[...mode.points, ...wirePreview(mode, cursor).slice(1)].map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={sch.wire}
                    strokeWidth={Math.max(sch.wireWidth, 1.4 * px)}
                    strokeDasharray={`${6 * px} ${4 * px}`}
                    strokeLinecap="round"
                  />
                  <circle cx={cursor.x} cy={cursor.y} r={3 * px} fill={sch.wire} />
                </>
              )}

              {/* Drawing in progress */}
              {draft && <DrawingView drawing={draft} px={px} opacity={0.75} />}
              {closing && mode.kind === "line" && (
                <circle cx={mode.points[0].x} cy={mode.points[0].y} r={6 * px} fill="none" stroke={sch.select} strokeWidth={1.6 * px} />
              )}
              {mode.kind === "box" && mode.shape === "block" && <BlockDraft box={boxOf(mode)} project={project} px={px} />}

              {/* Placement ghost */}
              {placingPart && cursor && (
                <SymbolBody
                  symbol={placingPart.symbol}
                  x={snapPoint(cursor, SCH_GRID).x}
                  y={snapPoint(cursor, SCH_GRID).y}
                  rot={placing!.rot}
                  color={sch.select}
                  refText={placingPart.powerNet ? (placingPart.defaultProps.net ?? placingPart.powerNet) : nextRef(project, placingPart.refPrefix)}
                  valueText={placingPart.valueProp ? (placing!.props?.[placingPart.valueProp] ?? placingPart.defaultProps[placingPart.valueProp]) : ""}
                  opacity={0.7}
                  isBox={placingPart.category === "ICs" || placingPart.refPrefix === "U" || placingPart.category === "Connectors"}
                />
              )}

              {/* Crosshair cursor for the wire, label and drawing tools */}
              {cursor && (tool !== "select" || mode.kind === "wire" || mode.kind === "line" || mode.kind === "box") && !placing && !editing && (
                <g stroke={sch.select} strokeWidth={px} opacity={0.6}>
                  <line x1={cursor.x - 8 * px} y1={cursor.y} x2={cursor.x + 8 * px} y2={cursor.y} />
                  <line x1={cursor.x} y1={cursor.y - 8 * px} x2={cursor.x} y2={cursor.y + 8 * px} />
                </g>
              )}
            </>
          )
        }}
      </Viewport>

      {labelDraft && (
        <form
          className="absolute z-10 flex items-center gap-1 rounded-[8px] border border-line bg-surface p-1 shadow-menu"
          style={{ left: labelDraft.screen.x + 8, top: labelDraft.screen.y - 18 }}
          onSubmit={(e) => {
            e.preventDefault()
            const name = labelDraft.name.trim()
            if (name) projectApi().commit((p) => addLabel(p, name, labelDraft.at, labelDraft.rot).project)
            setLabelDraft(null)
          }}
        >
          <input
            autoFocus
            className="field mono h-7 w-36 py-0"
            value={labelDraft.name}
            placeholder="Net name"
            // The suggested name is selected, so typing replaces it.
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setLabelDraft({ ...labelDraft, name: e.target.value.toUpperCase().replace(/\s+/g, "_") })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setLabelDraft(null)
            }}
            onBlur={() => setLabelDraft(null)}
          />
        </form>
      )}

      <SchematicHint mode={mode} tool={tool} placing={!!placing} editing={editing} />
    </div>
  )
}

/** Typing in place: a text's content where it sits on the sheet, or a block's name over its title. */
function InPlaceEditor({
  editing,
  t,
  project,
  defaultSize,
  frames,
  onChange,
  onCommit,
  onCancel,
}: {
  editing: Editing
  t: ViewTransform
  project: Project
  defaultSize: number
  frames: BlockFrame[]
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onCommit()
    }
  }
  if (editing.kind === "block") {
    const f = frames.find((x) => x.id === editing.id)
    if (!f) return null
    const at = toScreen(t, f.title)
    const size = Math.min(40, Math.max(13, BLOCK_TITLE * t.scale))
    return (
      <input
        autoFocus
        aria-label="Block name"
        className="absolute z-10 rounded-[6px] border border-select bg-surface px-1.5 font-[600] text-ink shadow-menu outline-none"
        style={{ left: at.x - 7, top: at.y - 4, fontSize: size, width: `${Math.max(10, editing.value.length + 3)}ch` }}
        value={editing.value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={keys}
        onBlur={onCommit}
      />
    )
  }
  const d = editing.id ? project.drawings?.find((x): x is DrawingText => x.id === editing.id && x.type === "text") : undefined
  const corner = d ? (() => {
    const b = textBox({ ...d, rot: 0 })
    return { x: b.minX, y: b.maxY }
  })() : editing.at
  const at = toScreen(t, corner)
  const size = Math.min(44, Math.max(12, (d?.size ?? defaultSize) * t.scale))
  const lines = editing.value.split("\n")
  const longest = Math.max(12, ...lines.map((l) => l.length))
  return (
    <textarea
      autoFocus
      aria-label="Text"
      placeholder="Type a note"
      rows={lines.length}
      className="absolute z-10 resize-none overflow-hidden rounded-[6px] border border-select bg-surface px-1.5 py-0.5 text-ink shadow-menu outline-none"
      style={{
        left: at.x - 7,
        top: at.y - 4,
        fontSize: size,
        lineHeight: LINE_HEIGHT,
        width: `${longest + 3}ch`,
        fontWeight: d?.bold ? 700 : 500,
        fontStyle: d?.italic ? "italic" : undefined,
        fontFamily: d?.mono ? "var(--font-mono)" : undefined,
      }}
      value={editing.value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={keys}
      onBlur={onCommit}
    />
  )
}

/** The block tool's box, and the parts it would take: those whose middle is inside it. */
function BlockDraft({ box, project, px }: { box: Box; project: Project; px: number }) {
  const sch = useSch()
  return (
    <g style={{ pointerEvents: "none" }}>
      {project.components.map((c) => {
        const b = schematicBounds(c)
        if (!pointInBox({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, box)) return null
        return <rect key={c.id} x={b.minX - 0.05} y={b.minY - 0.05} width={b.maxX - b.minX + 0.1} height={b.maxY - b.minY + 0.1} rx={0.04} fill={sch.selectSoft} stroke={sch.select} strokeWidth={px} />
      })}
      <rect
        x={box.minX}
        y={box.minY}
        width={box.maxX - box.minX}
        height={box.maxY - box.minY}
        fill="none"
        stroke={sch.block}
        strokeWidth={1.4 * px}
        strokeDasharray={`${6 * px} ${4 * px}`}
      />
    </g>
  )
}

function bumpName(last: string): string {
  if (!last) return "NET1"
  const m = last.match(/^(.*?)(\d+)$/)
  return m ? `${m[1]}${Number(m[2]) + 1}` : last
}

function sameHit(a: Hit | null, b: Hit | null) {
  if (!a || !b) return a === b
  if (a.type !== b.type) return false
  if (a.type === "pin" && b.type === "pin") return a.pin.componentId === b.pin.componentId && a.pin.pin === b.pin.pin
  return hitId(a) === hitId(b)
}

/** A block's frame, thinner than a wire, with its title in the top-left corner. */
function BlockView({ frame, selected, hovered, renaming, px }: { frame: BlockFrame; selected: boolean; hovered: boolean; renaming: boolean; px: number }) {
  const sch = useSch()
  const { box, titleBox } = frame
  const color = selected ? sch.select : sch.block
  return (
    <g>
      {hovered && !selected && (
        <rect x={titleBox.minX} y={titleBox.minY} width={titleBox.maxX - titleBox.minX} height={titleBox.maxY - titleBox.minY} fill={sch.selectSoft} />
      )}
      <rect
        x={box.minX}
        y={box.minY}
        width={box.maxX - box.minX}
        height={box.maxY - box.minY}
        fill={selected ? sch.selectSoft : "none"}
        stroke={color}
        strokeWidth={Math.max(0.012, (selected ? 1.6 : 1) * px)}
      />
      {!renaming && <WorldText x={frame.title.x} y={frame.title.y} text={frame.name} size={BLOCK_TITLE} extent={{ x: 1, y: -1 }} fill={color} weight={600} />}
    </g>
  )
}

function LabelView({ label, selected, px }: { label: NetLabel; selected: boolean; px: number }) {
  const sch = useSch()
  const b = labelBox(label)
  const tip = 0.06
  const { x, y } = label
  // A flag whose point touches the wire end it names.
  let d: string
  let at: Vec2
  if (label.rot === 0) {
    d = `M${x},${y} L${b.minX + tip},${b.maxY} L${b.maxX},${b.maxY} L${b.maxX},${b.minY} L${b.minX + tip},${b.minY} Z`
    at = { x: (b.minX + tip + b.maxX) / 2, y }
  } else if (label.rot === 180) {
    d = `M${x},${y} L${b.maxX - tip},${b.maxY} L${b.minX},${b.maxY} L${b.minX},${b.minY} L${b.maxX - tip},${b.minY} Z`
    at = { x: (b.minX + b.maxX - tip) / 2, y }
  } else if (label.rot === 90) {
    d = `M${x},${y} L${b.maxX},${b.minY + tip} L${b.maxX},${b.maxY} L${b.minX},${b.maxY} L${b.minX},${b.minY + tip} Z`
    at = { x, y: (b.minY + tip + b.maxY) / 2 }
  } else {
    d = `M${x},${y} L${b.maxX},${b.maxY - tip} L${b.maxX},${b.minY} L${b.minX},${b.minY} L${b.minX},${b.maxY - tip} Z`
    at = { x, y: (b.minY + b.maxY - tip) / 2 }
  }
  return (
    <g>
      <path d={d} fill={sch.label} stroke={selected ? sch.select : sch.wire} strokeWidth={Math.max(0.012, (selected ? 1.6 : 1) * px)} strokeLinejoin="round" />
      <WorldText
        x={at.x}
        y={at.y}
        text={label.name}
        size={SCH_TEXT}
        extent={{ x: 0, y: 0 }}
        vertical={label.rot === 90 || label.rot === 270}
        fill={sch.labelInk}
        weight={600}
        mono
      />
      <circle cx={x} cy={y} r={0.022} fill={sch.wire} />
    </g>
  )
}

function SchematicHint({ mode, tool, placing, editing }: { mode: Mode; tool: SchTool; placing: boolean; editing: Editing | null }) {
  let items: [string, string][] | null = null
  if (editing?.kind === "text") items = [["Enter", "done"], ["Shift+Enter", "new line"], ["Esc", "cancel"]]
  else if (editing) items = [["Enter", "rename"], ["Esc", "cancel"]]
  else if (placing) items = [["Click", "place"], ["R", "rotate"], ["Shift", "place several"], ["Esc", "cancel"]]
  else if (mode.kind === "wire") items = [["Click", "add a corner"], ["Pin", "finish"], ["/", "flip bend"], ["Backspace", "undo corner"], ["Esc", "done"]]
  else if (mode.kind === "line") items = [["Click", "add a corner"], ["Shift", "45°"], ["First corner", "close"], ["Double-click", "finish"], ["Backspace", "undo corner"]]
  else if (mode.kind === "box") items = mode.shape === "block" ? [["Release", "frame the parts inside"], ["Esc", "cancel"]] : [["Release", "finish"], ["Shift", "square"], ["Alt", "off the grid"]]
  else if (tool === "wire") items = [["Click", "start a wire at a pin or grid point"]]
  else if (tool === "label") items = [["Click", "attach a net label to a pin or wire end"]]
  else if (tool === "block") items = [["Drag", "around parts to frame them as a block"]]
  else if (tool === "text") items = [["Click", "place a text"], ["Click a text", "edit it"]]
  else if (tool === "line") items = [["Click", "start a line"], ["Drag", "draw one segment"], ["Shift", "45°"]]
  else if (tool === "rect") items = [["Drag", "draw a rectangle"], ["Shift", "square"], ["Shift on release", "draw another"]]
  if (!items) return null
  return <CanvasHint items={items} />
}

export function CanvasHint({ items, dark = false }: { items: [string, string][]; dark?: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[8px] px-3 py-1.5 text-[12px] shadow-float ${
        dark ? "bg-[#2c2140] text-silk" : "bg-surface text-ink-2"
      }`}
    >
      {items.map(([k, label]) => (
        <span key={k + label} className="flex items-center gap-1.5 whitespace-nowrap">
          <kbd className={`mono rounded-[4px] px-1.5 text-[11px] ${dark ? "bg-white/10 text-silk" : "bg-chrome text-ink"}`}>{k}</kbd>
          {label}
        </span>
      ))}
    </div>
  )
}
