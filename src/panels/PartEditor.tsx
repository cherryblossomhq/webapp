import { ExternalLink, Plus, Trash2, X } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SymbolBody } from "../editor/schematic/SymbolView"
import { PCB } from "../editor/theme"
import { buildCustomPart, CUSTOM_CATEGORIES, CUSTOM_SYMBOLS, customPartProblems } from "../model/customParts"
import { getFootprint, isValidFootprint, registerProjectFootprints } from "../model/footprints"
import { CATEGORIES } from "../model/library"
import { modelAssignment } from "../model/models3d"
import { partSourceLine } from "../model/partSource"
import { hasFieldPlaces, symbolOf } from "../model/symbolDrawing"
import { draftChanged, editPart, normalizeDraft, partUsers, sameModel, type PartDraft } from "../model/projectParts"
import { useOf } from "../model/sheets"
import type { CustomPartSpec, FootprintDef, Model3D, PadDef, PartCategory, PartDef, PinDef, PinSide } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { projectApi, useProjectStore } from "../store/projectStore"
import { uiApi, useUi } from "../store/uiStore"
import { Button, Field, IconButton, Segmented } from "../ui/controls"
import { lcscNumber, ModelControls } from "./ModelSection"
import { listed, removeProjectParts } from "./partActions"

// three.js loads with the first 3D preview, as with the 3D view.
const PartPreview3D = lazy(() => import("../editor/three/PartPreview3D").then((m) => ({ default: m.PartPreview3D })))

// The part editor: a project part's details, and the place to change them, as Altium's component
// properties are. Its symbol and footprint drawn beside what defines them, and its 3D model on
// the footprint; the edit is a draft until Save, which makes it one undo step with every
// component placed from the part following (`editPart` in `model/projectParts.ts`). A viewer
// reads it all and changes nothing.

type Tab = "general" | "pins" | "footprint" | "model"

type EditPin = PinDef & { side?: PinSide }

/** The editor's fields: a spec as the user types it, with its parameters as rows and its lists as text. */
interface Form {
  name: string
  description: string
  category: PartCategory
  refPrefix: string
  /** A discrete symbol's name, or empty for a box. */
  symbol: string
  keywords: string
  params: { key: string; value: string }[]
  valueProp: string
  footprint: string
  /** Pads shared between pins, as `pad=pin` pairs. */
  alias: string
  pins: EditPin[]
}

const formOf = (spec: CustomPartSpec): Form => ({
  name: spec.name,
  description: spec.description,
  category: spec.category,
  refPrefix: spec.refPrefix,
  symbol: spec.symbol ?? "",
  keywords: (spec.keywords ?? []).join(", "),
  params: Object.entries(spec.props).map(([key, value]) => ({ key, value })),
  valueProp: spec.valueProp ?? "",
  footprint: spec.footprint,
  alias: Object.entries(spec.padAlias ?? {})
    .map(([pad, pin]) => `${pad}=${pin}`)
    .join(", "),
  pins: spec.pins.map((p) => ({ ...p })),
})

/** `9=4, 10=4` as a pad alias, with a sentence for each pair it can't read. */
function parseAlias(text: string): { alias: Record<string, string>; problems: string[] } {
  const alias: Record<string, string> = {}
  const problems: string[] = []
  for (const pair of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=\s]+)\s*=\s*([^=\s]+)$/.exec(pair)
    if (m) alias[m[1]] = m[2]
    else problems.push(`shared pads are written pad=pin, as 9=4; "${pair}" isn't`)
  }
  return { alias, problems }
}

function draftFrom(form: Form, spec: CustomPartSpec): PartDraft {
  return {
    name: form.name,
    description: form.description,
    category: form.category,
    refPrefix: form.refPrefix.toUpperCase(),
    footprint: form.footprint,
    pins: form.pins,
    ...(form.symbol && { symbol: form.symbol }),
    ...(spec.drawing !== undefined && { drawing: spec.drawing }),
    props: Object.fromEntries(form.params.map((p) => [p.key.trim(), p.value])),
    ...(form.valueProp && { valueProp: form.valueProp }),
    padAlias: parseAlias(form.alias).alias,
    keywords: form.keywords.split(","),
  }
}

