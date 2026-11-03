import { applyChanges, type Change } from "@cherryblossom/project-changes"
import { uid } from "../lib/id"
import { PROJECT_FILE_VERSION, summarizeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { openStoredProject, projectRecord, type ChangesEvent, type KeptBatch, type ProjectRole, type ProjectStorage, type PushRefusal, type RemoteBatch, type UnsentEdits } from "./storage"

/** Quiet time after an edit before it is sent, so the edits of one gesture travel as one batch. */
const SEND_DELAY_MS = 40
/**
 * How much one batch may gather while the one before it is on its way (all of it, offline). A
 * refused batch is undone whole, so it should hold the last few edits, not an hour of them.
 */
const MAX_BATCH_STEPS = 8
const MAX_BATCH_CHANGES = 2_000
/** Waits before sending again a batch that didn't arrive (offline, a server error). */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000]
/** Try again now's wait: a moment for the connection, asked to sign in again with it, to do so. */
const RETRY_NOW_MS = 1_000

/**
 * How the open project's edits are getting to storage.
 *
 * - `saving`: an edit is on its way.
 * - `retrying`: a batch didn't arrive; it is sent again until it does, and edits keep queueing.
 * - `refused`: storage turned a batch away, and the top bar says what that means:
 *   `outdated` (a newer editor saved it: reload), `not_found` (deleted or unshared),
 *   `forbidden` (made read-only: the edit was undone), `too_large` (the edit was undone),
 *   `unupgradable` (stored in an older format, and too large to write in this editor's).
 */
export type SaveStatus =
  | { state: "saved" }
  | { state: "saving" }
  | { state: "retrying"; message: string }
  | { state: "refused"; reason: "outdated" | "not_found" | "forbidden" | "too_large" | "unupgradable" }

/** What the sync tells the open project's store. */
export interface SyncHost {
  /**
   * The project as storage now has it, with this copy's edits that haven't landed yet on top:
   * someone else's batch arrived, the project was loaded again, or an edit was refused and undone.
   */
  rebase(project: Project, batches: RemoteBatch[]): void
  status(status: SaveStatus): void
  role(role: ProjectRole): void
  /** Deleted, or no longer shared with this user. */
  gone(): void
  /**
   * Edits were refused and taken off the screen. The undo history held them, and its steps are
   * changes worked out against them: undoing one would write back values over other people's
   * edits for a step that never landed, so the history goes.
   */
  refused(): void
}

interface Pending {
  batch: number
  changes: Change[]
  /** Edits gathered in it. */
  steps: number
  /** Sent at least once: never added to again, since a send that seemed to fail may have landed. */
  sent: boolean
  /** The revision storage gave it; it is part of `confirmed` once the log shows it. */
  landed?: number
  /** The tab that made it, when not this one: a page that closed before it landed kept it in this browser (`adopt`). */
  from?: string
}

/**
 * One open project's link to storage, for live editing with anyone else who has it open.
 *
 * It keeps two copies of the project: `confirmed`, what storage has applied up to `revision`, and
 * the batches of this tab's edits that aren't in it yet (`pending`). What is on screen is always
 * `confirmed` with `pending` on top, so:
 *
 * - **A local edit shows at once** and travels as a batch of changes (`send`), one batch in flight
 *   at a time, so storage applies them in the order they were made.
 * - **Someone else's batch** is applied to `confirmed` in storage's order, and this tab's pending
 *   batches are put back on top. Where both changed the same value, this tab's pending one stays on
 *   screen: storage applies it after theirs, so it is what everyone will see.
 * - **This tab's own batch** coming back through the log moves from `pending` into `confirmed`,
 *   which changes nothing on screen.
 * - **A gap** (a long sleep, a whole-project write, a format change) loads the project again and
 *   puts `pending` back on top. A batch resent after a reload is recognised by its number and not
 *   applied twice.
 * - **What hasn't landed is kept in this browser** (`storage.unsent`) until it does: the next copy
 *   of the project opened here, after a reload or a closed tab, sends it first (`adopt`). Edits were
 *   once refused for hours while the user was still signed in, and a reload lost them all.
 *
 * Like the autosave it replaced, it outlives the project being on screen: closing a project leaves
 * its last batches to land (`retire`).
 */
