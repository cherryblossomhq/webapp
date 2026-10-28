import { Sparkles } from "lucide-react"
import { useRef } from "react"
import type { Box } from "../lib/geometry"
import { blockFrames, componentTextBoxes } from "../model/blocks"
import { drawingBounds } from "../model/drawings"
import { pcbCourtyard, pcbPads, schematicBounds } from "../model/instances"
import { labelBox } from "../model/labels"
import type { Project, Vec2 } from "../model/types"
import { usePresence, type Collaborator } from "../store/presence"
import { useUi, type View } from "../store/uiStore"
import { toScreen, type ViewTransform } from "./viewport"

/**
 * Other people on the canvas: their cursors, and outlines round what they have selected, in their
 * colours. A selection someone else holds is the clearest sign of what they are working on, so
 * nobody needs to ask before moving a part: if it is outlined in someone's colour, they have it.
 *
 * Only people on the same view are drawn; the top bar shows where everyone else is.
 */

function usePeersOn(view: View): Collaborator[] {
  const peers = usePresence((s) => s.peers)
  const self = usePresence((s) => s.selfUserId)
  const sheet = useUi((s) => s.sheet)
  // On the schematic, only people on the sheet shown: their coordinates are those of their sheet.
  return peers.filter((p) => p.state.view === view && p.userId !== self && (view !== "schematic" || (p.state.sheet ?? "") === sheet))
}

function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }))
}

function pointsBox(points: Vec2[], pad = 0): Box | null {
  if (!points.length) return null
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad }
}

/** The world box of each thing a selection holds, on one view. Ids gone from the project draw nothing. */
export function selectionBoxes(view: View, project: Project, selection: string[]): Box[] {
  const boxes: Box[] = []
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]))
  const components = byId(project.components)
  for (const key of selection) {
    const kind = key.slice(0, 1)
    const id = key.slice(2)
    let box: Box | null = null
    if (view === "schematic") {
      if (kind === "c") {
        // With its designator and value, so a name tag above it never covers them.
        const c = components.get(id)
        box = c ? union([schematicBounds(c), ...componentTextBoxes(c)]) : null
      } else if (kind === "w") box = pointsBox(project.wires.find((w) => w.id === id)?.points ?? [], 0.05)
      else if (kind === "l") {
        const l = project.labels.find((x) => x.id === id)
        box = l ? labelBox(l) : null
      } else if (kind === "b") box = blockFrames(project).find((f) => f.id === id)?.box ?? null
      else if (kind === "d") {
        const d = project.drawings?.find((x) => x.id === id)
        box = d ? drawingBounds(d) : null
      }
    } else if (view === "pcb") {
      if (kind === "c") {
        const c = components.get(id)
        box = c && c.pcb.placed ? (pcbCourtyard(c) ?? pointsBox(pcbPads(c).map((p) => ({ x: p.x, y: p.y })), 0.5)) : null
      } else if (kind === "t") {
        const t = project.traces.find((x) => x.id === id)
        box = t ? pointsBox(t.points, t.width / 2) : null
      } else if (kind === "v") {
        const v = project.vias.find((x) => x.id === id)
        box = v ? { minX: v.x - v.diameter / 2, minY: v.y - v.diameter / 2, maxX: v.x + v.diameter / 2, maxY: v.y + v.diameter / 2 } : null
      }
    }
    if (box) boxes.push(box)
  }
  return boxes
}

/** Outlines round what each person on this view has selected, drawn in world units under the cursors. */
export function PeerSelections({ view, project, px }: { view: View; project: Project; px: number }) {
  const peers = usePeersOn(view)
  return (
    <g pointerEvents="none">
      {peers.map((p) =>
        selectionBoxes(view, project, p.state.selection ?? []).map((b, i) => {
          const pad = 4 * px
          return (
            <rect
              key={`${p.sessionId}:${i}`}
              x={b.minX - pad}
              y={b.minY - pad}
              width={b.maxX - b.minX + 2 * pad}
              height={b.maxY - b.minY + 2 * pad}
              rx={3 * px}
              fill={p.color}
              fillOpacity={0.08}
              stroke={p.color}
              strokeWidth={2 * px}
            />
          )
        }),
      )}
    </g>
  )
}

const keyOf = (t: ViewTransform) => `${t.scale}:${t.tx}:${t.ty}`

/**
 * Each person's cursor with their name, and their name over what they have selected, in screen
 * space. Cursors glide between the points that arrive (a few a second) rather than jump, except
 * while this view itself pans or zooms, when they move with the canvas at once.
 */
export function PeerCursors({ view, project, t }: { view: View; project: Project; t: ViewTransform }) {
  const peers = usePeersOn(view)
  const last = useRef(keyOf(t))
  const moved = last.current !== keyOf(t)
  last.current = keyOf(t)
  const transition = moved ? "none" : "transform 110ms linear"
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {peers.map((p) => {
        const sel = union(selectionBoxes(view, project, p.state.selection ?? []))
        const tag = sel && toScreen(t, { x: sel.minX, y: sel.maxY })
        return (
          <div key={p.sessionId}>
            {tag && (
              <div
                className="absolute left-0 top-0 rounded-[4px] px-1 text-[10.5px] font-[650] leading-[16px] text-white"
                style={{ backgroundColor: p.color, transform: `translate(${tag.x - 4}px, ${tag.y - 22}px)` }}
              >
                {firstName(p.name)}
              </div>
            )}
            {p.state.cursor && <Cursor peer={p} at={toScreen(t, p.state.cursor)} transition={transition} />}
          </div>
        )
      })}
    </div>
  )
}

/** What a cursor is labelled: a first name, or a short name whole ("Guest 4F2A"). */
const firstName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) return "Guest"
  return trimmed.length <= 14 ? trimmed : trimmed.split(/\s+/)[0]
}

function Cursor({ peer, at, transition }: { peer: Collaborator; at: Vec2; transition: string }) {
  return (
    <div className="absolute left-0 top-0 will-change-transform" style={{ transform: `translate3d(${at.x}px, ${at.y}px, 0)`, transition }} data-peer-cursor={peer.name}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="-ml-px -mt-px drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.35)]">
        <path d="M2 1.5 L15.5 8.2 L9.2 9.6 L6.4 15.6 Z" fill={peer.color} stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <div
        className="absolute left-3.5 top-4 flex items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-[600] leading-[20px] text-white shadow-chip"
        style={{ backgroundColor: peer.color }}
      >
        {firstName(peer.name)}
        {peer.state.copilot && <Sparkles size={11} aria-label="Sakura is working" />}
        {peer.state.copilot && peer.state.copilotLabel && <span data-peer-activity>{peer.state.copilotLabel}</span>}
      </div>
    </div>
  )
}
