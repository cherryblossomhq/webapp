import { useEffect, useState } from "react"
import { Button } from "../ui/controls"
import { Shell } from "./KicadImportDialog"
import { ReportView } from "./ReportView"
import { loadProjectReport, type StoredReport } from "./reportStore"

/**
 * The report of the KiCad import that made a project, in a dialog: this browser's copy, else the file the project names in the account's
 * file store, read when the dialog opens (`loadProjectReport`).
 */
export function KicadReportDialog({ projectId, file, onClose }: { projectId: string; file: string | undefined; onClose: () => void }) {
  const [report, setReport] = useState<StoredReport | null | "loading">("loading")
  useEffect(() => {
    let live = true
    setReport("loading")
    void loadProjectReport(projectId, file).then((r) => live && setReport(r))
    return () => {
      live = false
    }
  }, [projectId, file])
  return (
    <Shell label="KiCad import report" onDismiss={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scroll-thin">
        {report === "loading" ? (
          <p className="text-[13px] text-ink-2">Opening the report...</p>
        ) : report ? (
          <ReportView summary={report.summary} name={report.name} />
        ) : (
          <p className="text-[13px] text-ink-2">The report could not be opened: its file is not in this account, or in the account of anyone this project is shared with.</p>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button data-autofocus onClick={onClose}>
          Close
        </Button>
      </div>
    </Shell>
  )
}
