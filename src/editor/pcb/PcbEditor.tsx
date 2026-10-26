import { FlipHorizontal2, Lock, RotateCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  boxesOverlap,
  chamferedElbow,
  closestPointOnSegment,
  normBox,
  pointInBox,
  pointSegmentDistance,
  round,
  samePoint,
  snapPoint,
  type Box,
} from "../../lib/geometry"
import { findPart } from "../../model/library"
import { isPhysical, pcbCourtyard, pcbSilk, slotEnds, type WorldPad } from "../../model/instances"
import { addTrace, addVia, autoPlacePcb, netTraceWidth, removeItems, updateComponent } from "../../model/ops"
import { boardTextStrokes, boardTextStrokeWidth } from "../../model/board"
import { BOARD_OWNER, pointPadDistance, segmentPadDistance, type CopperItem } from "../../model/pcb"
import { formatLength, nextPreferredWidth } from "../../model/rules"
import { designatorStrokes, getDesignators, SILK_WIDTH, type Designator } from "../../model/silk"
import type { ZoneFill } from "../../model/pour"
import type { ComponentInstance, CopperLayer, Project, Rotation, Vec2 } from "../../model/types"
import { getConnectivity, getPcbAnalysis } from "../../store/analysis"
import { projectApi, useProjectStore } from "../../store/projectStore"
import { selectionIds, uiApi, useUi } from "../../store/uiStore"
import { CanvasHint } from "../schematic/SchematicEditor"
import { PCB } from "../theme"
import { Tooltip } from "../../ui/Tooltip"
import { isTyping, toWorld, Viewport, type ViewportHandle, type ViewportPointerEvent, type ViewTransform } from "../viewport"

export const PCB_GRID = 0.25

type Hit =
  | { type: "pad"; pad: WorldPad; netId: string | null }
  | { type: "via"; id: string; at: Vec2 }
  | { type: "trace"; id: string; point: Vec2; layer: CopperLayer }
  | { type: "component"; id: string }
  | { type: "boardHandle" }

type Mode =
  | { kind: "idle" }
  | { kind: "marquee"; start: Vec2; current: Vec2; additive: boolean }
  | { kind: "drag"; start: Vec2; ids: string[]; moved: boolean }
  | { kind: "resize"; start: Vec2 }
  /** `width` is set once W has picked a preferred width; until then the net's width applies. */
  | { kind: "route"; layer: CopperLayer; points: Vec2[]; netId: string | null; diagonalFirst: boolean; width?: number }

const boardBox = (p: Project): Box => ({
  minX: p.board.x - p.board.width / 2,
  maxX: p.board.x + p.board.width / 2,
  minY: p.board.y - p.board.height / 2,
  maxY: p.board.y + p.board.height / 2,
})

function hitTest(p: Project, at: Vec2, tol: number, layer: CopperLayer, items: CopperItem[]): Hit | null {
  const bb = boardBox(p)
  if (Math.hypot(at.x - bb.maxX, at.y - bb.minY) <= tol * 1.6) return { type: "boardHandle" }
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
  const traces = [...p.traces].sort((a, b) => (a.layer === layer ? 1 : 0) - (b.layer === layer ? 1 : 0))
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i]
    for (let s = 0; s < t.points.length - 1; s++) {
      if (pointSegmentDistance(at, t.points[s], t.points[s + 1]) <= t.width / 2 + tol * 0.5) {
        return { type: "trace", id: t.id, point: closestPointOnSegment(at, t.points[s], t.points[s + 1]), layer: t.layer }
      }
    }
  }
  for (let i = p.components.length - 1; i >= 0; i--) {
    const c = p.components[i]
    if (!c.pcb.placed) continue
    const cy = pcbCourtyard(c)
    if (cy && pointInBox(at, cy)) return { type: "component", id: c.id }
  }
  return null
}

function hitSelectionId(h: Hit | null): string | null {
  if (!h) return null
  if (h.type === "pad") return `c:${h.pad.componentId}`
  if (h.type === "via") return `v:${h.id}`
  if (h.type === "trace") return `t:${h.id}`
  if (h.type === "component") return `c:${h.id}`
  return null
}

/** Of the selected parts, which can move and the references of the locked ones, which stay. */
export function splitLocked(project: Project, ids: string[]): { free: string[]; locked: string[] } {
  const parts = ids.map((id) => project.components.find((c) => c.id === id)).filter((c): c is ComponentInstance => !!c)
  return { free: parts.filter((c) => !c.pcb.locked).map((c) => c.id), locked: parts.filter((c) => c.pcb.locked).map((c) => c.ref) }
}