export class ProjectSync {
  /** This tab's copy of the project: names its batches, and its presence on the project. */
  readonly clientId = uid("s")
  private confirmed: Project
  private revision: number
  private pending: Pending[] = []
  private nextBatch = 1
  private inFlight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private stopped: "outdated" | "not_found" | "unupgradable" | null = null
  private notice: "forbidden" | "too_large" | null = null
  private unwatch: (() => void) | null = null
  /** Reads of the log that failed in a row, for the wait before reading it again. */
  private watchFailures = 0
  private reloading = false
  /** Taking on what a closed page kept (`adopt`): nothing is sent until it is first in line. */
  private adopting = false
  /** The batches kept in this browser (`storage.unsent`), with the edits each held when it was. */
  private kept = new Map<Pending, number>()
  private retired = false
  private role: ProjectRole

  constructor(
    readonly id: string,
    project: Project,
    revision: number,
    private readonly formatVersion: number,
    role: ProjectRole,
    private readonly storage: ProjectStorage,
    private readonly host: SyncHost,
  ) {
    this.confirmed = project
    this.revision = revision
    this.role = role
  }

  /** Follow the project's log, after upgrading a document stored in an older format. */
  start() {
    const unsent = this.storage.unsent
    if (unsent) {
      unsent.claim(this.clientId)
      if (this.role !== "viewer") void this.adopt(unsent)
    }
    if (this.formatVersion < PROJECT_FILE_VERSION && this.role !== "viewer") void this.upgrade()
    else this.watch()
  }

  /** True while an edit hasn't reached storage yet and is still going to. */
  get unsaved() {
    return !this.stopped && this.pending.some((p) => p.landed === undefined)
  }

  /** Queue the changes of a local edit. */
  send(changes: Change[]) {
    if (!changes.length || this.stopped) return
    this.notice = null
    const last = this.pending[this.pending.length - 1]
    if (last && !last.sent && last.steps < MAX_BATCH_STEPS && last.changes.length + changes.length <= MAX_BATCH_CHANGES) {
      last.changes.push(...changes)
      last.steps++
    } else {
      this.pending.push({ batch: this.nextBatch++, changes: [...changes], steps: 1, sent: false })
    }
    this.report()
    if (!this.inFlight && !this.reloading) this.wait(SEND_DELAY_MS)
  }

  /** Send what is queued now, and resolve once it has landed or failed. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.inFlight) return this.inFlight
    if (this.stopped || this.reloading || this.adopting) return Promise.resolve()
    const next = this.pending.find((p) => p.landed === undefined)
    if (!next) return Promise.resolve()
    next.sent = true
    const view = this.view()
    this.inFlight = this.storage
      .push(this.id, {
        clientId: next.from ?? this.clientId,
        batch: next.batch,
        changes: next.changes,
        formatVersion: PROJECT_FILE_VERSION,
        componentCount: summarizeProject(view).componentCount,
      })
      .then(
        (outcome) => {
          this.failures = 0
          if (!outcome.ok) return this.refused(next, outcome.reason)
          next.landed = outcome.revision
          // Already in `confirmed`: a resend of a batch that landed before a reload. If it was still
          // pending, the copy read since held it already and the screen showed it twice over (on top of
          // anything others did after it), so the screen is put right.
          if (outcome.revision <= this.revision && this.pending.includes(next)) {
            this.pending = this.pending.filter((p) => p !== next)
            this.host.rebase(this.view(), [])
          }
        },
        (error: unknown) => {
          this.host.status({ state: "retrying", message: error instanceof Error ? error.message : String(error) })
          this.wait(RETRY_DELAYS_MS[Math.min(this.failures++, RETRY_DELAYS_MS.length - 1)])
        },
      )
      .finally(() => {
        this.inFlight = null
        if (!this.timer && this.pending.some((p) => p.landed === undefined) && !this.stopped) void this.flush()
        else this.report()
      })
    return this.inFlight
  }

  /** Take down the strip saying the last edits were refused. */
  dismiss() {
    if (!this.notice) return
    this.notice = null
    this.report()
  }

  /** Send the batch that didn't arrive again soon, rather than after the wait it is in (up to 30 s). */
  retryNow() {
    if (this.failures === 0 || this.inFlight || this.stopped || this.reloading) return
    this.wait(RETRY_NOW_MS)
  }

  /** The project is off screen: stop following it, and let what is queued land. */
  retire() {
    this.retired = true
    this.unwatch?.()
    this.unwatch = null
    void this.flush()
  }

