import { Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import { isPhysical } from "../model/instances"
import { findPart } from "../model/library"
import { onBoard } from "../model/partFlags"
import {
  addNetClass,
  assignNet,
  classIndex,
  classNameOf,
  classNameProblem,
  defaultClassName,
  findClearanceRule,
  removeClearanceRule,
  removeNetClass,
  renameNetClass,
  setClassDescription,
  setClassField,
  setClassPatterns,
  setClearanceRule,
  setDefaultClassField,
  splitPatterns,
  type ClassField,
} from "../model/netClasses"
import { formatLength } from "../model/rules"
import type { ClearanceRule, DesignRules, NetClass, Project } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { projectApi } from "../store/projectStore"
import { Button, Field, IconButton } from "../ui/controls"
import { CommitInput, LengthInput, RuleGroup, RuleRow, Section, useLengthUnit } from "../ui/form"

const commitRules = (fn: (r: DesignRules) => DesignRules) => projectApi().commit((p) => ({ ...p, rules: fn(p.rules), updatedAt: Date.now() }))

/** The nets that carry something, by name: the ones a class can take. */
export function netNames(project: Project): string[] {
  return getConnectivity(project)
    .nets.filter((n) => n.pins.length > 0)
    .map((n) => n.name)
}

/** Net classes: each class's clearance, widths and via sizes, and which nets are in it. A net in none is in Default, which is the design rules above. */
export function NetClassesSection({ project }: { project: Project }) {
  const rules = project.rules
  const classes = rules.netClasses ?? []
  const names = netNames(project)
  return (
    <Section
      title="Net classes"
      id="net-classes"
      action={
        <Button onClick={() => commitRules((r) => addNetClass(r, "Class"))} className="px-2" aria-label="Add a net class">
          <Plus size={14} /> Add
        </Button>
      }
    >
      {classes.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">Every net is in the {defaultClassName(rules)} class, which is the design rules above. Add a class to give some nets their own clearance, trace width and via size.</p>
      ) : (
        <p className="text-[11.5px] text-ink-3">
          Two nets are checked at the larger of their classes&apos; clearances. A class width or via size applies to new copper and the autorouter; a width set for one net wins over its class&apos;s.
        </p>
      )}
      {classes.map((c) => (
        <ClassCard key={c.name} cls={c} rules={rules} nets={names} />
      ))}
      {(classes.length > 0 || rules.defaultClass) && <DefaultClassCard rules={rules} />}
    </Section>
  )
}

/**
 * Clearance rules: a clearance of its own for one pair of nets, or for one part's pads against every other net, that replaces the
 * classes'. Sakura and an assistant over MCP set them with `set_clearance_rule`; here they are seen, changed and removed, and made.
 */
export function ClearanceRulesSection({ project }: { project: Project }) {
  const rules = project.rules
  const list = rules.clearanceRules ?? []
  const names = netNames(project)
  const parts = project.components.filter((c) => onBoard(c) && isPhysical(findPart(c.partId))).map((c) => ({ id: c.id, ref: c.ref }))
  const [a, setA] = useState("")
  const [b, setB] = useState("")
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const label = (r: ClearanceRule) => (r.nets ? `${r.nets[0]} and ${r.nets[1]}` : `${refOf.get(r.component!) ?? "a removed part"}'s pads`)
  const target = (r: ClearanceRule): Pick<ClearanceRule, "nets" | "component"> => (r.nets ? { nets: r.nets } : { component: r.component })
  // A new rule starts where it loosens nothing: a pair at the clearance it is checked at now, a part's pads at the largest any class asks for.
  const pairNow = classIndex(rules).pair(a || null, b || null)
  const partStart = Math.max(rules.clearance, rules.minClearance ?? 0, ...(rules.netClasses ?? []).map((c) => c.clearance ?? rules.clearance))
  const pairTaken = !!a && !!b && !!findClearanceRule(list, { nets: [a, b] })
  return (
    <Section title="Clearance rules" id="clearance-rules">
      <p className="text-[11.5px] text-ink-3">
        A clearance for two nets, or for one part&apos;s pads against every other net, in place of the classes&apos;, smaller or larger. Where several apply, the largest does; never below the board&apos;s minimum.
      </p>
      {list.map((r) => (
        <RuleRow key={label(r)} label={label(r)} hint={r.nets ? "Copper of one net to copper of the other" : "This part's pads to copper of any other net"}>
          <div className="flex items-center gap-1">
            <LengthInput ariaLabel={`Clearance of ${label(r)}`} min={0} value={r.clearance} onCommit={(v) => v !== null && commitRules((x) => setClearanceRule(x, { ...target(r), clearance: v }))} />
            <IconButton label={`Remove the clearance rule for ${label(r)}`} onClick={() => commitRules((x) => removeClearanceRule(x, target(r)))}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        </RuleRow>
      ))}
      <div className="mt-1 flex items-center gap-1">
        <select className="field h-8 min-w-0 flex-1" aria-label="First net of a new clearance rule" value={a} onChange={(e) => setA(e.target.value)}>
          <option value="">Net...</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select className="field h-8 min-w-0 flex-1" aria-label="Second net of a new clearance rule" value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">and net...</option>
          {names
            .filter((n) => n !== a)
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
        </select>
        <Button
          className="px-2"
          aria-label="Add a clearance rule for the two nets"
          title={pairTaken ? `${a} and ${b} already have a clearance rule` : undefined}
          disabled={!a || !b || a === b || pairTaken}
          onClick={() => {
            commitRules((x) => setClearanceRule(x, { nets: [a, b], clearance: pairNow }))
            setA("")
            setB("")
          }}
        >
          <Plus size={14} />
        </Button>
      </div>
      {parts.length > 0 && (
        <select
          className="field mt-1 h-8 w-full"
          aria-label="Add a clearance rule for a part's pads"
          value=""
          onChange={(e) => {
            const id = e.target.value
            if (id) commitRules((x) => setClearanceRule(x, { component: id, clearance: partStart }))
          }}
        >
          <option value="">Add one for a part&apos;s pads...</option>
          {parts
            .filter((c) => !list.some((r) => r.component === c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.ref}
              </option>
            ))}
        </select>
      )}
    </Section>
  )
}

