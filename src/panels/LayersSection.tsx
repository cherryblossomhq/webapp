import { Eye, EyeOff } from "lucide-react"
import { useMemo, useState } from "react"
import { copperColor } from "../editor/theme"
import { defaultStackup, layerContent, setCopperLayer, setCopperLayerCount, setStackSettings, setStackup, updateStackRow, type LayerContent } from "../model/layerOps"
import { copperLayers, innerLayers, layerLabel, layerType, MAX_COPPER_LAYERS } from "../model/stack"
import type { CopperLayerType, Project, StackRow } from "../model/types"
import { projectApi } from "../store/projectStore"
import { copperShown, useUi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { CommitInput, Group, LengthInput, Row, Section } from "../ui/form"

// X1: the board's copper layers and its stackup, as the Inspector edits them. A board has two to 32 copper layers (KiCad's range, an even number of them in the files
// KiCad 9 writes); each can be named and told what it is for, and the stackup rows (thicknesses and materials) can be written out for the layers and edited.

const commit = (fn: (p: Project) => Project) => projectApi().commit((p) => fn(p))

const TYPES: { value: CopperLayerType; label: string; title: string }[] = [
  { value: "signal", label: "Signal", title: "Tracks and pours" },
  { value: "power", label: "Power", title: "A plane: a layer mostly poured with one net" },
  { value: "mixed", label: "Mixed", title: "Tracks and a plane on one layer" },
  { value: "jumper", label: "Jumper", title: "A layer used for a few short links" },
]

/** What taking a layer away would delete, in words; empty for a layer with nothing on it. */
export function contentSentence(c: LayerContent): string {
  const parts = [
    c.traces && `${c.traces} trace${c.traces === 1 ? "" : "s"}`,
    c.zones && `${c.zones} zone${c.zones === 1 ? "" : "s"} (on that layer)`,
    c.vias && `${c.vias} blind or buried via${c.vias === 1 ? "" : "s"}`,
    c.drawings && `${c.drawings} drawing${c.drawings === 1 ? "" : "s"}`,
    c.texts && `${c.texts} text${c.texts === 1 ? "" : "s"}`,
    c.pads && `${c.pads} pad layer${c.pads === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[]
  return parts.join(", ")
}

export function LayersSection({ project }: { project: Project }) {
  const stack = copperLayers(project.board)
  const [pending, setPending] = useState<number | null>(null)
  const counts = Array.from({ length: MAX_COPPER_LAYERS / 2 }, (_, i) => (i + 1) * 2)
  const wanted = pending ?? stack.length
  // What going to the wanted count would delete.
  const losing = useMemo(() => {
    const smaller = setCopperLayerCount(project, wanted)
    return innerLayers({ stack: smaller.project.board.stack }).length < innerLayers(project.board).length ? smaller.removed : null
  }, [project, wanted])
  const sentence = losing ? contentSentence(losing) : ""
  const layers = useUi((s) => s.layers)
  const hiddenCopper = useUi((s) => s.hiddenCopper)
  const toggleCopper = useUi((s) => s.toggleCopper)
  return (
    <Section title="Copper layers" id="copper-layers" action={<span className="text-[12px] text-ink-3">{stack.length}</span>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Layers">
          <select className="field h-8" aria-label="Number of copper layers" value={wanted} onChange={(e) => setPending(Number(e.target.value))}>
            {[...new Set([...counts, stack.length])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        {wanted !== stack.length && (
          <div className="flex items-end gap-1.5">
            <Button
              onClick={() => {
                commit((p) => setCopperLayerCount(p, wanted).project)
                setPending(null)
              }}
            >
              {sentence ? "Remove them" : "Apply"}
            </Button>
            <Button onClick={() => setPending(null)}>Cancel</Button>
          </div>
        )}
      </div>
      {wanted !== stack.length && sentence && <p className="text-[12px] text-warn">Going to {wanted} layers deletes what is on the layers that go: {sentence}. Undo brings it back.</p>}
      {wanted !== stack.length && !sentence && wanted < stack.length && <p className="text-[12px] text-ink-2">The layers that go have nothing on them.</p>}
      {wanted !== stack.length && (
        <p className="text-[12px] text-ink-3">The stackup rows describe the board as it is now: they are dropped when the layers change, and the standard stackup below writes them again.</p>
      )}
      <ul className="-mx-1.5 space-y-0.5">
        {stack.map((l, i) => {
          const content = layerContent(project, l)
          const n = content.traces
          return (
            <li key={l} className="flex items-center gap-1.5 px-1.5 py-0.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: copperColor(l) }} data-layer-swatch={l} aria-hidden />
              <button type="button" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-2 hover:text-ink" aria-label={`${copperShown({ layers, hiddenCopper }, l) ? "Hide" : "Show"} ${layerLabel(project.board, l)} copper`} aria-pressed={copperShown({ layers, hiddenCopper }, l)} title="Show or hide this layer on the board" onClick={() => toggleCopper(l)}>
                {copperShown({ layers, hiddenCopper }, l) ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <CommitInput ariaLabel={`Name of copper layer ${i + 1}`} value={project.board.stack?.copper[i]?.label ?? ""} placeholder={layerLabel({}, l)} onCommit={(v) => commit((p) => setCopperLayer(p, l, { label: v }))} className="min-w-0 flex-1" />
              <select aria-label={`Type of copper layer ${i + 1}`} className="field h-8 w-[84px]" value={layerType(project.board, l)} onChange={(e) => commit((p) => setCopperLayer(p, l, { type: e.target.value as CopperLayerType }))}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value} title={t.title}>
                    {t.label}
                  </option>
                ))}
              </select>
              {n > 0 && (
                <span className="w-9 text-right text-[11px] text-ink-3" title={`${n} traces on this layer`}>
                  {n}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <StackupEditor project={project} />
    </Section>
  )
}

const num = (v: string): number | undefined => {
  const t = v.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function StackupEditor({ project }: { project: Project }) {
  const rows = project.board.stack?.rows
  const stack = project.board.stack
  return (
    <Group label="Stackup">
      {!rows?.length ? (
        <div className="space-y-1.5">
          <p className="text-[12px] text-ink-2">No stackup of its own: the fab notes and the 3D view use the standard one for {copperLayers(project.board).length} layers.</p>
          <Button onClick={() => commit((p) => setStackup(p, defaultStackup(copperLayers(p.board).length, p.board.thickness)))}>Write out the standard stackup</Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-ink-3">
                <th className="pb-1 font-normal">Layer</th>
                <th className="pb-1 font-normal">Material</th>
                <th className="pb-1 text-right font-normal">Thickness</th>
                <th className="pb-1 text-right font-normal">εr</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: StackRow, i: number) => (
                <tr key={`${r.name}${i}`} className="border-b border-chrome-2 last:border-0">
                  <td className="py-1 pr-1.5 text-ink" title={r.type}>
                    {r.name}
                  </td>
                  <td className="py-1 pr-1.5">
                    {r.thickness !== undefined || r.material !== undefined ? (
                      <CommitInput ariaLabel={`Material of ${r.name}`} value={r.material ?? ""} onCommit={(v) => commit((p) => updateStackRow(p, i, { material: v.trim() || undefined }))} className="w-full" />
                    ) : null}
                  </td>
                  <td className="py-1 pr-1.5 text-right">
                    {r.thickness !== undefined && <LengthInput ariaLabel={`Thickness of ${r.name}`} value={r.thickness} onCommit={(v) => v !== null && commit((p) => updateStackRow(p, i, { thickness: v }))} className="w-[64px]" />}
                  </td>
                  <td className="py-1 text-right">
                    {r.material !== undefined && r.epsilonR !== undefined && <CommitInput ariaLabel={`Relative permittivity of ${r.name}`} value={r.epsilonR} type="number" onCommit={(v) => commit((p) => updateStackRow(p, i, { epsilonR: num(v) }))} className="w-[54px]" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Row label="Total" value={`${Number(rows.reduce((t, r) => t + (r.thickness ?? 0) + (r.sub ?? []).reduce((a, s) => a + (s.thickness ?? 0), 0), 0).toFixed(4))} mm`} />
          <Button onClick={() => commit((p) => setStackup(p, null))}>Remove the stackup rows</Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 pt-1.5">
        <Field label="Copper finish (KiCad's)">
          <CommitInput ariaLabel="Copper finish" value={stack?.finish ?? ""} placeholder="not set" onCommit={(v) => commit((p) => setStackSettings(p, { finish: v.trim() || undefined }))} />
        </Field>
        <Field label="Edge connector">
          <select className="field h-8" value={stack?.edgeConnector ?? "none"} onChange={(e) => commit((p) => setStackSettings(p, { edgeConnector: e.target.value === "none" ? undefined : (e.target.value as "yes" | "bevelled") }))}>
            <option value="none">None</option>
            <option value="yes">Edge connector</option>
            <option value="bevelled">Bevelled</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={stack?.edgePlating === true} onChange={(e) => commit((p) => setStackSettings(p, { edgePlating: e.target.checked ? true : undefined }))} className="accent-select" />
        Plated board edge
      </label>
      <label className="flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={stack?.dielectricConstraints === true} onChange={(e) => commit((p) => setStackSettings(p, { dielectricConstraints: e.target.checked ? true : undefined }))} className="accent-select" />
        Hold the dielectric thicknesses to the fab's constraints
      </label>
    </Group>
  )
}
