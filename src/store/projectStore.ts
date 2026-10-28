import { applyChanges, jsonEqual, type Change, type JsonObject } from "@cherryblossom/project-changes"
import { pruneGroups } from "../model/boardObjects"
import { followNetRenames } from "../model/copperNets"
import { settleLabelNetClasses } from "../model/directives"
import { followCopies, keepSheetsWithWork, settleStructure } from "../model/settleStructure"
import { pruneImportMarks } from "../model/importMarks"
import { settleKicadSheet } from "../model/kicadJoin"
import { create } from "zustand"
import { registerProjectParts } from "../model/customParts"
import { registerProjectFootprints } from "../model/footprints"
import { PROJECT_FILE_VERSION } from "../model/projectFile"
import { ensureTextFont, textFontMissing } from "../model/textFont"
import type { Project } from "../model/types"
import { projectChanges } from "./changes"
import type { ProjectRole, ProjectStorage, RemoteBatch } from "./storage"
import { ProjectSync, type SaveStatus, type SyncHost } from "./sync"

export type { SaveStatus } from "./sync"

const HISTORY_LIMIT = 200

/**
 * Copper that names its net follows a rename, what an import marked that no longer holds is retired, and a group loses what an edit deleted (and goes when nothing is left in it).
 * The first two stop at once for an edit that left the schematic alone, the group one for a board with no groups, and the classes directive labels give (S8) for a project with none.
 * S11: whatever made the edit, a sheet joined by KiCad's rules is left with its new T's cut, as KiCad cuts them (an edit that has done it already is unchanged by it, and a project with no such sheet is returned as it is).
 */
const settleEdit = (before: Project, made: Project) => settleLabelNetClasses(before, pruneGroups(pruneImportMarks(before, followNetRenames(before, settleKicadSheet(before, made)))))

/**
 * The project with its sheet tree and what hangs on it made whole (`settleStructure`): what is drawn on a sheet or use the tree no longer has goes, each use of a
 * reused sheet gets the parts another use has, and nothing is left on a copper layer the board does not have. The project itself when there is nothing to do.
 */
function settled(project: Project): Project {
  const next = settleStructure(project)
  return next !== project && projectChanges(project, next).length ? next : project
}

/**
 * One undoable step, as the changes that undo it and the ones that redo it, rather than a copy of
 * the project before it. With other people editing the same project, undo must take back this
 * user's own step and nothing else: applying its `undo` changes to the project as it now is puts
 * back the values this step replaced and leaves everyone else's edits alone (a part someone else
 * deleted meanwhile stays deleted).
 */
export interface HistoryStep {
  undo: Change[]
  redo: Change[]
}

/**
 * An older version of the project shown in place of it, read-only (`startPreview`). The live
 * project is kept beside it, and follows everyone's edits meanwhile, so leaving the preview shows
 * the project as it is by then.
 */
export interface Preview {
  /** The version shown: its id (for restoring), when it was current and what to call it. */
  version: { id: string; at: number; name: string | null; label: string }
  /** The project as it is now, followed through the sync while the preview is open. */
  live: Project
  /** The user's role on the live project: the shown one is `viewer` while previewing, so nothing edits it. */
  liveRole: ProjectRole
}

