import { useRef, type KeyboardEvent, type PointerEvent } from "react"

/**
 * The grip on a panel's right edge: drag it to make the panel wider or narrower, double-click it
 * for the panel's first width, or focus it and use the arrow keys. `onResize` follows the pointer;
 * `onDone` is called once, with the width it was let go at, so the width is saved once a drag.
 */
export function PanelResizer({
  label,
  width,
  min,
  max,
  initial,
  onResize,
  onDone,
}: {
  label: string
  width: number
  min: number
  /** The widest it may go now, from the width it is drawn at (the canvas keeps its room). */
  max: (drawn: number) => number
  initial: number
  onResize: (width: number) => void
  onDone: (width: number) => void
}) {
  const grip = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; from: number; max: number; last: number } | null>(null)
  const clamp = (w: number, hi: number) => Math.round(Math.min(Math.max(min, hi), Math.max(min, w)))
  // The panel as drawn, which a narrow window can hold under `width`.
  const drawn = () => grip.current?.parentElement?.offsetWidth ?? width

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const from = drawn()
    drag.current = { x: e.clientX, from, max: max(from), last: from }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const w = clamp(d.from + e.clientX - d.x, d.max)
    if (w === d.last) return
    d.last = w
    onResize(w)
  }
  const up = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    onDone(d.last)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    const from = drawn()
    const hi = max(from)
    const to = e.key === "ArrowLeft" ? from - step : e.key === "ArrowRight" ? from + step : e.key === "Home" ? min : e.key === "End" ? hi : null
    if (to === null) return
    e.preventDefault()
    onDone(clamp(to, hi))
  }

  return (
    <div
      ref={grip}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group absolute inset-y-0 -right-[4px] z-20 w-[8px] cursor-col-resize touch-none outline-none"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onDone(clamp(initial, max(drawn())))}
      onKeyDown={key}
    >
      <div className="mx-auto h-full w-[2px] bg-select opacity-0 transition-opacity delay-75 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  )
}
