import { Component, useEffect, useState, type ReactNode } from "react"
import { connectManagedAi, type ManagedAiHost } from "./ai/managedAi"
import { connectSupplierParts, type SupplierPartsSource } from "./ai/supplierParts"
import { createProject } from "./model/ops"
import { ProjectFileError } from "./model/projectFile"
import { Dashboard } from "./pages/Dashboard"
import { Editor } from "./pages/Editor"
import { AccountContext, type EditorAccount } from "./store/account"
import { useCopilot } from "./store/copilotStore"
import { browserModelFiles, connectModelFiles, type ModelFileStore } from "./store/modelFiles"
import { browserPresence } from "./store/presence"
import { localSharing } from "./store/sharing"
import { connectProjectStorage, settleSaves, useProjectStore } from "./store/projectStore"
import { browserProjectStorage, movedProjectId, moveBrowserProjects, openStoredProject, projectRecord, type ProjectStorage } from "./store/storage"
import { useUi, type View } from "./store/uiStore"

/** Where the host mounts the editor (`AppProps.basePath`). */
let basePath = ""

const parseRoute = () => {
  const m = window.location.pathname.slice(basePath.length).match(/^\/p\/([\w-]+)\/?$/)
  if (m) return { page: "editor" as const, id: m[1] }
  return { page: "home" as const }
}
type Route = ReturnType<typeof parseRoute>
/** The route now, kept as it was when the URL names the same page, so that page isn't loaded twice. */
const followRoute = (was: Route): Route => {
  const now = parseRoute()
  return (now.page === "editor" ? now.id : "") === (was.page === "editor" ? was.id : "") ? was : now
}

/** The mounted `App`, told of each change of page made here; the browser's back and forward are `popstate`. */
let onNavigate: (() => void) | undefined
const navigate = (path: string, { replace = false } = {}) => {
  if (replace) window.history.replaceState(null, "", path)
  else window.history.pushState(null, "", path)
  onNavigate?.()
}
const projectPath = (id: string) => `${basePath}/p/${id}`

/**
 * The view a project's address opens on, `?view=pcb` or `?view=3d`. The schematic needs none: a
 * project opens on it anyway, so its address is the bare one.
 */
const VIEWS: readonly View[] = ["schematic", "pcb", "3d"]
const viewInAddress = (): View | undefined => {
  const asked = new URLSearchParams(window.location.search).get("view")
  return VIEWS.find((v) => v === asked)
}
const viewQuery = (search: string, view: View) => {
  const query = new URLSearchParams(search)
  if (view === "schematic") query.delete("view")
  else query.set("view", view)
  const text = query.toString()
  return text ? `?${text}` : ""
}

export const openProjectRoute = (id: string) => navigate(projectPath(id))
/** A project's address in full: its link, to copy and send, opening on `view`. */
export const projectLink = (id: string, view: View = "schematic") => `${window.location.origin}${projectPath(id)}${viewQuery("", view)}`
/** The host's projects page, when it has one (`AppProps.account`); the editor's own dashboard otherwise. */
let projectsUrl: string | undefined

/** Leave the editor for one of the host's pages once the last edits have landed: sooner, the browser would ask to stay. */
export const leaveFor = (url: string) => void settleSaves().then(() => window.location.assign(url))

export const goHome = () => {
  if (projectsUrl) leaveFor(projectsUrl)
  else navigate(basePath || "/")
}

const BackToProjects = () => (
  <button className="text-brand underline underline-offset-4" onClick={goHome}>
    Back to projects
  </button>
)

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-paper px-6 text-center">
      <p className="max-w-[48ch] text-[15px] text-ink">{children}</p>
      <BackToProjects />
    </div>
  )
}

/** A project the editor can't render (a hand-edited file, say) offers a way out, not a blank page. */
class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <Notice>This project couldn't be opened.</Notice>
  }
}

export interface AppProps {
  /** How the copilot reaches managed AI: the host's session and links. Without it the copilot asks to sign in. */
  managedAi?: ManagedAiHost
  /** Where projects are kept: the website's is the signed-in account. This browser's storage when absent. */
  storage?: ProjectStorage
  /** A request to start on, handed over from the website's hero: it opens a new project with this in Sakura's composer. */
  initialPrompt?: string
  /**
   * Supplier part data (pins and land patterns by LCSC number), which the copilot builds parts
   * from. Without it, parts are made from the copilot's memory and marked unverified.
   */
  supplierParts?: SupplierPartsSource
  /**
   * Where the 3D model files a user adds are kept: the website's is the signed-in account. This
   * browser's IndexedDB when absent.
   */
  modelFiles?: ModelFileStore
  /**
   * The signed-in account, for a host that has one: who it is, shown at the right of the top bar,
   * and the host's pages for projects, settings and signing out. The host's projects page replaces
   * the editor's dashboard. Without it, as in the harness, the editor is its own home.
   */
  account?: EditorAccount
  /**
   * Where the host mounts the editor, with no trailing slash: the editor's own dashboard is this
   * path and a project is `<basePath>/p/<id>`, so the host serves both. The site's root when absent.
   */
  basePath?: string
}

let connectedHost: ManagedAiHost | undefined
let connectedParts: SupplierPartsSource | undefined
let defaultStorage: ProjectStorage | undefined
let defaultModelFiles: ModelFileStore | undefined
/** Once per page load, whatever React does with effects: each run would make another project. */
let promptHandled = false

