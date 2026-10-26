import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactElement } from "react"
import { createPortal } from "react-dom"
import { placeTooltip, showDelay } from "./tooltipPlacement"

export type TipContent = {
  /** What the control does, in a few words. */
  label: string
  /** One line of detail, shown muted under the label. */
  hint?: string
  /** The key that does the same, such as "V" or "⌘Z". */
  shortcut?: string
}

type Trigger = {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  "aria-describedby"?: string
  "aria-expanded"?: boolean | "true" | "false"
}

/** When a tooltip last went away, so the next one can show at once: moving along a toolbar reads as one hover. */
let lastHiddenAt = -Infinity
/** The hide function of the tooltip on screen, so opening another puts the first away: never two at once. */
let current: (() => void) | null = null

/**
 * A styled tooltip for the one control it wraps: shows after a short rest of the pointer or on
 * keyboard focus, hides on leave, press, blur, scroll or Escape. It draws in a portal and takes no
 * pointer events, so it never covers or steals a click. While the control's own popup is open
 * (`aria-expanded`), it stays away, since it would sit on top of the menu the control opened.
 */
export function Tooltip({ label, hint, shortcut, children }: TipContent & { children: ReactElement<Trigger> }) {
  const id = useId()
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState<{ warm: boolean; anchor: HTMLElement } | null>(null)
  const expanded = children.props["aria-expanded"] === true || children.props["aria-expanded"] === "true"
  const suppressed = useRef(expanded)
  suppressed.current = expanded

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    if (current === hide) current = null
    setOpen((cur) => {
      if (cur) lastHiddenAt = performance.now()
      return null
    })
  }, [])

  const show = (el: HTMLElement) => {
    window.clearTimeout(timer.current)
    if (suppressed.current) return
    const delay = showDelay(performance.now(), lastHiddenAt)
    timer.current = window.setTimeout(() => {
      if (suppressed.current) return
      if (current && current !== hide) current()
      current = hide
      setOpen({ warm: delay === 0, anchor: el })
    }, delay)
  }

  // Opening the control's popup puts its tooltip away.
  useEffect(() => {
    if (expanded) hide()
  }, [expanded, hide])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide()
    window.addEventListener("keydown", onKey)
    window.addEventListener("scroll", hide, true)
    window.addEventListener("blur", hide)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("blur", hide)
    }
  }, [open, hide])

  // A tooltip still waiting to show must not appear after its control is gone.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (current === hide) current = null
    },
    [hide],
  )

  const props = children.props
  const trigger: Trigger = {
    onPointerEnter: (e) => {
      props.onPointerEnter?.(e)
      if (e.pointerType !== "touch") show(e.currentTarget)
    },
    onPointerLeave: (e) => {
      props.onPointerLeave?.(e)
      hide()
    },
    onPointerDown: (e) => {
      props.onPointerDown?.(e)
      hide()
    },
    onFocus: (e) => {
      props.onFocus?.(e)
      // Only keyboard focus: a click focuses a button too, and must not pop a tooltip.
      if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget)
    },
    onBlur: (e) => {
      props.onBlur?.(e)
      hide()
    },
    "aria-describedby": open ? id : props["aria-describedby"],
  }

  return (
    <>
      {cloneElement(children, trigger)}
      {open && createPortal(<Bubble id={id} anchor={open.anchor} onGone={hide} warm={open.warm} label={label} hint={hint} shortcut={shortcut} />, document.body)}
    </>
  )
}

function Bubble({ id, anchor, warm, label, hint, shortcut, onGone }: TipContent & { id: string; anchor: HTMLElement; warm: boolean; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const { left, top } = placeTooltip(
      { left: a.left, top: a.top, width: a.width, height: a.height },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    )
    setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }))
  }, [anchor])

  // Measured before paint, so it never shows in the wrong place for a frame.
  useLayoutEffect(measure, [measure, label, hint, shortcut])

  // The control can move while the tooltip is up (a resize, a panel opening, a layout shift), so
  // follow it every frame and let go when it leaves the page.
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      if (!anchor.isConnected) return onGone()
      measure()
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [anchor, measure, onGone])

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      className={`pointer-events-none fixed z-[1000] w-max max-w-[260px] rounded-[var(--radius-ctl)] bg-ink px-2 py-1.5 text-[12px] leading-snug text-surface shadow-float ${warm ? "" : "animate-fade-in"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{label}</span>
        {shortcut && <span className="mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-surface/30 px-1 text-[11px] text-surface/80">{shortcut}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11.5px] text-surface/65">{hint}</div>}
    </div>
  )
}
