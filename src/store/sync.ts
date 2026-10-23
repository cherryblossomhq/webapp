import { applyChanges, type Change } from "@cherryblossom/project-changes"
import { uid } from "../lib/id"
import { PROJECT_FILE_VERSION, summarizeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { openStoredProject, projectRecord, type ChangesEvent, type ProjectRole, type ProjectStorage, type PushRefusal, type RemoteBatch } from "./storage"

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

/**
 * How the open project's edits are getting to storage.
 *
 * - `saving`: an edit is on its way.
 * - `retrying`: a batch didn't arrive; it is sent again until it does, and edits keep queueing.
 * - `refused`: storage turned a batch away, and the top bar says what that means:
 *   `outdated` (a newer editor saved it: reload), `not_found` (deleted or unshared),
 *   `forbidden` (made read-only: the edit was undone), `too_large` (the edit was undone).
 */
export type SaveStatus =
  | { state: "saved" }
  | { state: "saving" }
  | { state: "retrying"; message: string }
  | { state: "refused"; reason: "outdated" | "not_found" | "forbidden" | "too_large" }

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
  private stopped: "outdated" | "not_found" | null = null
  private notice: "forbidden" | "too_large" | null = null
  private unwatch: (() => void) | null = null
  private reloading = false
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
    if (this.stopped || this.reloading) return Promise.resolve()
    const next = this.pending.find((p) => p.landed === undefined)
    if (!next) return Promise.resolve()
    next.sent = true
    const view = this.view()
    this.inFlight = this.storage
      .push(this.id, {
        clientId: this.clientId,
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
          // Already in `confirmed`: a resend of a batch that landed before a reload.
          if (outcome.revision <= this.revision) this.pending = this.pending.filter((p) => p !== next)
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
        // A subscription that failed (signed out mid-session) is followed again on the next reload.
      },
    )
  }

  private onEvent(event: ChangesEvent) {
    if (this.retired) return
    if (event.type === "gone") return this.lose()
    this.setRole(event.role)
    if (event.type === "reset") return void this.reload()
    const theirs: RemoteBatch[] = []
    let moved = false
    for (const b of event.batches) {
      if (b.revision <= this.revision) continue
      if (b.revision !== this.revision + 1) return void this.reload()
      const mine = b.clientId === this.clientId ? this.pending.findIndex((p) => p.batch === b.batch) : -1
      if (mine >= 0) {
        this.confirmed = applyChanges(this.confirmed, this.pending[mine].changes)
        this.pending.splice(mine, 1)
      } else if (b.changes) {
        this.confirmed = applyChanges(this.confirmed, b.changes)
        if (b.clientId !== this.clientId) theirs.push(b)
        moved = true
      } else {
        return void this.reload()
      }
      this.revision = b.revision
    }
    if (moved) this.host.rebase(this.view(), theirs)
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
      // A viewer, or a document that can't take the upgrade: follow it as it is.
      this.watch()
    } catch {
      this.reloading = false
      setTimeout(() => void this.upgrade(attempt + 1), RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)])
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
        this.pending = []
        this.notice = "forbidden"
        this.setRole("viewer")
        this.host.rebase(this.view(), [])
        return
      case "too_large":
      case "invalid":
        // Those edits (the last few, at most a batch) can't be kept. Undo them on screen rather than
        // show a project that isn't saved.
        this.pending = this.pending.filter((p) => p !== batch)
        this.notice = "too_large"
        this.host.rebase(this.view(), [])
        return
    }
  }

  private setRole(role: ProjectRole) {
    if (role === this.role) return
    this.role = role
    this.host.role(role)
  }

  private lose() {
    this.stop("not_found")
    this.host.gone()
  }

  private stop(reason: "outdated" | "not_found") {
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
    if (this.stopped) return this.host.status({ state: "refused", reason: this.stopped })
    const waiting = this.pending.some((p) => p.landed === undefined)
    // A batch whose answer was lost but which the log showed landed: nothing is failing any more.
    if (!waiting) this.failures = 0
    if (this.failures > 0) return
    if (waiting) return this.host.status({ state: "saving" })
    this.host.status(this.notice ? { state: "refused", reason: this.notice } : { state: "saved" })
  }
}