type Load = { state: "loading" } | { state: "ready" } | { state: "missing" } | { state: "failed"; message: string }

export function App({ managedAi, storage: given, initialPrompt, supplierParts, modelFiles, account, basePath: base = "" }: AppProps) {
  // During render rather than in an effect: the copilot panel's effects run before this
  // component's, and its first account fetch needs the host's token already. Only when the
  // prop changes, so a host installed through the development hook isn't undone by a re-render.
  if (managedAi !== connectedHost) {
    connectedHost = managedAi
    connectManagedAi(managedAi)
  }
  if (supplierParts !== connectedParts) {
    connectedParts = supplierParts
    connectSupplierParts(supplierParts)
  }
  // This browser's tabs see each other on a project, as people on an account's project do; with a
  // stand-in account (the harness's `?account`), the Share dialog works on invitations kept in memory.
  const storage =
    given ??
    (defaultStorage ??= {
      ...browserProjectStorage(),
      presence: browserPresence(),
      ...(account?.user && { sharing: localSharing({ userId: account.user.id ?? "local", name: account.user.name, email: account.user.email, pictureUrl: account.user.pictureUrl ?? undefined }) }),
    })
  connectProjectStorage(storage)
  connectModelFiles(modelFiles ?? (defaultModelFiles ??= browserModelFiles()))
  projectsUrl = account?.projectsUrl
  basePath = base

  const [route, setRoute] = useState(parseRoute)
  // A project being made for the handed-over prompt: until it opens, there is no project to show
  // and the host's projects page is not where to send anyone.
  const [handingOff, setHandingOff] = useState(() => !!initialPrompt?.trim() && !promptHandled)
  const project = useProjectStore((s) => s.project)
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const view = useUi((s) => s.view)
  const shown = route.page === "editor" && load.state === "ready" && project?.id === route.id

  useEffect(() => {
    const follow = () => setRoute(followRoute)
    onNavigate = follow
    window.addEventListener("popstate", follow)
    return () => {
      onNavigate = undefined
      window.removeEventListener("popstate", follow)
    }
  }, [])

  // Projects from before they were saved to accounts are still in this browser's storage, and a
  // link to one names the id it had here. Signed out, there is no account to move them to yet.
  const signedOut = !!account?.signIn
  useEffect(() => {
    if (storage.location !== "account" || signedOut) return
    void moveBrowserProjects(storage).then(() => {
      const r = parseRoute()
      const to = r.page === "editor" ? movedProjectId(r.id) : undefined
      if (to) navigate(projectPath(to), { replace: true })
    })
  }, [storage, signedOut])

  useEffect(() => {
    if (!initialPrompt?.trim() || promptHandled) return
    promptHandled = true
    const fresh = createProject()
    storage
      .create(projectRecord(fresh))
      .then(({ id }) => {
        useCopilot.getState().seed(id, initialPrompt.trim())
        useUi.getState().setCopilotOpen(true)
        // The route follows at once, so it is the project's before the hand-off ends.
        openProjectRoute(id)
      })
      .catch((error: unknown) => console.warn("Couldn't start a project for the handed-over prompt", error))
      .finally(() => setHandingOff(false))
  }, [initialPrompt, storage])

  // With a host projects page, the editor has no home of its own: a URL with no project goes there.
  useEffect(() => {
    if (route.page === "home" && account && !handingOff) window.location.replace(account.projectsUrl)
  }, [route, account, handingOff])

  useEffect(() => {
    const store = useProjectStore.getState()
    if (route.page !== "editor") {
      if (store.project) store.close()
      return
    }
    if (store.project?.id === route.id) {
      setLoad({ state: "ready" })
      return
    }
    let current = true
    setLoad({ state: "loading" })
    storage
      .load(route.id)
      .then((stored) => {
        if (!current) return
        const moved = stored ? undefined : movedProjectId(route.id)
        if (moved) return navigate(projectPath(moved), { replace: true })
        if (!stored) return setLoad({ state: "missing" })
        useProjectStore.getState().open(openStoredProject(stored), { revision: stored.revision, formatVersion: stored.formatVersion, role: stored.role })
        const asked = viewInAddress()
        if (asked) useUi.getState().setView(asked)
        setLoad({ state: "ready" })
      })
      .catch((error: unknown) => {
        if (!current) return
        const message =
          error instanceof ProjectFileError ? error.message : "This project couldn't be loaded. Check your connection and try again."
        setLoad({ state: "failed", message })
      })
    return () => {
      current = false
    }
  }, [route, storage])

  // The address follows the view shown, so it links to what is on screen, as the Share dialog's
  // link does. Only once the project is open: until then the address still says what to open on.
  useEffect(() => {
    if (!shown || (viewInAddress() ?? "schematic") === view) return
    const { pathname, search, hash } = window.location
    window.history.replaceState(null, "", `${pathname}${viewQuery(search, view)}${hash}`)
  }, [shown, view])

  return <AccountContext.Provider value={account}>{content()}</AccountContext.Provider>

  function content() {
    if (route.page === "home") return account ? null : <Dashboard storage={storage} />
    if (load.state === "missing") {
      return (
        <Notice>
          {storage.location === "account" ? "This project doesn't exist, or it isn't shared with you." : "This project isn't saved in this browser."}
        </Notice>
      )
    }
    if (load.state === "failed") return <Notice>{load.message}</Notice>
    if (project?.id !== route.id) return null
    return (
      <EditorBoundary key={route.id}>
        <Editor />
      </EditorBoundary>
    )
  }
}
