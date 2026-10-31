import { ChevronRight, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import { useMemo, useState } from "react"
import { describeVerify, verifyProjectParts, withPartChecks } from "../ai/partTools"
import { lookupFailure, supplierParts } from "../ai/supplierParts"
import { unconnectedPinSeverity } from "../model/checkRules"
import { ignoreCheck, restoreCheck, splitIgnored, type ErcFinding } from "../model/erc"
import { needsCheck, partFindings } from "../model/partChecks"
import type { DrcViolation } from "../model/pcb"
import type { Project } from "../model/types"
import { useConnectivity, useErc, usePcbAnalysis } from "../store/analysis"
import { projectApi, useProjectStore } from "../store/projectStore"
import { uiApi } from "../store/uiStore"

export interface CheckItem {
  id: string
  severity: "error" | "warning"
  message: string
  where: "schematic" | "pcb"
  at: { x: number; y: number } | null
  /** Every place with this same finding; the list shows one row and steps through them. */
  ats: { x: number; y: number }[]
  count: number
  /** Selection a click makes, e.g. ["c:<id>"] for the part an electrical check is about. */
  select?: string[]
  /** Set on electrical checks, which can be ignored (`Project.ignoredChecks`). */
  ignoreKey?: string
}

/** An electrical check finding as a row of the list: a warning, unless a project from KiCad sets its rule to an error. */
const ercItem = (f: ErcFinding): CheckItem => ({
  id: `erc:${f.key}`,
  severity: f.severity ?? "warning",
  message: f.message,
  where: "schematic",
  at: f.at,
  ats: [f.at],
  count: 1,
  select: [...f.componentIds.map((id) => `c:${id}`), ...f.labelIds.map((id) => `l:${id}`)],
  ignoreKey: f.key,
})

/** Electrical check findings the user has ignored, as rows. */
export function useIgnoredChecks(): CheckItem[] {
  const ignoredKeys = useProjectStore((s) => s.project?.ignoredChecks)
  const erc = useErc()
  return useMemo(() => (erc ? splitIgnored(erc, ignoredKeys).ignored.map(ercItem) : []), [erc, ignoredKeys])
}

export function useChecks(): CheckItem[] {
  const project = useProjectStore((s) => s.project)
  const conn = useConnectivity()
  const pcb = usePcbAnalysis()
  const erc = useErc()
  return useMemo(() => {
    if (!project || !conn || !pcb || !erc) return []
    const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
    const items: CheckItem[] = []
    const byMessage = new Map<string, CheckItem>()
    const add = (item: Omit<CheckItem, "ats" | "count">) => {
      const key = `${item.severity}:${item.where}:${item.message}`
      const same = byMessage.get(key)
      if (same) {
        same.count++
        if (item.at) same.ats.push(item.at)
        return
      }
      const full = { ...item, ats: item.at ? [item.at] : [], count: 1 }
      byMessage.set(key, full)
      items.push(full)
    }
    // A pin left open is a warning here; on a project from KiCad it is what the project makes KiCad's `pin_not_connected`, and not listed when it ignores it.
    const openPin = unconnectedPinSeverity(project)
    for (const p of openPin ? conn.unconnectedPins : []) {
      add({
        id: `u${p.componentId}${p.pin}`,
        severity: openPin!,
        message: `${refOf.get(p.componentId)} pin ${p.pin} (${p.name}) isn't connected`,
        where: "schematic",
        at: p.pos,
      })
    }
    // One row each: their messages name the part, so there is nothing to group.
    for (const f of splitIgnored(erc, project.ignoredChecks).active) items.push(ercItem(f))
    // The pours of an edit are being filled again: say so, so no finding below is taken for one of the new fill.
    if (pcb.zonesPending) {
      items.push({ id: "pours-pending", severity: "warning", message: "Copper pours are being refilled. The board checks below are of the last fill and will update.", where: "pcb", at: null, ats: [], count: 1 })
    }
    const unrouted = pcb.violations.filter((v) => v.kind === "unrouted")
    if (unrouted.length) {
      items.push({
        id: "unrouted",
        severity: unrouted[0].severity,
        message: `${unrouted.length} ${unrouted.length === 1 ? "connection is" : "connections are"} not routed yet`,
        where: "pcb",
        at: unrouted[0].at,
        ats: unrouted.map((v) => v.at),
        count: 1,
      })
    }
    for (const v of pcb.violations.filter((x: DrcViolation) => x.kind !== "unrouted")) {
      add({ id: v.id, severity: v.severity, message: v.message, where: "pcb", at: v.at })
    }
    // Project parts: where their pinout and land came from, and whether a supplier contradicts
    // them. First among their severity: one unverified part outweighs its unconnected pins.
    const parts: CheckItem[] = partFindings(project).map((f) => {
      const ats = project.components.filter((c) => f.componentIds.includes(c.id)).map((c) => ({ x: c.sch.x, y: c.sch.y }))
      return { id: `part:${f.partId}:${f.message}`, severity: f.severity, message: f.message, where: "schematic", at: ats[0] ?? null, ats, count: 1 }
    })
    return [...parts, ...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
  }, [project, conn, pcb, erc])
}

/** Parts made from memory and never checked: what the "Check against supplier data" button checks. */
const uncheckedParts = (project: Project | null) =>
  (project?.parts ?? []).filter((s) => needsCheck(s) && project!.components.some((c) => c.partId === s.id))

/** Check the project's unverified parts against supplier data and record the results, as one undoable edit. */
function VerifyParts() {
  const project = useProjectStore((s) => s.project)
  // A viewer can't record what a check finds, and each check spends their own lookups.
  const viewer = useProjectStore((s) => s.role === "viewer")
  const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null })
  const source = supplierParts()
  const pending = uncheckedParts(project)
  if (!source || !project || !pending.length || viewer) return state.note ? <p className="border-b border-line px-4 py-2 text-[12px] text-ink-2">{state.note}</p> : null
  const run = async () => {
    setState({ busy: true, note: null })
    try {
      const outcome = await verifyProjectParts(project, source, { only: pending.map((s) => s.id) })
      const open = useProjectStore.getState().project
      if (!open || open.id !== project.id) return setState({ busy: false, note: null })
      const { results } = outcome
      if (results.size) useProjectStore.getState().commit((p) => withPartChecks(p, results))
      const bad = [...results.values()].filter((r) => r.verdict === "contradicted").length
      // Lookups that failed are said so, with counts: "Checked 0" would read as nothing to check.
      setState({ busy: false, note: `${describeVerify(outcome).replace(/^Checked (\d+)/, "Checked $1 against supplier data")}${bad ? ` ${bad} contradicted.` : ""}` })
    } catch (e) {
      setState({ busy: false, note: lookupFailure(e) })
    }
  }
  return (
    <div className="border-b border-line px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-ink-2">
          {pending.length} part{pending.length === 1 ? " isn't" : "s aren't"} checked against a supplier yet.
        </p>
        <button className="shrink-0 rounded-md bg-chrome-2 px-2.5 py-1 text-[12px] text-ink hover:bg-chrome disabled:opacity-60" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? "Checking…" : "Check against supplier data"}
        </button>
      </div>
      {state.note && <p className="mt-1.5 text-[12px] text-ink-2">{state.note}</p>}
    </div>
  )
}

