import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { Box } from "../lib/geometry"
import type { TextExtent } from "../model/symbols"
import type { Vec2 } from "../model/types"

export interface ViewTransform {
  /** pixels per world unit */
  scale: number
  tx: number
  ty: number
}

export const toScreen = (t: ViewTransform, p: Vec2): Vec2 => ({ x: p.x * t.scale + t.tx, y: -p.y * t.scale + t.ty })
export const toWorld = (t: ViewTransform, p: Vec2): Vec2 => ({ x: (p.x - t.tx) / t.scale, y: -(p.y - t.ty) / t.scale })

export interface ViewportHandle {
  fit: (box: Box, padding?: number) => void
  centerOn: (p: Vec2, scale?: number) => void
  /** Centres on a box with room around it to see where it is: about a third of the view, zoomed in no further than `maxScale`. */
  frame: (box: Box, maxScale: number) => void
  transform: () => ViewTransform
  element: () => HTMLDivElement | null
}

export interface ViewportPointerEvent {
  world: Vec2
  screen: Vec2
  native: PointerEvent | React.PointerEvent
}

interface ViewportProps {
  initialScale: number
  minScale: number
  maxScale: number
  grid: number
  gridColor: string
  /** Optional line grid every `every` world units, under the dot grid. */
  majorGrid?: { every: number; color: string }
  background: string
  fitBox: Box | null
  cursor?: string
  children: (t: ViewTransform) => ReactNode
  overlay?: (t: ViewTransform) => ReactNode
  onPointerDown?: (e: ViewportPointerEvent) => void
  onPointerMove?: (e: ViewportPointerEvent) => void
  onPointerUp?: (e: ViewportPointerEvent) => void
  onDoubleClick?: (e: ViewportPointerEvent) => void
  onContextMenu?: (e: ViewportPointerEvent) => void
  onLeave?: () => void
  onDrop?: (world: Vec2, data: DataTransfer) => void
  /** The pointer in world units on every move over the canvas, and null when it leaves: what collaborators see. */
  onWorldPointer?: (world: Vec2 | null) => void
  /** What the canvas shows, in world units, whenever that changes. */
  onVisible?: (box: Box) => void
  /** The user panned, zoomed or pressed on the canvas: whatever was steering the view should stop. */
  onUserMove?: () => void
  className?: string
}

/**
 * Pan/zoom canvas. Children render in world space (y-up) inside a flipped <g>.
 * Wheel zooms for mouse wheels and pinch; two-finger scroll pans. Middle-drag or
 * Space+drag pans.
 */
