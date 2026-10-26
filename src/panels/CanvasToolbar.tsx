import { BroomSparkles, CircleDot, Eye, LoaderCircle, MousePointer2, PaintBucket, PenLine, Route, Spline, Square, SquareDashed, Tag, Type, Wand2, Waypoints } from "lucide-react"
import { useEffect, useState } from "react"
import { uid } from "../lib/id"
import { autoroute } from "../model/autoroute"
import { decouplingSummary } from "../model/decoupling"
import { repackCopper, repackPcb } from "../model/ops"
import { routeAroundStitching, stitchVias } from "../model/stitch"
import type { Project } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { projectApi, useProjectStore } from "../store/projectStore"
import { useUi, type LayerVisibility } from "../store/uiStore"
import { onTidy, onTidyBusy, startTidy } from "../editor/schematic/tidyAction"
import { PCB } from "../editor/theme"
import { IconButton, Segmented } from "../ui/controls"
import { CleanupButton } from "./CleanupButton"

const shell = "pointer-events-auto flex items-center gap-0.5 rounded-[10px] border border-line bg-surface/95 p-1 shadow-float backdrop-blur"

export function SchematicToolbar() {
  const tool = useUi((s) => s.schTool)
  const setTool = useUi((s) => s.setSchTool)
  const oneBlock = useUi((s) => s.selection.filter((id) => id.startsWith("b:")).length === 1)
  const [status, setStatus] = useState<string | null>(null)
  const [tidying, setTidying] = useState(false)

  // Tidy says what it did, whether from here or from the T key, and that it is working meanwhile.
  useEffect(() => onTidy((r) => setStatus(r.problems.length ? `${r.message} ${r.problems[0]}` : r.message)), [])
  useEffect(
    () =>
      onTidyBusy((b) => {
        setTidying(b)
        if (b) setStatus("Tidying...")
      }),
    [],
  )
  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 4500)
    return () => clearTimeout(timer)
  }, [status])

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
      <div className={shell}>
        <IconButton label="Select" shortcut="V" active={tool === "select"} onClick={() => setTool("select")}>
          <MousePointer2 size={16} />
        </IconButton>
        <IconButton label="Wire" shortcut="W" active={tool === "wire"} onClick={() => setTool("wire")}>
          <Spline size={16} />
        </IconButton>
        <IconButton label="Net label" shortcut="L" active={tool === "label"} onClick={() => setTool("label")}>
          <Tag size={16} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Block" shortcut="B" hint="Drag around parts to frame them as a named block" active={tool === "block"} onClick={() => setTool("block")}>
          <SquareDashed size={16} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Text" shortcut="⇧T" hint="Titles, notes and callouts" active={tool === "text"} onClick={() => setTool("text")}>
          <Type size={16} />
        </IconButton>
        <IconButton label="Line" shortcut="P" hint="Lines, arrows and polygons; click back on the first corner to close one" active={tool === "line"} onClick={() => setTool("line")}>
          <PenLine size={16} />
        </IconButton>
        <IconButton label="Rectangle" shortcut="⇧R" active={tool === "rect"} onClick={() => setTool("rect")}>
          <Square size={16} />
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label={oneBlock ? "Tidy this block" : "Tidy the schematic"} shortcut="T" disabled={tidying} onClick={() => startTidy()}>
          {tidying ? <LoaderCircle size={16} className="animate-spin" /> : <BroomSparkles size={16} />}
        </IconButton>
        <span className="mx-1 h-5 w-px bg-line" />
        <CleanupButton />
      </div>
      {status && (
        <div role="status" className="pointer-events-auto rounded-[8px] border border-line bg-surface/95 px-2.5 py-1 text-[12px] text-ink-2 shadow-float">
          {status}
        </div>
      )}
    </div>
  )
}

const LAYER_NAMES: [keyof LayerVisibility, string, string | null][] = [
  ["top", "Top copper", PCB.topCopper],
  ["bottom", "Bottom copper", PCB.bottomCopper],
  ["silk", "Silkscreen", PCB.silk],
  ["courtyard", "Courtyards", PCB.courtyard],
  ["board", "Board edge", PCB.edge],
  ["ratsnest", "Ratsnest", null],
  ["labels", "Pin and net labels", null],
]

const GROUND_NAMES = ["GND", "GROUND", "VSS", "0V"]

function groundNet(p: Project): string | null {
  const names = getConnectivity(p).nets.filter((n) => n.pins.length > 0).map((n) => n.name)
  return GROUND_NAMES.find((g) => names.includes(g)) ?? null
}

/**
 * Add ground pours on both layers tied together with stitching vias, or remove every pour
 * and its stitching when there already are some.
 */
function toggleGroundPour(): string {
  const p = projectApi().project!
  if (p.zones.length) {
    projectApi().commit((x) => ({ ...x, zones: [], vias: x.vias.filter((v) => !v.net), updatedAt: Date.now() }))
    return "Removed copper pours"
  }
  const net = groundNet(p)
  if (!net) return "Add a GND net in the schematic first"
  let added = 0
  projectApi().commit((x) => {
    const poured: Project = {
      ...x,
      zones: [
        { id: uid("z"), net, layer: "top" },
        { id: uid("z"), net, layer: "bottom" },
      ],
    }
    const res = stitchVias(poured, net)
    added = res.added
    return res.project
  })
  return added ? `Poured ${net} on both layers with ${added} stitching vias` : `Poured ${net} on both layers`
}

