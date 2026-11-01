/**
 * The editor's entry point for a host app, in place of a Vite `main.tsx`.
 *
 * Importing this module starts the editor: the host mounts `App` client-side
 * only (every store reads `localStorage` and `location` when it is created),
 * loads `./styles.css` once, and runs `themeScript` in its `<head>`. The host
 * implements `ProjectStorage` against a type-only import, which starts nothing.
 */
import { registerBrowserRenderer } from "./ai/vision/encode"
import { watchTheme } from "./store/themeStore"

watchTheme()
// Sakura's pictures (`look`), drawn on this page's canvas and WebGL; loaded the first time one is taken.
registerBrowserRenderer(async () => (await import("./ai/vision/browserRenderer")).browserRenderer)

if (process.env.NODE_ENV === "development") {
  // Test hook for driving the editor from browser automation during development.
  void Promise.all([
    import("./store/projectStore"),
    import("./store/uiStore"),
    import("./store/analysis"),
    import("./model/instances"),
    import("./ai/managedAi"),
    import("./ai/supplierParts"),
  ]).then(([projectStore, uiStore, analysis, instances, managedAi, supplierParts]) => {
    Object.assign(window, {
      __cherryblossom: {
        projectApi: projectStore.projectApi,
        // The store itself, so a browser test can put the editor in a state (a viewer's, say) the harness can't reach.
        projectStore: projectStore.useProjectStore,
        uiApi: uiStore.uiApi,
        getConnectivity: analysis.getConnectivity,
        getPcbAnalysis: analysis.getPcbAnalysis,
        schematicPins: instances.schematicPins,
        pcbPads: instances.pcbPads,
        // Lets a browser test stand in for the host's session against a mocked /api/v1.
        connectManagedAi: managedAi.connectManagedAi,
        // And for its supplier part data.
        connectSupplierParts: supplierParts.connectSupplierParts,
      },
    })
  })
}

export { App, type AppProps } from "./App"
export type { ManagedAiHost } from "./ai/managedAi"
export type { AccountUser, EditorAccount } from "./store/account"
export type { PartsIndexSource, SupplierPartsSource } from "./ai/supplierParts"
export type { ModelFileStore } from "./store/modelFiles"
export type {
  ChangesEvent,
  OutgoingBatch,
  ProjectRecord,
  ProjectRole,
  ProjectStorage,
  PushOutcome,
  PushRefusal,
  RemoteBatch,
  SaveOutcome,
  SaveRefusal,
  StoredProject,
  StoredProjectSummary,
} from "./store/storage"
export type { PresenceMe, PresencePeer, PresenceSource } from "./store/presence"
export type { LeaseAnswer, LeaseHolder, LockSource } from "./store/boardLease"
export type { InviteResult, MemberRole, ShareInvite, ShareLink, ShareMember, SharePerson, SharingSource, SharingState } from "./store/sharing"
export type { HistorySource, HistoryState, NameOutcome, OpenedVersion, RestoreOutcome, VersionCounts, VersionInfo, VersionPerson, VersionSummary } from "./store/history"
