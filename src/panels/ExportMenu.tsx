import { Box, Braces, CircuitBoard, Download, FileJson, FileSpreadsheet, Package } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { buildFabricationZip, downloadBlob, downloadText, projectFileName } from "../export/bundle"
import { circuitJsonFile } from "../export/circuitJson"
import { serializeProject } from "../model/projectFile"
import { bomCsv } from "../export/bom"
import { pnpCsv } from "../export/pnp"
import { findPart } from "../model/library"
import { isPhysical } from "../model/instances"
import { autoPlacePcb } from "../model/ops"
import { getPcbAnalysis } from "../store/analysis"
import { projectApi } from "../store/projectStore"
import { Button, useDismiss } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"

/**
 * Exports need every part on the board; place stragglers first so nothing lands at the origin. A
 * viewer can't place them in the project, so their export places them in the copy it writes.
 */
function placedProject() {
  const p = projectApi().project!
  if (p.components.some((c) => !c.pcb.placed && isPhysical(findPart(c.partId)))) {
    if (projectApi().role === "viewer") return autoPlacePcb(p)
    projectApi().commit((x) => autoPlacePcb(x))
  }
  return projectApi().project!
}

export function ExportMenu() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; notes?: string[] } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(ref, open, () => setOpen(false))

  const run = async (fn: () => Promise<void> | void) => {
    setOpen(false)
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setNotice({ text: `The export failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const exportGerbers = () =>
    run(async () => {
      const p = placedProject()
      const errors = getPcbAnalysis(p).violations.filter((v) => v.severity === "error").length
      const unrouted = getPcbAnalysis(p).ratsnest.length
      downloadBlob(await buildFabricationZip(p), projectFileName(p, "zip"))
      setNotice({
        text:
          errors || unrouted
            ? `Exported with ${[errors && `${errors} DRC ${errors === 1 ? "error" : "errors"}`, unrouted && `${unrouted} unrouted ${unrouted === 1 ? "connection" : "connections"}`].filter(Boolean).join(" and ")}. Check before ordering.`
            : "Exported Gerbers, drill file, BOM and pick-and-place.",
      })
    })

  const exportCircuitJson = () =>
    run(() => {
      const p = placedProject()
      const { text, notes } = circuitJsonFile(p)
      downloadText(text, projectFileName(p, "circuit.json"), "application/json")
      setNotice({ text: "Exported Circuit JSON, which tscircuit and its tools read.", notes })
    })

  // The KiCad writer is a few megabytes of its own, fetched when it is first asked for.
  const exportKicad = () =>
    run(async () => {
      const p = placedProject()
      const { kicadZip } = await import("../export/kicad")
      const { blob, notes } = await kicadZip(p)
      downloadBlob(blob, projectFileName(p, "kicad.zip"))
      setNotice({ text: "Exported a KiCad project: schematic, board and project file.", notes })
    })

  // The STEP writer and the model files it reads are fetched when it is first asked for.
  const exportStep = () =>
    run(async () => {
      const p = placedProject()
      const { stepFile } = await import("../export/step3d")
      const { text, notes } = await stepFile(p, {
        onProgress: ({ done, total }) => total > 0 && done < total && setNotice({ text: `Reading 3D models: ${done} of ${total}` }),
      })
      downloadText(text, projectFileName(p, "step"), "model/step")
      setNotice({ text: "Exported the board and its parts as a STEP assembly.", notes })
    })

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), notice.notes?.length ? 20000 : 5000)
    return () => clearTimeout(t)
  }, [notice])

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Export" hint="Fabrication files, parts list or the project file">
        <Button onClick={() => setOpen(!open)} disabled={busy} aria-expanded={open} aria-haspopup="menu" aria-label="Export">
          <Download size={15} /> <span className="hidden lg:inline">Export</span>
        </Button>
      </Tooltip>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-[290px] overflow-hidden rounded-[10px] border border-line bg-surface p-1 shadow-menu">
          <MenuItem icon={<Package size={16} />} title="Fabrication files" detail="Gerbers, drill, BOM and pick-and-place as a .zip" onClick={exportGerbers} />
          <MenuItem icon={<FileSpreadsheet size={16} />} title="Bill of materials" detail="CSV, one line per distinct part" onClick={() => run(() => downloadText(bomCsv(placedProject()), projectFileName(projectApi().project!, "bom.csv"), "text/csv"))} />
          <MenuItem icon={<FileSpreadsheet size={16} />} title="Pick and place" detail="CSV of part positions for assembly" onClick={() => run(() => downloadText(pnpCsv(placedProject()), projectFileName(projectApi().project!, "pnp.csv"), "text/csv"))} />
          <MenuItem icon={<Braces size={16} />} title="Circuit JSON (tscircuit)" detail="Parts, nets, schematic and board for tscircuit tools" onClick={exportCircuitJson} />
          <MenuItem icon={<CircuitBoard size={16} />} title="KiCad project" detail="Schematic, board and project as a .zip for KiCad 9" onClick={exportKicad} />
          <MenuItem icon={<Box size={16} />} title="3D model (STEP)" detail="The board and every part as an assembly for mechanical CAD" onClick={exportStep} />
          <MenuItem
            icon={<FileJson size={16} />}
            title="Project file"
            detail="Cherry Blossom .json you can import later"
            onClick={() => run(() => downloadText(serializeProject(projectApi().project!, { pretty: true }), projectFileName(projectApi().project!, "json"), "application/json"))}
          />
        </div>
      )}
      {notice && (
        <div role="status" className="absolute right-0 top-10 z-20 w-[340px] rounded-[10px] bg-ink px-3 py-2 text-[12.5px] text-surface shadow-lg">
          <div className="flex items-start justify-between gap-2">
            <span>{notice.text}</span>
            {notice.notes?.length ? (
              <button onClick={() => setNotice(null)} className="shrink-0 underline" aria-label="Close">
                Close
              </button>
            ) : null}
          </div>
          {notice.notes?.length ? (
            <div className="mt-1.5 border-t border-surface/20 pt-1.5">
              <div className="font-[600]">What does not carry over</div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                {notice.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, title, detail, onClick }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex w-full items-start gap-3 rounded-[7px] px-2.5 py-2 text-left hover:bg-chrome">
      <span className="mt-0.5 text-ink-2">{icon}</span>
      <span>
        <span className="block text-[13px] font-[600] text-ink">{title}</span>
        <span className="block text-[12px] text-ink-2">{detail}</span>
      </span>
    </button>
  )
}
