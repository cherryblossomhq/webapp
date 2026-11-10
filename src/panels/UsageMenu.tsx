import type { MeResponse } from "@cherryblossom/api-contract"
import { ArrowUpRight, Gauge } from "lucide-react"
import { useRef, useState } from "react"
import { managedAiHost } from "../ai/managedAi"
import { useAccount } from "../store/accountStore"
import { IconButton, useDismiss } from "../ui/controls"

/**
 * The button in Sakura's header, after the chat history, that opens the account's AI usage: this
 * period's credits, today's actions, gift credits and credits bought, as `GET /api/v1/me` has them.
 * Opening it fetches them again, since every request Sakura makes spends some. Changing any of it
 * is the host's usage page.
 */
export function UsageMenu({ account }: { account: MeResponse }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  const toggle = () => {
    if (!open) void useAccount.getState().load(true)
    setOpen(!open)
  }
  // Not positioned: the card opens under the panel's header, at its right, as the chat history opens across it.
  return (
    <div ref={ref} className="shrink-0">
      <IconButton label="AI usage" active={open} aria-expanded={open} onClick={toggle}>
        <Gauge size={15} />
      </IconButton>
      {open && <Usage account={account} />}
    </div>
  )
}

function Usage({ account }: { account: MeResponse }) {
  const { plan, limits, usage, credits } = account
  const accountUrl = managedAiHost()?.accountUrl
  // Past the allowance the month keeps counting what gift and bought credits paid for, so
  // the allowance reads full, never over (as the account page has it).
  const included = Math.min(usage.monthlyTokens, limits.monthlyTokens)
  const gift = usage.giftCredits ?? 0
  return (
    <div
      role="dialog"
      aria-label="AI usage"
      className="absolute right-2 top-11 z-30 flex w-[272px] max-w-[calc(100%-16px)] flex-col gap-3 rounded-[10px] border border-line bg-surface p-3 shadow-menu"
    >
      <div className="text-[12.5px] font-[650] text-ink">{plan.name} plan</div>
      <Meter
        label="AI credits this period"
        used={included}
        total={limits.monthlyTokens}
        format={compact}
        note={usage.monthResetsAt ? `Resets ${day(usage.monthResetsAt)}` : "The 30-day period starts with your first request"}
      />
      <Meter
        label="AI actions today"
        used={usage.requestsThisDay}
        total={limits.requestsPerDay}
        format={(n) => n.toLocaleString("en-US")}
        note={usage.dayResetsAt ? `Resets at ${time(usage.dayResetsAt)}` : "One action is one model call; a request makes several"}
      />
      {(gift > 0 || credits.available || credits.balance > 0) && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2.5 text-[12px]">
          {gift > 0 && <Row label="Gift credits" value={`${compact(gift)} left`} />}
          {(credits.available || credits.balance > 0) && (
            <Row
              label="Credits bought"
              value={`${usd(credits.balanceCents)} left${credits.refilling ? ", refilling" : credits.autoRefill ? ", auto-refill on" : ""}`}
            />
          )}
        </div>
      )}
      {accountUrl && (
        <a
          href={accountUrl}
          target="_blank"
          rel="noreferrer"
          className="-mb-0.5 inline-flex items-center gap-1 self-start text-[12px] font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline"
        >
          Manage usage
          <ArrowUpRight size={13} />
        </a>
      )}
    </div>
  )
}

function Meter({ label, used, total, format, note }: { label: string; used: number; total: number; format: (n: number) => string; note: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const fill = pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-brand"
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-ink-2">{label}</span>
        <span className="shrink-0 tabular-nums text-ink">
          {format(used)} of {format(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        className="h-1.5 overflow-hidden rounded-full bg-chrome-2"
      >
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-ink-3">{note}</p>
    </div>
  )
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-2">
    <span className="text-ink-2">{label}</span>
    <span className="tabular-nums text-ink">{value}</span>
  </div>
)

/** Credits as the account page writes them: 4M, 1.5M, 320K. */
function compact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return n.toLocaleString("en-US")
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric" })
const time = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
