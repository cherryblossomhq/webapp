import { FlipHorizontal2, Lock, RotateCw } from "lucide-react"
import { resolvedComponents } from "../../model/ruleAreas"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  boxesOverlap,
  chamferedElbow,
  closestPointOnSegment,
  normBox,
  pointInBox,
  pointSegmentDistance,
  normalizeAngle,
  round,
  samePoint,
  snapPoint,
  type Box,
} from "../../lib/geometry"
import { findPart } from "../../model/library"
import { pcbCourtyard, pcbSilk, slotEnds, type WorldPad } from "../../model/instances"
import { holeCentre } from "../../model/padDistance"
import { addTrace, autoPlacePcb, netTraceWidth, removeItems, updateComponent } from "../../model/ops"
import { boardTextStrokes, boardTextStrokeWidth, mountingHoles, ownTexts } from "../../model/board"
import { addOutlinePaths, addOutlineShape, addSlot, moveOutlineArcMid, moveOutlineVertex, nearestOutlineSeg, outlineSelectionId, parseOutlineSelectionId, pathVertices, removeOutlinePath, slotPath, splitOutlineSeg, toggleOutlineArc, translateOutlinePath } from "../../model/outlineOps"
import { pathsSvgPath, segEnd, segStart, type ShapePath } from "../../model/shapes"
import { BOARD_OWNER, pointPadDistance, segmentPadDistance, type CopperItem } from "../../model/pcb"
import { addDimension, expandToGroups, groupSelection, removeDimensions, removeImages, topGroup, touchesGroup } from "../../model/boardObjects"
import { lockedInSelection, moveObjects, rotateObjects, selectionBounds } from "../../model/groupMoves"
import { worldShapes } from "../../model/shapeItems"
import { shapeLayerInfo } from "../../model/shapeLayers"
import { textLayerKind } from "../../model/texts"
import { addGraphic, moveGraphics, removeGraphics } from "../../model/shapeOps"
import { addBoardText, movePartTexts, moveBoardTexts, removeBoardTexts, removePartText, updateBoardTexts, updatePartText } from "../../model/textOps"
import { boardTextId, dimensionWorldText, parseTextId, worldTexts } from "../../model/texts"
import { imageSize } from "../../model/boardObjects"
import { imageState, imageUrl } from "../../store/imageFiles"
import { useImages } from "../../store/useImages"
import { buildDimension, DIMENSION_TOOL_KEY, dimensionClicks, dimensionHint, hitImage, imageShown, marqueeBoardObjects } from "./boardObjectEditing"
import { groupSelected, ungroupSelected } from "./groupActions"
import { dimensionShapes } from "../../model/dimensions"
import { formatLength, nextPreferredWidth } from "../../model/rules"
import { designatorStrokes, getDesignators, SILK_WIDTH, type Designator } from "../../model/silk"
import type { ZoneFill } from "../../model/pour"
import type { ComponentInstance, CopperLayer, Project, ReferenceImage, Vec2 } from "../../model/types"
import { getConnectivity, getLiveAnalysis, useFillTick } from "../../store/analysis"
import { reportPointer, reportViewport, stopFollowing } from "../../store/presence"
import { projectApi, useProjectStore } from "../../store/projectStore"
import { copperShown, selectionIds, uiApi, useUi } from "../../store/uiStore"
import { PeerCursors, PeerSelections } from "../PeerLayer"
import { clampLayer, copperLayers, layerLabel, layerOfKicadName, viaLayers } from "../../model/stack"
import { arcOf, closestPointOnArc, isArcTrace, pointArcDistance } from "../../model/arcTracks"
import { makeArcTrace, makeVia, moveArcPoint, nextCopperLayer } from "../../model/layerOps"
import { traceD } from "./traceGraphics"
import { CanvasHint } from "../schematic/SchematicEditor"
import { PointMark, ShapeDraw, shapeLayerColor } from "./ShapeGraphics"
import { worldPoints } from "../../model/pcbPoints"
import { TextDraw, textSide } from "./TextGraphics"
import { defaultTextStyle, hitText, marqueeTexts, movableTexts, textIds, TEXT_TOOL_KEY, visibleTexts } from "./textEditing"
import {
  addDrawPoint,
  buildShape,
  defaultDrawWidth,
  DRAW_TOOL_KEYS,
  EDGE_CUTS_LAYER,
  graphicIds,
  hitShape,
  isDrawTool,
  marqueeShapes,
  previewShape,
  visibleShapes,
  type DrawTool,
  type ShapeVisibility,
} from "./shapeEditing"
import { copperColor, PCB, pourColor } from "../theme"
import { addZone, deleteZoneCorner, insertZoneCorner, makeZone, moveZone, removeZones, setZoneCorner } from "../../model/zoneOps"
import { OtherZoneFills, ZoneOutlines, ZonePreview } from "./ZoneDraw"
import { nonCopperFills } from "../../model/nonCopperFill"
import { closesPolygon, cornerAt, KEEPOUT_TOOL_KEY, midpointAt, selectedZoneIds, zoneHit, zoneSelectionId, ZONE_TOOL_KEY } from "./zoneEditing"
import { Tooltip } from "../../ui/Tooltip"
import { isTyping, toWorld, Viewport, type ViewportHandle, type ViewportPointerEvent, type ViewTransform } from "../viewport"
import { onBoard } from "../../model/partFlags"

export const PCB_GRID = 0.25

type Hit =
  | { type: "pad"; pad: WorldPad; netId: string | null }
  | { type: "via"; id: string; at: Vec2 }
  | { type: "trace"; id: string; point: Vec2; layer: CopperLayer }
  | { type: "component"; id: string }
  /** A drawing on the board; `id` is its selection id (`g:<graphic id>`). */
  | { type: "shape"; id: string }
  /** A text, of the board or of a part; `id` is its selection id (`x:<id>`, `p:<component>:<index>`). */
  | { type: "text"; id: string }
  /** A reference image; `id` is its selection id (`i:<id>`). */
  | { type: "image"; id: string }
  | { type: "boardHandle" }
  /** A zone with a polygon, by its outline or its copper (`z:<id>`). */
  | { type: "zone"; id: string }
  /** A piece of the board's own outline (`o:<path>:<piece>`). */
  | { type: "outline"; path: number; seg: number }

type Mode =
  | { kind: "idle" }
  | { kind: "marquee"; start: Vec2; current: Vec2; additive: boolean }
  | { kind: "drag"; start: Vec2; ids: string[]; gids: string[]; texts: string[]; /** What `moveObjects` moves: everything in a selection that holds a group, and the dimensions and images of one that does not. */ more: string[]; moved: boolean }
  /** A dimension tool part way through: the clicks so far. */
  | { kind: "dim"; points: Vec2[] }
  /** A drawing tool part way through: the clicks so far. */
  | { kind: "draw"; tool: DrawTool; points: Vec2[] }
  | { kind: "resize"; start: Vec2 }
  /** Dragging a corner (`vertex`, `index` the corner), an arc's middle (`mid`, `index` the piece) or a whole shape of the outline (`move`). */
  | { kind: "outline"; what: "vertex" | "mid" | "move"; path: number; index: number; start: Vec2; moved: boolean }
  /** The zone or keepout tool part way through: the corners so far. */
  | { kind: "zone"; keepout: boolean; points: Vec2[] }
  /** Dragging a corner of a zone (`vertex`), or the whole zone (`move`). */
  | { kind: "zoneEdit"; what: "vertex" | "move"; id: string; ring: number; index: number; start: Vec2; moved: boolean }
  /** The slot tool, one end placed. */
  | { kind: "slot"; a: Vec2 }
  /** `width` is set once W has picked a preferred width; until then the net's width applies. */
  | { kind: "route"; layer: CopperLayer; points: Vec2[]; netId: string | null; diagonalFirst: boolean; width?: number; /** X4: the next piece is an arc track; `mid` is the point on it that has been clicked (null before that). */ arc?: { mid: Vec2 | null } }
  /** Dragging one of the three points of a selected arc track. */
  | { kind: "arcEdit"; id: string; index: 0 | 1 | 2; moved: boolean }

const boardBox = (p: Project): Box => ({
  minX: p.board.x - p.board.width / 2,
  maxX: p.board.x + p.board.width / 2,
  minY: p.board.y - p.board.height / 2,
  maxY: p.board.y + p.board.height / 2,
})

function hitTest(p: Project, at: Vec2, tol: number, layer: CopperLayer, items: CopperItem[], fills: ZoneFill[] = []): Hit | null {
  const bb = boardBox(p)
  if (!p.board.outline?.paths.length && Math.hypot(at.x - bb.maxX, at.y - bb.minY) <= tol * 1.6) return { type: "boardHandle" }
  // Pads on the active layer first, then any pad.
  const pads = items.filter((i): i is Extract<CopperItem, { kind: "pad" }> => i.kind === "pad")
  for (const pass of [true, false]) {
    for (const it of pads) {
      if (it.pad.componentId === BOARD_OWNER) continue
      if (pass && !it.layers.includes(layer)) continue
      if (pointPadDistance(at, it.pad) <= tol * 0.5) return { type: "pad", pad: it.pad, netId: it.netId }
    }
  }
  for (const v of p.vias) {
    if (Math.hypot(at.x - v.x, at.y - v.y) <= v.diameter / 2 + tol * 0.5) return { type: "via", id: v.id, at: { x: v.x, y: v.y } }
  }
  const ui = uiApi()
  // Traces on a layer that is hidden cannot be picked; those on the active layer are tried first.
  const traces = p.traces.filter((t) => copperShown(ui, t.layer)).sort((a, b) => (a.layer === layer ? 1 : 0) - (b.layer === layer ? 1 : 0))
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i]
    if (isArcTrace(t)) {
      // X4: an arc track is picked by its curve.
      const arc = arcOf(t.points)
      if (pointArcDistance(at, arc) <= t.width / 2 + tol * 0.5) return { type: "trace", id: t.id, point: closestPointOnArc(at, arc), layer: t.layer }
      continue
    }
    for (let s = 0; s < t.points.length - 1; s++) {
      if (pointSegmentDistance(at, t.points[s], t.points[s + 1]) <= t.width / 2 + tol * 0.5) {
        return { type: "trace", id: t.id, point: closestPointOnSegment(at, t.points[s], t.points[s + 1]), layer: t.layer }
      }
    }
  }
  // Text: the text itself, board text and a part's alike.
  const text = hitText(p, at, tol * 0.5, shapeVisibility())
  if (text) return { type: "text", id: text.id }
  // Drawings: a board drawing is picked itself, a part's drawing picks the part.
  const shapes = worldShapes(p)
  if (shapes.length) {
    const s = hitShape(shapes, at, tol * 0.5, shapeVisibility())
    if (s) return s.select ? { type: "shape", id: s.select } : s.owner === "#board" ? { type: "shape", id: s.id } : { type: "component", id: s.owner }
  }
  const parts = resolvedComponents(p)
  for (let i = parts.length - 1; i >= 0; i--) {
    const c = parts[i]
    if (!c.pcb.placed) continue
    const cy = pcbCourtyard(c)
    if (cy && pointInBox(at, cy)) return { type: "component", id: c.id }
  }
  // A zone with a polygon, by its edge or its copper, where nothing above it is.
  if (p.zones.some((z) => z.outline)) {
    const z = zoneHit(p, at, tol, layer, fills)
    if (z) return { type: "zone", id: z }
  }
  // The board's own outline, last: a part or copper on the edge is picked before it.
  if (p.board.outline?.paths.length) {
    const near = nearestOutlineSeg(p.board.outline.paths, at)
    if (near && near.distance <= tol * 0.5) return { type: "outline", path: near.path, seg: near.seg }
  }
  // A reference image is under everything else, so it is picked only where nothing is on top of it.
  const image = hitImage(p, at, shapeVisibility())
  if (image) return { type: "image", id: image }
  return null
}

