import { supplierParts } from "../ai/supplierParts"
import { lookupFromSource, type LcscLookup } from "../model/lcscMatch"
import type { ProjectStorage } from "../store/storage"
import { trackImport } from "./analytics"
import { startImport, type ImportJob, type StartOptions } from "./client"
import type { BoardChoice } from "./pick"
import type { InputEntry, Phase } from "./protocol"
import { attachLcsc, hasLcscNumbers } from "./lcsc"
import { saveImported, SaveRefused, type SaveKind } from "./save"
import { reportName, stoppedSummary, type ImportSummary } from "./summary"

// What the import screen is showing, and what moves it on. Plain state and no React, so the flow
// (choose a board, work, save, report, cancel) is tested without a browser; `useKicadImport` is
// the hook that puts it on a page. A website page with its own look can use the same controller.

export type ImportState =
  | { step: "idle" }
  | { step: "choose"; boards: BoardChoice[] }
  /** `slow`: the save has taken a while (a connection that is down holds it), and the dialog may be closed. */
  | { step: "working"; phase: Phase | "matching" | "saving"; slow?: boolean }
  | {
      step: "report"
      summary: ImportSummary
      /** The new project, when it was saved. */
      projectId: string | null
      name: string
      /** Why an imported board was not saved, in plain words. */
      saveError: string | null
      /** What the failure means for what to do next; a retry is offered only for `again` (or none given). */
      saveKind?: SaveKind | null
    }

/** How long a save may take before the dialog says it is still saving and lets the user close it. */
export const SLOW_SAVE_MS = 15_000

export class KicadImportController {
  state: ImportState = { step: "idle" }
  private listeners = new Set<() => void>()
  private files: InputEntry[] = []
  private job: ImportJob | null = null
  private choice: string | undefined
  /** Counts drops being read, so one that is cancelled or replaced is not started when it finishes. */
  private drops = 0
  /** The save in flight whose dialog is still open, by number; 0 once the dialog was closed on it, or none. */
  private saving = 0
  private saves = 0
  /** The LCSC lookup in flight, so a cancel can end it. */
  private lookup: AbortController | null = null