interface ProjectState {
  project: Project | null
  past: HistoryStep[]
  future: HistoryStep[]
  /** Snapshot taken when a drag/transient edit began. */
  transientBase: Project | null
  save: SaveStatus
  /** What this user may do to the open project. A viewer's edits are refused before they happen. */
  role: ProjectRole
  /** Counts edits refused because the project is view-only, so the notice saying so shows each time. */
  refusedEdits: number
  /** A past version shown in place of `project`, or null. While set, `role` reads `viewer`. */
  preview: Preview | null
  /** Show an older version of the open project read-only, taking back the live one when `endPreview` is called. */
  startPreview: (project: Project, version: Preview["version"]) => void
  /** Leave the preview and show the live project, as it is by now. */
  endPreview: () => void
  /** Forget the undo history: after a restore, whose steps were worked out against a state that is gone. */
  clearHistory: () => void
  /** The open project was deleted, or stopped being shared with this user, while it was open. */
  gone: boolean
  /** This tab's session on the open project: names its batches and its presence. Null without storage. */
  sessionId: string | null
  /** Open a project loaded from storage at `stored.revision`; without `stored`, one that isn't stored yet. */
  open: (p: Project, stored?: { revision: number; formatVersion?: number; role?: ProjectRole }) => void
  close: () => void
  /** Apply an undoable change. */
  commit: (fn: (p: Project) => Project) => void
  /**
   * Apply a change that is not a step of the user's own: a background check's verdict on a part,
   * or the editor tidying up after someone else's edit (a designator both of them took at once).
   * It is sent but not put in the undo history, so Undo still undoes what the user did last. It is
   * also applied to every item a step puts back whole (`fn` must be pure, and return a project it
   * has nothing to change in as it was), so Undo then Redo of a part's placement keeps it, even
   * for a part undone before the change arrived.
   */
  patch: (fn: (p: Project) => Project) => void
  /** Take down the strip saying the last edits were refused. */
  dismissSaveNotice: () => void
  beginTransient: () => void
  /** Replace the document during a drag without creating history entries. */
  setTransient: (fn: (base: Project) => Project) => void
  endTransient: (finalize?: (p: Project) => Project) => void
  cancelTransient: () => void
  undo: () => void
  redo: () => void
}

let storage: ProjectStorage | null = null

/** Where the open project is saved. Without one (the unit tests), edits aren't saved anywhere. */
export function connectProjectStorage(next: ProjectStorage | null | undefined) {
  storage = next ?? null
}

/** The storage the open project is kept in: its presence and sharing are the collaboration panels'. */
export const projectStorage = () => storage

let sync: ProjectSync | null = null
/** Syncs of projects no longer open whose last batches haven't landed: leaving the page still loses them. */
const retired = new Set<ProjectSync>()

/** Stop following the open project and let its last batches land, keeping the page guard while they do. */
function retireSync() {
  if (!sync) return
  sync.retire()
  if (sync.unsaved) retired.add(sync)
  sync = null
}

const unsavedSyncs = () => {
  for (const s of retired) if (!s.unsaved) retired.delete(s)
  return [sync, ...retired].filter((s): s is ProjectSync => !!s?.unsaved)
}

/** How long leaving the editor waits for its saves before going anyway: offline, a save never lands. */
const SETTLE_LIMIT_MS = 3_000

/**
 * Send every edit that hasn't landed and wait for it, so a page load away from the editor needn't
 * ask the user to stay. A second round takes the edits made while the first was on its way. Past
 * the limit it resolves regardless, and the page guard asks as it always did.
 */
export function settleSaves(): Promise<void> {
  const settle = async () => {
    for (let round = 0; round < 3 && unsavedSyncs().length; round++) {
      await Promise.all(unsavedSyncs().map((s) => s.flush()))
    }
  }
  return Promise.race([settle(), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_LIMIT_MS))])
}

/** Someone else's batches landed on the open project: what it was, and what it is now. */
type RemoteListener = (batches: RemoteBatch[], before: Project, after: Project) => void
const remoteListeners = new Set<RemoteListener>()

/** Hear about other people's edits to the open project as they land (for toasts, and tidying the selection). */
export function onRemoteChanges(listener: RemoteListener): () => void {
  remoteListeners.add(listener)
  return () => remoteListeners.delete(listener)
}

/**
 * Parts this tab added to the open project. When someone else added one at the same moment, both
 * took the same designator; `model/designators.ts` decides which of the two is renumbered, and only
 * the tab that added it can tell it is theirs.
 */
const createdHere = new Set<string>()
export const isCreatedHere = (componentId: string) => createdHere.has(componentId)

