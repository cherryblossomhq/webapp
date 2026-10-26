import type { PartCandidate } from "@cherryblossom/api-contract"
import { Box, FileUp, RotateCw, Search, Trash2 } from "lucide-react"
import { useRef, useState } from "react"
import { lookupFailure, supplierParts } from "../ai/supplierParts"
import { modelLibrary, useModelState } from "../editor/three/files/library"
import { componentModel, fileModel, MODEL_FILE_ACCEPT, modelFormatOf, modelOrigin, setModel } from "../model/models3d"
import { supplierModelOn } from "../model/supplier/model"
import type { ComponentInstance, Model3D, PartDef, Project } from "../model/types"
import { MAX_MODEL_FILE_BYTES, modelFileId, modelFiles } from "../store/modelFiles"
import { projectApi } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { Button, Field } from "../ui/controls"
import { CommitInput, LengthInput, Section } from "../ui/form"
import { Tooltip } from "../ui/Tooltip"

/** The LCSC number a component's part is sold under, when it says. */
function lcscOf(c: ComponentInstance, part: PartDef, project: Project): string | null {
  const spec = project.parts?.find((s) => s.id === part.id)
  const n = c.props.lcsc ?? spec?.props.lcsc ?? spec?.source?.supplier?.lcsc ?? part.defaultProps.lcsc
  return n && /^C\d+$/i.test(n.trim()) ? n.trim().toUpperCase() : null
}

/** What to search the supplier for: the part number, else its value and package. */
function searchFor(c: ComponentInstance, part: PartDef): string {
  const mpn = c.props.mpn ?? part.mpn ?? part.defaultProps.mpn
  if (mpn) return mpn
  const value = c.props.value ?? c.props[part.valueProp ?? ""]
  return [value, c.footprint, part.name].filter(Boolean).join(" ")
}

const num = (v: string) => {
  const n = Number(v.replace(",", "."))
  return Number.isFinite(n) ? n : null
}

/**
 * The real 3D model a part is drawn with on its footprint: a file the user adds, or the supplier's
 * model of the part. Every component of the part on that footprint shares it, as in KiCad a
 * footprint carries its model. Without one the part is drawn with its generated body.
 */