const shapeVisibility = (): ShapeVisibility => ({ hidden: uiApi().hiddenShapeLayers, layers: uiApi().layers })

function hitSelectionId(h: Hit | null): string | null {
  if (!h) return null
  if (h.type === "pad") return `c:${h.pad.componentId}`
  if (h.type === "via") return `v:${h.id}`
  if (h.type === "trace") return `t:${h.id}`
  if (h.type === "component") return `c:${h.id}`
  if (h.type === "shape") return h.id
  if (h.type === "text") return h.id
  if (h.type === "outline") return outlineSelectionId(h.path, h.seg)
  if (h.type === "image") return h.id
  if (h.type === "zone") return zoneSelectionId(h.id)
  return null
}

/** Of the selected parts, which can move and the references of the locked ones, which stay. */
export function splitLocked(project: Project, ids: string[]): { free: string[]; locked: string[] } {
  const parts = ids.map((id) => project.components.find((c) => c.id === id)).filter((c): c is ComponentInstance => !!c)
  return { free: parts.filter((c) => !c.pcb.locked).map((c) => c.id), locked: parts.filter((c) => c.pcb.locked).map((c) => c.ref) }
}

const lockedNote = (refs: string[]) =>
  `${refs.join(", ")} ${refs.length > 1 ? "are" : "is"} locked; turn off Locked in the Inspector to move ${refs.length > 1 ? "them" : "it"}`

const reportPcbPointer = (p: Vec2 | null) => reportPointer("pcb", p)
const reportPcbViewport = (b: Box) => reportViewport("pcb", b)

const lockedShapeNote = (n: number) => `${n > 1 ? `${n} drawings are` : "A drawing is"} locked; turn off Locked in the Inspector to move ${n > 1 ? "them" : "it"}`

/** The active layer as the board has it: the stored one can name a layer the board no longer has. */
const activeLayerNow = () => clampLayer(projectApi().project!.board, uiApi().activeLayer)