  constructor(
    private storage: ProjectStorage,
    private deps: {
      worker?: StartOptions["createWorker"]
      slowSaveMs?: number
      /** Looks an LCSC number up: the host's parts source by default, `null` for none. Tests give their own. */
      lcsc?: LcscLookup | null
    } = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  getState = () => this.state

  private set(state: ImportState) {
    this.state = state
    for (const l of this.listeners) l()
  }

  /** Start with files from a picker or a drop. */
  start(files: InputEntry[]) {
    if (this.state.step === "working") return
    this.files = files
    void this.run()
  }

  /**
   * Start with a drop whose files are still being read (a folder is walked entry by entry, which
   * takes a while for a big one). The progress shows at once; an empty drop or one that cannot be
   * read ends in a report that says so.
   */
  startFromDrop(entries: Promise<InputEntry[]>) {
    if (this.state.step === "working") return
    const drop = ++this.drops
    this.set({ step: "working", phase: "reading" })
    entries.then(
      (files) => {
        if (drop !== this.drops) return
        if (files.length === 0) return this.stop("no-board", "There were no files in what you dropped. Drop a .kicad_pcb file, a zip of the project folder, or a folder that has them.")
        this.files = files
        void this.run()
      },
      () => drop === this.drops && this.stop("bad-input", "The dropped files could not be read. Choose them with Import KiCad instead."),
    )
  }

  private stop(reason: "no-board" | "bad-input", message: string) {
    trackImport(stoppedSummary(reason, message), 0)
    this.set({ step: "report", summary: stoppedSummary(reason, message), projectId: null, name: "KiCad board", saveError: null })
  }

  /**
   * After a failed save: run the import again from the same files. Only when the failure says
   * nothing was saved and may not repeat; after one that may have gone through (or whose save is
   * still held), a second save could make a second project.
   */
  retry() {
    if (this.state.step !== "report" || !this.state.saveError || !this.files.length) return
    if (this.state.saveKind === "uncertain" || this.state.saveKind === "final") return
    void this.run(this.choice)
  }

  /** Several boards were found and the user picked one. */
  choose(id: string) {
    if (this.state.step !== "choose") return
    void this.run(id)
  }

  /**
   * Stop the import. Nothing is saved. During the save itself there is nothing to stop, so this
   * does nothing, until the save is slow: then it closes the dialog and leaves the save to finish
   * on its own (nothing more is shown for it, and the project appears in the list when it lands).
   */
  cancel() {
    if (this.state.step === "report" || this.state.step === "idle") return
    if (this.state.step === "working" && this.state.phase === "saving") {
      if (!this.state.slow) return
      this.saving = 0
      return this.set({ step: "idle" })
    }
    this.drops++
    const was = this.job
    this.job = null
    was?.cancel()
    this.lookup?.abort()
    this.lookup = null
    if (this.state.step === "working") trackImport(stoppedSummary("cancelled", "Cancelled."), 0)
    this.set({ step: "idle" })
  }

  /** Close the report or the chooser. */
  close() {
    if (this.state.step === "working") return this.cancel()
    this.files = []
    this.set({ step: "idle" })
  }

  private async run(choice?: string) {
    this.choice = choice
    this.set({ step: "working", phase: "reading" })
    const job = startImport(this.files, { choice, createWorker: this.deps.worker, onProgress: (phase) => this.job === job && !(this.state.step === "working" && this.state.phase === phase) && this.set({ step: "working", phase }) })
    this.job = job
    const result = await job.result
    if (this.job !== job) return
    this.job = null
    if (result.kind === "cancelled") return
    if (result.kind === "choose") return this.set({ step: "choose", boards: result.boards })

    const { durationMs } = result
    let outcome = result.outcome
    if (outcome.summary.status !== "imported" || !outcome.project) {
      trackImport(outcome.summary, durationMs)
      return this.set({ step: "report", summary: outcome.summary, projectId: null, name: reportName(outcome.summary), saveError: null })
    }
    // The parts that carry an LCSC number are looked up before the project is saved, so what is found is in it (a network step, so it is the page's and not the importer's).
    if (hasLcscNumbers(outcome.project)) {
      this.set({ step: "working", phase: "matching" })
      const abort = (this.lookup = new AbortController())
      const lookup = this.deps.lcsc !== undefined ? this.deps.lcsc : (() => { const s = supplierParts(); return s ? lookupFromSource(s) : null })()
      const matched = await attachLcsc(outcome, lookup, { signal: abort.signal })
      if (this.lookup !== abort || abort.signal.aborted) return
      this.lookup = null
      outcome = matched.outcome
    }
    const { summary } = outcome
    this.set({ step: "working", phase: "saving" })
    const name = outcome.project!.name
    const mine = (this.saving = ++this.saves)
    // A connection that is down holds a save and sends it when it is back, so the promise may wait a long time.
    const slow = setTimeout(() => {
      if (this.saving === mine && this.state.step === "working" && this.state.phase === "saving") this.set({ step: "working", phase: "saving", slow: true })
    }, this.deps.slowSaveMs ?? SLOW_SAVE_MS)
    try {
      const projectId = await saveImported(this.storage, outcome)
      clearTimeout(slow)
      trackImport(summary, durationMs)
      if (this.saving === mine) this.set({ step: "report", summary, projectId, name, saveError: null })
    } catch (e) {
      clearTimeout(slow)
      trackImport(summary, durationMs, false)
      const saveError = e instanceof SaveRefused ? e.message : "Couldn't tell whether the project was saved. Check your projects list before importing the board again."
      const saveKind: SaveKind = e instanceof SaveRefused ? e.kind : "uncertain"
      if (this.saving === mine) this.set({ step: "report", summary, projectId: null, name, saveError, saveKind })
    }
    if (this.saving === mine) this.saving = 0
  }
}
