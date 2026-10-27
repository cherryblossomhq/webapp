import { create } from "zustand"

/**
 * The board lease, the editor's side: whole-board actions (Sakura's `layout_pcb`, `route_pcb`,
 * `clear_routing` and `tidy_schematic`, the toolbar's Re-pack, Autoroute and Tidy, Clean up) take it
 * first, so two people, or one person's two tabs, don't rewrite the board at once. The server side
 * is the hosted app's (a lease that runs out after a minute unless renewed); the host's
 * `LockSource` is how this talks to it.
 *
 * Whoever has the lease says so (`holder`), and everyone else's buttons say who. An action that
 * finds it taken does not run and does not queue: it is told who has it and what they are doing.
 * Where the host has no leases (the harness, a browser-only project) every action goes ahead, and a
 * lease that can't be reached (offline) lets the action go ahead too: edits queue offline anyway,
 * and the lease is a courtesy between people, never access.
 */

/** Who holds the lease and what for. */
export interface LeaseHolder {
  userId: string
  sessionId: string
  name: string
  /** The action's key: `route_pcb`, `autoroute`... (`ACTION_PHRASES`). */
  action: string
  /** Sakura's tool, rather than a button. */
  viaSakura: boolean
  since: number
  expiresAt: number
  /** Another tab of the same user. */
  mine?: boolean
}

export type LeaseAnswer = { ok: true } | { ok: false; reason: "held"; holder: LeaseHolder & { mine: boolean } } | { ok: false; reason: "not_found" | "read_only" }

export interface LockSource {
  /** Take the lease for this tab, or renew it. Refused with the holder when another tab has it. */
  acquire(projectId: string, sessionId: string, me: { name: string }, action: string, viaSakura: boolean): Promise<LeaseAnswer>
  /** Push the lease out again. False when this tab no longer holds it. */
  renew(projectId: string, sessionId: string): Promise<boolean>
  release(projectId: string, sessionId: string): Promise<void>
  /** Who holds the lease on a project, live. */
  watch(projectId: string, listener: (holder: LeaseHolder | null) => void, onError: (error: Error) => void): () => void
}

/** The lease runs out after this long without a renewal (the hosted app's `LEASE_MS`); the editor renews every `RENEW_MS`. */
export const LEASE_MS = 60_000
export const RENEW_MS = 20_000

/** What each action is, in words that follow "is": Sakura's and the toolbar's. */
const ACTION_PHRASES: Record<string, string> = {
  layout_pcb: "placing parts on the board",
  relayout_all: "re-placing every part on the board",
  route_pcb: "routing the board",
  autoroute: "routing the board",
  clear_routing: "clearing the routing",
  tidy_schematic: "tidying the schematic",
  tidy: "tidying the schematic",
  cleanup: "cleaning up the schematic",
  repack: "re-packing the board",
}

const firstName = (name: string) => {
  return name.trim().split(/\s+/)[0] || "Someone"
}

/** "Ada's Sakura is routing the board", "Ada is tidying the schematic", "Your other tab is routing the board": who holds the lease and what for. */
export function holderSentence(holder: LeaseHolder): string {
  const what = ACTION_PHRASES[holder.action] ?? "changing the board"
  if (holder.mine) return `Your other tab is ${what}`
  const who = firstName(holder.name)
  return holder.viaSakura ? `${who}'s Sakura is ${what}` : `${who} is ${what}`
}

interface LeaseStore {
  /** Who else holds the lease on the open project, or null. Never this tab. */
  holder: LeaseHolder | null
}

export const useBoardLease = create<LeaseStore>(() => ({ holder: null }))

/** Whether another tab holds the lease now, and what to say about it. */
export const heldNote = (s: LeaseStore): string | null => (s.holder && s.holder.expiresAt > Date.now() ? `${holderSentence(s.holder)} right now.` : null)

/** What a whole-board action holds while it runs; `release` is safe to call more than once. */
export type BoardLease = { ok: true; release: () => void } | { ok: false; message: string }

interface Binding {
  projectId: string
  sessionId: string
  source: LockSource
  me: () => { name: string }
  selfUserId: string | null
}

let binding: Binding | null = null
/** This tab's holds: how many actions are running under the lease, and the timer that renews it. */
let holds = 0
let pendingAcquires = 0
let renewTimer: ReturnType<typeof setInterval> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
/** The action in hand, for the label when the lease is taken again. */
let heldAction = ""

/** Renew now: a long synchronous action (the router) blocks the timer, so it renews just before and after. */
export function renewBoardNow(): void {
  const b = binding
  if (b && holds > 0) void b.source.renew(b.projectId, b.sessionId).catch(() => {})
}

function stopRenewing() {
  if (renewTimer) clearInterval(renewTimer)
  renewTimer = null
}

/** Free the lease once nothing in this tab is using it and nothing is on its way to take it. */
function freeIfIdle(b: Binding) {
  if (holds > 0 || pendingAcquires > 0) return
  stopRenewing()
  void b.source.release(b.projectId, b.sessionId).catch(() => {
    // The lease runs out by itself.
  })
}

/**
 * Follow who holds the lease on the open project, until the returned function is called (the
 * project closed). This tab's own lease is not shown to it; another tab of the same user is.
 */