export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(props, ref) {
  const { initialScale, minScale, maxScale, grid, gridColor, background, fitBox } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [t, setT] = useState<ViewTransform>({ scale: initialScale, tx: 0, ty: 0 })
  const tRef = useRef(t)
  tRef.current = t
  const [size, setSize] = useState({ w: 0, h: 0 })
  const fitted = useRef(false)
  const panning = useRef<{ start: Vec2; t: ViewTransform; pointerId: number } | null>(null)
  const spaceDown = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)

  // A view placed before the first fit (a focus request from another view, say) is kept.
  const fit = useCallback(
    (box: Box, padding = 60) => {
      const el = hostRef.current
      if (!el) return
      fitted.current = true
      const w = el.clientWidth
      const h = el.clientHeight
      const bw = Math.max(box.maxX - box.minX, 1e-3)
      const bh = Math.max(box.maxY - box.minY, 1e-3)
      const scale = Math.min(maxScale, Math.max(minScale, Math.min((w - padding * 2) / bw, (h - padding * 2) / bh)))
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      setT({ scale, tx: w / 2 - cx * scale, ty: h / 2 + cy * scale })
    },
    [minScale, maxScale],
  )

  const centerOn = useCallback((p: Vec2, scale?: number) => {
    const el = hostRef.current
    if (!el) return
    fitted.current = true
    const s = scale ?? tRef.current.scale
    setT({ scale: s, tx: el.clientWidth / 2 - p.x * s, ty: el.clientHeight / 2 + p.y * s })
  }, [])

  const frame = useCallback(
    (box: Box, cap: number) => {
      const el = hostRef.current
      if (!el) return
      const bw = Math.max(box.maxX - box.minX, 1e-3)
      const bh = Math.max(box.maxY - box.minY, 1e-3)
      const scale = Math.min(cap, maxScale, Math.max(minScale, Math.min(el.clientWidth / bw, el.clientHeight / bh) / 3))
      centerOn({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, scale)
    },
    [centerOn, minScale, maxScale],
  )

  useImperativeHandle(ref, () => ({ fit, centerOn, frame, transform: () => tRef.current, element: () => hostRef.current }), [fit, centerOn, frame])

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (fitted.current || !size.w || !size.h) return
    fitted.current = true
    if (fitBox) fit(fitBox)
    else setT({ scale: initialScale, tx: size.w / 2, ty: size.h / 2 })
  }, [size, fitBox, fit, initialScale])

  const onVisible = props.onVisible
  useEffect(() => {
    if (!onVisible || !size.w || !size.h) return
    const a = toWorld(t, { x: 0, y: 0 })
    const b = toWorld(t, { x: size.w, y: size.h })
    onVisible({ minX: a.x, minY: b.y, maxX: b.x, maxY: a.y })
  }, [t, size, onVisible])

  const userMove = useRef(props.onUserMove)
  userMove.current = props.onUserMove

  // Wheel must be non-passive to prevent page zoom.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      userMove.current?.()
      const rect = el.getBoundingClientRect()
      const sp = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const cur = tRef.current
      const looksLikeMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY))
      if (e.ctrlKey || e.metaKey || looksLikeMouseWheel) {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018) * (e.deltaMode === 1 ? 16 : 1))
        const scale = Math.min(maxScale, Math.max(minScale, cur.scale * factor))
        const w = toWorld(cur, sp)
        setT({ scale, tx: sp.x - w.x * scale, ty: sp.y + w.y * scale })
      } else {
        setT({ ...cur, tx: cur.tx - e.deltaX, ty: cur.ty - e.deltaY })
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [minScale, maxScale])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e)) {
        spaceDown.current = true
        setSpaceHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false
        setSpaceHeld(false)
      }
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [])

  const toEvent = (e: React.PointerEvent | React.MouseEvent): ViewportPointerEvent => {
    const rect = hostRef.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    return { screen, world: toWorld(tRef.current, screen), native: e as React.PointerEvent }
  }

  const gridPx = grid * t.scale
  const step = gridPx < 7 ? (gridPx * 10 < 7 ? gridPx * 100 : gridPx * 10) : gridPx
  const dots = { image: `radial-gradient(circle, ${gridColor} 1px, transparent 1.2px)`, size: `${step}px ${step}px`, pos: `${t.tx - step / 2}px ${t.ty - step / 2}px` }
  const layers = [dots]
  const major = props.majorGrid
  if (major && major.every * t.scale >= 40) {
    const m = major.every * t.scale
    const size = `${m}px ${m}px`
    const pos = `${t.tx}px ${t.ty}px`
    layers.unshift(
      { image: `linear-gradient(to right, ${major.color} 1px, transparent 1px)`, size, pos },
      { image: `linear-gradient(to bottom, ${major.color} 1px, transparent 1px)`, size, pos },
    )
  }
  // Longhands only: a `background` shorthand would reset the dot size and position whenever
  // the colour changes (theme switch) while React leaves the unchanged longhands alone.
  const gridStyle: CSSProperties = {
    backgroundColor: background,
    backgroundImage: layers.map((l) => l.image).join(", "),
    backgroundSize: layers.map((l) => l.size).join(", "),
    backgroundPosition: layers.map((l) => l.pos).join(", "),
  }

  return (
    <div
      ref={hostRef}
      className={`absolute inset-0 overflow-hidden select-none touch-none ${props.className ?? ""}`}
      style={{ ...gridStyle, cursor: panning.current ? "grabbing" : spaceHeld ? "grab" : props.cursor }}
      onPointerDown={(e) => {
        props.onUserMove?.()
        if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
          e.preventDefault()
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
          panning.current = { start: { x: e.clientX, y: e.clientY }, t: tRef.current, pointerId: e.pointerId }
          return
        }
        hostRef.current?.focus({ preventScroll: true })
        if (e.button === 0) {
          // Captured so a drag released over a panel still ends, rather than following the cursor.
          hostRef.current?.setPointerCapture?.(e.pointerId)
          // A click on the canvas leaves page text behind; ⌘C and ⌘A are the canvas's again.
          window.getSelection()?.removeAllRanges()
        }
        props.onPointerDown?.(toEvent(e))
      }}
      onPointerMove={(e) => {
        const pan = panning.current
        if (pan) {
          setT({ ...pan.t, tx: pan.t.tx + e.clientX - pan.start.x, ty: pan.t.ty + e.clientY - pan.start.y })
          return
        }
        const ev = toEvent(e)
        props.onWorldPointer?.(ev.world)
        props.onPointerMove?.(ev)
      }}
      onPointerUp={(e) => {
        if (panning.current) {
          panning.current = null
          return
        }
        props.onPointerUp?.(toEvent(e))
      }}
      onPointerCancel={(e) => {
        if (panning.current) {
          panning.current = null
          return
        }
        props.onPointerUp?.(toEvent(e))
      }}
      onPointerLeave={() => {
        props.onWorldPointer?.(null)
        props.onLeave?.()
      }}
      onDoubleClick={(e) => props.onDoubleClick?.(toEvent(e))}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu?.(toEvent(e))
      }}
      onDragOver={(e) => {
        if (props.onDrop) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!props.onDrop) return
        e.preventDefault()
        props.onDrop(toEvent(e).world, e.dataTransfer)
      }}
      tabIndex={0}
    >
      <svg className="absolute inset-0 h-full w-full" width={size.w} height={size.h}>
        <g transform={`matrix(${t.scale},0,0,${-t.scale},${t.tx},${t.ty})`}>{props.children(t)}</g>
      </svg>
      {props.overlay?.(t)}
    </div>
  )
})

