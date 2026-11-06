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
    import("./store/partModels"),
    import("./store/accountStore"),
    import("./model/projectFile"),
  ]).then(([projectStore, uiStore, analysis, instances, managedAi, supplierParts, partModels, accountStore, projectFile]) => {
    Object.assign(window, {
      __cherryblossom: {
        projectApi: projectStore.projectApi,
        // The store itself, so a browser test can put the editor in a state (a viewer's, say) the harness can't reach.
        projectStore: projectStore.useProjectStore,
        // Where the open project is saved, so a check by hand can make its saves fail (`push` rejecting) on the real app.
        projectStorage: projectStore.projectStorage,
        uiApi: uiStore.uiApi,
        // Reads a project file, so a browser test can open a board bigger than the harness's browser storage holds (a speed test on a big board).
        parseProjectFile: projectFile.parseProjectFile,
        getConnectivity: analysis.getConnectivity,
        getPcbAnalysis: analysis.getPcbAnalysis,
        // What the views are shown, which says whether the checks or the pours are still to come (a speed test waits for them).
        getLiveAnalysis: analysis.getLiveAnalysis,
        schematicPins: instances.schematicPins,
        pcbPads: instances.pcbPads,
        // Lets a browser test stand in for the host's session against a mocked /api/v1. This hook comes after the page has loaded, often after Sakura's
        // panel asked for the account with no session and was told to sign in, so the account is asked again with the session, as a host's would be.
        connectManagedAi: (host: Parameters<typeof managedAi.connectManagedAi>[0]) => {
          managedAi.connectManagedAi(host)
          const account = accountStore.useAccount.getState()
          void account.load().then(() => (accountStore.useAccount.getState().status === "ready" ? null : account.load(true)))
        },
        // And for its supplier part data, and the supplier's and KiCad's 3D models.
        connectSupplierParts: supplierParts.connectSupplierParts,
        connectPartModels: partModels.connectPartModels,
      },
    })
  })
}

export { App, type AppProps } from "./App"
export type { AssistantActivity, ManagedAiHost } from "./ai/managedAi"
export type { AccountUser, EditorAccount } from "./store/account"
export type { PartsIndexSource, SupplierPartsSource } from "./ai/supplierParts"
export type { ModelFileStore } from "./store/modelFiles"
export type { PartModelSource } from "./store/partModels"
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
export type { ChatPart, ChatSaveOutcome, ChatSource, ChatSummary, ChatWrite, StoredChat } from "./store/chats"
export type { LeaseAnswer, LeaseHolder, LockSource } from "./store/boardLease"
export type { InviteResult, MemberRole, ShareInvite, ShareMember, SharePerson, SharingSource, SharingState } from "./store/sharing"
export type { HistorySource, HistoryState, NameOutcome, OpenedVersion, RestoreOutcome, VersionCounts, VersionInfo, VersionPerson, VersionSummary } from "./store/history"
