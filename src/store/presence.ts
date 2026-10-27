import { create } from "zustand"
import type { Box } from "../lib/geometry"
import type { Vec2 } from "../model/types"
import { useCopilot } from "./copilotStore"
import { useUi, type View } from "./uiStore"

/**
 * Who else has the open project open, and what they are doing: the faces in the top bar, their
 * cursors and selections on the canvas, and following one of them around (`follow`).
 *
 * Each tab says what it is doing (`PeerState`) through the host's `PresenceSource` (the website's
 * is the hosted app's; the harness's is a `BroadcastChannel` between this browser's tabs,
 * `browserPresence`). Presence is display and nothing else: what someone may do to the project is
 * the project's storage's business.
 *
 * It is kept cheap, because every update is a write everyone else's tab reads: alone on a project,
 * a tab only says where it is when that changes and every `HEARTBEAT_MS`; with company, it sends
 * its pointer too, at most every `CURSOR_MS`, and the receiving tabs glide each cursor between the
 * points they get.
 */

/** One tab's row, as the host's presence source keeps it. */
export interface PresencePeer {
  sessionId: string
  userId: string
  name: string
  pictureUrl?: string
  /** `PeerState` as JSON. */
  state: string
  updatedAt: number
}

/** How this tab's user is shown to the others. */
export interface PresenceMe {
  name: string
  pictureUrl?: string
}

export interface PresenceSource {
  /** Say what this tab is doing on a project. False when the user has no access to it (any more). */
  update(projectId: string, sessionId: string, me: PresenceMe, state: string): Promise<boolean>
  /** This tab closed the project. */
  leave(sessionId: string): void
  /** The tabs on a project, this one included, live. */
  watch(projectId: string, listener: (peers: PresencePeer[]) => void, onError: (error: Error) => void): () => void
}

/** What a tab says about itself. */
export interface PeerState {
  view: View
  /** On the schematic, the use of a sheet it shows (a path of sheet symbols; absent: the root), whose world units the cursor and viewport are in. */
  sheet?: string
  /** The pointer, in the view's world units; absent when it is off the canvas. */
  cursor?: Vec2
  /** What is selected, with the UI store's prefixes (`c:`, `w:`, `t:`...), up to `MAX_SELECTION`. */
  selection?: string[]
  /** What the canvas shows, in the view's world units: what following them frames. */
  viewport?: Box
  /** Sakura is working in that tab. */
  copilot?: boolean
  /** What it is doing, in a word or two ("Routing"): beside the face and the cursor while `copilot`. */
  copilotLabel?: string
  /** The tab it is following, whose view it mirrors. */
  following?: string
}

export interface Collaborator {
  sessionId: string
  userId: string
  name: string
  pictureUrl?: string
  /** Their colour on this screen: cursor, selection outline, ring round their face. */
  color: string
  state: PeerState
}

const HEARTBEAT_MS = 15_000
/** A tab not heard from for this long has gone (closed without saying, or lost its connection). */
const STALE_MS = 40_000
const CURSOR_MS = 90
/** Alone on a project, what this tab is doing is news to nobody: say it at a walk. */
const QUIET_MS = 1_500
const MAX_SELECTION = 300
const MAX_LABEL = 30

/**
 * Collaborator colours: apart from each other, from the selection blue, and from the copper red
 * and blue of the PCB, and readable on the cream schematic and the black board alike.
 */
export const PEER_COLORS = ["#8e4ec6", "#e5730f", "#12a594", "#d6409f", "#c99a14", "#0797b9", "#3e9b4f", "#a1663e"]

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A colour per person, the same in all their tabs, and different from everyone else's while there are colours to go round. */
export function assignColors(userIds: string[]): Map<string, string> {
  const colors = new Map<string, string>()
  const taken = new Set<number>()
  for (const id of [...new Set(userIds)].sort()) {
    let i = hash(id) % PEER_COLORS.length
    for (let n = 0; n < PEER_COLORS.length && taken.has(i); n++) i = (i + 1) % PEER_COLORS.length
    taken.add(i)
    colors.set(id, PEER_COLORS[i])
  }
  return colors
}