const PIN_KINDS: { value: NonNullable<PinDef["kind"]>; label: string }[] = [
  { value: "passive", label: "Passive" },
  { value: "input", label: "Input" },
  { value: "output", label: "Output" },
  { value: "io", label: "Bidirectional" },
  { value: "power", label: "Power" },
  { value: "ground", label: "Ground" },
  { value: "nc", label: "Not connected" },
]

const SIDES: PinSide[] = ["left", "right", "top", "bottom"]

/** Parameters most parts have, offered as the name of a new one. */
const COMMON_PARAMS = ["mpn", "manufacturer", "datasheet", "value", "lcsc", "package", "tolerance", "voltage", "power"]

const symbolLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ")

const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v.trim())

export function PartEditor() {
  const open = useUi((s) => s.partEditor)
  const spec = useProjectStore((s) => (open ? s.project?.parts?.find((p) => p.id === open.id) : undefined))
  if (!open) return null
  // Keyed by the part: another part opened starts from its own spec, not this one's draft.
  return spec ? <PartEditorBody key={spec.id} spec={spec} askRemove={!!open.remove} /> : <PartGone />
}

const close = () => uiApi().openPartEditor(null)

/** Escape closes, or steps back out of a question; set while the dialog is open. */
function useEscape(onEscape: () => void) {
  const latest = useRef(onEscape)
  useEffect(() => {
    latest.current = onEscape
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
}

function Shell({ children, labelledBy, onBackdrop }: { children: ReactNode; labelledBy: string; onBackdrop: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // Focus moves into the dialog, unless a control in it already took it (the Remove button of the question it opened on).
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
  }, [])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdrop()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        // Keys typed here are the dialog's: the canvas's shortcuts (Delete, undo, tools) must not act behind it.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[960px] animate-pop-in flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-dialog outline-none"
      >
        {children}
      </div>
    </div>
  )
}

/** The part went while it was open: someone else changed or removed it, or an undo took it back. */
function PartGone() {
  useEscape(close)
  return (
    <Shell labelledBy="part-gone-title" onBackdrop={close}>
      <div className="max-w-[420px] p-5">
        <h2 id="part-gone-title" className="text-[15px] font-semibold">
          This part is no longer in the project
        </h2>
        <p className="mt-2 text-[13px] text-ink-2">It was changed or removed, by someone else or by an undo. Open it again from the library to see it as it is now.</p>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        </div>
      </div>
    </Shell>
  )
}

