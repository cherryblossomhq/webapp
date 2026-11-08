import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react"
import { Tooltip } from "./Tooltip"

type Variant = "plain" | "primary" | "ghost" | "danger"

const variants: Record<Variant, string> = {
  plain: "bg-surface border border-line text-ink hover:bg-chrome",
  primary: "bg-ink text-surface border border-ink hover:bg-ink/85",
  ghost: "bg-transparent border border-transparent text-ink-2 hover:bg-chrome-2 hover:text-ink",
  danger: "bg-surface border border-line text-danger hover:bg-danger-soft",
}

export function Button({
  variant = "plain",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={`inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] px-3 text-[13px] font-medium transition-colors disabled:opacity-45 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function IconButton({
  label,
  active = false,
  className = "",
  children,
  shortcut,
  hint,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: string; hint?: string }) {
  return (
    <Tooltip label={label} hint={hint} shortcut={shortcut}>
      <button
        {...rest}
        aria-label={label}
        aria-pressed={active}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-ctl)] transition-colors disabled:opacity-35 ${
          active ? "bg-active text-on-active" : "text-ink-2 hover:bg-chrome-2 hover:text-ink"
        } ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T
  /** A `disabled` option is shown but can't be picked; its `title` says why. */
  options: { value: T; label: ReactNode; title?: string; hint?: string; shortcut?: string; disabled?: boolean }[]
  onChange: (v: T) => void
  size?: "sm" | "md"
}) {
  return (
    <div role="tablist" className="inline-flex rounded-[8px] bg-chrome-2 p-0.5">
      {options.map((o) => {
        const tab = (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={o.value === value}
            // Not `disabled`: a disabled button gets no pointer events, and its tooltip is what says why.
            aria-disabled={o.disabled || undefined}
            onClick={() => !o.disabled && onChange(o.value)}
            className={`${size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-3 text-[13px]"} shrink-0 whitespace-nowrap rounded-[6px] font-medium transition-colors ${
              o.value === value ? "bg-raised text-ink shadow-chip" : o.disabled ? "cursor-not-allowed text-ink-3 opacity-60" : "text-ink-2 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        )
        return o.title ? (
          <Tooltip key={o.value} label={o.title} hint={o.hint} shortcut={o.shortcut}>
            {tab}
          </Tooltip>
        ) : (
          tab
        )
      })}
    </div>
  )
}

/** A row of a menu (`role="menu"`): an icon and what it does; a dangerous one in red. */
export function MenuItem({ icon, danger, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] ${danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-chrome"}`}
    >
      <span className={danger ? "" : "text-ink-2"}>{icon}</span>
      {children}
    </button>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line bg-surface px-1 text-[11px] text-ink-2">
      {children}
    </kbd>
  )
}

/** Close a popover on a press outside `ref` or on Escape, while it is open. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  // The latest `close`, so callers can pass an inline function without re-subscribing every render.
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) latest.current()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && latest.current()
    window.addEventListener("pointerdown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [ref, open])
}
