import { ChevronDown, RotateCcw } from "lucide-react"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { formatLength, fromUnit, type LengthUnit } from "../model/rules"
import { uiApi, useUi } from "../store/uiStore"
import { Tooltip } from "./Tooltip"

/** Text/number input that commits on blur or Enter so typing doesn't spam the undo history. */
export function CommitInput({
  value,
  onCommit,
  type = "text",
  mono = false,
  step,
  min,
  ariaLabel,
  placeholder,
  className = "",
}: {
  value: string | number
  onCommit: (v: string) => void
  type?: "text" | "number"
  mono?: boolean
  step?: number
  min?: number
  ariaLabel?: string
  placeholder?: string
  className?: string
}) {
  // The edit in progress; null shows the value, so a commit that is refused or clamped to the
  // value it already had (an invalid hex code, a length under the minimum) doesn't leave the
  // rejected text in the field.
  const [draft, setDraft] = useState<string | null>(null)
  // Escape blurs to leave the field, and the blur must not save the draft it is throwing away.
  const cancelled = useRef(false)
  const commit = () => {
    setDraft(null)
    if (cancelled.current) cancelled.current = false
    // An emptied number field (or one it couldn't parse, which reads as "") keeps the value.
    else if (draft !== null && draft !== String(value) && !(type === "number" && draft.trim() === "")) onCommit(draft)
  }
  return (
    <input
      aria-label={ariaLabel}
      className={`field h-8 ${mono ? "mono" : ""} ${className}`}
      type={type}
      step={step}
      min={min}
      value={draft ?? String(value)}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          cancelled.current = true
          setDraft(null)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** The length unit chosen in the Inspector, a personal preference kept with the settings. */
export const useLengthUnit = (): LengthUnit => useUi((s) => s.settings.units)

/**
 * Length in millimetres, shown and typed in the chosen unit. `min` is in millimetres; an empty
 * field commits null when `optional`, and otherwise goes back to the value.
 */
export function LengthInput({
  value,
  onCommit,
  min = 0,
  ariaLabel,
  optional = false,
  placeholder,
  className = "",
}: {
  value: number | null
  onCommit: (mm: number | null) => void
  min?: number
  ariaLabel?: string
  optional?: boolean
  placeholder?: string
  className?: string
}) {
  const unit = useLengthUnit()
  const shown = value === null ? "" : formatLength(value, unit)
  return (
    <div className={`relative ${className}`}>
      <CommitInput
        ariaLabel={ariaLabel}
        type={optional ? "text" : "number"}
        step={unit === "mil" ? 1 : 0.05}
        value={shown}
        placeholder={placeholder}
        className="pr-9 tabular-nums"
        onCommit={(v) => {
          if (v.trim() === "") return optional && onCommit(null)
          const n = Number(v.replace(",", "."))
          if (Number.isFinite(n)) onCommit(Math.max(min, Number(fromUnit(n, unit).toFixed(4))))
        }}
      />
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11.5px] text-ink-3">{unit}</span>
    </div>
  )
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** #rgb or #rrggbb, with or without the hash, as lowercase #rrggbb; null when it isn't one. */
export function parseHex(s: string): string | null {
  const m = HEX.exec(s.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1]
  return `#${h.toLowerCase()}`
}

/**
 * A colour as a swatch and a hex code. The swatch opens the system colour picker, which
 * commits once when it closes; the hex field commits on Enter or blur. `fallback` is what an
 * unset colour shows, and the reset button returns to it.
 */
export function ColorField({
  value,
  fallback,
  onCommit,
  label,
}: {
  value: string | undefined
  fallback: string
  onCommit: (hex: string | undefined) => void
  label: string
}) {
  const color = value ?? fallback
  const [preview, setPreview] = useState(color)
  useEffect(() => setPreview(color), [color])
  const picker = useRef<HTMLInputElement>(null)
  const latest = useRef({ color, onCommit })
  latest.current = { color, onCommit }
  useEffect(() => {
    const el = picker.current
    if (!el) return
    // React's onChange is the input event, which fires on every move; "change" fires when the picker closes.
    const done = () => {
      const hex = parseHex(el.value)
      if (hex && hex !== latest.current.color.toLowerCase()) latest.current.onCommit(hex)
    }
    el.addEventListener("change", done)
    return () => el.removeEventListener("change", done)
  }, [])
  return (
    <div className="flex items-center gap-1.5">
      <Tooltip label={`Pick ${label.toLowerCase()}`}>
      <label className="relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-[var(--radius-ctl)] border border-line">
        <span className="absolute inset-[3px] rounded-[4px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]" style={{ background: preview }} />
        <input
          ref={picker}
          type="color"
          aria-label={`${label} picker`}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
        />
      </label>
      </Tooltip>
      <CommitInput
        mono
        ariaLabel={`${label} hex code`}
        value={color.toLowerCase()}
        className="min-w-0 flex-1 uppercase"
        onCommit={(v) => {
          const hex = parseHex(v)
          if (hex) onCommit(hex)
          else setPreview(color)
        }}
      />
      {value !== undefined && value.toLowerCase() !== fallback.toLowerCase() && (
        <Tooltip label={`Reset ${label.toLowerCase()}`} hint={`Back to ${fallback.toUpperCase()}`}>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-ctl)] text-ink-3 hover:bg-chrome-2 hover:text-ink"
            aria-label={`Reset ${label.toLowerCase()}`}
            onClick={() => onCommit(undefined)}
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors ${checked ? "bg-select" : "bg-chrome-2 shadow-[inset_0_0_0_1px_var(--color-line)]"}`}
    >
      <span className={`absolute h-[14px] w-[14px] rounded-full bg-white shadow-chip transition-transform ${checked ? "translate-x-[14px]" : "translate-x-[2px]"}`} />
    </button>
  )
}

/**
 * True where the user may read the project but not change it (a viewer's Inspector): every
 * `Section` then disables its controls, and only its fold stays, so a folded section can still be
 * opened to read.
 */
export const ReadOnly = createContext(false)

/** A titled Inspector section that folds away from its heading; the fold is kept for the session. */
export function Section({
  title,
  children,
  action,
  id,
  collapsible = !!id,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
  id?: string
  collapsible?: boolean
}) {
  const folded = useUi((s) => (id ? !!s.folded[id] : false))
  const readOnly = useContext(ReadOnly)
  return (
    <section className="border-b border-line px-4 py-3.5">
      <div className={`flex items-center justify-between gap-2 ${folded ? "" : "mb-2.5"}`}>
        {collapsible && id ? (
          <button type="button" className="group -ml-1 flex min-w-0 items-center gap-1 rounded px-1 text-left" aria-expanded={!folded} onClick={() => uiApi().toggleFolded(id)}>
            <h3 className="text-[12.5px] font-[650] text-ink">{title}</h3>
            <ChevronDown size={13} className={`text-ink-3 transition-transform group-hover:text-ink-2 ${folded ? "-rotate-90" : ""}`} />
          </button>
        ) : (
          <h3 className="text-[12.5px] font-[650] text-ink">{title}</h3>
        )}
        {!folded && action && (
          <fieldset disabled={readOnly} className="contents">
            {action}
          </fieldset>
        )}
      </div>
      {!folded && (
        <fieldset disabled={readOnly} className="min-w-0 space-y-2.5">
          {children}
        </fieldset>
      )}
    </section>
  )
}

/** Labelled group for controls that hold several buttons (a <label> would forward clicks). */
export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1 block text-[12px] text-ink-2">{label}</span>
      {children}
    </div>
  )
}

/** Read-only label and value on one line. */
export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-ink-2">{label}</span>
      <span className={`truncate text-right text-ink ${mono ? "mono" : ""}`}>{value}</span>
    </div>
  )
}

/** A rule: its name on the left (the hint shows on hover), its control on the right. */
export function RuleRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span className="min-w-0 text-[12.5px] text-ink-2" title={hint}>
        {label}
      </span>
      <div className="flex w-[118px] shrink-0 justify-end">{children}</div>
    </div>
  )
}

/** A titled group of rules inside a section, set closer together than the section's fields. */
export function RuleGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="space-y-1 pt-1">
      <h4 className="pb-0.5 text-[11px] font-[650] uppercase tracking-[0.06em] text-ink-3">{title}</h4>
      {children}
    </div>
  )
}