function PartEditorBody({ spec, askRemove }: { spec: CustomPartSpec; askRemove: boolean }) {
  const project = useProjectStore((s) => s.project)!
  const readOnly = useProjectStore((s) => s.role === "viewer")
  const [form, setForm] = useState<Form>(() => formOf(spec))
  const [tab, setTab] = useState<Tab>("general")
  const [refused, setRefused] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState(askRemove && !readOnly)
  /** The 3D model chosen in the draft; undefined while the user hasn't chosen, and the part keeps what it has. */
  const [chosenModel, setChosenModel] = useState<Model3D | null | undefined>(undefined)
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setRefused(null)
  }
  const chooseModel = (model: Model3D | null) => {
    setChosenModel(model)
    setRefused(null)
  }
  const drawn = spec.drawing !== undefined
  const draft = useMemo(() => draftFrom(form, spec), [form, spec])
  const normalized = useMemo(() => normalizeDraft(draft), [draft])
  const footprintFound = !!normalized.footprint && isValidFootprint(normalized.footprint)
  // What the part has on the draft's footprint unless a model is chosen: its own, or none on a footprint it wasn't on.
  const savedModel = modelAssignment(project, spec.id, spec.footprint)
  const keptModel = footprintFound ? modelAssignment(project, spec.id, normalized.footprint) : null
  const model = chosenModel !== undefined ? chosenModel : keptModel
  const modelChanged = chosenModel !== undefined && !sameModel(chosenModel, keptModel)
  const changed = draftChanged(spec, draft) || modelChanged
  const problems = useMemo(() => {
    const keys = form.params.map((p) => p.key.trim()).filter(Boolean)
    const twice = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))].map((k) => `the parameter ${k} is listed twice`)
    registerProjectFootprints(project)
    return [...twice, ...parseAlias(form.alias).problems, ...customPartProblems({ ...normalized, id: "" }, project.symbols)]
  }, [form, normalized, project])
  // The symbol as the draft draws it; null when the draft's pins don't fit the symbol chosen.
  const preview = useMemo(() => {
    try {
      return buildCustomPart({ ...normalized, id: `${spec.id}~draft` }, project.symbols)
    } catch {
      return null
    }
  }, [normalized, project.symbols, spec.id])
  const users = partUsers(project, spec.id)
  const refs = [...new Set(users.map((c) => c.ref))]
  const source = partSourceLine(spec)
  const modelLost = normalized.footprint !== spec.footprint && !!savedModel && chosenModel === undefined && !keptModel

  const cancel = () => (removing ? setRemoving(false) : close())
  useEscape(cancel)

  const save = () => {
    const live = projectApi().project
    if (!live) return
    const res = editPart(live, spec.id, draft, { conn: getConnectivity, ...(chosenModel !== undefined && { model: chosenModel }) })
    if (!res.ok) {
      setRefused(res.problems)
      return
    }
    if (res.project !== live) projectApi().commit(() => res.project)
    close()
    if (res.moved.length) uiApi().showNotice(`${normalized.name} saved. The pins of ${listed(res.moved)} moved with its symbol: check their wires.`)
  }
  const remove = () => {
    close()
    removeProjectParts([spec.id])
  }
  /** Show a component placed from the part, on the schematic, on the sheet it is drawn on. */
  const reveal = (ref: string) => {
    const c = users.find((x) => x.ref === ref)
    if (!c) return
    close()
    uiApi().setSheet(useOf(c))
    uiApi().focus("schematic", c.sch.x, c.sch.y)
    uiApi().select([`c:${c.id}`])
  }

  const shown = refused ?? (changed ? problems : [])
  return (
    <Shell labelledBy="part-editor-title" onBackdrop={() => !changed && cancel()}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id="part-editor-title" className="truncate text-[15px] font-semibold">
              {spec.name}
            </h2>
            <span className="shrink-0 rounded-[4px] bg-brand-soft px-1.5 text-[11px] font-medium text-brand">Project part</span>
            {readOnly && <span className="shrink-0 rounded-[4px] bg-chrome-2 px-1.5 text-[11px] text-ink-2">View only</span>}
          </div>
          {source && (
            <p className="mt-1 text-[12px] leading-snug text-ink-3" title={source.credit}>
              <span className="font-[600] text-ink-2">{source.label}</span>
              {source.detail ? `. ${source.detail.charAt(0).toUpperCase()}${source.detail.slice(1)}` : ""}
              {source.credit && <span className="mt-0.5 block text-[11px]">{source.credit}</span>}
            </p>
          )}
        </div>
        <IconButton label="Close" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>

      <div className="flex h-[600px] min-h-0 shrink">
        <aside className="scroll-thin flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-chrome p-4">
          <figure>
            <div className="flex h-[230px] items-center justify-center rounded-[8px] border border-line bg-paper">
              {preview ? <SymbolDetail part={preview} /> : <span className="px-4 text-center text-[12px] text-ink-3">The symbol can't be drawn with these pins</span>}
            </div>
            <figcaption className="mt-1 text-[11.5px] text-ink-3">Symbol{preview ? `, ${preview.pins.length} ${preview.pins.length === 1 ? "pin" : "pins"}` : ""}</figcaption>
          </figure>
          <figure>
            <div className="h-[200px] overflow-hidden rounded-[8px] border border-line bg-[#050406]">
              <FootprintPreview name={normalized.footprint} />
            </div>
            <figcaption className="mt-1 truncate text-[11.5px] text-ink-3" title={normalized.footprint}>
              <FootprintCaption name={normalized.footprint} />
            </figcaption>
          </figure>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-5 pt-3">
            <Segmented<Tab>
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "general", label: "General" },
                { value: "pins", label: `Pins (${preview?.pins.length ?? form.pins.length})` },
                { value: "footprint", label: "Footprint" },
                { value: "model", label: "3D model" },
              ]}
            />
          </div>
          {tab === "model" && (
            // Outside the fieldset, so a viewer can still turn the part over.
            <div className="px-5 pt-3">
              <div className="h-[250px] overflow-hidden rounded-[8px] border border-line bg-[#121116]">
                {footprintFound ? (
                  <Suspense fallback={null}>
                    <PartPreview3D partId={spec.id} footprint={normalized.footprint} model={model} board={project.board} />
                  </Suspense>
                ) : (
                  <p className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[#c9c4d6]">
                    {normalized.footprint ? `No footprint called ${normalized.footprint}, so nothing to draw.` : "No footprint, so nothing on the board to draw."}
                  </p>
                )}
              </div>
            </div>
          )}
          <fieldset disabled={readOnly} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4 pt-3">
            {tab === "general" && <GeneralTab form={form} set={set} drawn={drawn} />}
            {tab === "pins" &&
              (drawn ? (
                <DrawnPins pins={preview?.pins ?? []} />
              ) : (
                <PinsTab pins={form.pins} boxed={!form.symbol} onChange={(pins) => set({ pins })} />
              ))}
            {tab === "footprint" && <FootprintTab form={form} set={set} footprints={(project.footprints ?? []).map((f) => f.name)} drawn={drawn} modelLost={modelLost} />}
            {tab === "model" && footprintFound && (
              <ModelTab
                footprint={normalized.footprint}
                model={model}
                onChange={chooseModel}
                lcsc={lcscNumber(normalized.props.lcsc, spec.source?.supplier?.lcsc)}
                searchText={normalized.props.mpn || normalized.name}
                lost={modelLost ? { model: savedModel!, footprint: spec.footprint } : null}
                elsewhere={[...new Set(users.filter((c) => c.partId === spec.id && c.footprint !== spec.footprint).map((c) => c.ref))]}
              />
            )}
          </fieldset>
        </div>
      </div>

      {shown.length > 0 && (
        <ul role="alert" className="max-h-24 space-y-0.5 overflow-y-auto border-t border-line bg-danger-soft px-5 py-2 text-[12px] text-danger">
          {shown.map((p) => (
            <li key={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</li>
          ))}
        </ul>
      )}

      {removing ? (
        <footer className="flex items-center gap-3 border-t border-line bg-danger-soft px-5 py-3">
          <p className="min-w-0 flex-1 text-[12.5px] text-ink">
            Remove <span className="font-[600]">{spec.name}</span> from the project?
            {refs.length > 0 && ` ${listed(refs)} ${refs.length === 1 ? "is" : "are"} placed from it and will be deleted from the schematic and the board too.`}
          </p>
          <Button onClick={() => setRemoving(false)}>Keep it</Button>
          <Button variant="danger" onClick={remove} autoFocus>
            <Trash2 size={14} /> {refs.length ? `Remove part and ${refs.length === 1 ? refs[0] : `${refs.length} components`}` : "Remove part"}
          </Button>
        </footer>
      ) : (
        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
            {refs.length ? (
              <>
                Placed as{" "}
                {refs.slice(0, 12).map((r, i) => (
                  <span key={r}>
                    {i > 0 && ", "}
                    <button type="button" className="mono text-brand hover:underline" onClick={() => reveal(r)} title={`Show ${r} on the schematic`}>
                      {r}
                    </button>
                  </span>
                ))}
                {refs.length > 12 && ` and ${refs.length - 12} more`}
              </>
            ) : (
              "Not placed in this project yet"
            )}
          </p>
          {!readOnly && (
            <Button variant="danger" onClick={() => setRemoving(true)}>
              <Trash2 size={14} /> Remove from project
            </Button>
          )}
          {readOnly ? (
            <Button variant="primary" onClick={close}>
              Close
            </Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={!changed || problems.length > 0}>
                Save
              </Button>
            </>
          )}
        </footer>
      )}
    </Shell>
  )
}

