import { useEffect, useLayoutEffect, useRef } from "react"
import { mountingHoles } from "../../model/board"
import { findPart } from "../../model/library"
import { outlineGeometry } from "../../model/outline"
import { formatLength, type LengthUnit } from "../../model/rules"
import { worldShapes } from "../../model/shapeItems"
import { shapeLayerInfo } from "../../model/shapeLayers"
import { layerLabel } from "../../model/stack"
import { textShown, worldTexts } from "../../model/texts"
import type { Project, Vec2 } from "../../model/types"
import { zoneLayers } from "../../model/zones"
import type { ViewTransform } from "../viewport"
import type { Hit } from "./PcbEditor"

/** One line of the list a double click opens where several things are under the pointer: what it is, its name, and what tells it apart. */
export interface PickRow {
  /** The selection id picking it selects. */
  id: string
  kind: string
  name: string
  detail: string
}

export interface PickNames {
  /** The net of each track and via, by id (`PcbAnalysis`). */
  traceNet: Map<string, string | null>
  viaNet: Map<string, string | null>
  /** A net's name from its id. */
  netName: (id: string | null) => string | null
  unit: LengthUnit
}

const SHAPE_NAMES: Record<string, string> = { line: "Line", arc: "Arc", circle: "Circle", rect: "Rectangle", polygon: "Polygon", curve: "Curve", ellipse: "Ellipse" }

const layerName = (name: string) => shapeLayerInfo(name)?.label ?? name
const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ")
const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The rows for what is under the pointer (`hitsUnder`), in its order; `id` is what each selects. */
export function pickRows(p: Project, hits: { hit: Hit; id: string }[], names: PickNames): PickRow[] {
  const rows: PickRow[] = []
  const len = (mm: number, unit = false) => formatLength(mm, names.unit, unit)
  for (const { hit: h, id } of hits) {
    const row = describe(h)
    if (row) rows.push({ id, ...row })
  }
  return rows

  function describe(h: Hit): Omit<PickRow, "id"> | null {
    switch (h.type) {
      case "pad": {
        const c = p.components.find((x) => x.id === h.pad.componentId)
        if (!c) return null
        const pin = h.pad.pin ? findPart(c.partId)?.pins.find((x) => x.number === h.pad.pin)?.name : undefined
        const number = h.pad.padNumber ?? h.pad.pin ?? `${h.index + 1}`
        return { kind: "Pad", name: `${c.ref}.${number}`, detail: joined(pin && pin !== number ? clip(pin, 16) : null, names.netName(h.netId)) }
      }
      case "component": {
        const c = p.components.find((x) => x.id === h.id)
        return c ? { kind: "Part", name: c.ref, detail: clip(c.props.value || findPart(c.partId)?.name || "") } : null
      }
      case "trace": {
        const t = p.traces.find((x) => x.id === h.id)
        if (!t) return null
        return { kind: "Track", name: names.netName(names.traceNet.get(t.id) ?? null) ?? "No net", detail: joined(layerLabel(p.board, t.layer), len(t.width, true)) }
      }
      case "via": {
        const v = p.vias.find((x) => x.id === h.id)
        if (!v) return null
        return { kind: "Via", name: names.netName(names.viaNet.get(v.id) ?? null) ?? "No net", detail: `${len(v.diameter)} / ${len(v.drill, true)}` }
      }
      case "hole": {
        const hole = mountingHoles(p.board).find((x) => x.id === h.id)
        return { kind: "Hole", name: "Mounting holes", detail: hole ? `${len(hole.drill, true)} drill` : "" }
      }
      case "text": {
        const t = worldTexts(p).find((x) => x.id === h.id)
        if (!t) return null
        const shown = textShown(p, t.component ?? null, t.content, 0, undefined, t.layer).replace(/\s+/g, " ").trim()
        return { kind: "Text", name: clip(shown || t.content || "(empty)"), detail: joined(t.component?.ref, layerName(t.layer)) }
      }
      case "shape": {
        const s = worldShapes(p).find((x) => (x.select ?? x.id) === h.id)
        if (!s) return null
        if (s.dim) return { kind: "Dimension", name: "Dimension", detail: layerName(s.shape.layer) }
        return { kind: "Drawing", name: SHAPE_NAMES[s.shape.type] ?? "Drawing", detail: layerName(s.shape.layer) }
      }
      case "zone": {
        const z = p.zones.find((x) => x.id === h.id)
        if (!z) return null
        const kind = z.placement ? "Placement" : z.keepout ? "Keepout" : "Zone"
        return { kind, name: z.name || z.net || (z.keepout ? "Rule area" : "No net"), detail: zoneLayers(z).map((l) => layerLabel(p.board, l)).join(", ") }
      }
      case "outline": {
        const path = p.board.outline?.paths[h.path]
        if (!path) return null
        const cutout = outlineGeometry(p.board)?.rings.some((r) => r.path === h.path && r.hole)
        return { kind: "Outline", name: !path.closed ? "Open edge" : cutout ? "Cutout" : "Board edge", detail: "" }
      }
      case "image":
        return { kind: "Image", name: "Reference image", detail: "" }
      case "boardHandle":
        return null
    }
  }
}