/** Send the changes from `before` to `after`. The changes, empty when nothing that travels changed (a new `updatedAt` alone). */
function send(before: Project, after: Project): Change[] {
  const redo = projectChanges(before, after)
  if (!redo.length) return redo
  for (const c of redo) if (c.kind === "put" && c.collection === "components") createdHere.add(String(c.item.id))
  sync?.send(redo)
  return redo
}

/** Record an edit from `before` to `after` as a step, sending its changes. Null when nothing that travels changed. */
function step(before: Project, after: Project): HistoryStep | null {
  const redo = send(before, after)
  return redo.length ? { undo: projectChanges(after, before), redo } : null
}

/**
 * `fn` applied to each item `step` puts back whole (a part its undo or redo brings back), as it
 * would apply to that item in `project`: the item is put back into `project` and `fn` tried on that,
 * so what `fn` weighs it against (another part with its designator) is there too.
 */
function patchStep(s: HistoryStep, fn: (p: Project) => Project, project: Project): HistoryStep {
  const patchPuts = (changes: Change[]) => {
    let patched = false
    const out = changes.map((c) => {
      if (c.kind !== "put") return c
      const probe = applyChanges(project, [c])
      const after = fn(probe)
      if (after === probe) return c
      const key = c.key ?? "id"
      const list = (after as unknown as Record<string, unknown>)[c.collection]
      const item = Array.isArray(list) ? (list as JsonObject[]).find((i) => i?.[key] === c.item[key]) : undefined
      if (!item || jsonEqual(item, c.item)) return c
      patched = true
      return { ...c, item }
    })
    return patched ? out : changes
  }
  const undo = patchPuts(s.undo)
  const redo = patchPuts(s.redo)
  return undo === s.undo && redo === s.redo ? s : { undo, redo }
}

/**
 * An undo or a redo applied to the project as it is now, and settled: a sheet the step removes stays when others have put things on it (undoing a new sheet must not
 * delete a collaborator's parts, nor leave them on no sheet), and the sheet tree, copies of reused sheets and layers are made whole. What it changed travels as part of
 * the same step, so the other copies reach the same project.
 */
function applyStep(project: Project, changes: Change[]): Project {
  const applied = applyChanges(project, changes)
  const next = settled(followCopies(project, keepSheetsWithWork(project, applied)))
  registerProjectParts(next)
  send(project, next)
  return next
}