  // ---------- Following the log ----------

  private watch() {
    if (this.retired) return
    this.unwatch?.()
    this.unwatch = this.storage.watchChanges(
      this.id,
      this.revision,
      (event) => this.onEvent(event),
      () => {
        // The log couldn't be read (the query failed). Following it again from a fresh copy, after a
        // wait, rather than not at all: this tab's own edits would still land and say "saved" while it
        // never saw anyone else's again.
        if (this.retired || this.stopped) return
        this.unwatch?.()
        this.unwatch = null
        setTimeout(() => void this.reload(), RETRY_DELAYS_MS[Math.min(this.watchFailures++, RETRY_DELAYS_MS.length - 1)])
      },
    )
  }

  private onEvent(event: ChangesEvent) {
    if (this.retired) return
    if (event.type === "gone") return this.lose()
    this.watchFailures = 0
    this.setRole(event.role)
    if (event.type === "reset") return void this.reload()
    const theirs: RemoteBatch[] = []
    let moved = false
    let gap = false
    for (const b of event.batches) {
      if (b.revision <= this.revision) continue
      // A gap, or a whole write: load it again, after saying what landed before it.
      if (b.revision !== this.revision + 1) {
        gap = true
        break
      }
      const mine = this.pending.findIndex((p) => p.batch === b.batch && (p.from ?? this.clientId) === b.clientId)
      if (mine >= 0) {
        this.confirmed = applyChanges(this.confirmed, this.pending[mine].changes)
        this.pending.splice(mine, 1)
      } else if (b.changes) {
        this.confirmed = applyChanges(this.confirmed, b.changes)
        if (b.clientId !== this.clientId) theirs.push(b)
        moved = true
      } else {
        gap = true
        break
      }
      this.revision = b.revision
    }
    if (moved) this.host.rebase(this.view(), theirs)
    if (gap) return void this.reload()
    this.report()
  }

  /** What is on screen: storage's copy with this tab's pending batches on top. */
  private view(): Project {
    return this.pending.reduce((p, b) => applyChanges(p, b.changes), this.confirmed)
  }