/** Text the user highlighted on the page (a copilot reply, say), which ⌘C and ⌘A belong to. */
export function hasTextSelection(): boolean {
  const s = window.getSelection()
  return !!s && !s.isCollapsed && s.toString() !== ""
}

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable
}

// ---------- World-space text ----------

export function WorldText({
  x,
  y,
  text,
  size,
  extent,
  vertical = false,
  fill,
  weight = 500,
  mono = false,
  opacity,
}: {
  x: number
  y: number
  text: string
  size: number
  extent: TextExtent
  vertical?: boolean
  fill: string
  weight?: number
  mono?: boolean
  opacity?: number
}) {
  // In the text's own frame: forward is +x (or world up when vertical), up is world up (or world left).
  const forward = vertical ? extent.y : extent.x
  const up = vertical ? -extent.x : extent.y
  const anchor = forward > 0 ? "start" : forward < 0 ? "end" : "middle"
  const baseline = up > 0 ? "text-after-edge" : up < 0 ? "text-before-edge" : "central"
  return (
    <text
      transform={`translate(${x},${y}) scale(1,-1)${vertical ? " rotate(-90)" : ""}`}
      fontSize={size}
      textAnchor={anchor}
      dominantBaseline={baseline}
      fill={fill}
      fontWeight={weight}
      opacity={opacity}
      style={{ fontVariationSettings: mono ? '"MONO" 1' : '"MONO" 0', pointerEvents: "none" }}
    >
      {text}
    </text>
  )
}