export function ModelSection({ c, part, project }: { c: ComponentInstance; part: PartDef; project: Project }) {
  const model = componentModel(project, c)
  const { state, error } = useModelState(model)
  const realModels = useUi((s) => s.settings.realModels)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [hits, setHits] = useState<PartCandidate[] | null>(null)
  const sharing = project.components.filter((x) => x.partId === c.partId && x.footprint === c.footprint).length
  const source = supplierParts()
  const lcsc = lcscOf(c, part, project)

  // Into the project this was rendered for: a file still uploading when the user opens another
  // project must not land in that one.
  const assign = (next: Model3D | null) => projectApi().commit((p) => (p.id === project.id ? setModel(p, c.partId, c.footprint, next) : p))
  const edit = (patch: Partial<Model3D>) => model && assign({ ...model, ...patch })
  const run = async (what: string, work: () => Promise<void>) => {
    setBusy(what)
    setProblem(null)
    try {
      await work()
    } catch (e) {
      setProblem(lookupFailure(e))
    } finally {
      setBusy(null)
    }
  }

  const addFile = (file: File) =>
    run("file", async () => {
      const format = modelFormatOf(file.name)
      if (!format) throw new Error(`${file.name} isn't a model file this editor reads (STEP, OBJ, WRL, STL or GLB).`)
      if (file.size > MAX_MODEL_FILE_BYTES) throw new Error(`${file.name} is over ${MAX_MODEL_FILE_BYTES / 1024 / 1024} MB.`)
      const store = modelFiles()
      if (!store) throw new Error("Model files can't be kept in this editor.")
      const bytes = await file.arrayBuffer()
      const drafted = fileModel(await modelFileId(bytes), file.name, format)
      // Read it before keeping it: a file that doesn't read is neither stored nor assigned. The
      // reader may take its bytes (a STEP file goes to a worker), so it gets a copy.
      const object = await modelLibrary.prime(drafted, bytes.slice(0))
      await store.put({ name: file.name, bytes })
      const { fitToFootprint } = await import("../editor/three/files/fit")
      assign(fitToFootprint(drafted, object, c.footprint))
    })

  const takeSupplierModel = (number: string) =>
    run(number, async () => {
      if (!source) throw new Error("Supplier parts aren't available in this editor.")
      const record = await source.part(number)
      if (!record) throw new Error(`No supplier record for ${number}.`)
      if (!record.model3d) throw new Error(`${number} (${record.mpn}) has no 3D model at the supplier.`)
      const next = supplierModelOn(record, c.footprint)
      if (!next) throw new Error(`${number}'s land isn't this footprint's (${c.footprint}), so its model wouldn't sit on these pads.`)
      assign(next)
      setHits(null)
      setQuery(null)
    })

  const search = (q: string) =>
    run("search", async () => {
      if (!source) throw new Error("Supplier parts aren't available in this editor.")
      const found = await source.search(q)
      setHits(found.candidates.slice(0, 6))
      if (!found.candidates.length) setProblem(`Nothing at the supplier for "${q}".`)
    })

  return (
    <Section title="3D model" id="inspector-3d-model">
      <div className="flex items-start gap-2">
        <Box size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-ink" title={model?.name}>
            {model ? model.name : "Generated body"}
          </p>
          <p className="text-[11.5px] text-ink-3">
            {!model
              ? "Drawn from the footprint. Add the part's model file for the real part."
              : state === "failed"
                ? `Not drawn: ${error}`
                : state === "loading"
                  ? "Loading..."
                  : !realModels
                    ? `${modelOrigin(model)}. The 3D view is drawing generated bodies only.`
                    : modelOrigin(model)}
          </p>
          {model?.attribution && <p className="mt-0.5 text-[11px] text-ink-3">{model.attribution}</p>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Tooltip label="Add a model file" hint="STEP, OBJ, WRL, STL or GLB">
          <Button onClick={() => fileInput.current?.click()} disabled={!!busy}>
            <FileUp size={14} /> {busy === "file" ? "Adding..." : model?.source === "file" || model?.source === "kicad" ? "Replace" : "Add file"}
          </Button>
        </Tooltip>
        {source?.model && lcsc && model?.source !== "supplier" && (
          <Button onClick={() => takeSupplierModel(lcsc)} disabled={!!busy}>
            {busy === lcsc ? "Loading..." : `${lcsc}'s model`}
          </Button>
        )}
        {source?.model && !lcsc && query === null && (
          <Button onClick={() => setQuery(searchFor(c, part))} disabled={!!busy}>
            <Search size={14} /> Find
          </Button>
        )}
        {model && (
          <Tooltip label="Use the generated body">
            <Button variant="ghost" aria-label="Remove 3D model" onClick={() => assign(null)} disabled={!!busy}>
              <Trash2 size={14} />
            </Button>
          </Tooltip>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={MODEL_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (file) void addFile(file)
        }}
      />

      {query !== null && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (query.trim()) void search(query.trim())
          }}
        >
          <input className="field h-8" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the supplier for a model" placeholder="Part number" />
          <Button type="submit" disabled={!!busy || !query.trim()}>
            {busy === "search" ? "..." : "Search"}
          </Button>
        </form>
      )}
      {hits && hits.length > 0 && (
        <ul className="space-y-1">
          {hits.map((h) => (
            <li key={h.lcsc}>
              <button
                className="w-full rounded-[var(--radius-ctl)] border border-line px-2 py-1.5 text-left text-[12px] hover:bg-chrome disabled:opacity-45"
                disabled={!!busy}
                onClick={() => takeSupplierModel(h.lcsc)}
              >
                <span className="mono text-ink">{h.lcsc}</span> <span className="text-ink-2">{h.mpn}</span>
                <span className="block truncate text-[11px] text-ink-3">{busy === h.lcsc ? "Loading..." : (h.package ?? "package unknown")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="text-[12px] text-danger">{problem}</p>}

      {model && (
        <>
          <Field label="Placed by">
            <select className="field h-8" value={model.origin} onChange={(e) => edit({ origin: e.target.value as Model3D["origin"] })}>
              <option value="model">The file's origin</option>
              <option value="center">Centred on the footprint, standing on the board</option>
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-1.5">
            {(["x", "y", "z"] as const).map((k) => (
              <Field key={k} label={`Offset ${k.toUpperCase()}`}>
                <LengthInput min={-1e3} value={model.offset[k]} onCommit={(v) => v !== null && edit({ offset: { ...model.offset, [k]: v } })} />
              </Field>
            ))}
            {(["x", "y", "z"] as const).map((k) => (
              <Field key={k} label={`Turn ${k.toUpperCase()} (°)`}>
                <CommitInput
                  type="number"
                  step={90}
                  value={model.rotation[k]}
                  className="tabular-nums"
                  onCommit={(v) => {
                    const n = num(v)
                    if (n !== null) edit({ rotation: { ...model.rotation, [k]: ((n % 360) + 360) % 360 } })
                  }}
                />
              </Field>
            ))}
          </div>
          <div className="flex items-end gap-1.5">
            <Button onClick={() => edit({ rotation: { ...model.rotation, z: (model.rotation.z + 90) % 360 } })}>
              <RotateCw size={14} /> 90°
            </Button>
            {model.format !== "step" && (
              <Field label="Scale (mm per unit)">
                <CommitInput
                  type="number"
                  step={0.1}
                  min={0}
                  value={model.scale ?? 1}
                  className="tabular-nums"
                  onCommit={(v) => {
                    const n = num(v)
                    if (n !== null && n > 0) edit({ scale: n === 1 ? undefined : n })
                  }}
                />
              </Field>
            )}
          </div>
        </>
      )}
      {sharing > 1 && (
        <p className="text-[11.5px] text-ink-3">
          Every {part.name} on {c.footprint} uses it ({sharing} parts).
        </p>
      )}
    </Section>
  )
}
