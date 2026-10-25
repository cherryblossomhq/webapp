import { followNetRenames } from "../model/copperNets"
import { pruneImportMarks } from "../model/importMarks"
import { create } from "zustand"
import { registerProjectParts } from "../model/customParts"
import type { Project } from "../model/types"
import { projectRecord, type ProjectStorage, type SaveRefusal } from "./storage"

const HISTORY_LIMIT = 200
/** Quiet time after an edit before it is saved, so a burst of edits is one save. */
const SAVE_DELAY_MS = 600
/** Waits before retrying a save that didn't arrive (offline, a server error). */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000]

/**
 * How saving the open project is going.
 *
 * - `saving`: an edit is waiting to be saved, or on its way.
 * - `retrying`: a save didn't arrive; it is tried again until it does.
 * - `refused`: storage turned it away (`SaveRefusal`), and autosave has stopped for anything but
 *   `too_large`, since asking again won't change the answer. The top bar says what to do.
 */
export type SaveStatus = { state: "saved" } | { state: "saving" } | { state: "retrying"; message: string } | { state: "refused"; reason: SaveRefusal }

interface ProjectState {
  project: Project | null
  past: Project[]
  future: Project[]
  /** Snapshot taken when a drag/transient edit began. */
  transientBase: Project | null
  save: SaveStatus
  /** Open a project loaded at `revision` of its stored copy. */
  open: (p: Project, revision?: number) => void
  close: () => void
  /** Apply an undoable change. */
  commit: (fn: (p: Project) => Project) => void
  /**
   * Apply a change that is not a step of the user's own: a background check's verdict on a part.
   * It is saved but not put in the undo history, so Undo still undoes what the user did last. It is
   * also applied to the snapshots Undo and Redo go back to (`fn` must be pure, and return a
   * project it has nothing to change in as it was, so only the snapshots that have the part change),
   * so the change survives them.
   */
  patch: (fn: (p: Project) => Project) => void
  beginTransient: () => void
  /** Replace the document during a drag without creating history entries. */
  setTransient: (fn: (base: Project) => Project) => void
  endTransient: (finalize?: (p: Project) => Project) => void
  cancelTransient: () => void
  undo: () => void
  redo: () => void
  /** After a `conflict`: save this copy over the one saved elsewhere. */
  keepMine: () => Promise<void>
}

let storage: ProjectStorage | null = null

/** Where the open project is saved. Without one (the unit tests), edits aren't saved anywhere. */
export function connectProjectStorage(next: ProjectStorage | null | undefined) {
  storage = next ?? null
}

/**
 * One opened project's saving. It outlives the project being on screen: closing a project, or
 * opening another, leaves the last edit's save to land rather than cancelling it.
 */
class Autosave {
  /** The newest edit not yet sent. */
  private pending: Project | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private failures = 0
  private stopped = false

  constructor(
    readonly id: string,
    private revision: number,
    private readonly storage: ProjectStorage,
  ) {}

  /** True while an edit hasn't been saved yet and is still going to be. */
  get unsaved() {
    return this.inFlight !== null || (this.pending !== null && !this.stopped)
  }

  schedule(project: Project) {
    if (this.stopped) return
    this.pending = project
    this.report({ state: "saving" })
    this.wait(SAVE_DELAY_MS)
  }

  /** Save the pending edit now. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // The save in flight sends whatever is pending once it lands.
    if (this.inFlight) return this.inFlight
    const project = this.pending
    if (!project || this.stopped) return Promise.resolve()
    this.pending = null
    this.inFlight = this.storage
      .save(this.id, this.revision, projectRecord(project))
      .then(
        (outcome) => {
          this.failures = 0
          if (outcome.ok) {
            this.revision = outcome.revision
            if (!this.pending) this.report({ state: "saved" })
            return
          }
          // A smaller project may still fit, so the next edit tries again; nothing else changes by asking.
          if (outcome.reason !== "too_large") this.stopped = true
          this.report({ state: "refused", reason: outcome.reason })
        },
        (error: unknown) => {
          this.pending ??= project
          this.report({ state: "retrying", message: error instanceof Error ? error.message : String(error) })
          this.wait(RETRY_DELAYS_MS[Math.min(this.failures++, RETRY_DELAYS_MS.length - 1)])
        },
      )
      .finally(() => {
        this.inFlight = null
        // Edits made while that save was on its way.
        if (this.pending && !this.timer && !this.stopped) void this.flush()
        else if (!this.unsaved) closedUnsaved.delete(this)
      })
    return this.inFlight
  }

  /** Take over the stored copy at whatever revision it has reached, and save `project` over it. */
  async overwrite(project: Project) {
    const stored = await this.storage.load(this.id)
    if (!stored) {
      this.report({ state: "refused", reason: "not_found" })
      return
    }
    this.revision = stored.revision
    this.stopped = false
    this.pending = project
    this.report({ state: "saving" })
    await this.flush()
  }

  private wait(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, ms)
  }

  private report(save: SaveStatus) {
    // A project closed with a save still landing has nothing left on screen to tell.
    if (autosave === this) useProjectStore.setState({ save })
  }
}