/** Problems a list of checks adds up to, counting each place a grouped finding occurs. */
export const checkTotals = (checks: CheckItem[]) => {
  const errors = checks.reduce((n, c) => n + (c.severity === "error" ? c.count : 0), 0)
  return { errors, warnings: checks.reduce((n, c) => n + c.count, 0) - errors }
}

export function ChecksPanel() {
  const checks = useChecks()
  const ignored = useIgnoredChecks()
  const { errors } = checkTotals(checks)
  // Which occurrence of each grouped finding the next click goes to.
  const [step, setStep] = useState<Record<string, number>>({})
  const [showIgnored, setShowIgnored] = useState(false)
  const jump = (c: CheckItem) => {
    const i = (step[c.id] ?? 0) % c.ats.length
    const at = c.ats[i]
    // Focus first: a change of view drops the selection, so select after it.
    if (at) uiApi().focus(c.where, at.x, at.y)
    if (c.select) uiApi().select(c.select)
    setStep({ ...step, [c.id]: i + 1 })
  }
  const ignoredList = ignored.length > 0 && (
    <section className="border-b border-line">
      <h3>
        <button
          type="button"
          aria-expanded={showIgnored}
          onClick={() => setShowIgnored(!showIgnored)}
          className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[12px] text-ink-2 hover:text-ink"
        >
          <ChevronRight size={12} className={`shrink-0 text-ink-3 transition-transform ${showIgnored ? "rotate-90" : ""}`} />
          <span className="flex-1">Ignored</span>
          <span className="mono text-[11px] text-ink-3">{ignored.length}</span>
        </button>
      </h3>
      {showIgnored && (
        <ul>
          {ignored.map((c) => (
            <li key={c.id} className="flex items-start gap-2 border-t border-chrome-2 px-4 py-2 pl-[30px]">
              <button type="button" className="min-w-0 flex-1 text-left text-[12.5px] text-ink-3 hover:text-ink-2" onClick={() => jump(c)}>
                {c.message}
              </button>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-ink-2 hover:bg-chrome-2 hover:text-ink"
                onClick={() => projectApi().commit((p) => restoreCheck(p, c.ignoreKey!))}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
  if (!checks.length) {
    return (
      <div>
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <CircleCheck size={28} className="text-ok" />
          <p className="mt-3 font-[600] text-ink">No problems found</p>
          <p className="mt-1 text-[12.5px] text-ink-2">Every pin is connected, every net is routed and the board meets its design rules.</p>
        </div>
        {ignoredList}
      </div>
    )
  }
  return (
    <div>
      <VerifyParts />
      <p className="border-b border-line px-4 py-3 text-[12.5px] text-ink-2">
        {errors ? `${errors} ${errors === 1 ? "error blocks" : "errors block"} fabrication. ` : "No errors. "}
        Select an item to jump to it.
      </p>
      <ul>
        {checks.map((c) => (
          <li key={c.id} className="flex items-start border-b border-chrome-2 hover:bg-chrome">
            <button
              className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-2.5 text-left disabled:cursor-default"
              disabled={!c.ats.length}
              onClick={() => jump(c)}
            >
              {c.severity === "error" ? <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" /> : <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{c.message}</span>
                <span className="block text-[11.5px] text-ink-3">
                  {c.where === "pcb" ? "PCB" : "Schematic"}
                  {c.count > 1 && ` · ${c.count} places, select to step through them`}
                </span>
              </span>
              {c.count > 1 && <span className="mono mt-0.5 shrink-0 rounded-full bg-chrome-2 px-1.5 text-[11px] text-ink-2">{c.count}</span>}
            </button>
            {c.ignoreKey && (
              <button
                type="button"
                title="Stop warning about this. It stays under Ignored, where you can restore it."
                className="mr-3 mt-2 shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-chrome-2 hover:text-ink"
                onClick={() => projectApi().commit((p) => ignoreCheck(p, c.ignoreKey!))}
              >
                Ignore
              </button>
            )}
          </li>
        ))}
      </ul>
      {ignoredList}
    </div>
  )
}
