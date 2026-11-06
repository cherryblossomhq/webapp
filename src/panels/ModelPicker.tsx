import { creditWeightLabel, describeManagedModel, firstPlanWith, MANAGED_MODELS } from "@cherryblossom/ai-models"
import { Check, ChevronDown, Lock } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { managedAiHost } from "../ai/managedAi"
import { useUi } from "../store/uiStore"
import { useDismiss } from "../ui/controls"

/**
 * The model Sakura runs on, beside its name in the header: the plan's models by their product
 * names, each with its tagline and, for a weighted one, what it costs in credits, so what each is
 * for reads in the list rather than in a tooltip. Under them, locked, the roster's models the plan
 * doesn't have, each named with the first plan that does (`firstPlanWith`) and linking to the
 * host's plans; choosing one is still the server's to refuse. The button holds the name alone, so
 * it fits beside the header's buttons. With one model it still opens, to say what it is.
 */
export function ModelPicker({ models, value, disabled }: { models: string[]; value: string; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  // Opened, the chosen model has the focus, so the arrow keys start from it.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus()
  }, [open])
  // A request running closes it: the model can't change mid-request.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const pick = (id: string) => {
    if (id !== value) useUi.getState().updateSettings({ model: id })
    close()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])") ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const to =
      e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null
    if (to !== null) {
      e.preventDefault()
      items[to]?.focus()
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault()
      close()
    }
  }

  const { label } = describeManagedModel(value)
  const locked = MANAGED_MODELS.flatMap((m) => {
    const plan = models.includes(m.id) ? null : firstPlanWith(m.id)
    return plan ? [{ id: m.id, plan: plan[0].toUpperCase() + plan.slice(1) }] : []
  })
  const upgradeUrl = managedAiHost()?.upgradeUrl
  // Not positioned: the list opens under the panel's header, from its left, as the usage card does from its right.
  return (
    <div ref={ref} className="min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={`flex h-7 max-w-full items-center gap-1.5 rounded-[6px] border px-2 text-[12px] transition-colors disabled:opacity-60 ${
          open ? "border-select text-ink" : "border-line text-ink-2 hover:border-ink-3 hover:text-ink"
        }`}
      >
        <span className="sr-only">Model: </span>
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Model"
          onKeyDown={onKeyDown}
          className="absolute left-2 top-11 z-30 flex w-[300px] max-w-[calc(100%-16px)] origin-top-left animate-pop-in flex-col gap-0.5 rounded-[10px] border border-line bg-surface p-1 shadow-menu"
        >
          {models.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === value}
              onClick={() => pick(id)}
              className={`${ROW} hover:bg-chrome focus-visible:bg-chrome ${id === value ? "bg-chrome" : ""}`}
            >
              <ModelText id={id} />
              <Check size={14} className={`mt-0.5 shrink-0 text-brand ${id === value ? "" : "invisible"}`} />
            </button>
          ))}
          {locked.length > 0 && <div role="separator" className="mx-1.5 my-1 h-px bg-line" />}
          {locked.map(({ id, plan }) => {
            const tag = (
              <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-1.5 py-px text-[10.5px] font-medium text-brand">
                <Lock size={10} strokeWidth={2.5} />
                {plan}
              </span>
            )
            return upgradeUrl ? (
              <a
                key={id}
                role="menuitem"
                href={upgradeUrl}
                target="_blank"
                rel="noreferrer"
                title={`Included with ${plan}. See plans`}
                onClick={() => setOpen(false)}
                className={`${ROW} hover:bg-chrome focus-visible:bg-chrome`}
              >
                <ModelText id={id} locked />
                {tag}
              </a>
            ) : (
              <div key={id} role="menuitem" aria-disabled="true" className={ROW}>
                <ModelText id={id} locked />
                {tag}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const ROW = "flex w-full items-start gap-2 rounded-[7px] px-2.5 py-2 text-left outline-none"

function ModelText({ id, locked = false }: { id: string; locked?: boolean }): ReactNode {
  const model = describeManagedModel(id)
  const cost = creditWeightLabel(id)
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-baseline gap-2">
        <span className={`text-[12.5px] font-medium ${locked ? "text-ink-2" : "text-ink"}`}>{model.label}</span>
        {cost && <span className="rounded-full bg-chrome-2 px-1.5 py-px text-[10.5px] font-medium text-ink-2">{cost}</span>}
      </span>
      {model.tagline && <span className="text-[11.5px] leading-snug text-ink-3">{model.tagline}</span>}
    </span>
  )
}
