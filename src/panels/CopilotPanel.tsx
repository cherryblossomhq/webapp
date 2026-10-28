import { describeManagedModel } from "@cherryblossom/ai-models"
import { AlertTriangle, ArrowUp, ArrowUpRight, Boxes, Check, CornerDownRight, Loader2, LogIn, PanelLeftClose, RotateCcw, Sparkles, Square } from "lucide-react"
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { managedAiHost, type FailureKind } from "../ai/managedAi"
import { copilotAccess, copilotModel, useAccount, type CopilotAccess } from "../store/accountStore"
import { useCopilot, type Entry } from "../store/copilotStore"
import { useProjectStore } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { Button, IconButton } from "../ui/controls"

const SUGGESTIONS = [
  "Add a 3.3 V regulator with input and output caps",
  "Blink an LED at about 1 Hz with a 555 timer",
  "Add a BME280 sensor on I2C with pull-up resistors",
  "Check the design and fix unconnected pins",
]

/** Why the composer is off, if it is: no session, a plan without the copilot, or a project shared to view. */
type Gate = "signin" | "viewer" | Exclude<CopilotAccess, "ready"> | null

export function CopilotPanel() {
  const projectId = useProjectStore((s) => s.project?.id ?? null)
  const preferred = useUi((s) => s.settings.model)
  const status = useAccount((s) => s.status)
  const account = useAccount((s) => s.account)
  const entries = useCopilot((s) => (projectId ? s.threads[projectId] : undefined)) ?? EMPTY
  const runningProject = useCopilot((s) => s.runningProject)
  const { send, stop, clear } = useCopilot.getState()
  // A request handed over from the website's hero starts in the composer, for the user to send.
  const [draft, setDraft] = useState(() => (projectId ? (useCopilot.getState().seeds[projectId] ?? "") : ""))
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void useAccount.getState().load()
  }, [])

  useEffect(() => {
    if (projectId) useCopilot.getState().takeSeed(projectId)
  }, [projectId])

  const access = account ? copilotAccess(account) : null
  const viewer = useProjectStore((s) => s.role === "viewer")
  const gate: Gate = status === "signedOut" ? "signin" : access && access !== "ready" ? access : viewer ? "viewer" : null

  // The panel mounts when it opens, from its tab or ⌘L: either way the next thing is to type. The
  // account may have been asked before the session was there (Clean up asks it too), so a composer
  // that opens disabled takes the focus once it is enabled, unless the user has put it elsewhere.
  const focus = useRef<"mount" | "waiting" | "done">("mount")
  useEffect(() => {
    if (focus.current === "done") return
    if (gate) {
      focus.current = "waiting"
      return
    }
    const elsewhere = focus.current === "waiting" && document.activeElement !== document.body
    focus.current = "done"
    if (!elsewhere) inputRef.current?.focus()
  }, [gate])
  const model = account && access === "ready" ? copilotModel(account, preferred) : null
  const planGated = access === "upgrade" || access === "unavailable"
  const running = runningProject !== null

  // "Upgrade to Pro" opens in a new tab: coming back to this one should find the plan bought.
  useEffect(() => {
    if (!planGated) return
    const refresh = () => void useAccount.getState().load(true)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [planGated])
  const runningHere = !!projectId && runningProject === projectId
  const last = entries[entries.length - 1]
  const waiting = runningHere && (!last || last.kind === "user" || (last.kind === "tool" && last.status !== "running"))

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, waiting])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  if (!projectId) {
    return <div className="flex h-full items-center justify-center p-6 text-ink-3">Open a project to use Sakura.</div>
  }

  const submit = (text = draft) => {
    const trimmed = text.trim()
    if (!trimmed || running || gate) return
    send(projectId, trimmed)
    setDraft("")
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-1.5">
        <img src="/logo.svg" alt="" className="size-4 shrink-0" />
        <h2 className="text-[13px] font-[650] text-ink">Sakura</h2>
        {account && model && <ModelPicker models={account.plan.allowedModels} value={model} disabled={running} />}
        <div className="ml-auto flex items-center">
          <IconButton label="New conversation" disabled={running || !entries.length} onClick={() => clear(projectId)}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label="Hide Sakura" shortcut="⌘L" onClick={() => useUi.getState().setCopilotOpen(false)}>
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
      </div>

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {entries.length === 0 ? (
          <EmptyState gate={gate} unreachable={status === "error"} onPick={submit} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {entries.map((entry) => (
              <EntryView key={entry.id} entry={entry} projectId={projectId} busy={running} />
            ))}
            {waiting && (
              <div className="flex items-center gap-2 text-[12px] text-ink-3" aria-live="polite">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                Thinking
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            disabled={!!gate}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={gate === "signin" ? "Sign in to use Sakura" : gate ? "Not included in your plan" : "Describe a circuit or a change"}
            aria-label="Message Sakura"
            className="field scroll-thin max-h-40 min-h-8 resize-none leading-[1.4] disabled:bg-chrome"
          />
          {runningHere ? (
            <IconButton label="Stop" onClick={stop} className="shrink-0 border border-line">
              <Square size={13} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label="Send"
              disabled={!draft.trim() || running || !!gate}
              onClick={() => submit()}
              className="shrink-0 !bg-ink !text-surface hover:!bg-ink/85 disabled:!bg-chrome-2 disabled:!text-ink-3"
            >
              <ArrowUp size={16} />
            </IconButton>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          {running && !runningHere
            ? "Sakura is busy in another project."
            : "Enter to send, Shift+Enter for a new line. Changes can be undone."}
        </p>
      </div>
    </div>
  )
}

const EMPTY: Entry[] = []

/** The plan's models by their product names; just the name when there is one. */
function ModelPicker({ models, value, disabled }: { models: string[]; value: string; disabled: boolean }) {
  if (models.length < 2) {
    return <span className="truncate text-[11.5px] text-ink-3">{describeManagedModel(value).label}</span>
  }
  return (
    <select
      aria-label="Model"
      title={describeManagedModel(value).tagline}
      value={value}
      disabled={disabled}
      onChange={(e) => useUi.getState().updateSettings({ model: e.target.value })}
      className="h-7 min-w-0 truncate rounded-[6px] border border-transparent bg-transparent px-1 text-[12px] text-ink-2 outline-none hover:border-line focus:border-select disabled:opacity-60"
    >
      {models.map((id) => (
        <option key={id} value={id}>
          {describeManagedModel(id).label}
        </option>
      ))}
    </select>
  )
}

const signIn = () => managedAiHost()?.signIn?.()

function LinkButton({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-7 items-center gap-1 rounded-full bg-brand px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  )
}

function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-brand/25 bg-brand-soft/50 p-3">
      <div className="flex items-center gap-2 font-medium">
        <Sparkles size={15} className="shrink-0 text-brand" />
        {title}
      </div>
      <p className="mt-1 text-[12px] text-ink-2">{children}</p>
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  )
}

function GateNotice({ gate }: { gate: Exclude<Gate, null> }) {
  const host = managedAiHost()
  if (gate === "viewer") {
    return <Notice title="This project is shared with you to view">Sakura changes the board, so it works on projects you can edit. Ask the owner for edit access.</Notice>
  }
  if (gate === "signin") {
    return (
      <Notice
        title="Sign in to use Sakura"
        action={
          host?.signIn && (
            <Button variant="primary" onClick={signIn}>
              <LogIn size={14} />
              Sign in
            </Button>
          )
        }
      >
        Sakura runs on your Cherry Blossom plan.
      </Notice>
    )
  }
  if (gate === "upgrade") {
    return (
      <Notice title="Sakura is included from the Pro plan up" action={<LinkButton href={host?.upgradeUrl}>Upgrade to Pro</LinkButton>}>
        The Free plan is the whole editor, by hand. Upgrade to design with Sakura.
      </Notice>
    )
  }
  return <Notice title="Sakura isn't enabled for your account yet">Your boards are still here to edit by hand and export.</Notice>
}

function EmptyState({ gate, unreachable, onPick }: { gate: Gate; unreachable: boolean; onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <div>
        <h2 className="text-[15px] font-semibold">Design with Sakura</h2>
        <p className="mt-1 text-ink-2">
          Describe a circuit or a change. Sakura picks parts, creates the ones the library doesn't have, places them and wires them up.
        </p>
      </div>
      {gate && <GateNotice gate={gate} />}
      {!gate && unreachable && (
        <div className="flex items-center gap-2 rounded-[var(--radius-ctl)] bg-danger-soft px-2.5 py-2 text-[12px] text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span>Couldn't load your plan.</span>
          <button className="ml-auto font-medium underline underline-offset-2" onClick={() => void useAccount.getState().load(true)}>
            Retry
          </button>
        </div>
      )}
      {!gate && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-3">Try</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onPick(s)}
              className="rounded-[var(--radius-ctl)] border border-line px-2.5 py-2 text-left text-[12.5px] text-ink transition-colors hover:border-brand/40 hover:bg-brand-soft/60"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function FailureAction({ failure }: { failure?: FailureKind }) {
  const host = managedAiHost()
  if (failure === "signin" && host?.signIn) {
    return (
      <button className="ml-auto shrink-0 font-medium underline underline-offset-2" onClick={signIn}>
        Sign in
      </button>
    )
  }
  const href = failure === "plan" ? host?.upgradeUrl : failure === "limit" ? host?.accountUrl : undefined
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ml-auto shrink-0 font-medium underline underline-offset-2">
      {failure === "plan" ? "See plans" : "Manage usage"}
    </a>
  )
}

/** The blocks Clean up with AI proposes: shown whole, with the user's word asked before anything on the sheet changes. */
function PlanCard({ entry, projectId, busy }: { entry: Extract<Entry, { kind: "plan" }>; projectId: string; busy: boolean }) {
  const { plan, status } = entry
  const parts = plan.blocks.reduce((n, b) => n + b.refs.length, 0)
  return (
    <div className="rounded-[var(--radius-panel)] border border-brand/25 bg-brand-soft/40 p-3" aria-label="Proposed blocks">
      <div className="flex items-center gap-2 font-medium">
        <Boxes size={15} className="shrink-0 text-brand" />
        {plan.blocks.length} blocks for {parts} parts
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {plan.blocks.map((b) => (
          <li key={b.name} className="text-[12px] leading-[1.35]">
            <span className="font-semibold text-ink">{b.name}</span>
            {b.existing && <span className="text-ink-3"> (adds to your block)</span>}
            <span className="mono block text-ink-2">{b.refs.join(" ")}</span>
          </li>
        ))}
      </ul>
      {plan.left.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-3">
          {plan.left.length} {plan.left.length === 1 ? "part is" : "parts are"} not in the plan and go to OTHER: <span className="mono">{plan.left.join(" ")}</span>
        </p>
      )}
      <p className="mt-2 text-[12px] text-ink-3">Parts already in a block stay in it. Connections never change, and one undo brings everything back.</p>
      <div className="mt-2.5 flex items-center gap-2">
        {status === "pending" ? (
          <>
            <Button variant="primary" disabled={busy} onClick={() => useCopilot.getState().applyPlan(projectId, entry.id)}>
              Apply
            </Button>
            <Button disabled={busy} onClick={() => useCopilot.getState().cancelPlan(projectId, entry.id)}>
              Cancel
            </Button>
          </>
        ) : (
          <span className="text-[12px] font-medium text-ink-2">
            {status === "applying" ? "Applying..." : status === "applied" ? "Applied" : status === "cancelled" ? "Not applied" : "Out of date"}
          </span>
        )}
      </div>
    </div>
  )
}

function EntryView({ entry, projectId, busy }: { entry: Entry; projectId: string; busy: boolean }) {
  switch (entry.kind) {
    case "plan":
      return <PlanCard entry={entry} projectId={projectId} busy={busy} />
    case "user":
      return (
        <div className="ml-6 self-end whitespace-pre-wrap rounded-[10px] bg-chrome px-3 py-2 text-ink">{entry.text}</div>
      )
    case "assistant":
      return <RichText text={entry.text} />
    case "tool":
      return (
        <div className="flex items-start gap-1.5 text-[12px] leading-[1.35] text-ink-2">
          <span className="mt-px shrink-0">
            {entry.status === "running" ? (
              <Loader2 size={13} className="animate-spin text-ink-3" />
            ) : entry.status === "error" ? (
              <AlertTriangle size={13} className="text-warn" />
            ) : entry.changed ? (
              <Check size={13} className="text-ok" />
            ) : (
              <CornerDownRight size={13} className="text-ink-3" />
            )}
          </span>
          <span className={entry.status === "error" ? "text-warn" : entry.changed ? "text-ink" : ""}>{entry.label}</span>
        </div>
      )
    case "error":
      return (
        <div className="flex items-start gap-1.5 rounded-[var(--radius-ctl)] bg-danger-soft px-2.5 py-2 text-[12px] text-danger">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{entry.text}</span>
          <FailureAction failure={entry.failure} />
        </div>
      )
  }
}

/** Minimal formatting for assistant replies: paragraphs, bullet/numbered lists, `code`, **bold**. */
function RichText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/)
  return (
    <div className="flex flex-col gap-2 text-ink">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim())
        const bullet = /^\s*[-*•]\s+/
        const numbered = /^\s*\d+[.)]\s+/
        if (lines.length && lines.every((l) => bullet.test(l))) {
          return (
            <ul key={i} className="ml-4 list-disc space-y-0.5 marker:text-ink-3">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(bullet, ""))}</li>
              ))}
            </ul>
          )
        }
        if (lines.length && lines.every((l) => numbered.test(l))) {
          return (
            <ol key={i} className="ml-4 list-decimal space-y-0.5 marker:text-ink-3">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(numbered, ""))}</li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#+\s+/, ""))}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="mono rounded-[4px] bg-chrome px-1 py-px text-[12px]">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}