function GeneralTab({ form, set, drawn }: { form: Form; set: (patch: Partial<Form>) => void; drawn: boolean }) {
  // The parameter shown as the value may have no default here (a KiCad part's `value` is each component's own).
  const keys = [...new Set([form.valueProp, ...form.params.map((p) => p.key.trim())].filter(Boolean))]
  const setParam = (i: number, patch: Partial<Form["params"][number]>) => {
    const params = form.params.map((p, j) => (j === i ? { ...p, ...patch } : p))
    // A parameter renamed while it is the one shown as the value stays shown.
    const renamed = patch.key !== undefined && form.params[i].key === form.valueProp
    set({ params, ...(renamed && { valueProp: patch.key!.trim() }) })
  }
  return (
    <>
      <Field label="Name">
        <input className="field h-8" value={form.name} onChange={(e) => set({ name: e.target.value })} aria-label="Part name" />
      </Field>
      <Field label="Description">
        <textarea className="field min-h-[52px] resize-y py-1.5 leading-snug" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <select className="field h-8" value={form.category} onChange={(e) => set({ category: e.target.value as PartCategory })} aria-label="Category">
            {(drawn ? CATEGORIES : CUSTOM_CATEGORIES).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Designator prefix" hint="R, C, U, J...: parts are numbered after it">
          <input className="field mono h-8" value={form.refPrefix} onChange={(e) => set({ refPrefix: e.target.value.toUpperCase() })} aria-label="Designator prefix" />
        </Field>
      </div>
      {!drawn && (
        <Field label="Symbol" hint={form.symbol ? "A discrete symbol finds its pins by name (A and K, + and -, G, D and S)" : "A box with the pins on the sides the Pins tab gives them"}>
          <select className="field h-8" value={form.symbol} onChange={(e) => set({ symbol: e.target.value })} aria-label="Symbol">
            <option value="">Box</option>
            {Object.keys(CUSTOM_SYMBOLS).map((s) => (
              <option key={s} value={s}>
                {symbolLabel(s)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Search keywords" hint="Comma separated: what the library's search finds the part by besides its name">
        <input className="field h-8" value={form.keywords} onChange={(e) => set({ keywords: e.target.value })} aria-label="Search keywords" />
      </Field>

      <section aria-label="Parameters">
        <h3 className="mb-1 mt-4 text-[12px] font-[650] text-ink-2">Parameters</h3>
        <p className="mb-2 text-[11.5px] text-ink-3">What every component placed from the part starts with. A component that still has the old value follows a change here; one given its own keeps it.</p>
        <datalist id="part-param-keys">
          {COMMON_PARAMS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <table className="w-full text-[12.5px]">
          <tbody>
            {form.params.map((p, i) => (
              <tr key={i}>
                <td className="w-[34%] py-0.5 pr-1.5">
                  <input className="field mono h-7" list="part-param-keys" value={p.key} placeholder="name" onChange={(e) => setParam(i, { key: e.target.value })} aria-label={`Parameter ${i + 1} name`} />
                </td>
                <td className="py-0.5 pr-1">
                  <input className="field h-7" value={p.value} placeholder="value" onChange={(e) => setParam(i, { value: e.target.value })} aria-label={`Parameter ${p.key || i + 1} value`} />
                </td>
                <td className="w-14 py-0.5 text-right">
                  {isUrl(p.value) && (
                    <a href={p.value.trim()} target="_blank" rel="noreferrer" className="inline-flex rounded p-1 text-ink-3 hover:text-ink" aria-label={`Open ${p.key}`} title="Open in a new tab">
                      <ExternalLink size={13} />
                    </a>
                  )}
                  <button
                    type="button"
                    className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger"
                    aria-label={`Remove parameter ${p.key || i + 1}`}
                    onClick={() => set({ params: form.params.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-1.5 flex items-end gap-3">
          <Button type="button" onClick={() => set({ params: [...form.params, { key: "", value: "" }] })}>
            <Plus size={14} /> Add parameter
          </Button>
          <label className="ml-auto block w-[45%]">
            <span className="mb-1 block text-[12px] text-ink-2">Shown on the sheet as its value</span>
            <select className="field h-8" value={form.valueProp} onChange={(e) => set({ valueProp: e.target.value })} aria-label="Value parameter">
              <option value="">Nothing</option>
              {keys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </>
  )
}

/** The next pin number: one past the highest number, or the count for pins numbered otherwise (A1, B2). */
function nextPinNumber(pins: EditPin[]) {
  const numbers = pins.map((p) => Number(p.number)).filter((n) => Number.isInteger(n))
  const taken = new Set(pins.map((p) => p.number))
  let n = numbers.length ? Math.max(...numbers) + 1 : pins.length + 1
  while (taken.has(String(n))) n++
  return String(n)
}

function PinsTab({ pins, boxed, onChange }: { pins: EditPin[]; boxed: boolean; onChange: (pins: EditPin[]) => void }) {
  const edit = (i: number, patch: Partial<EditPin>) =>
    onChange(
      pins.map((p, j) => {
        if (j !== i) return p
        const next = { ...p, ...patch }
        if ("side" in patch && !patch.side) delete next.side
        return next
      }),
    )
  return (
    <>
      <p className="text-[11.5px] text-ink-3">
        Each pin's number is the pad it is on in the footprint. {boxed ? "A side left on Auto follows the type: power on top, ground below, inputs left, outputs right." : "The discrete symbol places the pins itself."}
      </p>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[11.5px] text-ink-3">
            <th className="w-[16%] pb-1 font-normal">Number</th>
            <th className="pb-1 font-normal">Name</th>
            <th className="w-[24%] pb-1 font-normal">Type</th>
            <th className="w-[18%] pb-1 font-normal">Side</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {pins.map((p, i) => (
            <tr key={i}>
              <td className="py-0.5 pr-1.5">
                <input className="field mono h-7" value={p.number} onChange={(e) => edit(i, { number: e.target.value })} aria-label={`Pin ${i + 1} number`} />
              </td>
              <td className="py-0.5 pr-1.5">
                <input className="field mono h-7" value={p.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label={`Pin ${p.number || i + 1} name`} />
              </td>
              <td className="py-0.5 pr-1.5">
                <select className="field h-7 py-0" value={p.kind ?? "passive"} onChange={(e) => edit(i, { kind: e.target.value as EditPin["kind"] })} aria-label={`Pin ${p.number || i + 1} type`}>
                  {PIN_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-0.5 pr-1">
                <select className="field h-7 py-0" disabled={!boxed} value={p.side ?? ""} onChange={(e) => edit(i, { side: (e.target.value || undefined) as PinSide | undefined })} aria-label={`Pin ${p.number || i + 1} side`}>
                  <option value="">Auto</option>
                  {SIDES.map((s) => (
                    <option key={s} value={s}>
                      {symbolLabel(s)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-0.5 text-right">
                <button type="button" className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label={`Remove pin ${p.number || i + 1}`} onClick={() => onChange(pins.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button type="button" onClick={() => onChange([...pins, { number: nextPinNumber(pins), name: "", kind: "passive" }])}>
        <Plus size={14} /> Add pin
      </Button>
    </>
  )
}

/** The pins of a part drawn from a KiCad symbol: its drawing has them, so they are read here, not edited. */
function DrawnPins({ pins }: { pins: PinDef[] }) {
  return (
    <>
      <p className="text-[11.5px] text-ink-3">This part's pins come with its KiCad symbol drawing, so they can't be changed here. Its footprint and everything else can.</p>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[11.5px] text-ink-3">
            <th className="w-[18%] pb-1 font-normal">Number</th>
            <th className="pb-1 font-normal">Name</th>
            <th className="w-[30%] pb-1 font-normal">Type</th>
          </tr>
        </thead>
        <tbody>
          {pins.map((p, i) => (
            <tr key={`${p.number}:${i}`} className="border-b border-chrome-2 last:border-0">
              <td className="mono py-1 text-ink-3">{p.number}</td>
              <td className="mono py-1 text-ink">{p.name}</td>
              <td className="py-1 text-ink-2">{p.type?.replace(/_/g, " ") ?? PIN_KINDS.find((k) => k.value === (p.kind ?? "passive"))?.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function FootprintTab({ form, set, footprints, drawn, modelLost }: { form: Form; set: (patch: Partial<Form>) => void; footprints: string[]; drawn: boolean; modelLost: boolean }) {
  return (
    <>
      <Field label="Footprint" hint="A footprint generator name (soic8, sot23_5, pinrow4_p2.54mm, 0603) or one of the project's own land patterns">
        <input className="field mono h-8" list="part-footprints" value={form.footprint} onChange={(e) => set({ footprint: e.target.value })} aria-label="Footprint" placeholder={drawn ? "None: a symbol with no footprint" : ""} />
        <datalist id="part-footprints">
          {footprints.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      {modelLost && <p className="text-[12px] text-ink-2">Its 3D model sat on the old footprint, so it isn't kept: the 3D model tab can keep it anyway, or give the new footprint another.</p>}
      {!drawn && (
        <Field label="Shared pads" hint="Pads that are one pin, written pad=pin: a SOT-223's tab is 4=2, an exposed pad wired as pin 9 is EP=9">
          <input className="field mono h-8" value={form.alias} onChange={(e) => set({ alias: e.target.value })} aria-label="Shared pads" placeholder="none" />
        </Field>
      )}
      <PadTable name={form.footprint.trim()} pins={form.pins} alias={parseAlias(form.alias).alias} />
    </>
  )
}

/** The part's 3D model on its footprint: chosen and placed as in the Inspector, kept in the draft until Save. */
function ModelTab({
  footprint,
  model,
  onChange,
  lcsc,
  searchText,
  lost,
  elsewhere,
}: {
  footprint: string
  model: Model3D | null
  onChange: (model: Model3D | null) => void
  lcsc: string | null
  searchText: string
  /** The model the part had on the footprint the draft moves it off, which doesn't follow unless asked. */
  lost: { model: Model3D; footprint: string } | null
  /** Components placed from the part on another footprint than its own, each with the model of that one. */
  elsewhere: string[]
}) {
  return (
    <>
      {lost && (
        <p className="text-[12px] text-ink-2">
          {lost.model.name} sat on {lost.footprint}, so it isn't kept on {footprint}.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => onChange(lost.model)}>
            Keep it anyway
          </button>
        </p>
      )}
      <div className="space-y-2.5">
        <ModelControls model={model} footprint={footprint} lcsc={lcsc} searchText={searchText} onChange={onChange} />
      </div>
      <p className="text-[11.5px] text-ink-3">
        Every component of this part on {footprint} is drawn with it.
        {elsewhere.length > 0 && ` ${listed(elsewhere)} ${elsewhere.length === 1 ? "is" : "are"} on another footprint, with its own model in the Inspector.`}
      </p>
    </>
  )
}

/** The footprint's pads, each with the pin it carries. */
function PadTable({ name, pins, alias }: { name: string; pins: EditPin[]; alias: Record<string, string> }) {
  const fp = useMemo(() => (name && isValidFootprint(name) ? getFootprint(name) : null), [name])
  if (!fp) return null
  const numbered = fp.pads.filter((p) => p.pin)
  if (!numbered.length) return <p className="text-[12px] text-ink-3">This footprint has no numbered pads.</p>
  const pinName = (pad: string) => pins.find((p) => p.number === (alias[pad] ?? pad))?.name
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-[11.5px] text-ink-3">
          <th className="w-[18%] pb-1 font-normal">Pad</th>
          <th className="pb-1 font-normal">Pin</th>
          <th className="w-[38%] pb-1 font-normal">Size</th>
        </tr>
      </thead>
      <tbody>
        {numbered.map((pad, i) => {
          const pin = alias[pad.pin!] ?? pad.pin!
          const named = pinName(pad.pin!)
          return (
            <tr key={`${pad.pin}:${i}`} className="border-b border-chrome-2 last:border-0">
              <td className="mono py-1 text-ink-3">{pad.pin}</td>
              <td className={`mono py-1 ${named === undefined && !pad.exposed ? "text-danger" : "text-ink"}`}>
                {named === undefined ? (pad.exposed ? "Exposed pad, no pin" : "No pin") : `${pin} ${named}`}
              </td>
              <td className="mono py-1 text-ink-2">
                {fmt(pad.width)} × {fmt(pad.height)}
                {pad.holeDiameter ? `, ⌀${fmt(pad.holeDiameter)}` : ""}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const fmt = (mm: number) => `${Number(mm.toFixed(2))}`

function FootprintCaption({ name }: { name: string }) {
  const fp = name && isValidFootprint(name) ? getFootprint(name) : null
  if (!fp) return <>{name ? "Footprint not found" : "No footprint"}</>
  const c = fp.courtyard
  return (
    <>
      <span className="mono">{name}</span>, {fp.pads.length} {fp.pads.length === 1 ? "pad" : "pads"}, {fmt(c.maxX - c.minX)} × {fmt(c.maxY - c.minY)} mm
    </>
  )
}

/** One pad as its copper, in the footprint's frame (y up). */
function PadShape({ pad, fill }: { pad: PadDef; fill: string }) {
  if (pad.shape === "circle") return <circle cx={pad.x} cy={pad.y} r={pad.width / 2} fill={fill} />
  if (pad.shape === "polygon" && pad.points) return <polygon points={pad.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={fill} />
  const short = Math.min(pad.width, pad.height)
  const rx = pad.shape === "pill" ? short / 2 : pad.round ? pad.round * short : 0
  return (
    <rect
      x={pad.x - pad.width / 2}
      y={pad.y - pad.height / 2}
      width={pad.width}
      height={pad.height}
      rx={rx}
      fill={fill}
      transform={pad.rot ? `rotate(${pad.rot} ${pad.x} ${pad.y})` : undefined}
    />
  )
}

/** A pad's drill: a round hole, or a slot along the pad's longer side. */
function Hole({ pad }: { pad: PadDef }) {
  const d = pad.holeDiameter!
  if (!pad.slotLength) return <circle cx={pad.x} cy={pad.y} r={d / 2} fill={PCB.hole} />
  const across = pad.width >= pad.height
  const w = across ? pad.slotLength : d
  const h = across ? d : pad.slotLength
  return <rect x={pad.x - w / 2} y={pad.y - h / 2} width={w} height={h} rx={d / 2} fill={PCB.hole} transform={pad.rot ? `rotate(${pad.rot} ${pad.x} ${pad.y})` : undefined} />
}

/** The symbol as the schematic draws it, with its pin names and numbers, a designator to come and the value. */
function SymbolDetail({ part }: { part: PartDef }) {
  const symbol = symbolOf(part)
  const b = symbol.bounds
  const imported = hasFieldPlaces(part)
  // Room round the drawing for the texts it puts outside its bounds (the designator and value above a box).
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 0.25
  const value = part.valueProp ? (part.defaultProps[part.valueProp] ?? "") : ""
  return (
    <svg viewBox={`${b.minX - pad} ${-b.maxY - pad} ${b.maxX - b.minX + pad * 2} ${b.maxY - b.minY + pad * 2}`} className="h-full w-full" role="img" aria-label={`Symbol of ${part.name}`}>
      <g transform="scale(1,-1)">
        <SymbolBody
          symbol={symbol}
          x={0}
          y={0}
          rot={0}
          refText={`${part.refPrefix}?`}
          valueText={value}
          isBox={!imported && (part.category === "ICs" || part.refPrefix === "U" || part.category === "Connectors")}
        />
      </g>
    </svg>
  )
}

/** The land as the PCB editor draws it: copper pads with their numbers, holes, silkscreen and courtyard. */
export function FootprintPreview({ name }: { name: string }) {
  const fp: FootprintDef | null = useMemo(() => (name && isValidFootprint(name) ? getFootprint(name) : null), [name])
  if (!fp) return <span className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ink-3">{name ? "No footprint by that name" : "No footprint"}</span>
  const xs = [fp.courtyard.minX, fp.courtyard.maxX, ...fp.pads.flatMap((p) => [p.x - p.width / 2, p.x + p.width / 2])]
  const ys = [fp.courtyard.minY, fp.courtyard.maxY, ...fp.pads.flatMap((p) => [p.y - p.height / 2, p.y + p.height / 2])]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const size = Math.max(maxX - minX, maxY - minY, 1)
  const m = size * 0.08
  const line = size / 140
  return (
    <svg viewBox={`${minX - m} ${-maxY - m} ${maxX - minX + 2 * m} ${maxY - minY + 2 * m}`} className="h-full w-full" role="img" aria-label={`Footprint ${name}`}>
      <g transform="scale(1,-1)">
        {!fp.noCourtyard && (
          <rect
            x={fp.courtyard.minX}
            y={fp.courtyard.minY}
            width={fp.courtyard.maxX - fp.courtyard.minX}
            height={fp.courtyard.maxY - fp.courtyard.minY}
            fill="none"
            stroke={PCB.courtyard}
            strokeWidth={line}
            strokeDasharray={`${line * 4} ${line * 3}`}
          />
        )}
        {fp.silk.map((path, i) => (
          <polyline key={i} points={path.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={PCB.silk} strokeWidth={line * 1.6} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {fp.pads.map((pad, i) => (pad.plated === false ? null : <PadShape key={i} pad={pad} fill={PCB.topCopper} />))}
        {fp.pads.map((pad, i) => (pad.holeDiameter ? <Hole key={i} pad={pad} /> : null))}
      </g>
      {fp.pads.length <= 120 &&
        fp.pads.map((pad, i) =>
          pad.pin ? (
            <text
              key={i}
              x={pad.x}
              y={-pad.y}
              fill={PCB.label}
              fontSize={Math.max(Math.min(pad.width, pad.height) * 0.55, size / 60)}
              textAnchor="middle"
              dominantBaseline="central"
              className="mono pointer-events-none select-none"
            >
              {pad.pin}
            </text>
          ) : null,
        )}
    </svg>
  )
}