/**
 * The list a double click opens where several things are under the pointer, as Altium's and KiCad's do: the one drawn on top first. Pointing at a
 * row (or moving to it with the arrows) shows it selected on the board (`onPreview`), a click or Enter picks it, Escape or a click elsewhere
 * closes the list. It stays at the point it was opened at while the view moves.
 */
export function PickMenu({ at, rows, t, onPreview, onPick, onClose }: { at: Vec2; rows: PickRow[]; t: ViewTransform; onPreview: (id: string | null) => void; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const x = at.x * t.scale + t.tx
  const y = -at.y * t.scale + t.ty

  // Beside the point, turned to the other side of it where the view's edge would cut it.
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.offsetParent
    if (!el || !box) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = x + 6 + w > box.clientWidth - 8 ? x - 6 - w : x + 6
    const top = y + 6 + h > box.clientHeight - 8 ? y - 6 - h : y + 6
    el.style.left = `${Math.max(8, left)}px`
    el.style.top = `${Math.max(8, top)}px`
  })

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus()
    // A press anywhere else closes it. One on the board does nothing else, as a click outside a menu doesn't: it does not get to the board.
    const board = ref.current?.closest("[data-pick-board]")
    const away = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
      if (board?.contains(e.target as Node)) e.stopPropagation()
    }
    document.addEventListener("pointerdown", away, true)
    return () => document.removeEventListener("pointerdown", away, true)
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Select one of the objects here"
      className="pointer-events-auto absolute z-30 min-w-[240px] max-w-[380px] animate-pop-in rounded-[9px] border border-white/10 bg-[#1f1d25]/95 p-1 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      style={{ left: x + 6, top: y + 6 }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => onPreview((document.activeElement as HTMLElement | null)?.dataset.pick ?? null)}
      // The list keeps its keys: the board's shortcuts (R, Delete...) would act on the selection behind it.
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") {
          e.preventDefault()
          onClose()
          return
        }
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")]
        const i = Math.max(items.indexOf(document.activeElement as HTMLElement), 0)
        const to = e.key === "ArrowDown" ? (i + 1) % items.length : e.key === "ArrowUp" ? (i + items.length - 1) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1
        if (to < 0) return
        e.preventDefault()
        items[to]?.focus()
      }}
    >
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          role="menuitem"
          data-pick={r.id}
          className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-white/85 outline-none focus:bg-white/10 focus:text-white"
          onMouseEnter={(e) => e.currentTarget.focus()}
          onFocus={() => onPreview(r.id)}
          onClick={() => onPick(r.id)}
        >
          <span className="w-[64px] shrink-0 text-white/45">{r.kind}</span>
          <span className="mono min-w-0 truncate font-medium">{r.name}</span>
          {r.detail && <span className="ml-auto shrink-0 pl-3 text-white/45">{r.detail}</span>}
        </button>
      ))}
    </div>
  )
}
