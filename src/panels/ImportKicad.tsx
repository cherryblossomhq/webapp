import { Loader2, X } from "lucide-react"
import { useState } from "react"
import { projectApi, useProjectStore } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { importKicadPart, type ImportOutcome } from "./kicadImport"

// The library panel's import: the hook that runs one, and the notice that says how it went.

type ImportState = { status: "busy" } | ({ status: "done" } & ImportOutcome)

/** Importing KiCad files into the open project, one import at a time. A single part is placed straight away. */
export function useKicadImport(onImported: (partIds: string[]) => void) {
  const projectId = useProjectStore((s) => s.project?.id)
  const startPlacing = useUi((s) => s.startPlacing)
  const [state, setState] = useState<ImportState | null>(null)
  const run = async (files: File[]) => {
    if (!projectId || !files.length || state?.status === "busy") return
    setState({ status: "busy" })
    try {
      const outcome = await importKicadPart(files, projectId, projectApi().commit)
      setState({ status: "done", ...outcome })
      onImported(outcome.partIds)
      if (outcome.partIds.length === 1) startPlacing(outcome.partIds[0])
    } catch (e) {
      setState({ status: "done", partIds: [], names: [], problems: [e instanceof Error ? e.message : String(e)] })
    }
  }
  return { state, run, busy: state?.status === "busy", dismiss: () => setState(null) }
}

/** What the last import did: the parts it added, and what didn't come in. */
export function ImportNotice({ state, onDismiss }: { state: ImportState; onDismiss: () => void }) {
  if (state.status === "busy") {
    return (
      <p role="status" className="mx-3 mb-2 flex items-center gap-1.5 text-[11.5px] text-ink-2">
        <Loader2 size={13} className="animate-spin" /> Importing KiCad files...
      </p>
    )
  }
  const { names, problems } = state
  const head = !names.length
    ? "Nothing was imported."
    : names.length === 1
      ? `Imported ${names[0]}. Click the schematic to place it.`
      : `Imported ${names.length} parts: ${names.join(", ")}. They're under This project.`
  return (
    <div role={names.length ? "status" : "alert"} className="mx-3 mb-2 rounded-[8px] border border-line bg-surface px-2.5 py-2 text-[11.5px] leading-snug">
      <div className="flex items-start gap-1.5">
        <p className={`min-w-0 flex-1 ${names.length ? "text-ink" : "text-danger"}`}>{head}</p>
        <button aria-label="Dismiss" onClick={onDismiss} className="-mr-1 -mt-0.5 rounded p-0.5 text-ink-3 hover:text-ink">
          <X size={13} />
        </button>
      </div>
      {problems.length > 0 && (
        <ul className={`mt-1 list-disc space-y-0.5 pl-4 ${names.length ? "text-warn" : "text-ink-2"}`}>
          {problems.slice(0, 6).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
          {problems.length > 6 && <li>And {problems.length - 6} more.</li>}
        </ul>
      )}
    </div>
  )
}