const lockedNote = (refs: string[]) =>
  `${refs.join(", ")} ${refs.length > 1 ? "are" : "is"} locked; turn off Locked in the Inspector to move ${refs.length > 1 ? "them" : "it"}`

export function PcbEditor() {
  const project = useProjectStore((s) => s.project)!
  const selection = useUi((s) => s.selection)
  const tool = useUi((s) => s.pcbTool)
  const layer = useUi((s) => s.activeLayer)
  const unit = useUi((s) => s.settings.units)
  const layers = useUi((s) => s.layers)
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

  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), 3500)
    return () => clearTimeout(timer)
  }, [note])

  const sch = useMemo(() => getConnectivity(project), [project])
  const pcb = useMemo(() => getPcbAnalysis(project), [project])
  const selected = useMemo(() => new Set(selection), [selection])
  const pours = usePourPaths(pcb.zoneFills)
  const pinNames = usePinNames(project.components)
  const designators = getDesignators(project)

  // Place parts that were added in the schematic since the last visit.
  useEffect(() => {
    const p = projectApi().project
    if (p && p.components.some((c) => !c.pcb.placed && isPhysical(findPart(c.partId)))) {
      projectApi().commit((x) => autoPlacePcb(x))
    }
  }, [])

  useEffect(() => {
    const vp = vpRef.current
    if (focusRequest?.view !== "pcb" || !vp) return
    if (focusRequest.box) vp.frame(focusRequest.box, 15)
    else vp.centerOn(focusRequest, Math.max(vp.transform().scale, 30))
  }, [focusRequest])

  const tol = () => 6 / (vpRef.current?.transform().scale ?? 14)

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
      const h = hitTest(projectApi().project!, world, tol(), uiApi().activeLayer, getPcbAnalysis(projectApi().project!).items)
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

  const placeViaAndSwitch = useCallback(() => {
    const m = modeRef.current
    if (m.kind !== "route") return
    const at = m.points[m.points.length - 1]
    commitRoute(m)
    projectApi().commit((p) => (p.vias.some((v) => samePoint(v, at)) ? p : addVia(p, at, { locked: true }).project))
    const nextLayer: CopperLayer = m.layer === "top" ? "bottom" : "top"
    uiApi().setActiveLayer(nextLayer)
    setMode({ ...m, layer: nextLayer, points: [at] })
  }, [commitRoute])

  // ---------- pointer ----------
  const onPointerDown = (e: ViewportPointerEvent) => {
    const native = e.native as React.PointerEvent
    if (native.button !== 0) return
    const p = projectApi().project!
    const m = modeRef.current
    const { at, hit } = snapTarget(e.world, native.altKey)

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

    if (tool === "route") {
      let netId: string | null = null
      let startLayer = uiApi().activeLayer
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
      projectApi().commit((x) => addVia(x, at, { locked: true }).project)
      return
    }

    // select
    const h = hitTest(p, e.world, tol(), uiApi().activeLayer, pcb.items)
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
    if (native.shiftKey) {
      uiApi().toggleSelect(id)
      return
    }
    let sel = uiApi().selection
    if (!sel.includes(id)) {
      sel = [id]
      uiApi().select(sel)
    }
    const { free, locked } = splitLocked(p, selectionIds(sel, "c"))
    if (locked.length) setNote(lockedNote(locked))
    if (free.length) {
      projectApi().beginTransient()
      setMode({ kind: "drag", start: e.world, ids: free, moved: false })
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
      projectApi().setTransient((base) => ({
        ...base,
        components: base.components.map((c) =>
          ids.has(c.id) ? { ...c, pcb: { ...c.pcb, x: round(c.pcb.x + delta.x), y: round(c.pcb.y + delta.y), placed: true } } : c,
        ),
      }))
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
      const h = hitTest(project, e.world, tol(), layer, pcb.items)
      setHover((prev) => (hitSelectionId(prev) === hitSelectionId(h) && prev?.type === h?.type ? prev : h))
    }
  }

  const onPointerUp = () => {
    const m = modeRef.current
    if (m.kind === "marquee") {
      const box = normBox(m.start, m.current)
      const ids: string[] = []
      for (const c of project.components) {
        const cy = c.pcb.placed ? pcbCourtyard(c) : null
        if (cy && boxesOverlap(box, cy)) ids.push(`c:${c.id}`)
      }
      for (const t of project.traces) if (t.points.some((pt) => pointInBox(pt, box))) ids.push(`t:${t.id}`)
      for (const v of project.vias) if (pointInBox(v, box)) ids.push(`v:${v.id}`)
      const base = m.additive ? uiApi().selection : []
      uiApi().select([...new Set([...base, ...ids])])
      setMode({ kind: "idle" })
    } else if (m.kind === "drag" || m.kind === "resize") {
      if (m.kind === "drag" && !m.moved) projectApi().cancelTransient()
      else projectApi().endTransient()
      setMode({ kind: "idle" })
    }
  }

  const onDoubleClick = () => {
    const m = modeRef.current
    if (m.kind === "route") {
      commitRoute(m)
      setMode({ kind: "idle" })
    }
  }

  const onContextMenu = () => {
    const m = modeRef.current
    if (m.kind === "route") {
      commitRoute(m)
      setMode({ kind: "idle" })
    }
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return
      const m = modeRef.current
      const key = e.key.toLowerCase()
      const sel = uiApi().selection
      if (key === "escape") {
        if (m.kind === "route") {
          commitRoute(m)
          setMode({ kind: "idle" })
        } else if (m.kind === "drag" || m.kind === "resize") {
          projectApi().cancelTransient()
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
      if (key === "x") uiApi().setPcbTool("route")
      else if (key === "v") uiApi().setPcbTool(tool === "select" ? "via" : "select")
      else if (key === "s") uiApi().setPcbTool("select")
      else if (key === "l") uiApi().setActiveLayer(uiApi().activeLayer === "top" ? "bottom" : "top")
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
      } else if (key === "r") {
        const { free: comps, locked } = splitLocked(projectApi().project!, selectionIds(sel, "c"))
        if (locked.length) setNote(lockedNote(locked))
        if (!comps.length) return
        projectApi().commit((p) =>
          comps.reduce((acc, id) => {
            const c = acc.components.find((x) => x.id === id)
            return c ? updateComponent(acc, id, { pcb: { rot: (((c.pcb.rot + 90) % 360) as Rotation) } }) : acc
          }, p),
        )
      } else if (key === "delete" || key === "backspace") {
        const traces = selectionIds(sel, "t")
        const vias = selectionIds(sel, "v")
        if (!traces.length && !vias.length) return
        e.preventDefault()
        projectApi().commit((p) => removeItems(p, { traces, vias }))
        uiApi().clearSelection()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [commitRoute, placeViaAndSwitch, tool])

  // ---------- render ----------
  const bb = boardBox(project)
  const r = Math.min(project.board.cornerRadius, project.board.width / 2, project.board.height / 2)
  const cursorCss = tool === "route" || mode.kind === "route" ? "crosshair" : tool === "via" ? "cell" : hover?.type === "boardHandle" ? "nwse-resize" : "default"
  const placed = project.components.filter((c) => c.pcb.placed && isPhysical(findPart(c.partId)))
  // Both layers are opaque; the active one is in front, so gaps in its pour show the other.
  const layerOrder: CopperLayer[] = layer === "top" ? ["bottom", "top"] : ["top", "bottom"]
  const front = layers[layer] ? layer : layerOrder.find((l) => layers[l]) ?? layer
  // An explicit highlight (from the net list) dims everything else; hover only outlines.
  const dimOthers = !!highlightNet
  const selectedComps = selectionIds(selection, "c")
  const barComponent = selectedComps.length === 1 && mode.kind === "idle" ? project.components.find((c) => c.id === selectedComps[0]) : undefined

  const routeWidth = (mode.kind === "route" ? mode.width : undefined) ?? netTraceWidth(project.rules, mode.kind === "route" ? netName(mode.netId) : null)
  const markers = pcb.violations.filter((v) => v.severity === "error" && v.kind !== "net-conflict")

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
              {layers.board && (
                <rect x={bb.minX} y={bb.minY} width={bb.maxX - bb.minX} height={bb.maxY - bb.minY} rx={r} fill={PCB.board} stroke={PCB.edge} strokeWidth={Math.max(0.15, 2 * px)} />
              )}

              {layerOrder.map((l) =>
                layers[l] ? (
                  <g key={l}>
                    {pours
                      .filter((f) => f.layer === l)
                      .map((f) => (
                        <path
                          key={f.zoneId}
                          d={f.d}
                          fill={l === "top" ? PCB.topPour : PCB.bottomPour}
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
                        const pts = tr.points.map((p) => `${p.x},${p.y}`).join(" ")
                        return (
                          <g key={tr.id} opacity={dim(net)}>
                            {(hi || isSel) && (
                              <polyline
                                points={pts}
                                fill="none"
                                stroke={PCB.select}
                                strokeWidth={tr.width + 3 * px}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity={isSel ? 0.95 : 0.6}
                              />
                            )}
                            <polyline
                              points={pts}
                              fill="none"
                              stroke={l === "top" ? PCB.topCopper : PCB.bottomCopper}
                              strokeWidth={tr.width}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </g>
                        )
                      })}
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

              {/* Through-hole pads, mounting holes and vias span both layers */}
              {(layers.top || layers.bottom) && (
                <>
                  {pcb.items.map((it) =>
                    it.kind === "pad" && it.layers.length === 2 ? (
                      <g key={it.id} opacity={dim(netOf(it))}>
                        <PadShape pad={it.pad} color={PCB.pad} highlight={!!activeNet && it.netId === activeNet} px={px} />
                      </g>
                    ) : null,
                  )}
                  {project.vias.map((v) => {
                    const net = pcb.viaNet.get(v.id) ?? null
                    const isSel = selected.has(`v:${v.id}`)
                    return (
                      <g key={v.id} opacity={dim(net)}>
                        <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={isSel ? PCB.select : PCB.via} stroke={activeNet && net === activeNet ? "#fff" : "none"} strokeWidth={1.4 * px} />
                        <circle cx={v.x} cy={v.y} r={v.drill / 2} fill={PCB.hole} />
                      </g>
                    )
                  })}
                </>
              )}

              {/* Silkscreen: part outlines, designators and free text */}
              {layers.silk && (
                <>
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
                  {(project.texts ?? []).map((tx) => (
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
                if (!isSel && !isHover && !layers.courtyard) return null
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

              {/* Board resize handle */}
              {tool === "select" && (
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
                  <polyline
                    points={[...mode.points, ...routePreview(mode, cursor).slice(1)].map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={mode.layer === "top" ? PCB.topCopper : PCB.bottomCopper}
                    strokeOpacity={0.85}
                    strokeWidth={routeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx={cursor.x} cy={cursor.y} r={routeWidth / 2 + 1.5 * px} fill="none" stroke="#fff" strokeWidth={px} />
                </>
              )}
              {tool === "via" && cursor && mode.kind === "idle" && (
                <circle cx={cursor.x} cy={cursor.y} r={project.rules.viaDiameter / 2} fill={PCB.via} opacity={0.6} />
              )}
            </>
          )
        }}
      </Viewport>
      {mode.kind === "route" ? (
        <CanvasHint
          dark
          items={[
            ["Click", "add a corner"],
            ["V", `via to ${mode.layer === "top" ? "bottom" : "top"}`],
            ["W", `width ${formatLength(routeWidth, unit, true)}`],
            ["/", "flip bend"],
            ["Esc", "finish"],
          ]}
        />
      ) : tool === "route" ? (
        <CanvasHint dark items={[["Click", "a pad to start routing"], ["L", "switch layer"]]} />
      ) : note ? (
        <CanvasHint dark items={[["Locked", note]]} />
      ) : hover && (hover.type === "pad" || hover.type === "trace") && (netName(activeNet) || hover.type === "pad") ? (
        <div className="mono pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[6px] bg-[#26232e] px-2.5 py-1 text-[12px] text-silk">
          {hover.type === "pad" ? padHoverText(project, hover.pad, pinNames, netName(hover.netId)) : netName(activeNet)}
        </div>
      ) : null}
    </div>
  )
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
  else if (pad.shape === "polygon" && pad.points)
    shape = <polygon points={pad.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={color} stroke={stroke} strokeWidth={sw} />
  else {
    const rr = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : Math.min(pad.width, pad.height) * 0.12
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
  if (!ends) return <circle cx={pad.x} cy={pad.y} r={d / 2} fill={PCB.hole} stroke={PCB.plating} strokeWidth={strokeWidth} />
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
  const rotate = () => projectApi().commit((p) => updateComponent(p, c.id, { pcb: { rot: (((c.pcb.rot + 90) % 360) as Rotation) } }))
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
          <span className="mono">{c.pcb.rot}°</span>
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