export const useProjectStore = create<ProjectState>((set, get) => {
  /** True, and the read-only notice shown again, when the open project can't be edited by this user. */
  const readOnly = () => {
    if (get().role !== "viewer") return false
    // A preview says why itself, in its banner.
    if (get().preview) return true
    set((s) => ({ refusedEdits: s.refusedEdits + 1 }))
    return true
  }
  /**
   * A viewer pressed something that would start a drag. A press is also how they select, so it is
   * refused silently, and said only if the pointer then moves (`setTransient`).
   */
  let viewerPress = false

  const hostFor = (self: () => ProjectSync | null): SyncHost => ({
    rebase(shown, batches) {
      if (sync !== self()) return
      // Someone else's batch, or a project read again, can leave the sheet tree with things on sheets it no longer has, or a reused sheet's new use without a part another use got
      // meanwhile. Every copy settles it the same way (`settleStructure` is deterministic) and sends the difference; what is already settled sends nothing.
      const view = settled(shown)
      const { preview } = get()
      if (view !== shown && (preview?.liveRole ?? get().role) !== "viewer") sync?.send(projectChanges(shown, view))
      // A preview is on screen: the live project moves behind it, and is there when the preview closes.
      if (preview) return set({ preview: { ...preview, live: view } })
      const { transientBase, project: before } = get()
      registerProjectParts(view)
      if (transientBase && before) {
        // Mid-drag: the drag so far goes back on top of the project as it now is.
        set({ transientBase: view, project: applyChanges(view, projectChanges(transientBase, before)) })
      } else {
        set({ project: view })
      }
      const after = get().project
      if (batches.length && before && after) for (const listener of remoteListeners) listener(batches, before, after)
    },
    status(save) {
      if (sync === self()) set({ save })
    },
    role(role) {
      if (sync !== self()) return
      const { preview } = get()
      if (preview) return set({ preview: { ...preview, liveRole: role } })
      set({ role })
      if (role === "viewer") get().cancelTransient()
    },
    gone() {
      if (sync === self()) set({ gone: true })
    },
    refused() {
      if (sync === self()) set({ past: [], future: [] })
    },
  })

  return {
    project: null,
    past: [],
    future: [],
    transientBase: null,
    save: { state: "saved" },
    role: "owner",
    refusedEdits: 0,
    gone: false,
    sessionId: null,
    preview: null,

    open: (p, stored) => {
      retireSync()
      createdHere.clear()
      registerProjectParts(p)
      const role = stored?.role ?? "owner"
      let created: ProjectSync | null = null
      if (storage) {
        created = new ProjectSync(
          p.id,
          p,
          stored?.revision ?? 0,
          stored?.formatVersion ?? PROJECT_FILE_VERSION,
          role,
          storage,
          hostFor(() => created),
        )
      }
      sync = created
      set({ project: p, past: [], future: [], transientBase: null, save: { state: "saved" }, role, refusedEdits: 0, gone: false, sessionId: created?.clientId ?? null, preview: null })
      created?.start()
    },
    close: () => {
      retireSync()
      set({ project: null, past: [], future: [], transientBase: null, save: { state: "saved" }, role: "owner", gone: false, sessionId: null, preview: null })
    },

    startPreview: (shown, version) => {
      if (!get().project) return
      get().cancelTransient()
      const { project, role, preview } = get()
      registerProjectParts(shown)
      set({
        project: shown,
        role: "viewer",
        transientBase: null,
        preview: { version, live: preview?.live ?? project!, liveRole: preview?.liveRole ?? role },
      })
    },
    endPreview: () => {
      const { preview } = get()
      if (!preview) return
      registerProjectParts(preview.live)
      set({ project: preview.live, role: preview.liveRole, transientBase: null, preview: null })
    },
    clearHistory: () => set({ past: [], future: [] }),

    commit: (fn) => {
      const { project, past, future, transientBase } = get()
      if (!project || readOnly()) return
      const made = fn(project)
      if (made === project) return
      const next = settleEdit(project, made)
      // A change that lands mid-drag (the copilot works in the background) ends the drag where it
      // is: rebuilding the drag from its starting snapshot afterwards would drop the change.
      const steps = [transientBase && transientBase !== project ? step(transientBase, project) : null, step(project, next)].filter(
        (s): s is HistoryStep => !!s,
      )
      set({
        project: next,
        transientBase: null,
        ...(steps.length && { past: [...past, ...steps].slice(-HISTORY_LIMIT), future: [] }),
        ...(!steps.length && { future }),
      })
    },

    patch: (fn) => {
      const { project, past, future, transientBase, role } = get()
      if (!project || role === "viewer") return
      const next = fn(project)
      // A press that never moved has the base and the project as one object, and must stay one: two
      // calls make two objects, and `endTransient` would take the pair for a drag and record a step.
      const base = transientBase === project ? next : transientBase && fn(transientBase)
      // Mid-drag only the drag's starting point is sent; the drag goes when it ends, over this.
      if (transientBase && base) send(transientBase, base)
      else send(project, next)
      const patchAll = (steps: HistoryStep[]) => {
        const out = steps.map((s) => patchStep(s, fn, next))
        return out.some((s, i) => s !== steps[i]) ? out : steps
      }
      const history = { past: patchAll(past), future: patchAll(future) }
      if (next === project && history.past === past && history.future === future) return
      set({ project: next, ...history, ...(base && { transientBase: base }) })
    },

    dismissSaveNotice: () => sync?.dismiss(),

    beginTransient: () => {
      const { project, role } = get()
      if (!project) return
      viewerPress = role === "viewer"
      if (!viewerPress) set({ transientBase: project })
    },
    setTransient: (fn) => {
      const base = get().transientBase
      if (!base) {
        if (viewerPress) {
          viewerPress = false
          readOnly()
        }
        return
      }
      set({ project: fn(base) })
    },
    endTransient: (finalize) => {
      viewerPress = false
      const { transientBase, project, past } = get()
      if (!transientBase || !project) {
        set({ transientBase: null })
        return
      }
      // A press that never moved changed nothing, and must not cost the redo stack a step.
      if (!finalize && project === transientBase) {
        set({ transientBase: null })
        return
      }
      // A fresh object lets caches that skipped work during the drag (copper pours) recompute.
      const dropped = finalize ? finalize(project) : { ...project }
      // What a schematic drag connected or renamed is settled as a commit settles it (a pin that now has a net loses its import mark); a PCB drag skips it at once.
      const finalProject = settleEdit(transientBase, dropped)
      const s = finalProject === transientBase ? null : step(transientBase, finalProject)
      set({ project: finalProject, transientBase: null, ...(s && { past: [...past, s].slice(-HISTORY_LIMIT), future: [] }) })
    },
    cancelTransient: () => {
      viewerPress = false
      const base = get().transientBase
      if (base) set({ project: base, transientBase: null })
    },

    // Both wait for a drag to end: the drag's own changes would otherwise land on top of the step undone.
    undo: () => {
      const { past, project, future, transientBase } = get()
      if (!past.length || !project || transientBase || readOnly()) return
      const s = past[past.length - 1]
      const next = applyStep(project, s.undo)
      set({ project: next, past: past.slice(0, -1), future: [s, ...future] })
    },
    redo: () => {
      const { past, project, future, transientBase } = get()
      if (!future.length || !project || transientBase || readOnly()) return
      const [s, ...rest] = future
      const next = applyStep(project, s.redo)
      set({ project: next, past: [...past, s], future: rest })
    },
  }
})

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => unsavedSyncs().forEach((s) => void s.flush()))
  // An edit is a network request, and one cut off by the page going away is work lost.
  window.addEventListener("beforeunload", (e) => {
    const unsaved = unsavedSyncs()
    if (!unsaved.length) return
    unsaved.forEach((s) => void s.flush())
    e.preventDefault()
  })
}

