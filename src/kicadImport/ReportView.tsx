import { AlertTriangle, CheckCircle2, Download, XCircle } from "lucide-react"
import { Button } from "../ui/controls"
import { downloadReport } from "./download"
import { reportLead, reportSections, reportTitle, reportTone, saveNextStep } from "./sections"
import type { SaveKind } from "./save"
import type { ImportSummary } from "./summary"

// The report screen's body: what came in, what was left out and why, what changed, and for a
// refusal what the board uses that is not supported yet. Shown after every import, and again from
// the project's panel. The words come from `sections.ts`, shared with the website's projects page.
// With `saveError` the board was read but not saved, and the screen says that first.

const TONES = { ok: ["text-ok", CheckCircle2], warn: ["text-warn", AlertTriangle], bad: ["text-danger", XCircle] } as const

export function ReportView({ summary: s, name, saveError = null, saveKind = null }: { summary: ImportSummary; name: string; saveError?: string | null; saveKind?: SaveKind | null }) {
  const [color, Icon] = TONES[reportTone(s, saveError)]
  return (
    // PostHog's click capture records the text of what is clicked, and this screen shows file and part names.
    <div className="ph-no-capture">
      <div className="flex items-start gap-2.5">
        <Icon size={20} className={`mt-0.5 shrink-0 ${color}`} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-[650] text-ink">{reportTitle(s, saveError, saveKind)}</h2>
          {saveError ? (
            <div role="alert" className="mt-1.5 rounded-[10px] border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              <p>{reportLead(s, saveError)}</p>
              <p className="mt-1 text-ink-2">{saveNextStep(saveKind, s.kind)}</p>
            </div>
          ) : (
            <p className="mt-0.5 text-[13px] text-ink-2">{reportLead(s)}</p>
          )}
        </div>
      </div>

      {reportSections(s, saveError).map((section) => (
        <section key={section.title} className="mt-4">
          <h3 className="text-[13px] font-[650] text-ink">
            {section.title}
            {section.count !== undefined && <span className="ml-1.5 font-normal text-ink-3">{section.count}</span>}
          </h3>
          <div className="mt-1.5 space-y-1.5 text-[12.5px] text-ink-2">
            {section.lines.map((l, i) => (
              <p key={i}>
                {l.lead && <span className="font-medium text-ink">{l.lead}: </span>}
                {l.text}
              </p>
            ))}
          </div>
        </section>
      ))}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={() => downloadReport(s, name, "text")}>
          <Download size={15} /> Full report (text)
        </Button>
        <Button onClick={() => downloadReport(s, name, "json")}>
          <Download size={15} /> Full report (JSON)
        </Button>
      </div>
    </div>
  )
}
