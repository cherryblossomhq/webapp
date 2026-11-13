import { AlertTriangle, Box, Braces, CheckCircle2, CircuitBoard, Download, FileJson, FileSpreadsheet, Package, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { isTyping } from "../editor/viewport"
import { buildFabricationZip, downloadBlob, downloadProjectFile, downloadText, projectFileName } from "../export/bundle"
import { circuitJsonFile } from "../export/circuitJson"
import { outlineWarning } from "../export/outlineGuard"
import { bomCsv } from "../export/bom"
import { pnpCsv } from "../export/pnp"
import { placedParts } from "../export/placedModels"
import type { ModelProgress } from "../export/placedModels"
import { componentModel } from "../model/models3d"
import { naturalCompare } from "../lib/natural"
import { ensureTextFont } from "../model/textFont"
import { onBoard } from "../model/partFlags"
import { autoPlacePcb } from "../model/ops"
import { resolvedComponents } from "../model/ruleAreas"
import type { Project } from "../model/types"
import { getPcbAnalysis } from "../store/analysis"
import { projectApi, useProjectStore } from "../store/projectStore"
import type { ExportFormat, ExportModelSettings } from "../store/settings"
import { useUi } from "../store/uiStore"
import { Button } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

// The Export dialog: every file the editor makes, in one place, each with what is in it, what it needs from the board, and the
// options it has (the KiCad and Altium projects' 3D models). It was a menu of eight rows until the exports began to have options.
// What each export writes is `src/export`; this only asks for it, and remembers the format and the options for the browser.

type Group = "Manufacturing" | "Other tools" | "Mechanical" | "Project"

interface FormatInfo {
  id: ExportFormat
  group: Group
  title: string
  icon: ReactNode
  /** One line under the title, in the list. */
  short: string
  /** What the file is for. */
  detail: string
  /** What is in it, a line each. */
  contents: string[]
  /** The file's extension, as the button says it. */
  ext: string
  beta?: boolean
}

const FORMATS: FormatInfo[] = [
  {
    id: "fabrication",
    group: "Manufacturing",
    title: "Fabrication files",
    icon: <Package size={16} />,
    short: "Gerbers, drill, BOM and pick-and-place",
    detail: "Everything a board house needs to make and assemble the board, in one .zip to upload as it is.",
    contents: ["Gerbers (RS-274X): copper, solder mask, paste, silkscreen and the outline", "Excellon drill files, plated and non-plated", "Bill of materials and pick-and-place (CSV)", "Fabrication notes: the board, the smallest features and the rules"],
    ext: ".zip",
  },
  {
    id: "bom",
    group: "Manufacturing",
    title: "Bill of materials",
    icon: <FileSpreadsheet size={16} />,
    short: "CSV, one line per distinct part",
    detail: "The parts to buy: one line per distinct part, with its designators, quantity, value, footprint and part numbers.",
    contents: ["One CSV file"],
    ext: ".csv",
  },
  {
    id: "pnp",
    group: "Manufacturing",
    title: "Pick and place",
    icon: <FileSpreadsheet size={16} />,
    short: "CSV of part positions for assembly",
    detail: "Where each part sits for an assembly machine: designator, position, rotation and side.",
    contents: ["One CSV file"],
    ext: ".csv",
  },
  {
    id: "kicad",
    group: "Other tools",
    title: "KiCad project",
    icon: <CircuitBoard size={16} />,
    short: "Schematic, board and project for KiCad 9",
    detail: "The schematic, the board and the project as KiCad 9 files, to open in KiCad or keep working there.",
    contents: ["Schematic sheets (.kicad_sch)", "Board (.kicad_pcb)", "Project file with the design rules and net classes (.kicad_pro)"],
    ext: ".zip",
    beta: true,
  },
  {
    id: "altium",
    group: "Other tools",
    title: "Altium project",
    icon: <CircuitBoard size={16} />,
    short: "Schematic, board and project for Altium Designer",
    detail: "The schematic, the board and the project as Altium Designer documents.",
    contents: ["Schematic sheets (.SchDoc)", "Board with its rules and pours (.PcbDoc)", "Project (.PrjPcb)"],
    ext: ".zip",
    beta: true,
  },
  {
    id: "circuit-json",
    group: "Other tools",
    title: "Circuit JSON (tscircuit)",
    icon: <Braces size={16} />,
    short: "Parts, nets, schematic and board for tscircuit tools",
    detail: "The parts, nets, schematic and board in tscircuit's Circuit JSON, which its tools read.",
    contents: ["One .circuit.json file"],
    ext: ".json",
  },
  {
    id: "step",
    group: "Mechanical",
    title: "3D model (STEP)",
    icon: <Box size={16} />,
    short: "The board and every part, for mechanical CAD",
    detail: "The board as an exact solid with its holes, and every part that has a 3D model where it sits, as one assembly for SolidWorks, Fusion, FreeCAD or Onshape.",
    contents: ["One STEP AP214 file, each part named by its designator"],
    ext: ".step",
  },
  {
    id: "project",
    group: "Project",
    title: "Project file",
    icon: <FileJson size={16} />,
    short: "Cherry Blossom .json you can import later",
    detail: "The whole project as a Cherry Blossom file: a backup, or a copy to import into another account.",
    contents: ["One .json file. 3D model files you added stay in your account and are not in it."],
    ext: ".json",
  },
]

const GROUPS: Group[] = ["Manufacturing", "Other tools", "Mechanical", "Project"]
const formatOf = (id: ExportFormat) => FORMATS.find((f) => f.id === id) ?? FORMATS[0]

/**
 * Exports need every part on the board; place stragglers first so nothing lands at the origin. A
 * viewer can't place them in the project, so their export places them in the copy it writes.
 */
function placedProject(): Project {
  const p = projectApi().project!
  if (resolvedComponents(p).some((c) => !c.pcb.placed && onBoard(c))) {
    if (projectApi().role === "viewer") return autoPlacePcb(p)
    projectApi().commit((x) => autoPlacePcb(x))
  }
  return projectApi().project!
}

/** "J1, R3 and U2", or the first few and how many more. */
function listRefs(refs: string[], most = 6): string {
  const sorted = [...refs].sort(naturalCompare)
  if (sorted.length <= most) return sorted.length > 1 ? `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}` : sorted.join("")
  return `${sorted.slice(0, most).join(", ")} and ${sorted.length - most} more`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The Export button of the top bar, and the dialog it opens. */
export function ExportButton() {
  const [open, setOpen] = useState(false)
  // A line saying what was exported, and nothing more: the exporters' notes (what does not carry over) are for the tests and the docs, not
  // a wall of fine print after every download.
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])
  return (
    <div className="relative">
      <Tooltip label="Export" hint="Fabrication files, other tools, 3D or the project file">
        <Button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label="Export">
          <Download size={15} /> <span className="hidden lg:inline">Export</span>
        </Button>
      </Tooltip>
      {open && (
        <ExportDialog
          onClose={() => setOpen(false)}
          onDone={(text) => {
            setOpen(false)
            setNotice(text)
          }}
        />
      )}
      {notice && (
        <div role="status" className="absolute right-0 top-10 z-20 w-[340px] rounded-[10px] bg-ink px-3 py-2 text-[12.5px] text-surface shadow-lg">
          {notice}
        </div>
      )}
    </div>
  )
}

