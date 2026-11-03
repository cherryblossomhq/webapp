import { CloudOff, Eye, Sparkles } from "lucide-react"
import { canFollow, distinctPeople, usePresence, type Collaborator } from "../store/presence"
import { useProjectStore } from "../store/projectStore"
import { Avatar } from "../ui/Avatar"
import { Tooltip } from "../ui/Tooltip"

const WHERE = { schematic: "On the schematic", pcb: "On the PCB", "3d": "In the 3D view" } as const
const MAX_FACES = 4

/**
 * The people on the project with the user, as faces in their colours. A click follows one: this
 * tab shows what they are looking at, on their view, until the user pans, zooms, clicks the canvas
 * or presses Esc. Their own other tabs are the user, not company, and aren't shown.
 */
export function Collaborators() {
  const peers = usePresence((s) => s.peers)
  const self = usePresence((s) => s.selfUserId)
  const following = usePresence((s) => s.following)
  const sessionId = useProjectStore((s) => s.sessionId)
  const people = distinctPeople(peers.filter((p) => p.userId !== self))
  if (!people.length) return null
  const shown = people.slice(0, MAX_FACES)
  const more = people.slice(MAX_FACES)
  // Whose Sakura is working, by person (their first tab that says so): a small chip after the faces.
  const working = people.flatMap((p) => peers.find((x) => x.userId === p.userId && x.state.copilot) ?? [])
  return (
    <div className="flex items-center pl-1 pr-1" aria-label="People on this project">
      {shown.map((p, i) => (
        <Face key={p.userId} peer={peers.find((x) => x.sessionId === following && x.userId === p.userId) ?? p} first={i === 0} following={peers.some((x) => x.sessionId === following && x.userId === p.userId)} sessionId={sessionId} />
      ))}
      {more.length > 0 && (
        <Tooltip label={more.map((p) => p.name || "Guest").join(", ")}>
          <span className="-ml-1.5 flex size-7 items-center justify-center rounded-full bg-chrome-2 text-[11px] font-[650] text-ink-2 ring-2 ring-surface">+{more.length}</span>
        </Tooltip>
      )}
      {working.length > 0 && <SakuraChip working={working} />}
    </div>
  )
}

/** "Sakura for Ada: Routing", or for the first of several (the title says it in full). Next to the faces, in the colour of the person it works for. */
function SakuraChip({ working }: { working: Collaborator[] }) {
  const first = working[0]
  const who = first.name.trim() || "Guest"
  const more = working.length - 1
  const doing = first.state.copilotLabel
  return (
    <span
      role="status"
      data-sakura-chip
      className="ml-1.5 flex h-6 max-w-[200px] items-center gap-1 rounded-full px-2 text-[11.5px] font-[600] leading-none text-white"
      style={{ backgroundColor: first.color }}
      title={working.map((p) => `Sakura is working for ${p.name.trim() || "Guest"}${p.state.copilotLabel ? `: ${p.state.copilotLabel}` : ""}`).join(". ")}
    >
      <Sparkles size={11} className="shrink-0" />
      <span className="truncate">
        {`Sakura for ${who}`}
        {doing ? `: ${doing}` : ""}
        {more > 0 ? ` +${more}` : ""}
      </span>
    </span>
  )
}

function Face({ peer, first, following, sessionId }: { peer: Collaborator; first: boolean; following: boolean; sessionId: string | null }) {
  const followsYou = !!sessionId && peer.state.following === sessionId
  const allowed = canFollow(peer, sessionId)
  const hint = [
    peer.state.copilot ? `Sakura is working for them${peer.state.copilotLabel ? `: ${peer.state.copilotLabel}` : ""}` : WHERE[peer.state.view],
    followsYou ? "Following you" : following ? "Click to stop following" : allowed ? "Click to follow" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <Tooltip label={peer.name || "Guest"} hint={hint}>
      <button
        aria-label={following ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
        aria-pressed={following}
        disabled={!allowed && !following}
        onClick={() => (following ? usePresence.getState().unfollow() : usePresence.getState().follow(peer.sessionId))}
        className={`relative rounded-full transition-transform hover:z-10 hover:-translate-y-px disabled:cursor-default ${first ? "" : "-ml-1.5"}`}
      >
        <Avatar person={peer} size="sm" color={peer.color} className={following ? "scale-105" : ""} />
        {(peer.state.copilot || following) && (
          <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full text-white ring-2 ring-surface" style={{ backgroundColor: peer.color }}>
            {following ? <Eye size={9} /> : <Sparkles size={9} />}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/** Shown while storage can't be reached: editing waits for it (`editingPaused`), and others' edits show when it's back. */
export function OfflinePill() {
  const online = useProjectStore((s) => s.online)
  const viewer = useProjectStore((s) => s.role === "viewer")
  if (online) return null
  return (
    <Tooltip label="Offline" hint={viewer ? "Changes show again when you're back online" : "Editing is paused until you're back online"}>
      <span className="flex h-7 items-center gap-1.5 rounded-full bg-chrome-2 px-2.5 text-[12px] font-[600] text-ink-2">
        <CloudOff size={13} />
        Offline
      </span>
    </Tooltip>
  )
}

/** While following someone: their colour round the canvas, and the way out. */
export function FollowFrame() {
  const following = usePresence((s) => s.following)
  const leader = usePresence((s) => s.peers.find((p) => p.sessionId === s.following))
  if (!following || !leader) return null
  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20 border-2" style={{ borderColor: leader.color }} />
      <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full py-1 pl-1 pr-1 text-[12px] font-[600] text-white shadow-float" style={{ backgroundColor: leader.color }}>
        <Avatar person={leader} size="xs" />
        <span>Following {leader.name || "Guest"}</span>
        <button className="rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30" onClick={() => usePresence.getState().unfollow()}>
          Stop
        </button>
      </div>
    </>
  )
}
