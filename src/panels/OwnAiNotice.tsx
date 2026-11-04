import { ArrowUpRight } from "lucide-react"
import type { AssistantClient } from "../ai/managedAi"
import { ASSISTANTS } from "./assistantLogos"

// What a plan without Sakura is offered beside the upgrade: the user's own assistant, through the
// MCP server every plan has. Its model runs on the user's subscription, so it costs us no credit and
// Free keeps it. Each client links to its own steps on the host's page.

export function OwnAiNotice({ page, guides }: { page: string; guides?: Partial<Record<AssistantClient, string>> }) {
  return (
    <section aria-label="Bring your own AI" className="rounded-[var(--radius-panel)] border border-line p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ok">Free on every plan</p>
      <h3 className="mt-1 font-medium leading-[1.3] text-ink">Use the Claude or ChatGPT you already pay for</h3>
      <p className="mt-1 text-[12px] text-ink-2">
        Connect it to Cherry Blossom and it designs with Sakura&apos;s tools: real parts from supplier data, wiring,
        layout, routing and checks. Every edit lands live in this tab.
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {ASSISTANTS.map((c) => (
          <li key={c.id}>
            <a
              href={guides?.[c.id] ?? page}
              target="_blank"
              rel="noreferrer"
              aria-label={`Connect ${c.name}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[12px] text-ink transition-colors hover:border-brand/40 hover:bg-brand-soft/60"
            >
              {c.logo}
              {c.name}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 flex items-center gap-1 text-[11.5px] text-ink-3">
        No API key: add the server and sign in.
        <a href={page} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium text-ink-2 hover:text-ink">
          How it works
          <ArrowUpRight size={12} />
        </a>
      </p>
    </section>
  )
}