export function parsePeerState(text: string): PeerState {
  try {
    const raw = JSON.parse(text) as Partial<PeerState>
    const view = raw.view === "pcb" || raw.view === "3d" ? raw.view : "schematic"
    const point = (p: unknown): p is Vec2 => !!p && typeof (p as Vec2).x === "number" && typeof (p as Vec2).y === "number"
    const box = (b: unknown): b is Box => !!b && ["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite((b as Record<string, number>)[k]))
    return {
      view,
      ...(typeof raw.sheet === "string" && raw.sheet && raw.sheet.length <= 500 && { sheet: raw.sheet }),
      ...(point(raw.cursor) && { cursor: raw.cursor }),
      ...(Array.isArray(raw.selection) && { selection: raw.selection.filter((s): s is string => typeof s === "string").slice(0, MAX_SELECTION) }),
      ...(box(raw.viewport) && { viewport: raw.viewport }),
      ...(raw.copilot === true && { copilot: true }),
      // Shown to everyone, so a tab can't make it long.
      ...(raw.copilot === true && typeof raw.copilotLabel === "string" && raw.copilotLabel.trim() && { copilotLabel: raw.copilotLabel.trim().slice(0, MAX_LABEL) }),
      ...(typeof raw.following === "string" && { following: raw.following }),
    }
  } catch {
    return { view: "schematic" }
  }
}

interface PresenceStore {
  /** Everyone else on the open project, one per tab, in the order they arrived. */
  peers: Collaborator[]
  /** The host has answered once for the open project: `peers` is who was there, not a list still loading. */
  loaded: boolean
  /** The user's own id, as the host knows it: their other tabs aren't company. */
  selfUserId: string | null
  /** This tab's session on the open project. */
  selfSessionId: string | null
  /** The tab this one is following: its view and what it is looking at. */
  following: string | null
  follow: (sessionId: string) => void
  unfollow: () => void
}

export const usePresence = create<PresenceStore>((set) => ({
  peers: [],
  loaded: false,
  selfUserId: null,
  selfSessionId: null,
  following: null,
  follow: (following) => set({ following }),
  unfollow: () => set({ following: null }),
}))

/** Stop following whoever this tab follows: the user took the view back. */
export function stopFollowing() {
  if (usePresence.getState().following) usePresence.getState().unfollow()
}

/**
 * The tabs in a ring of following that comes back to this one (A follows B follows A), or null.
 * Each would frame the next one's framing, a little wider every time, for ever.
 */
function followRing(s: PresenceStore): string[] | null {
  const self = s.selfSessionId
  if (!self || !s.following) return null
  const ring = [self]
  for (let at: string | undefined = s.following; at && ring.length <= s.peers.length + 1; ) {
    if (at === self) return ring
    if (ring.includes(at)) return null
    ring.push(at)
    at = s.peers.find((p) => p.sessionId === at)?.state.following
  }
  return null
}

/**
 * Mirror the followed tab: its view, and what it shows, framed to fill this canvas. Following
 * someone who follows this tab would chase each other's framing outward for ever, so the second
 * of the two is refused (`canFollow`); two who clicked each other at once (or a longer ring) are
 * parted here, by the tab of the ring with the greatest id letting go, which every tab in it agrees on.
 */
export function followLeader(): () => void {
  let applied = ""
  const apply = (s: PresenceStore) => {
    const ring = followRing(s)
    if (ring && ring.reduce((a, b) => (b > a ? b : a)) === s.selfSessionId) {
      applied = ""
      return s.unfollow()
    }
    const leader = s.following ? s.peers.find((p) => p.sessionId === s.following) : undefined
    if (!leader) {
      applied = ""
      return
    }
    const ui = useUi.getState()
    const { view, viewport } = leader.state
    const sheet = view === "schematic" ? (leader.state.sheet ?? "") : ""
    const key = `${leader.sessionId}:${view}:${sheet}:${viewport ? [viewport.minX, viewport.minY, viewport.maxX, viewport.maxY].map((n) => n.toFixed(3)).join(",") : ""}`
    if (key === applied) return
    applied = key
    if (view !== ui.view) ui.setView(view)
    // Their sheet is where their view is: the same coordinates mean another place on another sheet.
    if (view === "schematic" && sheet !== ui.sheet) ui.setSheet(sheet)
    if (viewport && view !== "3d") ui.focus(view, (viewport.minX + viewport.maxX) / 2, (viewport.minY + viewport.maxY) / 2, viewport, true)
  }
  apply(usePresence.getState())
  return usePresence.subscribe(apply)
}

/** Whether this tab may follow another: not one that is following this tab. */
export const canFollow = (peer: Collaborator, ownSessionId: string | null) => !ownSessionId || peer.state.following !== ownSessionId

/** Distinct people among the peers, first tab each: the faces in the top bar. */
export function distinctPeople(peers: Collaborator[]): Collaborator[] {
  const seen = new Set<string>()
  return peers.filter((p) => !seen.has(p.userId) && seen.add(p.userId))
}

// ---------- What this tab reports ----------

let pointer: { view: View; at: Vec2 } | null = null
const viewports: Partial<Record<View, Box>> = {}
let publish: ((kind: "cursor" | "state") => void) | null = null

/** The pointer moved over a canvas (null: it left). Cheap enough to call on every move. */
export function reportPointer(view: View, at: Vec2 | null) {
  pointer = at ? { view, at } : pointer?.view === view ? null : pointer
  publish?.("cursor")
}

/** What a canvas shows changed (a pan, a zoom, a resize). */
export function reportViewport(view: View, box: Box) {
  viewports[view] = box
  publish?.("cursor")
}

function ownState(): PeerState {
  const ui = useUi.getState()
  const view = ui.view
  return {
    view,
    ...(view === "schematic" && ui.sheet && { sheet: ui.sheet }),
    ...(pointer?.view === view && { cursor: round(pointer.at) }),
    ...(ui.selection.length && { selection: ui.selection.slice(0, MAX_SELECTION) }),
    ...(viewports[view] && { viewport: viewports[view] }),
    ...(useCopilot.getState().runningProject && { copilot: true, ...(useCopilot.getState().activity && { copilotLabel: useCopilot.getState().activity! }) }),
    ...(usePresence.getState().following && { following: usePresence.getState().following! }),
  }
}

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })

/**
 * Be present on a project: say what this tab is doing and follow everyone else's tabs, until the
 * returned function is called (the project closed, the tab left).
 */
export function startPresence(projectId: string, sessionId: string, source: PresenceSource, me: () => PresenceMe, selfUserId: string | null): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSent = 0
  let rows: PresencePeer[] = []
  /** The source has said who is here at least once. */
  let answered = false
  /** When each tab's row last changed, by this tab's clock: a row that stops changing has gone. */
  const heard = new Map<string, { updatedAt: number; at: number }>()

  usePresence.setState({ peers: [], loaded: false, following: null, selfUserId, selfSessionId: sessionId })

  const company = () => usePresence.getState().peers.some((p) => p.userId !== selfUserId)

  const send = () => {
    timer = null
    if (stopped) return
    lastSent = Date.now()
    void source.update(projectId, sessionId, me(), JSON.stringify(ownState())).catch(() => {
      // Presence is best effort: the next change or heartbeat tries again.
    })
  }

  const schedule = (kind: "cursor" | "state") => {
    if (stopped) return
    // A pointer nobody can see isn't worth a write.
    if (kind === "cursor" && !company()) return
    const gap = company() ? CURSOR_MS : QUIET_MS
    if (timer) return
    timer = setTimeout(send, Math.max(0, lastSent + gap - Date.now()))
  }
  publish = schedule

  const refresh = () => {
    const now = Date.now()
    for (const r of rows) {
      const h = heard.get(r.sessionId)
      if (!h || h.updatedAt !== r.updatedAt) heard.set(r.sessionId, { updatedAt: r.updatedAt, at: now })
    }
    const live = rows.filter((r) => r.sessionId !== sessionId && now - (heard.get(r.sessionId)?.at ?? 0) < STALE_MS)
    const colors = assignColors(live.map((r) => r.userId))
    const before = usePresence.getState()
    const peers = live
      .map((r) => ({ sessionId: r.sessionId, userId: r.userId, name: r.name, pictureUrl: r.pictureUrl, color: colors.get(r.userId)!, state: parsePeerState(r.state) }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    const hadCompany = company()
    usePresence.setState({ peers, loaded: answered, ...(before.following && !peers.some((p) => p.sessionId === before.following) && { following: null }) })
    // Someone arrived: they should see this tab's pointer and selection now, not at the next heartbeat.
    if (!hadCompany && company()) schedule("state")
  }

  const unwatch = source.watch(
    projectId,
    (next) => {
      rows = next
      answered = true
      refresh()
    },
    () => {},
  )
  const unsubscribeUi = useUi.subscribe((s, prev) => {
    if (s.view !== prev.view || s.selection !== prev.selection || s.sheet !== prev.sheet) schedule("state")
  })
  const unsubscribeCopilot = useCopilot.subscribe((s, prev) => {
    if (s.runningProject !== prev.runningProject || s.activity !== prev.activity) schedule("state")
  })
  const unsubscribeFollow = usePresence.subscribe((s, prev) => {
    if (s.following !== prev.following) schedule("state")
  })
  const heartbeat = setInterval(() => {
    refresh()
    if (Date.now() - lastSent >= HEARTBEAT_MS - 500) {
      if (timer) clearTimeout(timer)
      send()
    }
  }, 5_000)
  send()

  return () => {
    stopped = true
    if (publish === schedule) publish = null
    if (timer) clearTimeout(timer)
    clearInterval(heartbeat)
    unwatch()
    unsubscribeUi()
    unsubscribeCopilot()
    unsubscribeFollow()
    source.leave(sessionId)
    usePresence.setState({ peers: [], loaded: false, following: null })
  }
}

// ---------- This browser's tabs ----------

const CHANNEL = "cherryblossom:editor:presence"

type Message =
  | { type: "state"; projectId: string; peer: PresencePeer }
  | { type: "leave"; sessionId: string }
  | { type: "hello"; projectId: string }

/**
 * Presence between this browser's tabs, for the development harness: each tab is a guest of its
 * own, so two tabs on one project show each other's cursors as two people's would.
 */
export function browserPresence(): PresenceSource {
  let opened: BroadcastChannel | null | undefined
  // Opened on first use: an open channel keeps a test runner's process alive.
  const channel = () => (opened ??= typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null)
  const userId = guestId()
  /** This tab's own rows, to say again when another tab says hello. */
  const mine = new Map<string, { projectId: string; peer: PresencePeer }>()
  return {
    async update(projectId, sessionId, me, state) {
      const peer = { sessionId, userId, name: me.name, pictureUrl: me.pictureUrl, state, updatedAt: Date.now() }
      mine.set(sessionId, { projectId, peer })
      channel()?.postMessage({ type: "state", projectId, peer } satisfies Message)
      return true
    },
    leave(sessionId) {
      mine.delete(sessionId)
      channel()?.postMessage({ type: "leave", sessionId } satisfies Message)
    },
    watch(projectId, listener) {
      const peers = new Map<string, PresencePeer>()
      const emit = () => listener([...peers.values(), ...[...mine.values()].filter((m) => m.projectId === projectId).map((m) => m.peer)])
      const onMessage = (e: MessageEvent<Message>) => {
        const m = e.data
        if (m.type === "state" && m.projectId === projectId) peers.set(m.peer.sessionId, m.peer)
        else if (m.type === "state" || m.type === "leave") peers.delete(m.type === "state" ? m.peer.sessionId : m.sessionId)
        else if (m.type === "hello" && m.projectId === projectId) {
          for (const own of mine.values()) if (own.projectId === projectId) channel()?.postMessage({ type: "state", projectId, peer: { ...own.peer, updatedAt: Date.now() } } satisfies Message)
          return
        } else return
        emit()
      }
      channel()?.addEventListener("message", onMessage)
      channel()?.postMessage({ type: "hello", projectId } satisfies Message)
      emit()
      return () => channel()?.removeEventListener("message", onMessage)
    },
  }
}

/** This tab's guest identity in the harness, kept for the tab's life. */
function guestId(): string {
  const key = "cherryblossom:editor:guest"
  try {
    const kept = sessionStorage.getItem(key)
    if (kept) return kept
    const id = `guest-${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return `guest-${Math.random().toString(36).slice(2, 8)}`
  }
}

/** The harness's stand-in name for a guest: "Guest" and a few letters of its id. */
export const guestName = () => `Guest ${guestId().slice(6, 10).toUpperCase()}`
export const guestUserId = guestId
