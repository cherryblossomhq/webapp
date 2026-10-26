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
export { moveBrowserProjects } from "./store/storage"
export type { ProjectStorage, StoredProjectSummary } from "./store/storage"