/** Re-pack every part that isn't locked, decoupling capacitors beside their chips. */
function repack(): string {
  const before = projectApi().project!
  const next = repackPcb(before)
  if (next === before) return "Every part is locked or held by locked traces"
  projectApi().commit(() => next)
  const old = new Map(before.components.map((c) => [c.id, c.pcb]))
  const caps = decouplingSummary(next, new Set(next.components.filter((c) => c.pcb !== old.get(c.id)).map((c) => c.id)))
  const copper = repackCopper(before, next)
  return [
    copper.traces || copper.vias ? "Re-packed the board and cleared its unlocked traces" : "Re-packed the board",
    copper.stitchedBefore || copper.stitchedAfter ? `stitching vias redone (${copper.stitchedBefore} before, ${copper.stitchedAfter} now)` : "",
    caps.total ? `${caps.near} of ${caps.total} decoupling capacitors beside their pins` : "",
  ]
    .filter(Boolean)
    .join("; ")
}

export function PcbToolbar() {
  const tool = useUi((s) => s.pcbTool)
  const setTool = useUi((s) => s.setPcbTool)
  const layer = useUi((s) => s.activeLayer)
  const setLayer = useUi((s) => s.setActiveLayer)
  const layers = useUi((s) => s.layers)
  const toggleLayer = useUi((s) => s.toggleLayer)
  const [showLayers, setShowLayers] = useState(false)
  const hasPours = useProjectStore((s) => (s.project?.zones.length ?? 0) > 0)
  const [routing, setRouting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 4500)
    return () => clearTimeout(timer)
  }, [status])

  const runAutoroute = () => {
    setRouting(true)
    // Let the spinner paint before the router blocks the main thread.
    setTimeout(() => {
      const res = routeAroundStitching(projectApi().project!, (p) => autoroute(p))
      if (res.addedTraces || res.addedVias) projectApi().commit(() => res.project)
      setRouting(false)
      const outer = copperLayers(res.project.board).length > 2 ? " (outer layers only)" : ""
      if (!res.routed && !res.remaining) setStatus("Nothing left to route")
      else if (res.remaining) setStatus(`Routed ${res.routed} connections${outer}; ${res.remaining} need routing by hand`)
      else setStatus(`Routed ${res.routed} connections with ${res.addedVias} vias${outer}`)
    }, 30)
  }

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
      <div className="flex items-start gap-2">
        <div className={shell}>
          <IconButton label="Select and move" shortcut="S" active={tool === "select"} onClick={() => setTool("select")}>
            <MousePointer2 size={16} />
          </IconButton>
          <IconButton label="Route trace" shortcut="X" active={tool === "route"} onClick={() => setTool("route")}>
            <Route size={16} />
          </IconButton>
          <IconButton label="Place via" shortcut="V" active={tool === "via"} onClick={() => setTool("via")}>
            <CircleDot size={16} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Re-pack parts" hint="Lines up every part that isn't locked, decoupling capacitors beside their chips; clears unlocked traces and stitches pours again" onClick={() => setStatus(repack())}>
            <Wand2 size={16} />
          </IconButton>
          <IconButton label="Autoroute" hint="Draws traces for the connections that are still open" disabled={routing} onClick={runAutoroute}>
            {routing ? <LoaderCircle size={16} className="animate-spin" /> : <Waypoints size={16} />}
          </IconButton>
          <IconButton label={hasPours ? "Remove copper pours" : "Pour ground"} hint={hasPours ? undefined : "Fills both layers with the ground net"} active={hasPours} onClick={() => setStatus(toggleGroundPour())}>
            <PaintBucket size={16} />
          </IconButton>
        </div>
        <div className={`${shell} gap-1.5 pl-2`}>
          <span className="text-[12px] text-ink-2">Layer</span>
          <Segmented
            size="sm"
            value={layer}
            onChange={setLayer}
            options={[
              { value: "top", label: <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-top" />Top</span>, title: "Top copper", shortcut: "L" },
              { value: "bottom", label: <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-bottom" />Bottom</span>, title: "Bottom copper", shortcut: "L" },
            ]}
          />
          <div className="relative">
            <IconButton label="Layers" hint="Choose which layers are drawn" active={showLayers} aria-expanded={showLayers} onClick={() => setShowLayers(!showLayers)}>
              <Eye size={16} />
            </IconButton>
            {showLayers && (
              <div className="absolute left-0 top-10 w-[200px] rounded-[10px] border border-line bg-surface p-1.5 shadow-menu">
                {LAYER_NAMES.map(([key, label, color], i) => (
                  <div key={key}>
                    {i > 0 && !color && LAYER_NAMES[i - 1][2] && <div className="mx-2 my-1 border-t border-line" />}
                    <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] hover:bg-chrome">
                      <input type="checkbox" checked={layers[key]} onChange={() => toggleLayer(key)} className="accent-select" />
                      <span className="flex-1">{label}</span>
                      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />}
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {status && (
        <div role="status" className="pointer-events-auto rounded-[8px] border border-line bg-surface/95 px-2.5 py-1 text-[12px] text-ink-2 shadow-float">
          {status}
        </div>
      )}
    </div>
  )
}