// A project with KiCad text is drawn with KiCad's own stroke font, a chunk of its own that is fetched the first time one is
// open. Until it arrives the texts are laid out with the editor's letters; when it does, the open project is replaced by a
// copy of itself (not an edit: no history step, no save) so everything that drew text draws it again.
let fontWatch: Promise<void> | null = null
useProjectStore.subscribe((state, prev) => {
  const p = state.project
  if (!p || p === prev.project || fontWatch || !textFontMissing(p)) return
  fontWatch = ensureTextFont(p)
    .then((loaded) => {
      // Cleared before the swap, so the swap (and a project opened while this load ran) can ask for what it still needs.
      fontWatch = null
      if (!loaded) return
      useProjectStore.setState((s) => {
        if (!s.project) return {}
        const copy = { ...s.project }
        // A drag that has not moved yet keeps its base the open project, so ending it still adds no history step.
        return s.transientBase === s.project ? { project: copy, transientBase: copy } : { project: copy }
      })
    })
    .catch(() => {})
    .finally(() => {
      fontWatch = null
    })
})

/** Non-hook accessor for event handlers. */
export const projectApi = () => useProjectStore.getState()

// A land that an edit rewrote (a layer count that moved a bottom part's inner layers, an undo of it) is the land the editor reads, before any view of the project renders.
useProjectStore.subscribe((s) => {
  if (s.project?.footprints) registerProjectFootprints(s.project)
})