/** The tooltip on a class entry that matches no net of the board. */
export const STALE_NET_HINT = "No net on this board has this name, so this entry does nothing. A net may have been renamed. Take it out, or add the net under its new name."

const FIELD_ROWS: { field: ClassField; label: string; hint: string; group: "main" | "pair" | "micro" }[] = [
  { field: "clearance", label: "Clearance", hint: "Copper to copper of another net", group: "main" },
  { field: "traceWidth", label: "Trace width", hint: "Width of new traces and the autorouter's on these nets", group: "main" },
  { field: "viaDiameter", label: "Via diameter", hint: "Copper diameter of new vias on these nets", group: "main" },
  { field: "viaDrill", label: "Via drill", hint: "Drill of new vias on these nets", group: "main" },
  { field: "diffPairWidth", label: "Pair trace width", hint: "Width of each trace of a differential pair", group: "pair" },
  { field: "diffPairGap", label: "Pair gap", hint: "Gap between the traces of a differential pair", group: "pair" },
  { field: "microViaDiameter", label: "Micro via diameter", hint: "Kept with the class; the editor draws no micro vias yet", group: "micro" },
  { field: "microViaDrill", label: "Micro via drill", hint: "Kept with the class; the editor draws no micro vias yet", group: "micro" },
]

function ClassCard({ cls, rules, nets }: { cls: NetClass; rules: DesignRules; nets: string[] }) {
  const unit = useLengthUnit()
  const base = classIndex(rules).base
  const index = classIndex(rules)
  const inherited = (field: ClassField): string => {
    const v = base[field]
    return v === undefined ? "" : formatLength(v, unit)
  }
  const available = nets.filter((n) => !cls.nets.includes(n))
  const byPattern = nets.filter((n) => !cls.nets.includes(n) && index.classOf(n) === cls)
  return (
    <div className="mt-2 space-y-1 rounded-[8px] border border-line px-2.5 py-2" role="group" aria-label={`Net class ${cls.name}`}>
      <div className="flex items-center gap-1.5">
        <CommitInput
          ariaLabel="Net class name"
          mono
          value={cls.name}
          onCommit={(v) => {
            if (!classNameProblem(rules, v, cls.name)) commitRules((r) => renameNetClass(r, cls.name, v))
          }}
          className="flex-1"
        />
        <IconButton label={`Delete the class ${cls.name}`} onClick={() => commitRules((r) => removeNetClass(r, cls.name))}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <CommitInput ariaLabel="Net class description" placeholder="Description" value={cls.description ?? ""} onCommit={(v) => commitRules((r) => setClassDescription(r, cls.name, v))} />
      {(["main", "pair", "micro"] as const).map((group) => (
        <RuleGroup key={group} title={group === "main" ? "Sizes" : group === "pair" ? "Differential pair" : "Micro via"}>
          {FIELD_ROWS.filter((f) => f.group === group).map((f) => (
            <RuleRow key={f.field} label={f.label} hint={f.hint}>
              <LengthInput
                ariaLabel={`${cls.name} ${f.label}`}
                min={0}
                optional
                placeholder={inherited(f.field) || "Default"}
                value={cls[f.field] ?? null}
                onCommit={(v) => commitRules((r) => setClassField(r, cls.name, f.field, v === null ? undefined : v))}
              />
            </RuleRow>
          ))}
        </RuleGroup>
      ))}
      <Field label="Nets" hint="A net takes the class that lists it first; a net no class lists takes the first whose pattern fits, and every other is in Default.">
        <div className="space-y-1">
          {cls.nets.length === 0 && <p className="text-[12px] text-ink-3">No nets yet.</p>}
          <ul className="flex flex-wrap gap-1">
            {cls.nets.map((n) => {
              // a net the board no longer has (after a label rename, say) is listed but changes nothing
              const stale = !nets.includes(n)
              return (
                <li
                  key={n}
                  data-stale={stale ? "true" : undefined}
                  title={stale ? STALE_NET_HINT : undefined}
                  className={`flex items-center gap-1 rounded-[6px] bg-chrome px-1.5 py-0.5 text-[12px] ${stale ? "opacity-50" : ""}`}
                >
                  <span className={`mono ${stale ? "line-through" : ""}`}>{n}</span>
                  <button type="button" aria-label={`Take ${n} out of ${cls.name}`} className="text-ink-3 hover:text-ink" onClick={() => commitRules((r) => assignNet(r, n, null))}>
                    <X size={12} />
                  </button>
                </li>
              )
            })}
          </ul>
          {available.length > 0 && (
            <select
              className="field h-8 w-full"
              aria-label={`Add a net to ${cls.name}`}
              value=""
              onChange={(e) => {
                const net = e.target.value
                if (net) commitRules((r) => assignNet(r, net, cls.name))
              }}
            >
              <option value="">Add a net...</option>
              {available.map((n) => (
                <option key={n} value={n}>
                  {n}
                  {index.classOf(n) ? ` (now in ${classNameOf(rules, n)})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </Field>
      <Field label="Patterns" hint="Net names with * for any run and ? for one character, or a regular expression (both read the whole name), as KiCad's net class patterns. Separate with commas.">
        <CommitInput
          ariaLabel={`${cls.name} patterns`}
          mono
          placeholder="e.g. USB_*, (A|B)[0-9]"
          value={(cls.patterns ?? []).join(", ")}
          onCommit={(v) => commitRules((r) => setClassPatterns(r, cls.name, splitPatterns(v)))}
        />
        {byPattern.length > 0 && (
          <p className="mt-1 text-[11.5px] text-ink-3">
            Also takes {byPattern.length} net{byPattern.length === 1 ? "" : "s"} by pattern: <span className="mono">{byPattern.slice(0, 4).join(", ")}{byPattern.length > 4 ? ", ..." : ""}</span>
          </p>
        )}
      </Field>
    </div>
  )
}

/** In the nets list: which class the highlighted net is in, and a way to change it. */
export function NetClassField({ project, net }: { project: Project; net: string }) {
  const rules = project.rules
  const classes = rules.netClasses ?? []
  if (!classes.length) return null
  const current = classIndex(rules).classOf(net)
  const listed = classes.some((c) => c.nets.includes(net))
  return (
    <Field label={`Net class of ${net}`} hint={current && !listed ? "In this class by one of its patterns. Choosing another class lists the net there, which wins over patterns; to take it out of the class, change the pattern." : undefined}>
      <select
        className="field h-8 w-full"
        aria-label={`Net class of ${net}`}
        value={current?.name ?? ""}
        onChange={(e) => commitRules((r) => assignNet(r, net, e.target.value || null))}
      >
        <option value="">{defaultClassName(rules)}</option>
        {classes.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  )
}

const DEFAULT_ONLY = [
  { field: "diffPairWidth", label: "Pair trace width", hint: "Width of each trace of a differential pair in the Default class" },
  { field: "diffPairGap", label: "Pair gap", hint: "Gap between the traces of a differential pair in the Default class" },
  { field: "microViaDiameter", label: "Micro via diameter", hint: "Kept with the class; the editor draws no micro vias yet" },
  { field: "microViaDrill", label: "Micro via drill", hint: "Kept with the class; the editor draws no micro vias yet" },
] as const

/** What the Default class has besides the design rules (a differential pair, micro vias), and the name and description it came with. */
function DefaultClassCard({ rules }: { rules: DesignRules }) {
  const d = rules.defaultClass
  return (
    <div className="mt-2 space-y-1 rounded-[8px] border border-line px-2.5 py-2" role="group" aria-label={`Net class ${defaultClassName(rules)}`}>
      <p className="mono text-[12.5px] text-ink">{defaultClassName(rules)}</p>
      <p className="text-[11.5px] text-ink-3">{d?.description ?? "The design rules above: every net no class lists."}</p>
      {DEFAULT_ONLY.map((f) => (
        <RuleRow key={f.field} label={f.label} hint={f.hint}>
          <LengthInput ariaLabel={`Default ${f.label}`} min={0} optional placeholder="none" value={d?.[f.field] ?? null} onCommit={(v) => commitRules((r) => setDefaultClassField(r, f.field, v === null ? undefined : v))} />
        </RuleRow>
      ))}
    </div>
  )
}