  /** Load the project again, and put this tab's pending batches back on top. */
  private async reload(attempt = 0): Promise<void> {
    if (this.reloading || this.stopped) return
    this.reloading = true
    this.unwatch?.()
    this.unwatch = null
    let stored: Awaited<ReturnType<ProjectStorage["load"]>>
    try {
      stored = await this.storage.load(this.id)
    } catch (error) {
      this.reloading = false
      this.host.status({ state: "retrying", message: error instanceof Error ? error.message : String(error) })
      setTimeout(() => void this.reload(attempt + 1), RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)])
      return
    }
    this.reloading = false
    if (!stored) return this.lose()
    let project: Project
    try {
      project = openStoredProject(stored)
    } catch {
      // Too new for this editor (or no longer a project at all): only a reload can help.
      return this.stop("outdated")
    }
    this.confirmed = project
    this.revision = stored.revision
    this.setRole(stored.role ?? "owner")
    // Batches that landed before the copy just read are in it.
    this.pending = this.pending.filter((p) => p.landed === undefined || p.landed > stored.revision)
    this.host.rebase(this.view(), [])
    if ((stored.formatVersion ?? PROJECT_FILE_VERSION) < PROJECT_FILE_VERSION && this.role !== "viewer") return void this.upgrade(attempt)
    this.watch()
    void this.flush()
  }

  /**
   * Write the document in this editor's format before sending changes to it: changes are worked
   * out on the migrated project, and applied to an older document they could mean something else.
   */
  private async upgrade(attempt = 0): Promise<void> {
    this.reloading = true
    try {
      const outcome = await this.storage.replace(this.id, this.revision, projectRecord(this.confirmed))
      this.reloading = false
      if (outcome.ok) {
        this.revision = outcome.revision
        this.watch()
        void this.flush()
        return
      }
      if (outcome.reason === "conflict" && attempt < 3) return void this.reload(attempt + 1)
      if (outcome.reason === "not_found") return this.lose()
      if (outcome.reason === "outdated") return this.stop("outdated")
      // Changes can't be sent to a document in an older format, and this one can't take the newer:
      // say so, rather than queue edits that are refused, reloaded and refused again.
      if (outcome.reason === "too_large") {
        this.stop("unupgradable")
        this.host.refused()
        return
      }
      // A viewer meanwhile, or still in conflict: follow it as it is.
      this.watch()
      this.report()
    } catch {
      this.reloading = false
      setTimeout(() => void this.upgrade(attempt + 1), RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)])
    }
  }

  // ---------- Edits kept in this browser ----------

  /**
   * Put first in line, and on screen, the edits a page that closed before they landed kept of this project (a reload, a closed
   * tab, a crash). They go under the tab and number they were made with, so one that landed after all is answered with its
   * revision and taken off again rather than applied twice; edits made here meanwhile wait, since they are newer.
   */
  private async adopt(unsent: UnsentEdits) {
    this.adopting = true
    let kept: KeptBatch[] = []
    try {
      kept = (await unsent.orphans(this.id)).filter((k) => k.formatVersion === PROJECT_FILE_VERSION)
    } catch {
      // The browser won't say: this page's own edits go ahead, and what was kept stays for the next.
    }
    this.adopting = false
    if (this.stopped) return
    if (kept.length) {
      const adopted = kept.map((k): Pending => ({ batch: k.batch, changes: k.changes, steps: 1, sent: true, from: k.clientId }))
      for (const p of adopted) this.kept.set(p, p.steps)
      this.pending.unshift(...adopted)
      this.host.rebase(this.view(), [])
    }
    void this.flush()
  }

  /** Keep in this browser each batch that hasn't landed, as it gathers edits, and let go of each as it lands or is refused. */
  private keep() {
    const unsent = this.storage.unsent
    // Stopped, nothing it holds will land from here, and an editor that can send it may open it next.
    if (!unsent || this.stopped) return
    const waiting = new Set(this.pending.filter((p) => p.landed === undefined))
    for (const p of this.kept.keys()) {
      if (waiting.has(p)) continue
      unsent.drop(this.id, p.from ?? this.clientId, p.batch)
      this.kept.delete(p)
    }
    for (const p of waiting) {
      if (this.kept.get(p) === p.steps) continue
      unsent.keep(this.id, { clientId: p.from ?? this.clientId, batch: p.batch, changes: p.changes, formatVersion: PROJECT_FILE_VERSION, savedAt: Date.now() })
      this.kept.set(p, p.steps)
    }
  }

  // ---------- Refusals ----------

  private refused(batch: Pending, reason: PushRefusal) {
    switch (reason) {
      case "conflict":
        // The document's format moved on under this copy: load it again, which upgrades it.
        batch.sent = true
        return void this.reload()
      case "outdated":
        return this.stop("outdated")
      case "not_found":
        return this.lose()
      case "forbidden":
        // Made a viewer meanwhile: nothing queued can land, and what is on screen goes back to storage's.
        // Batches that landed but aren't in `confirmed` yet arrive through the log like anyone's.
        this.pending = []
        this.setRole("viewer")
        this.notice = "forbidden"
        this.host.rebase(this.view(), [])
        this.host.refused()
        return
      case "too_large":
      case "invalid":
        // Those edits (the last few, at most a batch) can't be kept. Undo them on screen rather than
        // show a project that isn't saved.
        this.pending = this.pending.filter((p) => p !== batch)
        this.notice = "too_large"
        this.host.rebase(this.view(), [])
        this.host.refused()
        return
    }
  }

  private setRole(role: ProjectRole) {
    if (role === this.role) return
    this.role = role
    // "Made a viewer, so your edits weren't saved" is stale once they may edit again.
    if (role !== "viewer" && this.notice === "forbidden") {
      this.notice = null
      this.report()
    }
    this.host.role(role)
  }

  private lose() {
    this.stop("not_found")
    this.host.gone()
  }

  private stop(reason: "outdated" | "not_found" | "unupgradable") {
    this.stopped = reason
    this.unwatch?.()
    this.unwatch = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.report()
  }

  private wait(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, ms)
  }

  private report() {
    this.keep()
    if (this.stopped) return this.host.status({ state: "refused", reason: this.stopped })
    const waiting = this.pending.some((p) => p.landed === undefined)
    // A batch whose answer was lost but which the log showed landed: nothing is failing any more.
    if (!waiting) this.failures = 0
    if (this.failures > 0) return
    if (waiting) return this.host.status({ state: "saving" })
    this.host.status(this.notice ? { state: "refused", reason: this.notice } : { state: "saved" })
  }
}
