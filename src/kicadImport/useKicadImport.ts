import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { ProjectStorage } from "../store/storage"
import { KicadImportController } from "./controller"

/** The import's controller for a page, and what it is showing now. A page that goes away mid-import cancels it. */
export function useKicadImport(storage: ProjectStorage) {
  const controller = useMemo(() => new KicadImportController(storage), [storage])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  useEffect(() => () => controller.cancel(), [controller])
  return { controller, state }
}