export function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: (notice: string) => void }) {
  const settings = useUi((s) => s.settings)
  const updateSettings = useUi((s) => s.updateSettings)
  const [format, setFormat] = useState<ExportFormat>(settings.exportFormat)
  const models = settings.exportModels
  const setModels = (patch: Partial<ExportModelSettings>) => updateSettings({ exportModels: { ...models, ...patch } })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const info = formatOf(format)

  const close = () => {
    abort.current?.abort()
    onClose()
  }
  const latestClose = useRef(close)
  useEffect(() => {
    latestClose.current = close
  })
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        latestClose.current()
      } else if (!isTyping(e) && !box.current?.contains(e.target as Node)) {
        // The canvas's shortcuts listen on the window, and none is for the dialog: Delete would delete the selection behind it. A key pressed
        // inside the dialog reaches its own handlers first, and goes no further (`onKeyDown` on the dialog).
        e.stopPropagation()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [])

  const pick = (id: ExportFormat) => {
    if (busy) return
    setFormat(id)
    setFailure(null)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = FORMATS.findIndex((f) => f.id === format)
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0
    if (step) {
      e.preventDefault()
      const next = FORMATS[(i + step + FORMATS.length) % FORMATS.length]
      pick(next.id)
      list.current?.querySelector<HTMLElement>(`[data-format="${next.id}"]`)?.focus()
    } else if (e.key === "Enter") {
      e.preventDefault()
      void run()
    }
  }

  const onProgress = ({ done, total }: ModelProgress) => setProgress(total > 0 && done < total ? `Reading 3D models: ${done} of ${total}` : null)

  async function run() {
    if (busy || !projectApi().project) return
    const controller = new AbortController()
    abort.current = controller
    const signal = controller.signal
    setBusy(true)
    setFailure(null)
    setProgress(null)
    updateSettings({ exportFormat: format })
    try {
      // KiCad text is laid out with KiCad's font, which is fetched when a project with such text opens; an export waits for it.
      await ensureTextFont(projectApi().project!)
      const done = await exportFormat(format, models, { onProgress, signal })
      if (!signal.aborted) onDone(done)
    } catch (e) {
      if (!signal.aborted) setFailure(`The export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (abort.current === controller) abort.current = null
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
        className="flex w-full max-w-[760px] animate-pop-in flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-dialog">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id="export-title" className="text-[15px] font-[600] text-ink">
            Export
          </h2>
          <button type="button" onClick={close} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-2 hover:bg-chrome-2 hover:text-ink">
            <X size={15} />
          </button>
        </div>
        <div className="flex min-h-[400px] flex-col sm:flex-row">
          <div ref={list} role="listbox" aria-label="Formats" onKeyDown={onListKey} className="shrink-0 border-b border-line bg-chrome p-2 sm:w-[256px] sm:border-b-0 sm:border-r">
            {GROUPS.map((g) => (
              <div key={g} role="group" aria-label={g} className="mb-1.5 last:mb-0">
                <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-[600] uppercase tracking-[0.04em] text-ink-3">{g}</div>
                {FORMATS.filter((f) => f.group === g).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    data-format={f.id}
                    aria-selected={f.id === format}
                    tabIndex={f.id === format ? 0 : -1}
                    onClick={() => pick(f.id)}
                    onDoubleClick={() => void run()}
                    className={`flex w-full items-start gap-2.5 rounded-[7px] px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-select/50 ${f.id === format ? "bg-raised shadow-chip" : "hover:bg-chrome-2"}`}
                  >
                    <span className={`mt-0.5 ${f.id === format ? "text-ink" : "text-ink-2"}`}>{f.icon}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[13px] font-[600] text-ink">
                        {f.title}
                        {f.beta && <Beta />}
                      </span>
                      <span className="block truncate text-[11.5px] text-ink-2">{f.short}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col p-5">
            <div className="flex items-center gap-2 text-[15px] font-[600] text-ink">
              <span className="text-ink-2">{info.icon}</span>
              {info.title}
              {info.beta && <Beta />}
            </div>
            <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-2">{info.detail}</p>
            <h3 className="mt-4 text-[11px] font-[600] uppercase tracking-[0.04em] text-ink-3">What's in it</h3>
            <ul className="mt-1.5 space-y-1 text-[12.5px] text-ink">
              {info.contents.map((c) => (
                <li key={c} className="flex gap-2">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                  {c}
                </li>
              ))}
            </ul>
            <Options format={format} models={models} setModels={setModels} disabled={busy} />
            <BoardStatus format={format} models={models} />
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-line px-5 py-3">
          <div role={failure ? "alert" : undefined} aria-live="polite" className={`min-w-0 flex-1 truncate text-[12.5px] ${failure ? "text-danger" : "text-ink-2"}`} title={failure ?? undefined}>
            {failure ?? progress ?? (busy ? "Writing the files…" : "")}
          </div>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy} aria-label={`Download ${info.title}`}>
            <Download size={14} /> {busy ? "Exporting…" : `Download ${info.ext}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Beta() {
  return <span className="rounded-full border border-warn px-1.5 text-[11px] font-[500] leading-4 text-warn">beta</span>
}

function Options({ format, models, setModels, disabled }: { format: ExportFormat; models: ExportModelSettings; setModels: (p: Partial<ExportModelSettings>) => void; disabled: boolean }) {
  if (format !== "kicad" && format !== "altium") return null
  return (
    <fieldset disabled={disabled} className="mt-4">
      <legend className="text-[11px] font-[600] uppercase tracking-[0.04em] text-ink-3">Options</legend>
      {format === "kicad" ? (
        <>
          <Check
            checked={models.kicad}
            onChange={(kicad) => setModels({ kicad })}
            label="Include 3D models"
            hint="Supplier models and the files you added go into the project as STEP files, in a 3dmodels folder each footprint names. KiCad's own library models are named from KiCad's 3D library."
          />
          <div className="pl-6">
            <Check
              checked={models.kicad && models.kicadLibrary}
              disabled={!models.kicad}
              onChange={(kicadLibrary) => setModels({ kicadLibrary })}
              label="Copy KiCad's library models too"
              hint="Every model in the project, so it opens with its parts on a computer without KiCad's 3D library. A bigger download."
            />
          </div>
        </>
      ) : (
        <Check
          checked={models.altium}
          onChange={(altium) => setModels({ altium })}
          label="Include 3D models"
          hint="Every part's model is embedded in the board as a STEP file, KiCad's own included, since Altium has no KiCad library."
        />
      )}
    </fieldset>
  )
}

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <label className={`mt-2 flex gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-[3px] accent-select" />
      <span>
        <span className="block text-[13px] font-[500] text-ink">{label}</span>
        <span className="block text-[12px] leading-[1.45] text-ink-2">{hint}</span>
      </span>
    </label>
  )
}

/** What the board means for the export chosen, before it is made: what a fab would refuse, and which parts have no 3D model. */
function BoardStatus({ format, models }: { format: ExportFormat; models: ExportModelSettings }) {
  const project = useProjectStore((s) => s.project)
  const lines = useMemo(() => {
    if (!project) return []
    const out: { tone: "warn" | "ok"; text: string }[] = []
    const unplaced = resolvedComponents(project).filter((c) => !c.pcb.placed && onBoard(c)).length
    const board = format === "fabrication" || format === "bom" || format === "pnp" || format === "kicad" || format === "altium" || format === "step" || format === "circuit-json"
    if (board && unplaced) out.push({ tone: "warn", text: `${plural(unplaced, "part isn't", "parts aren't")} on the board yet; ${unplaced === 1 ? "it is" : "they are"} placed when you export.` })
    if (format === "fabrication") {
      const warning = outlineWarning(project)
      if (warning) out.push({ tone: "warn", text: warning })
      const analysis = getPcbAnalysis(project)
      // Unrouted connections are counted on their own (a project from KiCad makes them errors, as KiCad's unconnected_items is one).
      const errors = analysis.violations.filter((v) => v.severity === "error" && v.kind !== "unrouted").length
      const unrouted = analysis.ratsnest.length
      if (errors || unrouted) out.push({ tone: "warn", text: `${[errors && plural(errors, "DRC error"), unrouted && plural(unrouted, "unrouted connection")].filter(Boolean).join(" and ")}. Check before ordering.` })
      else if (!warning) out.push({ tone: "ok", text: "Checks pass: no DRC errors and nothing unrouted." })
    }
    const withModels = format === "step" || (format === "kicad" && models.kicad) || (format === "altium" && models.altium)
    if (withModels) {
      const parts = placedParts(project)
      const missing = parts.filter((c) => !componentModel(project, c)).map((c) => c.ref)
      if (missing.length) out.push({ tone: "warn", text: `${missing.length} of ${plural(parts.length, "part")} ${missing.length === 1 ? "has" : "have"} no 3D model${format === "step" ? " and are left out" : ""}: ${listRefs(missing)}.` })
      else if (parts.length) out.push({ tone: "ok", text: `Every part on the board has a 3D model (${parts.length}).` })
    }
    return out
  }, [project, format, models.kicad, models.altium])
  if (!lines.length) return null
  return (
    <div className="mt-auto space-y-1.5 pt-4">
      {lines.map((l) => (
        <div key={l.text} className={`flex gap-2 rounded-[7px] px-2.5 py-1.5 text-[12.5px] leading-[1.45] ${l.tone === "warn" ? "bg-warn/10 text-ink" : "bg-chrome text-ink-2"}`}>
          {l.tone === "warn" ? <AlertTriangle size={14} className="mt-[2px] shrink-0 text-warn" /> : <CheckCircle2 size={14} className="mt-[2px] shrink-0 text-ok" />}
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

/** Make and download one export of the open project; resolves to the line said after it. */
async function exportFormat(format: ExportFormat, models: ExportModelSettings, o: { onProgress: (p: ModelProgress) => void; signal: AbortSignal }): Promise<string> {
  const p = placedProject()
  const reader = async () => (await import("../editor/three/files/library")).browserModelReader
  switch (format) {
    case "fabrication": {
      const blob = await buildFabricationZip(p)
      o.signal.throwIfAborted()
      downloadBlob(blob, projectFileName(p, "zip"))
      const warning = outlineWarning(p)
      const analysis = getPcbAnalysis(p)
      const errors = analysis.violations.filter((v) => v.severity === "error" && v.kind !== "unrouted").length
      const unrouted = analysis.ratsnest.length
      if (warning) return `Exported, but: ${warning}`
      if (errors || unrouted) return `Exported with ${[errors && plural(errors, "DRC error"), unrouted && plural(unrouted, "unrouted connection")].filter(Boolean).join(" and ")}. Check before ordering.`
      return "Exported Gerbers, drill file, BOM and pick-and-place."
    }
    case "bom":
      downloadText(bomCsv(p), projectFileName(p, "bom.csv"), "text/csv")
      return "Exported the bill of materials."
    case "pnp":
      downloadText(pnpCsv(p), projectFileName(p, "pnp.csv"), "text/csv")
      return "Exported the pick-and-place file."
    case "circuit-json":
      downloadText(circuitJsonFile(p).text, projectFileName(p, "circuit.json"), "application/json")
      return "Exported Circuit JSON, which tscircuit and its tools read."
    case "kicad": {
      // The KiCad writer is a few megabytes of its own, fetched when it is first asked for.
      const { kicadZip } = await import("../export/kicad")
      const options = models.kicad ? { models: { reader: await reader(), copyLibrary: models.kicadLibrary, onProgress: o.onProgress, signal: o.signal } } : {}
      const { blob } = await kicadZip(p, options)
      o.signal.throwIfAborted()
      downloadBlob(blob, projectFileName(p, "kicad.zip"))
      return models.kicad ? "Exported a KiCad project with its 3D models." : "Exported a KiCad project: schematic, board and project file."
    }
    case "altium": {
      const { altiumZip } = await import("../export/altium")
      const options = models.altium ? { models: { reader: await reader(), onProgress: o.onProgress, signal: o.signal } } : {}
      const { blob } = await altiumZip(p, options)
      o.signal.throwIfAborted()
      downloadBlob(blob, projectFileName(p, "altium.zip"))
      return models.altium ? "Exported an Altium project with its 3D models." : "Exported an Altium project: schematic, board and project file."
    }
    case "step": {
      // The STEP writer and the model files it reads are fetched when it is first asked for.
      const { stepFile } = await import("../export/step3d")
      const { text } = await stepFile(p, await reader(), { onProgress: o.onProgress, signal: o.signal })
      o.signal.throwIfAborted()
      downloadText(text, projectFileName(p, "step"), "model/step")
      return "Exported the board and its parts as a STEP assembly."
    }
    case "project":
      downloadProjectFile(projectApi().project!)
      return "Exported the project file."
  }
}
