import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useDismiss } from "./controls"
import { Tooltip } from "./Tooltip"

export type ToolChoice<T extends string> = {
  value: T
  label: string
  icon: ReactNode
  shortcut?: string
  hint?: string
}

/** A row in a group's menu that does something once rather than picking a tool, such as opening a file. */
export type ToolAction = { label: string; icon: ReactNode; onClick: () => void }

/** The tool each group last showed, kept while the page is open, so leaving a view and coming back shows the same one. */
const shownByGroup = new Map<string, string>()

/**
 * Several tools behind one toolbar button, as Figma keeps its shapes: the button is the group's
 * last-used tool and picks it, the chevron beside it lists the rest. A tool picked by its key
 * shows on the button too, and the group is lit while any of its tools is on.
 */
export function ToolGroup<T extends string>({
  label,
  tools,
  actions = [],
  active,
  onPick,
  disabled = false,
}: {
  /** What the group is, for the chevron and its menu: "Bus tools". */
  label: string
  tools: ToolChoice<T>[]
  actions?: ToolAction[]
  /** The tool that is on, from any group or none. */
  active: string
  onPick: (tool: T) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  useDismiss(wrapper, open, () => setOpen(false))
  const on = tools.find((t) => t.value === active)
  const shown = on ?? tools.find((t) => t.value === shownByGroup.get(label)) ?? tools[0]
  const onValue = on?.value
  useEffect(() => {
    if (onValue) shownByGroup.set(label, onValue)
  }, [label, onValue])

  const pick = (t: T) => {
    setOpen(false)
    onPick(t)
  }
  const half = on ? "text-on-active" : "text-ink-2 hover:bg-chrome-2 hover:text-ink"

  return (
    <div ref={wrapper} className={`relative flex rounded-[var(--radius-ctl)] ${on ? "bg-active" : ""}`}>
      <Tooltip label={shown.label} hint={shown.hint} shortcut={shown.shortcut}>
        <button
          type="button"
          aria-label={shown.label}
          aria-pressed={!!on}
          disabled={disabled}
          onClick={() => pick(shown.value)}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-l-[var(--radius-ctl)] transition-colors disabled:opacity-35 ${half}`}
        >
          {shown.icon}
        </button>
      </Tooltip>
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(!open)}
          className={`inline-flex h-8 w-4 items-center justify-center rounded-r-[var(--radius-ctl)] transition-colors disabled:opacity-35 ${open && !on ? "bg-chrome-2 text-ink" : half}`}
        >
          <ChevronDown size={12} strokeWidth={2.25} />
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label={label} className="absolute left-0 top-10 z-30 w-max min-w-[190px] origin-top-left animate-pop-in rounded-[10px] border border-line bg-surface p-1 shadow-menu">
          {tools.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitemradio"
              aria-label={t.label}
              aria-checked={t.value === active}
              onClick={() => pick(t.value)}
              className={`flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] text-ink hover:bg-chrome ${t.value === active ? "bg-chrome font-medium" : ""}`}
            >
              <span className="text-ink-2">{t.icon}</span>
              <span className="flex-1 whitespace-nowrap text-left">{t.label}</span>
              {t.shortcut && <span className="mono pl-4 text-[11.5px] text-ink-3">{t.shortcut}</span>}
            </button>
          ))}
          {actions.length > 0 && <div className="mx-1 my-1 h-px bg-line" />}
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              aria-label={a.label}
              onClick={() => {
                setOpen(false)
                a.onClick()
              }}
              className="flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] text-ink hover:bg-chrome"
            >
              <span className="text-ink-2">{a.icon}</span>
              <span className="flex-1 whitespace-nowrap text-left">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