export function startBoardLease(projectId: string, sessionId: string, source: LockSource, me: () => { name: string }, selfUserId: string | null): () => void {
  const mine: Binding = { projectId, sessionId, source, me, selfUserId }
  binding = mine
  holds = 0
  pendingAcquires = 0
  useBoardLease.setState({ holder: null })
  const show = (holder: LeaseHolder | null) => {
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    if (!holder || holder.sessionId === sessionId || holder.expiresAt <= Date.now()) return useBoardLease.setState({ holder: null })
    useBoardLease.setState({ holder: { ...holder, mine: selfUserId !== null && holder.userId === selfUserId } })
    // A lease nobody renewed frees itself, and the server's answer does not change when the time passes: say so here.
    expiryTimer = setTimeout(() => useBoardLease.setState({ holder: null }), holder.expiresAt - Date.now() + 50)
  }
  const unwatch = source.watch(projectId, show, () => {})
  // A closed or reloaded tab lets go at once, so the next one is not told "your other tab" for a minute.
  const onPageHide = () => {
    if (holds > 0 || pendingAcquires > 0) void source.release(projectId, sessionId).catch(() => {})
  }
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide)
  return () => {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide)
    unwatch()
    stopRenewing()
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = null
    if (binding === mine) {
      if (holds > 0) void source.release(projectId, sessionId).catch(() => {})
      binding = null
      holds = 0
      pendingAcquires = 0
    }
    useBoardLease.setState({ holder: null })
  }
}

const NO_LEASE: BoardLease = { ok: true, release: () => {} }

/** The sentence an action that finds the lease taken is told. */
export function refusalMessage(holder: LeaseHolder, forSakura: boolean): string {
  const tail = forSakura ? " Wait for it to finish, or work on something else. Tell the user, and do not call this tool again until it is done." : " Wait for it to finish, or work on something else."
  return `${holderSentence(holder)} right now.${tail}`
}

/**
 * Take the lease for a whole-board action. Synchronous (and free) where the host has no leases; else
 * one round trip, which is all a project with one person on it ever pays. Release the result when
 * the action ends, however it ends. Several actions in one tab share the lease (Clean up with AI
 * tidies under its own lease), and it is freed when the last one lets go.
 */
export function acquireBoard(action: string, viaSakura: boolean): BoardLease | Promise<BoardLease> {
  const b = binding
  if (!b) return NO_LEASE
  if (holds > 0 && pendingAcquires === 0) {
    // Already ours: the lease is only noted, the server has it.
    holds++
    heldAction = action
    return holdHandle(b)
  }
  pendingAcquires++
  heldAction = action
  return b.source.acquire(b.projectId, b.sessionId, b.me(), action, viaSakura).then(
    (answer): BoardLease => {
      pendingAcquires--
      if (binding !== b) return NO_LEASE
      if (answer.ok) {
        holds++
        if (!renewTimer) {
          renewTimer = setInterval(() => {
            void b.source
              .renew(b.projectId, b.sessionId)
              .then((kept) => {
                // It ran out (a long pause) and nobody took it: take it again, quietly.
                if (!kept && holds > 0) void b.source.acquire(b.projectId, b.sessionId, b.me(), heldAction, viaSakura).catch(() => {})
              })
              .catch(() => {})
          }, RENEW_MS)
        }
        return holdHandle(b)
      }
      freeIfIdle(b)
      if (answer.reason === "held") return { ok: false, message: refusalMessage(answer.holder, viaSakura) }
      if (answer.reason === "read_only") return { ok: false, message: "You can view this project, not change it." }
      return NO_LEASE
    },
    (): BoardLease => {
      pendingAcquires--
      freeIfIdle(b)
      // The lease can't be reached (offline): the action goes ahead, as edits do.
      return NO_LEASE
    },
  )
}

function holdHandle(b: Binding): BoardLease {
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      holds = Math.max(0, holds - 1)
      if (binding === b) freeIfIdle(b)
    },
  }
}

/** Run `fn` under the lease, or say who has it. `fn` may be async; the lease is freed when it ends or throws. */
export async function withBoard<T>(action: string, fn: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const lease = await acquireBoard(action, false)
  if (!lease.ok) return lease
  try {
    return { ok: true, value: await fn() }
  } finally {
    lease.release()
  }
}

/**
 * Sakura's whole-board tools, and the key each takes the lease under: the ones that rewrite much of
 * the board or sheet at once. `place_parts` (named parts), `set_board`, `set_pour` (one net),
 * `set_net_width`, `group_parts` and `edit_block` stay out: each touches what the call names.
 * `clear_routing` with nets or refs, and `tidy_schematic` with named blocks, are scoped the same way.
 */
export function wholeBoardAction(name: string, input: unknown): string | null {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const some = (v: unknown) => Array.isArray(v) && v.length > 0
  switch (name) {
    case "layout_pcb":
      return i.relayout_all === true ? "relayout_all" : "layout_pcb"
    case "route_pcb":
      return "route_pcb"
    case "clear_routing":
      return some(i.nets) || some(i.refs) ? null : "clear_routing"
    case "tidy_schematic":
      return some(i.blocks) ? null : "tidy_schematic"
    default:
      return null
  }
}