let autosave: Autosave | null = null
/** Saves of projects no longer open that haven't landed: leaving the page still loses them. */
const closedUnsaved = new Set<Autosave>()

/** Send the open project's last edit and let it go, keeping the page guard while it lands. */
function retireAutosave() {
  if (!autosave) return
  void autosave.flush()
  if (autosave.unsaved) closedUnsaved.add(autosave)
  autosave = null
}

const unsavedAutosaves = () => [autosave, ...closedUnsaved].filter((a): a is Autosave => !!a?.unsaved)

/** How long leaving the editor waits for its saves before going anyway: offline, a save never lands. */
const SETTLE_LIMIT_MS = 3_000

/**
 * Send every save that hasn't landed and wait for it, so a page load away from the editor needn't
 * ask the user to stay. A second round takes the edits made while the first was on its way. Past
 * the limit it resolves regardless, and the page guard asks as it always did.
 */
export function settleSaves(): Promise<void> {
  const settle = async () => {
    for (let round = 0; round < 2 && unsavedAutosaves().length; round++) {
      await Promise.all(unsavedAutosaves().map((a) => a.flush()))
    }
  }
  return Promise.race([settle(), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_LIMIT_MS))])
}

/** What is safe to store: never a drag in progress, which Esc may still take back. */
const savable = (s: ProjectState) => s.transientBase ?? s.project

const scheduleSave = (s: ProjectState) => {
  const p = savable(s)
  if (p) autosave?.schedule(p)
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  past: [],
  future: [],
  transientBase: null,
  save: { state: "saved" },

  open: (p, revision = 0) => {
    retireAutosave()
    registerProjectParts(p)
    autosave = storage ? new Autosave(p.id, revision, storage) : null
    set({ project: p, past: [], future: [], transientBase: null, save: { state: "saved" } })
  },
  close: () => {
    retireAutosave()
    set({ project: null, past: [], future: [], transientBase: null, save: { state: "saved" } })
  },

  commit: (fn) => {
    const { project, past, transientBase } = get()
    if (!project) return
    const made = fn(project)
    if (made === project) return
    // Copper that names its net follows a rename, and what an import marked that no longer holds is retired.
    const next = pruneImportMarks(project, followNetRenames(project, made))
    // A change that lands mid-drag (the copilot works in the background) ends the drag where it
    // is: rebuilding the drag from its starting snapshot afterwards would drop the change.
    const before = transientBase && transientBase !== project ? [transientBase, project] : [project]
    set({ project: next, past: [...past, ...before].slice(-HISTORY_LIMIT), future: [], transientBase: null })
    scheduleSave(get())
  },

  patch: (fn) => {
    const { project, past, future, transientBase } = get()
    if (!project) return
    const next = fn(project)
    if (next === project) return
    // A press that never moved has the base and the project as one object, and must stay one: two
    // calls make two objects, and `endTransient` would take the pair for a drag and push an empty undo step.
    const base = transientBase === project ? next : transientBase && fn(transientBase)
    // The edit goes into every snapshot that has what it changes, or Undo then Redo (or placing
    // again) would bring the part back without the verdict. A snapshot without it comes back as it was.
    set({ project: next, past: past.map(fn), future: future.map(fn), ...(base && { transientBase: base }) })
    scheduleSave(get())
  },

  beginTransient: () => {
    const { project } = get()
    if (project) set({ transientBase: project })
  },
  setTransient: (fn) => {
    const base = get().transientBase
    if (!base) return
    set({ project: fn(base) })
  },
  endTransient: (finalize) => {
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
    const finalProject = finalize ? finalize(project) : { ...project }
    if (finalProject === transientBase) {
      set({ transientBase: null, project: finalProject })
      return
    }
    set({
      project: finalProject,
      transientBase: null,
      past: [...past, transientBase].slice(-HISTORY_LIMIT),
      future: [],
    })
    scheduleSave(get())
  },
  cancelTransient: () => {
    const base = get().transientBase
    if (base) set({ project: base, transientBase: null })
  },

  // Both wait for a drag to end: its starting snapshot would otherwise outlive the step undone.
  undo: () => {
    const { past, project, future, transientBase } = get()
    if (!past.length || !project || transientBase) return
    const prev = past[past.length - 1]
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future] })
    scheduleSave(get())
  },
  redo: () => {
    const { past, project, future, transientBase } = get()
    if (!future.length || !project || transientBase) return
    const [next, ...rest] = future
    set({ project: next, past: [...past, project], future: rest })
    scheduleSave(get())
  },

  keepMine: async () => {
    const p = savable(get())
    if (p && autosave) await autosave.overwrite(p)
  },
}))

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => unsavedAutosaves().forEach((a) => void a.flush()))
  // A save is a network request now, and one cut off by the page going away is work lost.
  window.addEventListener("beforeunload", (e) => {
    const unsaved = unsavedAutosaves()
    if (!unsaved.length) return
    unsaved.forEach((a) => void a.flush())
    e.preventDefault()
  })
}

/** Non-hook accessor for event handlers. */
export const projectApi = () => useProjectStore.getState()
