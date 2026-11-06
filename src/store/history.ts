import type { ProjectRole } from "./storage"

/**
 * A project's version history, as the history panel (`panels/HistoryPanel.tsx`) sees it. The host
 * implements it: the website's keeps a copy of the document as
 * the project is edited, thins them by age, and keeps the ones people name. The editor holds no
 * rule about who may do what: `HistoryState.role` says, and the host refuses a restore or a name
 * from a viewer whatever the panel shows.
 */

export interface VersionPerson {
  userId: string
  name: string
  email: string
  pictureUrl?: string
}

/** Items added, removed and changed. */
export interface VersionCounts {
  added: number
  removed: number
  changed: number
}

export const SUMMARY_KINDS = ["parts", "wires", "traces", "vias", "zones", "labels", "other"] as const
export type SummaryKind = (typeof SUMMARY_KINDS)[number]
export type VersionSummary = Record<SummaryKind, VersionCounts>

/** Who did it for the user: Sakura, or their own AI assistant over MCP. */
export type VersionVia = "sakura" | "assistant"

export interface VersionInfo {
  id: string
  /** When that state stopped being current (when it was named, for a named version). */
  at: number
  revision: number
  /** `auto`: kept as the project was edited; `named`: named by an editor, never thinned; `restore`: the state a restore replaced. */
  kind: "auto" | "named" | "restore"
  name: string | null
  /** On a `restore` version, when the version restored from was current. */
  restoredFromAt: number | null
  /** Who named it, or restored. */
  by: VersionPerson | null
  /** Named or kept for them by Sakura or their AI assistant (`save_version`, `restore_version`), not by hand. */
  via: VersionVia | null
  /** Who edited the project in the span since the version before it. */
  editors: VersionPerson[]
  formatVersion: number
  size: number
  /** What changed since the version before it. */
  summary: VersionSummary
}

export interface HistoryState {
  role: ProjectRole
  revision: number
  updatedAt: number
  /** The state now: the edits since the newest version, and who made them. */
  current: { edits: number; editors: VersionPerson[] }
  /** Newest first. */
  versions: VersionInfo[]
  /** There are older versions than were asked for. */
  more: boolean
}

export type NameOutcome = { ok: true; versionId: string } | { ok: false; reason: "not_found" | "forbidden" | "invalid" | "too_many" }
/** `kept` is the version that holds the project as it was before the restore: a new one, or the newest when it is that already. */
export type KeepOutcome = { ok: true; kept: string } | { ok: false; reason: "not_found" | "forbidden" }
export type RestoreOutcome = { ok: true; revision: number } | { ok: false; reason: "not_found" | "forbidden" | "outdated" | "too_large" }

export interface OpenedVersion {
  content: string
  formatVersion: number
  revision: number
  at: number
}

export interface HistorySource {
  /** The history, newest `limit` versions, live. `null` when the user has no access to the project. */
  watch(projectId: string, limit: number, listener: (state: HistoryState | null) => void, onError: (error: Error) => void): () => void
  /** A version's project file, to look at. */
  open(projectId: string, versionId: string): Promise<OpenedVersion | null>
  /** Name the project as it is now, or (with `versionId`) an older version. Named versions are kept for good. `via` when Sakura saves it. */
  name(projectId: string, name: string, versionId?: string, via?: "sakura"): Promise<NameOutcome>
  /** Take a version's name off, so it is thinned like any other. */
  unname(projectId: string, versionId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" | "forbidden" }>
  /** Make a version the project's state, as a new change on top: every open copy loads it, and what it replaced is kept first. */
  restore(projectId: string, versionId: string, formatVersion: number): Promise<RestoreOutcome>
  /**
   * Keep the project as it is now before `versionId` is restored as changes (Sakura's `restore_version`, which brings it
   * back as one undo step rather than through `restore`): the "Before restoring" copy `restore` keeps.
   */
  keep(projectId: string, versionId: string, via?: "sakura"): Promise<KeepOutcome>
}

const KIND_WORDS: Record<SummaryKind, [string, string]> = {
  parts: ["part", "parts"],
  wires: ["wire", "wires"],
  traces: ["trace", "traces"],
  vias: ["via", "vias"],
  zones: ["zone", "zones"],
  labels: ["label", "labels"],
  other: ["other item", "other items"],
}

export interface ChangeLine {
  kind: SummaryKind
  /** "+2 parts", "−1 wire" or "~3 traces changed". */
  text: string
  sign: "added" | "removed" | "changed"
}

/** What a version says changed, as short lines, parts then wires then traces first. Empty when nothing did. */
export function changeLines(summary: VersionSummary): ChangeLine[] {
  const lines: ChangeLine[] = []
  for (const kind of SUMMARY_KINDS) {
    const { added, removed, changed } = summary[kind]
    const word = (n: number) => KIND_WORDS[kind][n === 1 ? 0 : 1]
    if (added) lines.push({ kind, sign: "added", text: `+${added} ${word(added)}` })
    if (removed) lines.push({ kind, sign: "removed", text: `−${removed} ${word(removed)}` })
    if (changed) lines.push({ kind, sign: "changed", text: `~${changed} ${word(changed)}` })
  }
  return lines
}

/** The words for when a version was, to the minute: "Oct 27, 3:10 PM". */
export function versionTime(at: number, now = Date.now()): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() && { year: "numeric" }) })}, ${time}`
}

/** Who made a version, as the list says it: "Ada", "Ada with Sakura", "Ada's AI assistant". Null when no one did (one kept as the project was edited). */
export function versionBy(v: Pick<VersionInfo, "by" | "via">): string | null {
  const who = v.by ? v.by.name || v.by.email || "Someone" : null
  if (v.via === "assistant") return who ? `${who}'s AI assistant` : "An AI assistant"
  if (v.via === "sakura") return who ? `${who} with Sakura` : "Sakura"
  return who
}

/** What to call a version: its name, or what kind of state it is. */
export function versionLabel(v: Pick<VersionInfo, "kind" | "name" | "restoredFromAt" | "at">): string {
  if (v.name) return v.name
  if (v.kind === "restore") return v.restoredFromAt ? `Before restoring ${versionTime(v.restoredFromAt)}` : "Before a restore"
  return versionTime(v.at)
}
