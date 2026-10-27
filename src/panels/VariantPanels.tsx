import { useState } from "react"
import { findPart } from "../model/library"
import type { ComponentInstance, Project } from "../model/types"
import { activeVariant, addVariant, removeVariant, renameVariant, setActiveVariant, setVariantOverride, variantNames, type VariantFlag } from "../model/variants"
import { projectApi, useProjectStore } from "../store/projectStore"
import { Button, Field } from "../ui/controls"
import { CommitInput, Row, Section } from "../ui/form"

// S9: schematic variants in the Inspector. The project section lists the variants and chooses the one the BOM, the position file, the do not
// populate marks and the board follow (`model/variants.ts` is the one resolver); a symbol's section says what each variant changes on it.

const commit = (fn: (p: Project) => Project | null) => projectApi().commit((p) => fn(p) ?? p)

/** How many symbols and sheet symbols a variant changes something on. */
const touched = (project: Project, name: string) => project.components.filter((c) => c.variants?.[name]).length + (project.sheetSymbols ?? []).filter((s) => Object.values(s.variants ?? {}).some((per) => per[name])).length

export function VariantsSection({ project }: { project: Project }) {
  const names = variantNames(project)
  const active = activeVariant(project)
  // A viewer looks at the variants: the store would refuse each of these, so none is offered.
  const viewer = useProjectStore((s) => s.role === "viewer")
  const [draft, setDraft] = useState("")
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState("")
  if (!names.length && !project.components.length) return null
  const add = () => {
    const res = addVariant(projectApi().project!, draft)
    if (!res) {
      setError(draft.trim() ? `There is already a variant called ${draft.trim()}.` : "Give the variant a name.")
      return
    }
    setError("")
    setDraft("")
    commit(() => res)
  }
  return (
    <Section title="Variants" id="variants">
      <Field label="Shown">
        <select
          className="field h-8"
          value={active ?? ""}
          disabled={!names.length || viewer}
          onChange={(e) => commit((p) => setActiveVariant(p, e.target.value === "" ? undefined : e.target.value))}
          aria-label="Active variant"
        >
          <option value="">None: the symbols as they are</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[12px] text-ink-2">The BOM, the position file, the do not populate marks, the board and the exports follow the variant shown.</p>
      {names.map((n) => (
        <div key={n} className="flex items-center justify-between gap-2">
          <CommitInput value={n} ariaLabel={`Name of variant ${n}`} onCommit={(v) => commit((p) => renameVariant(p, n, v))} />
          <span className="shrink-0 text-[12px] text-ink-2">{touched(project, n)} changed</span>
          {removing === n ? (
            <span className="flex shrink-0 items-center gap-1">
              <Button
                disabled={viewer}
                onClick={() => {
                  commit((p) => removeVariant(p, n))
                  setRemoving(null)
                }}
              >
                Remove it
              </Button>
              <Button onClick={() => setRemoving(null)}>Keep</Button>
            </span>
          ) : (
            <Button disabled={viewer} onClick={() => setRemoving(n)} aria-label={`Remove variant ${n}`}>
              Remove
            </Button>
          )}
        </div>
      ))}
      {removing && <p className="text-[12px] text-ink-2">Removing a variant also removes what it changes on {touched(project, removing)} symbol{touched(project, removing) === 1 ? "" : "s"}.</p>}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input className="field h-8 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New variant" aria-label="New variant name" disabled={viewer} />
        <Button type="submit" disabled={viewer}>
          Add
        </Button>
      </form>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}

const FLAG_ROWS: { key: VariantFlag; label: string }[] = [
  { key: "dnp", label: "Do not populate" },
  { key: "excludeFromBom", label: "Not in the BOM" },
  { key: "excludeFromPos", label: "Not in the position file" },
  { key: "notOnBoard", label: "Not on the board" },
  { key: "excludeFromSim", label: "Left out of simulation" },
]

const stateOf = (v: boolean | undefined) => (v === undefined ? "" : v ? "on" : "off")

/** What each variant changes on one symbol: a flag set, cleared or left as the symbol has it, and a value of its own. */
export function ComponentVariantsSection({ c, project }: { c: ComponentInstance; project: Project }) {
  const names = variantNames(project)
  const active = activeVariant(project)
  const [picked, setPicked] = useState<string | null>(null)
  const viewer = useProjectStore((s) => s.role === "viewer")
  if (!names.length) return null
  const name = picked && names.includes(picked) ? picked : (active ?? names[0])
  const o = c.variants?.[name]
  const part = findPart(c.partId)
  const own = part?.valueProp ? (c.props[part.valueProp] ?? "") : ""
  return (
    <Section title="Variants" id="symbol-variants">
      <Field label="Variant">
        <select className="field h-8" value={name} onChange={(e) => setPicked(e.target.value)} aria-label="Variant to edit">
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
              {c.variants?.[n] ? " (changes this part)" : ""}
            </option>
          ))}
        </select>
      </Field>
      {FLAG_ROWS.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink-2">{f.label}</span>
          <select
            className="field h-8 w-[130px]"
            value={stateOf(o?.[f.key])}
            aria-label={`${f.label} in ${name}`}
            disabled={viewer}
            onChange={(e) => commit((p) => setVariantOverride(p, c.id, name, { [f.key]: e.target.value === "" ? null : e.target.value === "on" }))}
          >
            <option value="">As the symbol</option>
            <option value="on">Yes</option>
            <option value="off">No</option>
          </select>
        </div>
      ))}
      <Field label="Value">
        <CommitInput
          mono
          value={o?.fields?.Value ?? ""}
          placeholder={own || "as the symbol"}
          ariaLabel={`Value in ${name}`}
          onCommit={(v) => commit((p) => setVariantOverride(p, c.id, name, { fields: { Value: v.trim() === "" ? null : v } }))}
        />
      </Field>
      {Object.entries(o?.fields ?? {})
        .filter(([f]) => f !== "Value")
        .map(([f, v]) => (
          <Row key={f} label={f} value={v} mono />
        ))}
      <p className="text-[12px] text-ink-2">A choice here applies in {name} only. Leave a flag as the symbol to keep what the symbol has.</p>
    </Section>
  )
}
