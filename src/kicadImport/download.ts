import { downloadText, slugify } from "../export/bundle"
import { reportJson, reportText, type ImportSummary } from "./summary"

/** Save the full report as a text or JSON file, named for the project. */
export function downloadReport(summary: ImportSummary, name: string, format: "text" | "json") {
  const file = `${slugify(name)}-import-report`
  if (format === "text") downloadText(reportText(summary, name), `${file}.txt`)
  else downloadText(reportJson(summary, name), `${file}.json`, "application/json")
}