export function PcbEditor() {
  const project = useProjectStore((s) => s.project)!
  const selection = useUi((s) => s.selection)
  const tool = useUi((s) => s.pcbTool)
  const layer = clampLayer(project.board, useUi((s) => s.activeLayer))
  const unit = useUi((s) => s.settings.units)
  const layers = useUi((s) => s.layers)
  const hiddenCopper = useUi((s) => s.hiddenCopper)
  const hiddenShapeLayers = useUi((s) => s.hiddenShapeLayers)
  const drawLayer = useUi((s) => s.drawLayer)
  const uiSlotWidth = useUi((s) => s.slotWidth)
  const drawWidth = useUi((s) => s.drawWidth)
  const dimensionKind = useUi((s) => s.dimensionKind)
  const highlightNet = useUi((s) => s.highlightNet)
  const focusRequest = useUi((s) => s.focusRequest)
  const vpRef = useRef<ViewportHandle>(null)
  const [mode, setMode] = useState<Mode>({ kind: "idle" })
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [cursor, setCursor] = useState<Vec2 | null>(null)
  const [hover, setHover] = useState<Hit | null>(null)
  const [fitBox] = useState(() => boardBox(project))
  const [note, setNote] = useState<string | null>(null)
  /** What the last outline edit did, when that is worth saying (a drawn shape replaced the rectangle). */
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), 3500)
    return () => clearTimeout(timer)
  }, [note])
  useEffect(() => {
    if (!info) return
    const timer = setTimeout(() => setInfo(null), 6000)
    return () => clearTimeout(timer)
  }, [info])

  const sch = useMemo(() => getConnectivity(project), [project])
  const fillTick = useFillTick((s) => s.tick)
  const pcb = useMemo(() => getLiveAnalysis(project), [project, fillTick])
  const selected = useMemo(() => new Set(selection), [selection])
  const pours = usePourPaths(pcb.zoneFills)
  const pinNames = usePinNames(project.components)
  const designators = getDesignators(project)
  useImages(project.images)

  // Place parts that were added in the schematic since the last visit. Not for a viewer, who can't.
  useEffect(() => {
    const p = projectApi().project
    if (p && projectApi().role !== "viewer" && resolvedComponents(p).some((c) => !c.pcb.placed && onBoard(c))) {
      projectApi().commit((x) => autoPlacePcb(x))
    }
  }, [])

  useEffect(() => {
    const vp = vpRef.current
    if (focusRequest?.view !== "pcb" || !vp) return
    if (focusRequest.box && focusRequest.fit) vp.fit(focusRequest.box, 0)
    else if (focusRequest.box) vp.frame(focusRequest.box, 15)
    else vp.centerOn(focusRequest, Math.max(vp.transform().scale, 30))
  }, [focusRequest])

  const tol = () => 6 / (vpRef.current?.transform().scale ?? 14)

  // A tool stays with its own clicks: switching tools drops a drawing that was half made.
  useEffect(() => {
    if (modeRef.current.kind === "draw" || modeRef.current.kind === "dim") setMode({ kind: "idle" })
  }, [tool])

  const drawStyle = () => ({ layer: drawLayer, width: drawWidth ?? defaultDrawWidth(drawLayer) })

  const netName = (id: string | null) => (id ? (sch.nets.find((n) => n.id === id)?.name ?? null) : null)

  const activeNet = useMemo(() => {
    if (highlightNet) return highlightNet
    if (mode.kind === "route") return mode.netId
    if (hover?.type === "pad") return hover.netId
    if (hover?.type === "trace") return pcb.traceNet.get(hover.id) ?? null
    const ts = selectionIds(selection, "t")
    if (ts.length === 1) return pcb.traceNet.get(ts[0]) ?? null
    return null
  }, [highlightNet, mode, hover, pcb, selection])

  /** Snap to pad centres / via centres when hovering copper, otherwise to the grid. */
  const snapTarget = useCallback(
    (world: Vec2, free = false): { at: Vec2; hit: Hit | null } => {
      const h = hitTest(projectApi().project!, world, tol(), activeLayerNow(), getLiveAnalysis(projectApi().project!).items)
      if (h?.type === "pad") return { at: { x: h.pad.x, y: h.pad.y }, hit: h }
      if (h?.type === "via") return { at: h.at, hit: h }
      if (h?.type === "trace") return { at: { x: round(h.point.x), y: round(h.point.y) }, hit: h }
      return { at: free ? { x: round(world.x, 3), y: round(world.y, 3) } : snapPoint(world, PCB_GRID), hit: h }
    },
    [],
  )

  const routePreview = (m: Extract<Mode, { kind: "route" }>, to: Vec2) => {
    const last = m.points[m.points.length - 1]
    return chamferedElbow(last, to, m.diagonalFirst)
  }

  const commitRoute = useCallback((m: Extract<Mode, { kind: "route" }>, extra: Vec2[] = []) => {
    const points = [...m.points, ...extra]
    if (points.length >= 2) {
      // Hand-routed copper is locked: a re-pack would clear it and move the parts it reaches.
      projectApi().commit((p) => addTrace(p, { layer: m.layer, width: m.width ?? netTraceWidth(p.rules, netNameOf(p, m.netId)), points, locked: true }).project)
    }
  }, [])

  /** Make the drawing the clicks so far describe, or say why it is not one. */
  const commitDraw = useCallback((tool: DrawTool, points: Vec2[]) => {
    const ui = uiApi()
    const shape = buildShape(tool, points, { layer: ui.drawLayer, width: ui.drawWidth ?? defaultDrawWidth(ui.drawLayer) })
    if (shape && ui.drawLayer === EDGE_CUTS_LAYER) {
      // On the board's edge a drawing is the outline: a closed shape is a cutout or the board, a piece waits to be joined to the others.
      const before = projectApi().project!
      const plain = !before.board.outline?.paths.length
      let said = ""
      projectApi().commit((p) => {
        const res = addOutlineShape(p, shape)
        if (res.crossing) {
          said = res.crossing
          return p
        }
        said = res.replacedRectangle
          ? `The shape you closed is the board now, and the rectangle is gone${mountingHoles(p.board).length ? ", and its corner mounting holes with it: Back to a rectangle, in the Board section, brings them back" : ""}. Undo brings it back.`
          : res.closedLoops
            ? "Shape closed: a cutout if it is inside the board, otherwise another piece of it."
            : plain
              ? "Outline started. The rectangle stays until you close a shape that reaches outside it, which replaces it; a closed shape inside it is a cutout."
              : "Not closed yet: carry on until the edge comes back to its start."
        return res.project
      })
      setInfo(said)
    } else if (shape) projectApi().commit((p) => addGraphic(p, shape).project)
    else setNote(tool === "arc" ? "The three points of an arc must not lie on a line" : tool === "polygon" ? "A polygon needs three corners that do not lie on a line" : "That drawing has no size")
  }, [])

  /** Make the zone the clicks so far describe, on the layer shown, and select it so its properties are at hand. */
  const commitZone = useCallback((m: Extract<Mode, { kind: "zone" }>) => {
    const p = projectApi().project!
    const nets = getConnectivity(p).nets.filter((n) => n.pins.length > 0 && !n.name.startsWith("Net-"))
    // A pour starts on ground when the board has it, or else on the net of the pour it follows: the Inspector changes it.
    const net = m.keepout ? "" : (nets.find((n) => n.name === "GND")?.name ?? nets[0]?.name ?? "")
    const zone = makeZone(m.points, { layers: [activeLayerNow()], net, keepout: m.keepout ? { tracks: true, vias: true, pour: true } : undefined })
    if (!zone) {
      setNote("A zone needs three corners that do not lie on a line")
      return
    }
    projectApi().commit((x) => addZone(x, zone))
    uiApi().select([zoneSelectionId(zone.id)])
    uiApi().setPcbTool("select")
  }, [])

  /**
   * A via where the route has got to, and the route goes on from it on the layer the via leads to (X5): the next layer in the stack for a through via, and for a
   * blind, buried or micro one the layer the via's settings name, or the layer next to this one. The via joins this layer and that one (a through via, every layer).
   */
  const placeViaAndSwitch = useCallback(() => {
    const m = modeRef.current
    if (m.kind !== "route") return
    const at = m.points[m.points.length - 1]
    commitRoute(m)
    const ui = uiApi()
    const p0 = projectApi().project!
    const adjacent = nextCopperLayer(p0, m.layer, m.layer === "bottom" ? -1 : 1)
    const target = ui.viaTo && ui.viaTo !== m.layer && copperLayers(p0.board).includes(ui.viaTo) ? ui.viaTo : adjacent
    const kind = ui.viaKind
    projectApi().commit((p) => (p.vias.some((v) => samePoint(v, at)) ? p : makeVia(p, at, { locked: true, net: netNameOf(p, m.netId), kind: kind === "blind" ? "blind" : kind === "micro" ? "micro" : "through", between: [m.layer, target] }).project))
    uiApi().setActiveLayer(target)
    setMode({ ...m, layer: target, points: [at], arc: m.arc ? { mid: null } : undefined })
  }, [commitRoute])

  // ---------- pointer ----------
  const onPointerDown = (e: ViewportPointerEvent) => {
    const native = e.native as React.PointerEvent
    if (native.button !== 0) return
    const p = projectApi().project!
    const m = modeRef.current
    const { at, hit } = snapTarget(e.world, native.altKey)

    if (m.kind === "route" && m.arc) {
      // X4: an arc track by three points: where it starts (the last corner), a point on it, and where it ends.
      const isEnd = hit && (hit.type === "pad" || hit.type === "via" || hit.type === "trace") && !samePoint(at, m.points[0])
      if (!m.arc.mid) {
        if (!samePoint(at, m.points[m.points.length - 1])) setMode({ ...m, arc: { mid: at } })
        return
      }
      const start = m.points[m.points.length - 1]
      const mid = m.arc.mid
      const width = m.width ?? netTraceWidth(p.rules, netNameOf(p, m.netId))
      let made = false
      if (m.points.length > 1) commitRoute(m)
      projectApi().commit((x) => {
        const res = makeArcTrace(x, { layer: m.layer, start, mid, end: at, width, net: undefined, locked: true })
        made = res.trace !== null
        return res.project
      })
      if (!made) {
        setNote("The three points of an arc track must not lie on a line")
        setMode({ ...m, points: [start], arc: { mid: null } })
        return
      }
      if (isEnd) setMode({ kind: "idle" })
      else setMode({ ...m, points: [at], arc: { mid: null } })
      return
    }

    if (m.kind === "route") {
      const seg = routePreview(m, at)
      const isEnd = hit && (hit.type === "pad" || hit.type === "via" || hit.type === "trace") && !samePoint(at, m.points[0])
      if (isEnd || (m.points.length > 1 && samePoint(at, m.points[m.points.length - 1]))) {
        commitRoute(m, seg.slice(1))
        setMode({ kind: "idle" })
      } else {
        setMode({ ...m, points: [...m.points, ...seg.slice(1)] })
      }
      return
    }

    if (tool === "text") {
      const ui = uiApi()
      const style = defaultTextStyle(ui.drawLayer)
      const bottom = ui.drawLayer.startsWith("B.")
      let id = ""
      projectApi().commit((x) => {
        const res = addBoardText(x, { layer: ui.drawLayer, text: "TEXT", x: at.x, y: at.y, rot: 0, size: style.size, thickness: style.thickness, ...(bottom ? { mirror: true as const } : {}) })
        id = res.text.id
        return res.project
      })
      if (id) uiApi().select([boardTextId(id)])
      uiApi().setPcbTool("select")
      return
    }

    if (tool === "slot") {
      if (m.kind === "slot") {
        if (Math.hypot(at.x - m.a.x, at.y - m.a.y) < 1e-6) setNote("The two ends of a slot are the same point")
        else {
          const width = uiApi().slotWidth
          const crossing = addOutlinePaths(projectApi().project!, [slotPath(m.a, at, width)]).crossing
          if (crossing) setNote(crossing)
          else projectApi().commit((x) => addSlot(x, m.a, at, width))
          setInfo("Slot cut into the board.")
        }
        setMode({ kind: "idle" })
      } else setMode({ kind: "slot", a: at })
      return
    }

    if (tool === "dimension") {
      const ui = uiApi()
      const kind = ui.dimensionKind
      const clicks = m.kind === "dim" ? m.points : []
      if (clicks.length + 1 < dimensionClicks(kind)) {
        setMode({ kind: "dim", points: [...clicks, at] })
        return
      }
      const made = buildDimension(kind, ui.drawLayer, clicks, at)
      setMode({ kind: "idle" })
      if (!made) {
        setNote("A dimension needs two points that are not the same")
        return
      }
      let id = ""
      projectApi().commit((x) => {
        const res = addDimension(x, made)
        id = res.dimension.id
        return res.project
      })
      if (id) uiApi().select([`m:${id}`])
      uiApi().setPcbTool("select")
      return
    }

    if (tool === "zone" || tool === "keepout") {
      const points = m.kind === "zone" ? m.points : []
      if (closesPolygon(points, at, tol() * 1.3)) {
        commitZone({ kind: "zone", keepout: tool === "keepout", points })
        setMode({ kind: "idle" })
      } else setMode({ kind: "zone", keepout: tool === "keepout", points: [...points, at] })
      return
    }

    if (isDrawTool(tool)) {
      const step = addDrawPoint(tool, m.kind === "draw" ? m.points : [], at)
      if (step.complete) {
        commitDraw(tool, step.points)
        setMode({ kind: "idle" })
      } else setMode({ kind: "draw", tool, points: step.points })
      return
    }

    if (tool === "route") {
      let netId: string | null = null
      let startLayer = activeLayerNow()
      if (hit?.type === "pad") {
        netId = hit.netId
        if (!hit.pad.layers.includes(startLayer)) startLayer = hit.pad.layers[0]
      } else if (hit?.type === "trace") {
        netId = pcb.traceNet.get(hit.id) ?? null
        startLayer = hit.layer
      } else if (hit?.type === "via") {
        netId = pcb.viaNet.get(hit.id) ?? null
      }
      uiApi().setActiveLayer(startLayer)
      setMode({ kind: "route", layer: startLayer, points: [at], netId, diagonalFirst: false })
      return
    }

    if (tool === "via") {
      const ui = uiApi()
      const here = activeLayerNow()
      const adjacent = nextCopperLayer(p, here, here === "bottom" ? -1 : 1)
      const target = ui.viaTo && ui.viaTo !== here && copperLayers(p.board).includes(ui.viaTo) ? ui.viaTo : adjacent
      projectApi().commit((x) => makeVia(x, at, { locked: true, kind: ui.viaKind === "blind" ? "blind" : ui.viaKind === "micro" ? "micro" : "through", between: [here, target] }).project)
      return
    }

    // select
    // The three points of a selected arc track (X4) are handles that win over what lies under them.
    const tsel = selectionIds(uiApi().selection, "t")
    const arc0 = tsel.length === 1 && !native.shiftKey ? p.traces.find((t) => t.id === tsel[0] && isArcTrace(t)) : undefined
    if (arc0) {
      const reach = tol() * 1.3
      const k = arc0.points.findIndex((pt) => Math.hypot(pt.x - e.world.x, pt.y - e.world.y) <= reach)
      if (k >= 0) {
        projectApi().beginTransient()
        setMode({ kind: "arcEdit", id: arc0.id, index: k as 0 | 1 | 2, moved: false })
        return
      }
    }
    // The corners and arc middles of a selected piece of the outline are handles that win over what lies under them.
    const sel0 = uiApi().selection.map(parseOutlineSelectionId).find((x) => x !== null)
    const outlinePaths = p.board.outline?.paths
    if (sel0 && outlinePaths?.[sel0.path] && !native.shiftKey) {
      const path = outlinePaths[sel0.path]
      const reach = tol() * 1.3
      const k = pathVertices(path).findIndex((v) => Math.hypot(v.x - e.world.x, v.y - e.world.y) <= reach)
      const arcSeg = path.segs.findIndex((sg) => sg.kind === "arc" && Math.hypot(sg.mid.x - e.world.x, sg.mid.y - e.world.y) <= reach)
      if (k >= 0 || arcSeg >= 0) {
        projectApi().beginTransient()
        setMode({ kind: "outline", what: k >= 0 ? "vertex" : "mid", path: sel0.path, index: k >= 0 ? k : arcSeg, start: e.world, moved: false })
        return
      }
    }
    // The corners and edge middles of a selected zone are handles that win over what lies under them.
    const zsel = selectedZoneIds(uiApi().selection)
    const zone0 = zsel.length === 1 ? p.zones.find((z) => z.id === zsel[0]) : undefined
    if (zone0?.outline && !zone0.locked && !native.shiftKey) {
      const reach = tol() * 1.3
      const c = cornerAt(zone0, e.world, reach)
      if (c) {
        projectApi().beginTransient()
        setMode({ kind: "zoneEdit", what: "vertex", id: zone0.id, ring: c.ring, index: c.index, start: e.world, moved: false })
        return
      }
      const mid = midpointAt(zone0, e.world, reach)
      if (mid) {
        projectApi().beginTransient()
        projectApi().setTransient((base) => ({ ...base, zones: base.zones.map((z) => (z.id === zone0.id ? insertZoneCorner(z, mid.ring, mid.index, mid.at) : z)) }))
        setMode({ kind: "zoneEdit", what: "vertex", id: zone0.id, ring: mid.ring, index: mid.index + 1, start: e.world, moved: true })
        return
      }
    }
    const h = hitTest(p, e.world, tol(), activeLayerNow(), pcb.items, pcb.zoneFills)
    if (h?.type === "zone" && !native.shiftKey) {
      uiApi().select([zoneSelectionId(h.id)])
      const z = p.zones.find((x) => x.id === h.id)
      if (z?.locked) setNote("That zone is locked; turn off Locked in the Inspector to move it")
      else {
        projectApi().beginTransient()
        setMode({ kind: "zoneEdit", what: "move", id: h.id, ring: 0, index: 0, start: e.world, moved: false })
      }
      return
    }
    if (h?.type === "outline" && !native.shiftKey) {
      uiApi().select([outlineSelectionId(h.path, h.seg)])
      projectApi().beginTransient()
      setMode({ kind: "outline", what: "move", path: h.path, index: h.seg, start: e.world, moved: false })
      return
    }
    if (h?.type === "boardHandle") {
      projectApi().beginTransient()
      setMode({ kind: "resize", start: e.world })
      return
    }
    const id = hitSelectionId(h)
    if (!id) {
      if (!native.shiftKey) uiApi().clearSelection()
      setMode({ kind: "marquee", start: e.world, current: e.world, additive: native.shiftKey })
      return
    }
    // Ctrl or Cmd picks the one object, inside its group; otherwise a group is picked whole, as KiCad picks one.
    const alone = native.ctrlKey || native.metaKey
    const picked = alone ? [id] : expandToGroups(p, [id])
    if (native.shiftKey) {
      const have = new Set(uiApi().selection)
      if (picked.every((x) => have.has(x))) uiApi().select(uiApi().selection.filter((x) => !picked.includes(x)))
      else uiApi().select([...new Set([...uiApi().selection, ...picked])])
      return
    }
    let sel = uiApi().selection
    if (!sel.includes(id)) {
      sel = picked
      uiApi().select(sel)
    }
    // A selection with a group in it moves as one, whatever it holds; the dimensions and images of one with none move with it.
    const grouped = touchesGroup(p, sel)
    const more = grouped ? sel : sel.filter((s) => s.startsWith("m:") || s.startsWith("i:"))
    const heldMore = lockedInSelection(p, more)
    if (heldMore.length) setNote(`${heldMore.length} locked ${heldMore.length === 1 ? "object stays" : "objects stay"} where ${heldMore.length === 1 ? "it is" : "they are"}; unlock ${heldMore.length === 1 ? "it" : "them"} (or the group) to move ${heldMore.length === 1 ? "it" : "them"}`)
    if (grouped) {
      if (more.length > heldMore.length) {
        projectApi().beginTransient()
        setMode({ kind: "drag", start: e.world, ids: [], gids: [], texts: [], more, moved: false })
      }
      return
    }
    const { free, locked } = splitLocked(p, selectionIds(sel, "c"))
    const gSel = new Set(graphicIds(sel))
    const drawings = (p.graphics ?? []).filter((g) => gSel.has(g.id))
    const freeDrawings = drawings.filter((g) => !g.locked).map((g) => g.id)
    const lockedDrawings = drawings.length - freeDrawings.length
    const movable = movableTexts(p, sel)
    const lockedTexts = movable.locked
    const notes = [locked.length ? lockedNote(locked) : "", lockedDrawings ? lockedShapeNote(lockedDrawings) : "", lockedTexts ? `${lockedTexts > 1 ? `${lockedTexts} texts are` : "A text is"} locked; turn off Locked in the Inspector to move ${lockedTexts > 1 ? "them" : "it"}` : ""].filter(Boolean)
    if (notes.length) setNote(notes.join(". "))
    const freeTexts = textIds(sel).filter((tid) => {
      const parsed = parseTextId(tid)
      return parsed?.kind === "board" ? movable.board.includes(parsed.text) : !!parsed && movable.parts.some((q) => q.component === parsed.component && q.index === parsed.index)
    })
    if (free.length || freeDrawings.length || freeTexts.length || more.length > heldMore.length) {
      projectApi().beginTransient()
      setMode({ kind: "drag", start: e.world, ids: free, gids: freeDrawings, texts: freeTexts, more, moved: false })
    }
  }

  const onPointerMove = (e: ViewportPointerEvent) => {
    const native = e.native as React.PointerEvent
    const m = modeRef.current
    const { at } = snapTarget(e.world, native.altKey)
    setCursor(at)
    uiApi().setCursor(at)
    if (m.kind === "marquee") {
      setMode({ ...m, current: e.world })
      return
    }
    if (m.kind === "drag") {
      const raw = { x: e.world.x - m.start.x, y: e.world.y - m.start.y }
      const delta = native.altKey ? { x: round(raw.x, 3), y: round(raw.y, 3) } : snapPoint(raw, PCB_GRID)
      if (!m.moved && delta.x === 0 && delta.y === 0) return
      const ids = new Set(m.ids)
      projectApi().setTransient((base) => {
        const moved = ids.size
          ? {
              ...base,
              components: base.components.map((c) =>
                ids.has(c.id) ? { ...c, pcb: { ...c.pcb, x: round(c.pcb.x + delta.x), y: round(c.pcb.y + delta.y), placed: true } } : c,
              ),
            }
          : base
        const drawn = m.gids.length ? moveGraphics(moved, m.gids, delta.x, delta.y) : moved
        const texted = (() => {
          if (!m.texts.length) return drawn
          const mv = movableTexts(drawn, m.texts)
          return movePartTexts(moveBoardTexts(drawn, mv.board, delta.x, delta.y), mv.parts, delta.x, delta.y)
        })()
        return m.more.length ? moveObjects(texted, m.more, delta.x, delta.y) : texted
      })
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "arcEdit") {
      const to = native.altKey ? { x: round(e.world.x, 3), y: round(e.world.y, 3) } : snapPoint(e.world, PCB_GRID)
      projectApi().setTransient((base) => moveArcPoint(base, m.id, m.index, to))
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "zoneEdit") {
      const free = native.altKey
      if (m.what === "move") {
        const raw = { x: e.world.x - m.start.x, y: e.world.y - m.start.y }
        const delta = free ? { x: round(raw.x, 3), y: round(raw.y, 3) } : snapPoint(raw, PCB_GRID)
        if (!m.moved && delta.x === 0 && delta.y === 0) return
        projectApi().setTransient((base) => ({ ...base, zones: base.zones.map((z) => (z.id === m.id ? moveZone(z, delta.x, delta.y) : z)) }))
      } else {
        const to = free ? { x: round(e.world.x, 3), y: round(e.world.y, 3) } : snapPoint(e.world, PCB_GRID)
        projectApi().setTransient((base) => ({ ...base, zones: base.zones.map((z) => (z.id === m.id ? setZoneCorner(z, m.ring, m.index, to) : z)) }))
      }
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "outline") {
      const free = native.altKey
      const to = free ? { x: round(e.world.x, 3), y: round(e.world.y, 3) } : snapPoint(e.world, PCB_GRID)
      if (m.what === "move") {
        const raw = { x: e.world.x - m.start.x, y: e.world.y - m.start.y }
        const delta = free ? { x: round(raw.x, 3), y: round(raw.y, 3) } : snapPoint(raw, PCB_GRID)
        if (!m.moved && delta.x === 0 && delta.y === 0) return
        projectApi().setTransient((base) => translateOutlinePath(base, m.path, delta.x, delta.y))
      } else {
        projectApi().setTransient((base) => (m.what === "vertex" ? moveOutlineVertex(base, m.path, m.index, to) : moveOutlineArcMid(base, m.path, m.index, to)) ?? base)
      }
      if (!m.moved) setMode({ ...m, moved: true })
      return
    }
    if (m.kind === "resize") {
      projectApi().setTransient((base) => {
        const bb = boardBox(base)
        const right = Math.max(bb.minX + 5, snapPoint(e.world, 0.5).x)
        const bottom = Math.min(bb.maxY - 5, snapPoint(e.world, 0.5).y)
        const width = round(right - bb.minX, 2)
        const height = round(bb.maxY - bottom, 2)
        return { ...base, board: { ...base.board, width, height, x: round(bb.minX + width / 2, 3), y: round(bb.maxY - height / 2, 3) } }
      })
      return
    }
    if (m.kind === "idle") {
      const h = hitTest(project, e.world, tol(), layer, pcb.items, pcb.zoneFills)
      setHover((prev) => (hitSelectionId(prev) === hitSelectionId(h) && prev?.type === h?.type ? prev : h))
    }
  }

  const onPointerUp = () => {
    const m = modeRef.current
    if (m.kind === "marquee") {
      const box = normBox(m.start, m.current)
      const ids: string[] = []
      for (const c of resolvedComponents(project)) {
        const cy = c.pcb.placed ? pcbCourtyard(c) : null
        if (cy && boxesOverlap(box, cy)) ids.push(`c:${c.id}`)
      }
      for (const t of project.traces) if (t.points.some((pt) => pointInBox(pt, box))) ids.push(`t:${t.id}`)
      for (const v of project.vias) if (pointInBox(v, box)) ids.push(`v:${v.id}`)
      ids.push(...marqueeShapes(worldShapes(project), box, shapeVisibility()))
      ids.push(...marqueeTexts(project, box, shapeVisibility()))
      ids.push(...marqueeBoardObjects(project, box, shapeVisibility()))
      const base = m.additive ? uiApi().selection : []
      uiApi().select(expandToGroups(project, [...new Set([...base, ...ids])]))
      setMode({ kind: "idle" })
    } else if (m.kind === "drag" || m.kind === "resize" || m.kind === "outline" || m.kind === "zoneEdit" || m.kind === "arcEdit") {
      if ((m.kind === "drag" || m.kind === "outline" || m.kind === "zoneEdit" || m.kind === "arcEdit") && !m.moved) projectApi().cancelTransient()
      else projectApi().endTransient()
      setMode({ kind: "idle" })
    }
  }

  const onDoubleClick = () => {
    const m = modeRef.current
    if (m.kind === "route") {
      commitRoute(m)
      setMode({ kind: "idle" })
    } else if (m.kind === "draw" && m.tool === "polygon") {
      commitDraw("polygon", m.points)
      setMode({ kind: "idle" })
    } else if (m.kind === "zone") {
      commitZone(m)
      setMode({ kind: "idle" })
    }
  }

  const onContextMenu = () => {
    const m = modeRef.current
    if (m.kind === "route") {
      commitRoute(m)
      setMode({ kind: "idle" })
    } else if (m.kind === "draw") {
      if (m.tool === "polygon") commitDraw("polygon", m.points)
      setMode({ kind: "idle" })
    } else if (m.kind === "zone") {
      commitZone(m)
      setMode({ kind: "idle" })
    } else if (m.kind === "idle" && cursor) {
      // A right click on a corner of the selected zone takes the corner away (the polygon keeps three).
      const zsel = selectedZoneIds(uiApi().selection)
      const z = zsel.length === 1 ? projectApi().project!.zones.find((x) => x.id === zsel[0]) : undefined
      const c = z && !z.locked ? cornerAt(z, cursor, tol() * 1.3) : null
      if (z && c) projectApi().commit((x) => ({ ...x, zones: x.zones.map((q) => (q.id === z.id ? deleteZoneCorner(q, c.ring, c.index) : q)) }))
    }
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return
      const m = modeRef.current
      const key = e.key.toLowerCase()
      const sel = uiApi().selection
      const drawKey = !e.altKey ? (Object.keys(DRAW_TOOL_KEYS) as DrawTool[]).find((k) => DRAW_TOOL_KEYS[k].toLowerCase() === key) : undefined
      if (key === "escape") {
        if (m.kind === "route") {
          commitRoute(m)
          setMode({ kind: "idle" })
        } else if (m.kind === "draw" || m.kind === "dim" || m.kind === "zone") {
          setMode({ kind: "idle" })
        } else if (m.kind === "drag" || m.kind === "resize" || m.kind === "outline" || m.kind === "zoneEdit" || m.kind === "arcEdit") {
          projectApi().cancelTransient()
          setMode({ kind: "idle" })
        } else if (m.kind === "slot") {
          setMode({ kind: "idle" })
        } else {
          uiApi().clearSelection()
          uiApi().setPcbTool("select")
          uiApi().setHighlightNet(null)
        }
        return
      }
      if (m.kind === "route") {
        if (key === "v") placeViaAndSwitch()
        else if (key === "a") setMode({ ...m, arc: m.arc ? undefined : { mid: null } })
        else if (key === "/") setMode({ ...m, diagonalFirst: !m.diagonalFirst })
        else if (key === "w") {
          // The corners so far keep their width; the trace carries on from the last one at the next.
          const p = projectApi().project!
          const width = nextPreferredWidth(p.rules, m.width ?? netTraceWidth(p.rules, netNameOf(p, m.netId)))
          if (m.points.length > 1) commitRoute(m)
          setMode({ ...m, points: m.points.slice(-1), width })
        }
        else if (key === "backspace") {
          e.preventDefault()
          if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
          else setMode({ kind: "idle" })
        }
        return
      }
      // A viewer's drawing tools are off, as their buttons are.
      const viewer = projectApi().role === "viewer"
      if (m.kind === "dim" && key === "backspace") {
        e.preventDefault()
        if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
        else setMode({ kind: "idle" })
        return
      }
      if (m.kind === "zone") {
        if (key === "enter") {
          e.preventDefault()
          commitZone(m)
          setMode({ kind: "idle" })
          return
        }
        if (key === "backspace") {
          e.preventDefault()
          if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
          else setMode({ kind: "idle" })
          return
        }
      }
      if (m.kind === "draw") {
        if (key === "enter" && m.tool === "polygon") {
          e.preventDefault()
          commitDraw("polygon", m.points)
          setMode({ kind: "idle" })
          return
        }
        if (key === "backspace") {
          e.preventDefault()
          if (m.points.length > 1) setMode({ ...m, points: m.points.slice(0, -1) })
          else setMode({ kind: "idle" })
          return
        }
      }
      if (!viewer && key === ZONE_TOOL_KEY.toLowerCase() && !e.altKey) uiApi().setPcbTool(tool === "zone" ? "select" : "zone")
      else if (!viewer && key === KEEPOUT_TOOL_KEY.toLowerCase() && !e.altKey) uiApi().setPcbTool(tool === "keepout" ? "select" : "keepout")
      else if (!viewer && key === "o" && !e.altKey) uiApi().setPcbTool(tool === "slot" ? "select" : "slot")
      else if (!viewer && key === DIMENSION_TOOL_KEY.toLowerCase() && !e.altKey) uiApi().setPcbTool(tool === "dimension" ? "select" : "dimension")
      else if (!viewer && key === TEXT_TOOL_KEY.toLowerCase() && !e.altKey) uiApi().setPcbTool(tool === "text" ? "select" : "text")
      else if (!viewer && drawKey) uiApi().setPcbTool(tool === drawKey ? "select" : drawKey)
      else if (key === "x" && !viewer) uiApi().setPcbTool("route")
      else if (key === "v") uiApi().setPcbTool(tool === "select" && !viewer ? "via" : "select")
      else if (key === "s") uiApi().setPcbTool("select")
      else if (key === "l") uiApi().setActiveLayer(nextCopperLayer(projectApi().project!, activeLayerNow(), e.shiftKey ? -1 : 1))
      else if (key === "f" && !e.shiftKey) {
        const { free: comps, locked } = splitLocked(projectApi().project!, selectionIds(sel, "c"))
        if (locked.length) setNote(lockedNote(locked))
        if (comps.length) {
          projectApi().commit((p) =>
            comps.reduce((acc, id) => {
              const c = acc.components.find((x) => x.id === id)
              return c ? updateComponent(acc, id, { pcb: { side: c.pcb.side === "top" ? "bottom" : "top" } }) : acc
            }, p),
          )
        } else if (!locked.length) vpRef.current?.fit(boardBox(projectApi().project!))
      } else if (key === "r" && touchesGroup(projectApi().project!, sel)) {
        // A selection with a group in it turns as one body about the middle of its box.
        const turned = rotateObjects(projectApi().project!, sel)
        if (turned) {
          projectApi().commit(() => turned.project)
          if (turned.notes.length) setNote(turned.notes.join(". "))
        }
      } else if (key === "r" && textIds(sel).length && !selectionIds(sel, "c").length) {
        // Selected texts turn a quarter turn counter-clockwise about their own anchor.
        const ids = textIds(sel)
        projectApi().commit((p) => {
          const byId = new Map(worldTexts(p).map((t) => [t.id, t]))
          return ids.reduce((acc, id) => {
            const t = byId.get(id)
            const parsed = parseTextId(id)
            if (!t || !parsed || t.locked) return acc
            return parsed.kind === "board" ? updateBoardTexts(acc, [parsed.text], { rot: t.rot + 90 }) : updatePartText(acc, parsed.component, parsed.index, { rot: t.rot + 90 })
          }, p)
        })
      } else if (key === "r") {
        const { free: comps, locked } = splitLocked(projectApi().project!, selectionIds(sel, "c"))
        if (locked.length) setNote(lockedNote(locked))
        if (!comps.length) return
        projectApi().commit((p) =>
          comps.reduce((acc, id) => {
            const c = acc.components.find((x) => x.id === id)
            return c ? updateComponent(acc, id, { pcb: { rot: normalizeAngle(c.pcb.rot + 90) } }) : acc
          }, p),
        )
      } else if (key === "delete" || key === "backspace") {
        // What a locked group (or its own lock) holds stays, as KiCad keeps it.
        const current = projectApi().project
        const held = new Set(current ? lockedInSelection(current, sel) : [])
        const free = (prefix: string, ids: string[]) => ids.filter((id) => !held.has(`${prefix}:${id}`))
        const traces = free("t", selectionIds(sel, "t"))
        const vias = free("v", selectionIds(sel, "v"))
        const drawings = free("g", graphicIds(sel))
        const texts = textIds(sel).filter((id) => {
          const q = parseTextId(id)
          return q?.kind !== "board" || !held.has(`x:${q.text}`)
        })
        const dims = free("m", selectionIds(sel, "m"))
        const images = free("i", selectionIds(sel, "i"))
        const outlinePieces = sel.map(parseOutlineSelectionId).filter((x): x is { path: number; seg: number } => x !== null)
        if (held.size) setNote(`${held.size} locked ${held.size === 1 ? "object stays" : "objects stay"}; unlock ${held.size === 1 ? "it" : "them"} (or the group) to delete ${held.size === 1 ? "it" : "them"}`)
        const zoneIds = selectedZoneIds(sel)
        if (!traces.length && !vias.length && !drawings.length && !texts.length && !dims.length && !images.length && !outlinePieces.length && !zoneIds.length) return
        e.preventDefault()
        projectApi().commit((p0) => {
          const p = zoneIds.length ? removeZones(p0, zoneIds.filter((id) => !p0.zones.find((z) => z.id === id)?.locked)) : p0
          // Shapes of the outline go last index first, so the others keep their numbers.
          const shapesOut = [...new Set(outlinePieces.map((x) => x.path))].sort((a, b) => b - a).reduce((acc, idx) => removeOutlinePath(acc, idx), p)
          const rest = traces.length || vias.length ? removeItems(shapesOut, { traces, vias }) : shapesOut
          let out = drawings.length ? removeGraphics(rest, drawings) : rest
          if (dims.length) out = removeDimensions(out, dims)
          if (images.length) out = removeImages(out, images)
          const parsed = texts.map(parseTextId)
          const board = parsed.flatMap((q) => (q?.kind === "board" ? [q.text] : []))
          if (board.length) out = removeBoardTexts(out, board)
          // A part's own text goes, last index first; its reference and value stay (hide them in the Inspector).
          for (const q of parsed.filter((x): x is Extract<typeof x, { kind: "part" }> => x?.kind === "part").sort((a, b) => b.index - a.index)) out = removePartText(out, q.component, q.index)
          return out
        })
        uiApi().clearSelection()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [commitRoute, commitDraw, commitZone, placeViaAndSwitch, tool])

  // Group and ungroup, as KiCad has them (Ctrl or Cmd G, with Shift to take a group apart).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "g") return
      e.preventDefault()
      if (e.shiftKey) ungroupSelected()
      else groupSelected()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // ---------- render ----------
  const bb = boardBox(project)
  const outlinePaths = project.board.outline?.paths
  const selectedOutline = selection.map(parseOutlineSelectionId).find((x) => x !== null) ?? null
  const selectedArcs = selectionIds(selection, "t").length === 1 ? project.traces.filter((t) => selected.has(`t:${t.id}`) && isArcTrace(t)) : []
  const r = Math.min(project.board.cornerRadius, project.board.width / 2, project.board.height / 2)
  const cursorCss = tool === "route" || mode.kind === "route" || isDrawTool(tool) || tool === "text" || tool === "dimension" || tool === "zone" || tool === "keepout" ? "crosshair" : tool === "via" ? "cell" : hover?.type === "boardHandle" ? "nwse-resize" : "default"
  const placed = resolvedComponents(project).filter((c) => c.pcb.placed && onBoard(c))
  // Every copper layer is opaque; the active one is in front, so gaps in its pour show the others, which lie in stack order (the back first) behind it.
  const stack = copperLayers(project.board)
  const copperOn = (l: CopperLayer) => copperShown({ layers, hiddenCopper }, l)
  const layerOrder: CopperLayer[] = layer === "top" && stack.length === 2 ? ["bottom", "top"] : [...[...stack].reverse().filter((l) => l !== layer), layer]
  const front = copperOn(layer) ? layer : [...layerOrder].reverse().find((l) => copperOn(l)) ?? layer
  // An explicit highlight (from the net list) dims everything else; hover only outlines.
  const dimOthers = !!highlightNet
  const selectedComps = selectionIds(selection, "c")
  const barComponent = selectedComps.length === 1 && mode.kind === "idle" ? project.components.find((c) => c.id === selectedComps[0]) : undefined

  const routeWidth = (mode.kind === "route" ? mode.width : undefined) ?? netTraceWidth(project.rules, mode.kind === "route" ? netName(mode.netId) : null)
  // Drawings on screen, by what they are drawn as: copper in its layer's group, silkscreen with the part silk, the rest muted.
  const vis: ShapeVisibility = { hidden: hiddenShapeLayers, layers }
  const shown = visibleShapes(worldShapes(project), vis)
  // X29: the fills of the zones on mask, paste, silkscreen and user layers.
  const otherFills = nonCopperFills(project)
  const otherShown = (name: string) => !hiddenShapeLayers[name] && (shapeLayerInfo(name)?.kind !== "silk" || layers.silk)
  const hlName = highlightNet ? netName(highlightNet) : null
  const shapeDim = (net: string | undefined) => (dimOthers && net !== hlName ? 0.3 : 1)
  const sideOpacity = (layerName: string) => {
    const side = shapeLayerInfo(layerName)?.side
    return side && side !== front ? 0.55 : 1
  }
  const shapeKindOf = (layerName: string) => shapeLayerInfo(layerName)?.kind ?? "user"
  const drawPreview = mode.kind === "draw" && cursor ? previewShape(mode.tool, mode.points, cursor, drawStyle()) : null
  const dimensionPreview = tool === "dimension" && cursor ? buildDimension(dimensionKind, drawLayer, mode.kind === "dim" ? mode.points : [], cursor) : null
  // The groups a selection is in, each framed (the box of what is in it).
  const selectedGroupFrames = (() => {
    if (!project.groups?.length || !selection.length) return []
    const frames = new Map<string, { id: string; box: NonNullable<ReturnType<typeof selectionBounds>> }>()
    for (const s of selection) {
      const m = s.slice(2)
      const top = topGroup(project, m)
      if (!top || frames.has(top.id)) continue
      const box = selectionBounds(project, groupSelection(project, top))
      if (box) frames.set(top.id, { id: top.id, box })
    }
    return [...frames.values()]
  })()
  // Texts on screen, by what their layer is for; none on a board that has none.
  const shownTexts = visibleTexts(project, vis)
  const markers = pcb.violations.filter((v) => v.severity === "error")

  return (
    <div className="absolute inset-0">
      <Viewport
        ref={vpRef}
        initialScale={14}
        minScale={1.5}
        maxScale={400}
        grid={1}
        gridColor={PCB.grid}
        majorGrid={{ every: 10, color: PCB.gridMajor }}
        background={PCB.outside}
        fitBox={fitBox}
        cursor={cursorCss}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onLeave={() => {
          setHover(null)
          uiApi().setCursor(null)
        }}
        onWorldPointer={reportPcbPointer}
        onVisible={reportPcbViewport}
        onUserMove={stopFollowing}
        overlay={(t) => (
          <>
            {mode.kind === "marquee" && (
              <div
                className="pointer-events-none absolute border border-white/80 bg-white/10"
                style={{
                  left: Math.min(mode.start.x, mode.current.x) * t.scale + t.tx,
                  top: -Math.max(mode.start.y, mode.current.y) * t.scale + t.ty,
                  width: Math.abs(mode.current.x - mode.start.x) * t.scale,
                  height: Math.abs(mode.current.y - mode.start.y) * t.scale,
                }}
              />
            )}
            {barComponent && <SelectionBar c={barComponent} t={t} />}
            <PeerCursors view="pcb" project={project} t={t} />
            {selectedOutline && outlinePaths?.[selectedOutline.path]?.segs[selectedOutline.seg] && mode.kind === "idle" && tool === "select" && (
              <OutlineBar path={outlinePaths[selectedOutline.path]} index={selectedOutline.path} seg={selectedOutline.seg} t={t} />
            )}
          </>
        )}
      >
        {(t) => {
          const px = 1 / t.scale
          const view = visibleBox(t, vpRef.current?.element())
          const netOf = (it: CopperItem) => (it.kind === "pad" ? it.netId : null)
          const dim = (net: string | null | undefined) => (dimOthers && net !== highlightNet ? 0.3 : 1)
          return (
            <>
              {layers.board && outlinePaths?.length ? (
                <OutlineDraw paths={outlinePaths} selected={selectedOutline} px={px} />
              ) : layers.board ? (
                <rect x={bb.minX} y={bb.minY} width={bb.maxX - bb.minX} height={bb.maxY - bb.minY} rx={r} fill={PCB.board} stroke={PCB.edge} strokeWidth={Math.max(0.15, 2 * px)} />
              ) : null}

              {/* Reference images, under everything else, as KiCad draws a bitmap */}
              {(project.images ?? []).filter((m) => imageShown(m, vis)).map((m) => (
                <ReferenceImageDraw key={m.id} image={m} px={px} selected={selected.has(`i:${m.id}`)} />
              ))}

              {layerOrder.map((l) =>
                copperOn(l) ? (
                  <g key={l}>
                    {pours
                      .filter((f) => f.layer === l)
                      .map((f) => (
                        <path
                          key={f.zoneId}
                          d={f.d}
                          fill={pourColor(l)}
                          fillRule="evenodd"
                          opacity={dim(f.netId)}
                        />
                      ))}
                    {project.traces
                      .filter((tr) => tr.layer === l)
                      .map((tr) => {
                        const net = pcb.traceNet.get(tr.id) ?? null
                        const isSel = selected.has(`t:${tr.id}`)
                        const hi = !!activeNet && net === activeNet
                        const d = traceD(tr)
                        return (
                          <g key={tr.id} opacity={dim(net)}>
                            {(hi || isSel) && <path d={d} fill="none" stroke={PCB.select} strokeWidth={tr.width + 3 * px} strokeLinecap="round" strokeLinejoin="round" opacity={isSel ? 0.95 : 0.6} />}
                            <path d={d} fill="none" stroke={copperColor(l)} strokeWidth={tr.width} strokeLinecap="round" strokeLinejoin="round" />
                          </g>
                        )
                      })}
                    {shown
                      .filter((s) => shapeKindOf(s.shape.layer) === "copper" && layerOfKicadName(s.shape.layer) === l)
                      .map((s) => (
                        <g key={s.id} opacity={shapeDim(s.shape.net)}>
                          <ShapeDraw shape={s.shape} color={copperColor(l)} px={px} selected={selected.has(s.select ?? s.id)} />
                        </g>
                      ))}
                    {shownTexts
                      .filter((tx) => textLayerKind(tx.layer) === "copper" && layerOfKicadName(tx.layer) === l)
                      .map((tx) => (
                        <TextDraw key={tx.id} t={tx} project={project} px={px} selected={selected.has(tx.id)} />
                      ))}
                    {pcb.items.map((it) =>
                      it.kind === "pad" && it.layers.length === 1 && it.layers[0] === l ? (
                        <g key={it.id} opacity={dim(netOf(it))}>
                          <PadShape pad={it.pad} color={l === front ? PCB.pad : PCB.padBack} highlight={!!activeNet && it.netId === activeNet} px={px} />
                        </g>
                      ) : null,
                    )}
                  </g>
                ) : null,
              )}

              {/* Through-hole pads, mounting holes and vias span the layers they have copper on (every one for a through-hole pad and a through via) */}
              {stack.some((l) => copperOn(l)) && (
                <>
                  {pcb.items.map((it) =>
                    it.kind === "pad" && it.layers.length >= 2 && it.layers.some((l) => copperOn(l)) ? (
                      <g key={it.id} opacity={dim(netOf(it))}>
                        <PadShape pad={it.pad} color={PCB.pad} highlight={!!activeNet && it.netId === activeNet} px={px} />
                      </g>
                    ) : null,
                  )}
                  {project.vias.map((v) => {
                    const net = pcb.viaNet.get(v.id) ?? null
                    const isSel = selected.has(`v:${v.id}`)
                    const span = viaLayers(project.board, v)
                    if (!span.some((l) => copperOn(l))) return null
                    // A via that does not run the whole stack (X5) is drawn in the colour of the layer it starts on, with a dashed ring: blind and buried, and a micro via a ring of its own.
                    const partial = v.kind !== undefined
                    return (
                      <g key={v.id} opacity={dim(net)}>
                        <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={isSel ? PCB.select : partial ? copperColor(span.find((l) => copperOn(l)) ?? span[0]) : PCB.via} stroke={activeNet && net === activeNet ? "#fff" : partial ? PCB.hole : "none"} strokeWidth={1.4 * px} strokeDasharray={partial ? `${3 * px} ${2 * px}` : undefined} />
                        <circle cx={v.x} cy={v.y} r={v.drill / 2} fill={PCB.hole} />
                        {v.kind === "micro" && <circle cx={v.x} cy={v.y} r={v.diameter / 2 - 1.2 * px} fill="none" stroke={PCB.hole} strokeWidth={1 * px} />}
                      </g>
                    )
                  })}
                </>
              )}

              {/* Drawings on mask, paste, fabrication, courtyard, adhesive and user layers: thin and muted, under the silkscreen */}
              {shown
                .filter((s) => {
                  const k = shapeKindOf(s.shape.layer)
                  return k !== "copper" && k !== "silk"
                })
                .map((s) => (
                  <g key={s.id} opacity={shapeDim(s.shape.net) * sideOpacity(s.shape.layer) * 0.85}>
                    <ShapeDraw shape={s.shape} color={shapeLayerColor(s.shape.layer)} px={px} selected={selected.has(s.select ?? s.id)} />
                  </g>
                ))}

              <OtherZoneFills fills={otherFills} silk={false} shown={otherShown} opacityOf={(name) => sideOpacity(name) * 0.85} />

              {/* Text on mask, paste, fabrication, courtyard, adhesive, user and edge layers: muted, under the silkscreen */}
              {shownTexts
                .filter((tx) => {
                  const k = textLayerKind(tx.layer)
                  return k !== "copper" && k !== "silk"
                })
                .map((tx) => (
                  <TextDraw key={tx.id} t={tx} project={project} px={px} selected={selected.has(tx.id)} opacity={(textSide(tx.layer) && textSide(tx.layer) !== front ? 0.55 : 1) * 0.85} />
                ))}

              {/* PCB points (X23): the board's and those of the parts on it, on the layers they name */}
              {worldPoints(project, placed).map((pt, i) => (
                <g key={`pt${i}`} opacity={sideOpacity(pt.layer) * 0.85}>
                  <PointMark x={pt.x} y={pt.y} size={pt.size} color={shapeLayerColor(pt.layer)} px={px} />
                </g>
              ))}

              {/* Silkscreen: part outlines, designators and free text */}
              {layers.silk && (
                <>
                  {shownTexts
                    .filter((tx) => textLayerKind(tx.layer) === "silk")
                    .map((tx) => (
                      <TextDraw key={tx.id} t={tx} project={project} px={px} selected={selected.has(tx.id)} opacity={textSide(tx.layer) !== front ? 0.55 : 1} />
                    ))}
                  <OtherZoneFills fills={otherFills} silk shown={otherShown} opacityOf={sideOpacity} />
                  {shown
                    .filter((s) => shapeKindOf(s.shape.layer) === "silk")
                    .map((s) => (
                      <g key={s.id} opacity={sideOpacity(s.shape.layer)}>
                        <ShapeDraw shape={s.shape} color={shapeLayerColor(s.shape.layer)} px={px} selected={selected.has(s.select ?? s.id)} />
                      </g>
                    ))}
                  {placed.map((c) => (
                    <g key={`s${c.id}`} opacity={c.pcb.side === front ? 1 : 0.55}>
                      {pcbSilk(c).map((path, i) => (
                        <polyline
                          key={i}
                          points={path.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill="none"
                          stroke={c.pcb.side === "top" ? PCB.silk : PCB.silkBottom}
                          strokeWidth={SILK_WIDTH}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                      {designators.get(c.id) && <DesignatorText d={designators.get(c.id)!} />}
                    </g>
                  ))}
                  {ownTexts(project).map((tx) => (
                    <g key={tx.id} opacity={tx.side === front ? 1 : 0.55}>
                      {boardTextStrokes(tx).map((path, i) => (
                        <polyline
                          key={i}
                          points={path.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill="none"
                          stroke={tx.side === "top" ? PCB.silk : PCB.silkBottom}
                          strokeWidth={boardTextStrokeWidth(tx)}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                    </g>
                  ))}
                </>
              )}

              {/* Pin names on pads and net names along traces once there is room to read them */}
              {layers.labels && (layers.top || layers.bottom) && (
                <>
                  <TraceLabels project={project} items={pcb.items} traceNet={pcb.traceNet} netName={netName} scale={t.scale} front={front} view={view} />
                  <PadLabels items={pcb.items} pinNames={pinNames} scale={t.scale} front={front} view={view} />
                </>
              )}

              {/* Courtyards / selection */}
              {placed.map((c) => {
                const cy = pcbCourtyard(c)
                if (!cy) return null
                const isSel = selected.has(`c:${c.id}`)
                const isHover = hover?.type === "component" && hover.id === c.id
                // A part marked do not populate keeps a dashed courtyard, so it reads as fitted on the board but not on the build.
                const dnp = !!c.flags?.dnp
                if (!isSel && !isHover && !layers.courtyard && !dnp) return null
                return (
                  <rect
                    key={`cy${c.id}`}
                    x={cy.minX}
                    y={cy.minY}
                    width={cy.maxX - cy.minX}
                    height={cy.maxY - cy.minY}
                    fill={isSel ? PCB.selectSoft : "none"}
                    stroke={isSel || isHover ? PCB.select : PCB.courtyard}
                    strokeOpacity={isSel ? 1 : isHover ? 0.7 : 1}
                    strokeWidth={(isSel ? 1.6 : 1.2) * px}
                    strokeDasharray={dnp ? `${5 * px} ${3 * px}` : undefined}
                  />
                )
              })}

              {/* Ratsnest */}
              {layers.ratsnest &&
                pcb.ratsnest.map((rl, i) => (
                  <line
                    key={`r${i}`}
                    x1={rl.a.x}
                    y1={rl.a.y}
                    x2={rl.b.x}
                    y2={rl.b.y}
                    stroke={activeNet === rl.netId ? "#ffffff" : PCB.ratsnest}
                    strokeWidth={(activeNet === rl.netId ? 1.6 : 1) * px}
                    strokeDasharray={`${5 * px} ${3 * px}`}
                  />
                ))}

              {/* DRC markers */}
              {markers.map((v) => (
                <g key={v.id}>
                  <circle cx={v.at.x} cy={v.at.y} r={Math.max(0.35, 7 * px)} fill="none" stroke={PCB.danger} strokeWidth={1.6 * px} />
                  <circle cx={v.at.x} cy={v.at.y} r={Math.max(0.08, 1.6 * px)} fill={PCB.danger} />
                </g>
              ))}

              {/* The outlines of the zones, and the corners of the selected ones */}
              {tool !== "route" && <ZoneOutlines project={project} selected={selected} px={px} active={layer} />}
              {(tool === "zone" || tool === "keepout") && (
                <ZonePreview
                  points={mode.kind === "zone" ? mode.points : []}
                  cursor={cursor}
                  keepout={tool === "keepout"}
                  px={px}
                  closes={mode.kind === "zone" && !!cursor && closesPolygon(mode.points, cursor, 1.3 * tol())}
                />
              )}
              {/* The corners and arc middles of the selected piece of the outline */}
              {tool === "select" && selectedOutline && outlinePaths?.[selectedOutline.path] && (
                <OutlineHandles path={outlinePaths[selectedOutline.path]} px={px} />
              )}
              {/* The three points of a selected arc track: where it starts, a point on it and where it ends */}
              {tool === "select" &&
                selectedArcs.map((tr) => (
                  <g key={`arc${tr.id}`}>
                    <polyline points={tr.points.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={PCB.select} strokeOpacity={0.35} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />
                    {tr.points.map((q, i) => (
                      <rect key={i} x={q.x - 3.5 * px} y={q.y - 3.5 * px} width={7 * px} height={7 * px} fill={i === 1 ? PCB.edge : PCB.select} stroke={PCB.outside} strokeWidth={px} />
                    ))}
                  </g>
                ))}
              {/* The slot being cut */}
              {tool === "slot" && cursor && mode.kind === "slot" && (
                <path d={pathsSvgPath([slotPath(mode.a, cursor, uiSlotWidth)])} fill={PCB.select} fillOpacity={0.25} stroke={PCB.select} strokeWidth={px} />
              )}
              {tool === "slot" && cursor && <circle cx={cursor.x} cy={cursor.y} r={4 * px} fill="none" stroke="#fff" strokeWidth={px} />}

              {/* Board resize handle: a board with an outline of its own is reshaped by its corners instead */}
              {tool === "select" && !outlinePaths?.length && (
                <rect
                  x={bb.maxX - 4 * px}
                  y={bb.minY - 4 * px}
                  width={8 * px}
                  height={8 * px}
                  fill={hover?.type === "boardHandle" || mode.kind === "resize" ? PCB.select : PCB.edge}
                  stroke={PCB.outside}
                  strokeWidth={px}
                />
              )}

              {/* Route preview */}
              {mode.kind === "route" && cursor && (
                <>
                  {mode.arc ? (
                    <>
                      {mode.points.length > 1 && <polyline points={mode.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={copperColor(mode.layer)} strokeOpacity={0.85} strokeWidth={routeWidth} strokeLinecap="round" strokeLinejoin="round" />}
                      <path
                        d={traceD(mode.arc.mid ? { arc: true, points: [mode.points[mode.points.length - 1], mode.arc.mid, cursor] } : { points: [mode.points[mode.points.length - 1], cursor] })}
                        fill="none"
                        stroke={copperColor(mode.layer)}
                        strokeOpacity={0.85}
                        strokeWidth={routeWidth}
                        strokeLinecap="round"
                        strokeDasharray={mode.arc.mid ? undefined : `${4 * px} ${3 * px}`}
                      />
                      {mode.arc.mid && <circle cx={mode.arc.mid.x} cy={mode.arc.mid.y} r={2.5 * px} fill="#fff" />}
                    </>
                  ) : (
                    <polyline
                      points={[...mode.points, ...routePreview(mode, cursor).slice(1)].map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke={copperColor(mode.layer)}
                      strokeOpacity={0.85}
                      strokeWidth={routeWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                  <circle cx={cursor.x} cy={cursor.y} r={routeWidth / 2 + 1.5 * px} fill="none" stroke="#fff" strokeWidth={px} />
                </>
              )}
              {/* Drawing preview: the shape so far to the cursor, the clicks made, and the point that would be placed */}
              {isDrawTool(tool) && cursor && (
                <>
                  {drawPreview && <ShapeDraw shape={drawPreview} color={shapeLayerColor(drawLayer)} px={px} opacity={0.85} />}
                  {mode.kind === "draw" && mode.points.map((pt, i) => <circle key={i} cx={pt.x} cy={pt.y} r={2.5 * px} fill="#fff" />)}
                  <circle cx={cursor.x} cy={cursor.y} r={4 * px} fill="none" stroke="#fff" strokeWidth={px} />
                </>
              )}
              {tool === "via" && cursor && mode.kind === "idle" && (
                <circle cx={cursor.x} cy={cursor.y} r={project.rules.viaDiameter / 2} fill={PCB.via} opacity={0.6} />
              )}

              <PeerSelections view="pcb" project={project} px={px} />
              {/* A dimension on its way: what the clicks so far make, and the point that would be placed */}
              {tool === "dimension" && cursor && (
                <>
                  {dimensionPreview && (
                    <>
                      {dimensionShapes({ ...dimensionPreview, id: "preview" }).map((shape, i) => (
                        <ShapeDraw key={i} shape={shape} color={shapeLayerColor(drawLayer)} px={px} opacity={0.85} />
                      ))}
                      {(() => {
                        const wt = dimensionWorldText({ ...dimensionPreview, id: "preview" })
                        return wt ? <TextDraw t={wt} project={project} px={px} opacity={0.85} /> : null
                      })()}
                    </>
                  )}
                  {mode.kind === "dim" && mode.points.map((pt, i) => <circle key={i} cx={pt.x} cy={pt.y} r={2.5 * px} fill="#fff" />)}
                  <circle cx={cursor.x} cy={cursor.y} r={4 * px} fill="none" stroke="#fff" strokeWidth={px} />
                </>
              )}
              {/* A group that is selected, framed */}
              {selectedGroupFrames.map((f) => (
                <rect key={f.id} x={f.box.minX - 1} y={f.box.minY - 1} width={f.box.maxX - f.box.minX + 2} height={f.box.maxY - f.box.minY + 2} fill="none" stroke={PCB.select} strokeOpacity={0.7} strokeWidth={1.2 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
              ))}
            </>
          )
        }}
      </Viewport>
      {pcb.zonesPending && (
        <div role="status" className="pointer-events-none absolute left-3 top-3 rounded-[6px] bg-[#1f1d25]/90 px-2 py-1 text-[11px] text-white/80">
          Refilling copper pours. What is drawn and checked is the last fill until it is done.
        </div>
      )}
      {mode.kind === "route" ? (
        <CanvasHint
          dark
          items={[
            ["Click", mode.arc ? (mode.arc.mid ? "the end of the arc" : "a point on the arc") : "add a corner"],
            ["V", `via to ${layerLabel(project.board, uiApi().viaTo && uiApi().viaTo !== mode.layer ? uiApi().viaTo! : nextCopperLayer(project, mode.layer, mode.layer === "bottom" ? -1 : 1)).toLowerCase()}`],
            ["A", mode.arc ? "straight track" : "arc track"],
            ["W", `width ${formatLength(routeWidth, unit, true)}`],
            ["/", "flip bend"],
            ["Esc", "finish"],
          ]}
        />
      ) : tool === "route" ? (
        <CanvasHint dark items={[["Click", "a pad to start routing"], ["L", "next layer (Shift: previous)"]]} />
      ) : note ? (
        <CanvasHint dark items={[[isDrawTool(tool) ? "Not drawn" : "Locked", note]]} />
      ) : info ? (
        <CanvasHint dark items={[["Outline", info]]} />
      ) : tool === "slot" ? (
        <CanvasHint dark items={[["Click", mode.kind === "slot" ? "the other end of the slot" : "one end of the slot"], ["Esc", "cancel"]]} />
      ) : tool === "zone" || tool === "keepout" ? (
        <CanvasHint
          dark
          items={
            mode.kind === "zone" && mode.points.length
              ? [["Click", "add a corner"], ["Enter", "finish"], ["Backspace", "undo a corner"], ["Esc", "cancel"], ["Alt", "off the grid"]]
              : [["Click", `the first corner of the ${tool === "keepout" ? "keepout" : "zone"} on the ${layer} layer`], ["Alt", "off the grid"]]
          }
        />
      ) : isDrawTool(tool) ? (
        <CanvasHint dark items={drawHint(tool, mode.kind === "draw" ? mode.points.length : 0)} />
      ) : tool === "dimension" ? (
        <CanvasHint dark items={dimensionHint(dimensionKind, mode.kind === "dim" ? mode.points.length : 0)} />
      ) : hover && (hover.type === "pad" || hover.type === "trace") && (netName(activeNet) || hover.type === "pad") ? (
        <div className="mono pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[6px] bg-[#26232e] px-2.5 py-1 text-[12px] text-silk">
          {hover.type === "pad" ? padHoverText(project, hover.pad, pinNames, netName(hover.netId)) : netName(activeNet)}
        </div>
      ) : null}
    </div>
  )
}

/** The hint line of a drawing tool, by how many clicks it has so far. */
function drawHint(tool: DrawTool, clicks: number): [string, string][] {
  const free: [string, string] = ["Alt", "off the grid"]
  if (tool === "polygon") return clicks ? [["Click", "add a corner"], ["Enter", "finish"], ["Backspace", "undo a corner"], ["Esc", "cancel"], free] : [["Click", "the first corner"], free]
  const next: Record<Exclude<DrawTool, "polygon">, string[]> = {
    line: ["the start", "the end"],
    arc: ["the start", "a point on the arc", "the end"],
    circle: ["the centre", "a point on the circle"],
    rect: ["a corner", "the opposite corner"],
  }
  return clicks ? [["Click", next[tool][clicks]], ["Esc", "cancel"], free] : [["Click", next[tool][0]], free]
}

const netNameOf = (p: Project, netId: string | null) => (netId ? (getConnectivity(p).nets.find((n) => n.id === netId)?.name ?? null) : null)

/** World-space box currently on screen, for culling labels. */
function visibleBox(t: ViewTransform, el: HTMLElement | null | undefined): Box | null {
  if (!el) return null
  const a = toWorld(t, { x: 0, y: 0 })
  const b = toWorld(t, { x: el.clientWidth, y: el.clientHeight })
  return normBox(a, b)
}

const inView = (view: Box | null, p: Vec2, margin: number) =>
  !view || (p.x >= view.minX - margin && p.x <= view.maxX + margin && p.y >= view.minY - margin && p.y <= view.maxY + margin)

/** Fill paths for every pour, built once per analysis. */
function usePourPaths(fills: ZoneFill[]) {
  return useMemo(
    () =>
      fills.map((f) => ({
        zoneId: f.zoneId,
        layer: f.layer,
        netId: f.netId,
        d: f.polygons
          .flatMap((poly) => poly.map((ring) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`))
          .join(""),
      })),
    [fills],
  )
}

/** Pin names per component, keyed `${componentId}:${pin}`. */
function usePinNames(components: ComponentInstance[]) {
  return useMemo(() => {
    const out = new Map<string, string>()
    for (const c of components) {
      for (const pin of findPart(c.partId)?.pins ?? []) out.set(`${c.id}:${pin.number}`, pin.name)
    }
    return out
  }, [components])
}

type PinNames = Map<string, string>

function padHoverText(project: Project, pad: WorldPad, pinNames: PinNames, net: string | null) {
  const ref = project.components.find((c) => c.id === pad.componentId)?.ref ?? ""
  const name = pad.pin ? pinNames.get(`${pad.componentId}:${pad.pin}`) : undefined
  const pin = name && name !== pad.padNumber ? `${pad.padNumber} ${name}` : (pad.padNumber ?? "")
  return `${ref}.${pin}${net ? `  ${net}` : ""}`
}

function PadShape({ pad, color, highlight, px }: { pad: WorldPad; color: string; highlight: boolean; px: number }) {
  const stroke = highlight ? "#ffffff" : "none"
  const sw = highlight ? 1.6 * px : 0
  let shape
  if (pad.shape === "circle") shape = <circle cx={pad.x} cy={pad.y} r={pad.width / 2} fill={color} stroke={stroke} strokeWidth={sw} />
  else if (pad.rings && pad.rings.length > 1)
    // A custom pad with a hole in it or in pieces: every ring, even-odd.
    shape = <path d={pad.rings.map((ring) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`).join("")} fillRule="evenodd" fill={color} stroke={stroke} strokeWidth={sw} />
  else if (pad.shape === "polygon" && pad.points)
    shape = <polygon points={pad.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={color} stroke={stroke} strokeWidth={sw} />
  else {
    // A pad that has its own shape is drawn as it is; the plain one keeps the slight rounding it has always been drawn with.
    const rr = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : pad.x7 ? (pad.corner ?? 0) : Math.min(pad.width, pad.height) * 0.12
    shape = <rect x={pad.x - pad.width / 2} y={pad.y - pad.height / 2} width={pad.width} height={pad.height} rx={rr} fill={color} stroke={stroke} strokeWidth={sw} />
  }
  return (
    <g>
      {shape}
      {pad.holeDiameter && <HoleShape pad={pad} d={pad.holeDiameter} px={px} />}
    </g>
  )
}

/** A pad's drill: a circle, or a rounded slot. */
function HoleShape({ pad, d, px }: { pad: WorldPad; d: number; px: number }) {
  const strokeWidth = Math.min(d * 0.12, Math.max(0.05, 1.2 * px))
  const ends = slotEnds(pad)
  const at = holeCentre(pad)
  if (!ends) return <circle cx={at.x} cy={at.y} r={d / 2} fill={PCB.hole} stroke={PCB.plating} strokeWidth={strokeWidth} />
  const [a, b] = ends
  // Two round-capped strokes: the plating ring, then the drill inside it, as the circle draws them.
  return (
    <g strokeLinecap="round">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PCB.plating} strokeWidth={d + strokeWidth} />
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PCB.hole} strokeWidth={d - strokeWidth} />
    </g>
  )
}

const CHAR_W = 0.62

/** Pad label: the pin name when it says more than the number, otherwise the pad number. */
function padLabel(pad: WorldPad, pinNames: PinNames) {
  const raw = pad.pin ? pinNames.get(`${pad.componentId}:${pad.pin}`) : undefined
  const name = raw?.split("/")[0].trim()
  if (name && name !== pad.padNumber && !/^[~\d]*$/.test(name)) return name
  return pad.padNumber ?? ""
}

/** Text readable on any copper: light fill with a dark halo painted underneath. */
function HaloText({ x, y, size, angle, text, weight = 650 }: { x: number; y: number; size: number; angle: number; text: string; weight?: number }) {
  return (
    <text
      transform={`translate(${x},${y}) scale(1,-1)${angle ? ` rotate(${-angle})` : ""}`}
      fontSize={size}
      textAnchor="middle"
      dominantBaseline="central"
      fill={PCB.label}
      stroke={PCB.labelHalo}
      strokeWidth={size * 0.24}
      strokeLinejoin="round"
      paintOrder="stroke"
      fontWeight={weight}
      style={{ fontVariationSettings: '"MONO" 1', pointerEvents: "none" }}
    >
      {text}
    </text>
  )
}

function PadLabels({ items, pinNames, scale, front, view }: { items: CopperItem[]; pinNames: PinNames; scale: number; front: CopperLayer; view: Box | null }) {
  // Big pads are labelled even with the whole board in view, as long as the text is legible.
  if (scale < 3) return null
  const out: ReactNode[] = []
  for (const it of items) {
    if (it.kind !== "pad" || it.pad.componentId === BOARD_OWNER) continue
    const pad = it.pad
    if (pad.layers.length === 1 && pad.layers[0] !== front) continue
    if (!inView(view, pad, Math.max(pad.width, pad.height))) continue
    const text = padLabel(pad, pinNames)
    if (!text) continue
    const fit = (along: number, across: number) => Math.min(across * 0.6, (along * 0.92) / Math.max(1, text.length) / CHAR_W)
    // Through-hole labels sit across the drill, sized to the copper ring around it. Labels
    // on tall pads turn upright only when that makes them clearly bigger.
    const d = Math.min(pad.width, pad.height)
    const across = fit(pad.width, pad.height)
    const upright = fit(pad.height, pad.width)
    const vertical = !pad.holeDiameter && pad.height > pad.width * 1.15 && upright > across * 1.15
    const size = pad.holeDiameter ? Math.min(d * 0.42, (d * 0.96) / Math.max(1, text.length) / CHAR_W) : vertical ? upright : across
    if (size * scale < 5.5) continue
    out.push(<HaloText key={it.id} x={pad.x} y={pad.y} size={size} angle={vertical ? 90 : 0} text={text} />)
  }
  return <g>{out}</g>
}

function TraceLabels({
  project,
  items,
  traceNet,
  netName,
  scale,
  front,
  view,
}: {
  project: Project
  items: CopperItem[]
  traceNet: Map<string, string | null>
  netName: (id: string | null) => string | null
  scale: number
  front: CopperLayer
  view: Box | null
}) {
  if (scale < 9) return null
  const out: ReactNode[] = []
  // Labels never cover pads on the front layer, where the pin names are.
  const pads = items.flatMap((it) => (it.kind === "pad" && it.layers.includes(front) && (!view || boxesOverlap(it.box, view)) ? [it.pad] : []))
  const onPad = (from: Vec2, to: Vec2, gap: number) => pads.some((pad) => segmentPadDistance(from, to, pad) < gap)
  // Repeat the name along long runs, roughly every few hundred pixels.
  const spacing = 240 / scale
  for (const tr of project.traces) {
    if (tr.layer !== front) continue
    const name = netName(traceNet.get(tr.id) ?? null)
    if (!name || name.startsWith("Net-")) continue
    // Thin traces get text a little wider than the copper, as long as it stays legible.
    const size = Math.max(tr.width * 0.72, Math.min(9 / scale, tr.width * 1.6))
    if (size * scale < 6.5) continue
    const textLen = name.length * size * CHAR_W
    for (let i = 0; i < tr.points.length - 1; i++) {
      const a = tr.points[i]
      const b = tr.points[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < textLen + size * 2) continue
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      if (angle > 90) angle -= 180
      if (angle <= -90) angle += 180
      const count = Math.max(1, Math.floor(len / Math.max(spacing, textLen * 3)))
      for (let k = 0; k < count; k++) {
        const f = (k + 0.5) / count
        const at = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
        if (!inView(view, at, textLen)) continue
        const ux = ((b.x - a.x) / len) * (textLen / 2)
        const uy = ((b.y - a.y) / len) * (textLen / 2)
        if (onPad({ x: at.x - ux, y: at.y - uy }, { x: at.x + ux, y: at.y + uy }, size * 0.6)) continue
        out.push(<HaloText key={`${tr.id}:${i}:${k}`} x={at.x} y={at.y} size={size} angle={angle} text={name} weight={600} />)
      }
    }
  }
  return <g>{out}</g>
}

/** Designator in the same strokes, at the same spot, as the Gerber silkscreen. */
function DesignatorText({ d }: { d: Designator }) {
  return (
    <>
      {designatorStrokes(d).map((path, i) => (
        <polyline
          key={i}
          points={path.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={d.side === "top" ? PCB.silk : PCB.silkBottom}
          strokeWidth={SILK_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </>
  )
}

const fmtMm = (v: number) => v.toFixed(2)

/** Floating bar above a selected part: where it is, and quick rotate and flip. */
function SelectionBar({ c, t }: { c: ComponentInstance; t: ViewTransform }) {
  const cy = pcbCourtyard(c)
  if (!cy) return null
  const left = cy.minX * t.scale + t.tx
  const above = -cy.maxY * t.scale + t.ty - 38
  const top = above < 8 ? -cy.minY * t.scale + t.ty + 8 : above
  const locked = !!c.pcb.locked
  const rotate = () => projectApi().commit((p) => updateComponent(p, c.id, { pcb: { rot: normalizeAngle(c.pcb.rot + 90) } }))
  const flip = () => projectApi().commit((p) => updateComponent(p, c.id, { pcb: { side: c.pcb.side === "top" ? "bottom" : "top" } }))
  const btn = "flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-white/80 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-40"
  return (
    <div
      className="pointer-events-auto absolute flex items-center gap-1 rounded-[8px] border border-white/10 bg-[#1f1d25]/95 py-0.5 pl-2 pr-0.5 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      style={{ left: Math.max(8, left), top }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="mono font-semibold text-white">{c.ref}</span>
      <span className="mono px-1.5 text-white/60">
        {fmtMm(c.pcb.x)}, {fmtMm(c.pcb.y)} mm
      </span>
      {locked && (
        <span className="flex items-center gap-1 text-white/60" title="Locked: turn off Locked in the Inspector to move, rotate or flip this part">
          <Lock size={12} />
          Locked
        </span>
      )}
      <Tooltip label={locked ? "Locked" : "Rotate 90°"} shortcut={locked ? undefined : "R"}>
        <button type="button" className={btn} disabled={locked} onClick={rotate}>
          <RotateCw size={13} />
          <span className="mono">{Number(c.pcb.rot.toFixed(2))}°</span>
        </button>
      </Tooltip>
      <Tooltip label={locked ? "Locked" : "Flip to the other side"} shortcut={locked ? undefined : "F"}>
        <button type="button" className={btn} disabled={locked} onClick={flip}>
          <FlipHorizontal2 size={13} />
          {c.pcb.side === "top" ? "Top" : "Bottom"}
        </button>
      </Tooltip>
    </div>
  )
}


const OUTLINE_STROKE = (px: number) => Math.max(0.15, 2 * px)

/** The board drawn from its own outline: its loops filled with the cutouts left out, every piece stroked, and the selected one lit. */
function OutlineDraw({ paths, selected, px }: { paths: ShapePath[]; selected: { path: number; seg: number } | null; px: number }) {
  const closed = paths.filter((p) => p.closed)
  const open = paths.filter((p) => !p.closed)
  const lit = selected ? paths[selected.path] : undefined
  const w = OUTLINE_STROKE(px)
  return (
    <>
      {closed.length > 0 && <path d={pathsSvgPath(closed)} fill={PCB.board} fillRule="evenodd" stroke={PCB.edge} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />}
      {open.length > 0 && <path d={pathsSvgPath(open)} fill="none" stroke={PCB.danger} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={`${6 * px} ${3 * px}`} />}
      {lit && <path d={pathsSvgPath([lit])} fill="none" stroke={PCB.select} strokeWidth={w + 2 * px} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />}
      {lit && selected && lit.segs[selected.seg] && <path d={pathsSvgPath([{ closed: false, segs: [lit.segs[selected.seg]] }])} fill="none" stroke="#fff" strokeWidth={w + 4 * px} strokeLinejoin="round" strokeLinecap="round" opacity={0.55} />}
    </>
  )
}

/** Squares on the corners of a selected piece of the outline, a dot on the middle of each arc. */
function OutlineHandles({ path, px }: { path: ShapePath; px: number }) {
  return (
    <>
      {pathVertices(path).map((v, i) => (
        <rect key={`v${i}`} x={v.x - 4 * px} y={v.y - 4 * px} width={8 * px} height={8 * px} fill={PCB.select} stroke="#fff" strokeWidth={px} />
      ))}
      {path.segs.map((sg, i) => (sg.kind === "arc" ? <circle key={`m${i}`} cx={sg.mid.x} cy={sg.mid.y} r={4 * px} fill="#fff" stroke={PCB.select} strokeWidth={1.5 * px} /> : null))}
    </>
  )
}

/** Floating bar above the selected piece of the outline: bend it into an arc or straighten it, add a corner, delete the shape. */
function OutlineBar({ path, index, seg, t }: { path: ShapePath; index: number; seg: number; t: ViewTransform }) {
  const s = path.segs[seg]
  const a = segStart(s)
  const b = segEnd(s)
  const mid = s.kind === "arc" ? s.mid : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const left = mid.x * t.scale + t.tx
  const top = Math.max(8, -mid.y * t.scale + t.ty - 46)
  const btn = "flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-white/80 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-40"
  const run = (f: (p: Project) => Project | null) => projectApi().commit((p) => f(p) ?? p)
  const bendable = s.kind === "line" || s.kind === "arc"
  return (
    <div
      className="pointer-events-auto absolute flex items-center gap-1 rounded-[8px] border border-white/10 bg-[#1f1d25]/95 py-0.5 pl-2 pr-0.5 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      style={{ left: Math.max(8, left - 90), top }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="text-white/60">{path.closed ? "Outline" : "Open edge"}</span>
      <button type="button" className={btn} disabled={!bendable} title="Bend this edge into an arc, or make an arc straight" onClick={() => run((p) => toggleOutlineArc(p, index, seg))}>
        {s.kind === "arc" ? "Straight" : "Arc"}
      </button>
      <button type="button" className={btn} disabled={!bendable} title="Add a corner in the middle of this edge" onClick={() => run((p) => splitOutlineSeg(p, index, seg, mid))}>
        Add corner
      </button>
      <button type="button" className={btn} title="Delete this shape of the outline (Delete)" onClick={() => { run((p) => removeOutlinePath(p, index)); uiApi().clearSelection() }}>
        Delete
      </button>
    </div>
  )
}

/** A reference image: the picture centred where the project puts it, at its size on the board; an outline that says so when its file is not here. */
function ReferenceImageDraw({ image: m, px, selected }: { image: ReferenceImage; px: number; selected: boolean }) {
  const { w, h } = imageSize(m)
  const url = imageUrl(m)
  const state = imageState(m.file)
  return (
    <g transform={`translate(${m.x} ${m.y}) scale(1 -1)`} opacity={0.85}>
      {url ? <image href={url} x={-w / 2} y={-h / 2} width={w} height={h} preserveAspectRatio="none" /> : <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="none" stroke={PCB.shapeUser} strokeDasharray={`${6 * px} ${4 * px}`} strokeWidth={1.2 * px} />}
      {!url && state?.state === "missing" && (
        <text x={0} y={0} textAnchor="middle" fontSize={Math.max(0.8, 11 * px)} fill={PCB.shapeUser}>
          image not available
        </text>
      )}
      {selected && <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="none" stroke={PCB.select} strokeWidth={2 * px} />}
    </g>
  )
}
