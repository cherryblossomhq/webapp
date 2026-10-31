/**
 * What a host needs to list projects on a page of its own: the website's `/projects` is one.
 *
 * Importing this does **not** start the editor (no theme sync, no development hook), so a host can
 * draw previews and act on stored projects without mounting `App`. It is still client-only: the
 * previews fill copper pours as they draw, and the project file reader registers project parts.
 */
export { BoardPreview } from "./pages/BoardPreview"
export { EXAMPLES, type Example } from "./model/examples"
export { createProject } from "./model/ops"
export type { Project } from "./model/types"
export {
  actionFailure,
  createStoredProject,
  downloadStoredProject,
  duplicateStoredProject,
  importProjectFile,
  previewProject,
  removeStoredProject,
  renameStoredProject,
} from "./store/projectActions"
// The KiCad import, for a projects page with a look of its own: the same controller the editor's
// dashboard runs, and the report as data to draw (`src/kicadImport/`, AGENTS.md).
export { connectAnalytics, type EventSink } from "./kicadImport/analytics"
// Where an import keeps the files a project names (the user's own KiCad files, reference images): a projects page connects the account's.
export { connectModelFiles, type ModelFileStore } from "./store/modelFiles"
export { KicadImportController, type ImportState } from "./kicadImport/controller"
export { downloadReport } from "./kicadImport/download"
export { entriesFromDrop, entriesFromFiles, isProjectFileDrop } from "./kicadImport/dropped"
export { useModal } from "./kicadImport/focus"
export { ACCEPTED_EXTENSIONS } from "./kicadImport/pick"
export { PHASE_LABELS } from "./kicadImport/protocol"
export { sizeText } from "./kicadImport/save"
export { reportLead, reportSections, reportTitle, reportTone, saveNextStep, type ReportSection } from "./kicadImport/sections"
export { moveBrowserProjects } from "./store/storage"
export type { ProjectStorage, StoredProjectSummary } from "./store/storage"
