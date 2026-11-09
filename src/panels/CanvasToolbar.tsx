import { Ban, BetweenHorizontalStart, BoxSelect, BroomSparkles, Network, Circle, CircleDot, Eye, Hexagon, ImagePlus, LoaderCircle, MousePointer2, PaintBucket, Pentagon, PenLine, Pill, Route, Ruler, Slash, Spline, Square, SquareDashed, Tag, Type, Wand2, Waypoints } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { imageFacts } from "../lib/imageFacts"
import { addImage } from "../model/boardObjects"
import { putImageFile } from "../store/imageFiles"
import { DIMENSION_KINDS, DIMENSION_NAMES, DIMENSION_TOOL_KEY } from "../editor/pcb/boardObjectEditing"
import { uid } from "../lib/id"
import { autoroute } from "../model/autoroute"
import { decouplingSummary } from "../model/decoupling"
import { autoPlacePcb, repackCopper, repackPcb, unplacedParts } from "../model/ops"
import { worldShapes } from "../model/shapeItems"
import { worldTexts } from "../model/texts"
import { routeAroundStitching, stitchVias } from "../model/stitch"
import type { Project } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { heldNote, renewBoardNow, useBoardLease, withBoard } from "../store/boardLease"
import { projectApi, useProjectStore } from "../store/projectStore"
import { useUi, type LabelChoice, type LayerVisibility, type PcbTool, type SchTool, type ViaChoice } from "../store/uiStore"
import { useAt } from "../model/sheets"
import { shownPath } from "../store/sheetScope"
import { copperLayers, layerLabel } from "../model/stack"
import { copperColor } from "../editor/theme"
import { onTidy, onTidyBusy, startTidy } from "../editor/schematic/tidyAction"
import { PCB } from "../editor/theme"
import { shapeLayerColor } from "../editor/pcb/ShapeGraphics"
import { defaultDrawWidth, EDGE_CUTS_LAYER, DRAW_TOOL_KEYS, DRAW_TOOL_NAMES, drawLayerChoices, usedShapeLayers, type DrawTool } from "../editor/pcb/shapeEditing"
import { TEXT_TOOL_KEY } from "../editor/pcb/textEditing"
import { KEEPOUT_TOOL_KEY, PLACEMENT_TOOL_KEY, ZONE_TOOL_KEY } from "../editor/pcb/zoneEditing"
import { isWholeBoardPour } from "../model/zones"
import { IconButton, Segmented } from "../ui/controls"
import { ToolGroup, type ToolChoice } from "../ui/ToolGroup"
import { CleanupButton } from "./CleanupButton"
import { CopperLayerList } from "./CopperLayerList"

const shell = "pointer-events-auto flex items-center gap-0.5 rounded-[10px] border border-line bg-surface/95 p-1 shadow-float backdrop-blur"

/** Under a toolbar while another tab holds the board lease: who, and what they are doing. The whole-board buttons are off meanwhile. */
function BoardHeldNote({ note }: { note: string | null }) {
  if (!note) return null
  return (
    <div role="status" data-board-held className="pointer-events-auto rounded-[8px] border border-line bg-surface/95 px-2.5 py-1 text-[12px] text-ink-2 shadow-float">
      {note}
    </div>
  )
}

// The schematic's less used tools, a menu each: buses, sheets and shapes are drawn far less often than wires and labels.
const SCH_BUS_TOOLS: ToolChoice<SchTool>[] = [
  { value: "bus", label: "Bus", shortcut: "U", hint: "A line that carries several nets: name it with a label like D[0..7] or {A B}", icon: <Waypoints size={16} /> },
  { value: "busentry", label: "Bus entry", shortcut: "/", hint: "The short diagonal where a wire leaves a bus; the wire's label names the member it is", icon: <Slash size={16} /> },
]
const SCH_FRAME_TOOLS: ToolChoice<SchTool>[] = [
  { value: "block", label: "Block", shortcut: "B", hint: "Drag around parts to frame them as a named block", icon: <SquareDashed size={16} /> },
  { value: "sheet", label: "Sheet", hint: "Drag out a sheet: a rectangle that stands for another page of the schematic, opened by double-clicking it", icon: <Network size={16} /> },
  { value: "entry", label: "Sheet entry", hint: "Click the edge of a sheet symbol to add an entry, with its port inside the sheet", icon: <BetweenHorizontalStart size={16} /> },
]
const SCH_DRAW_TOOLS: ToolChoice<SchTool>[] = [
  { value: "line", label: "Line", shortcut: "P", hint: "Lines, arrows and polygons; click back on the first corner to close one", icon: <PenLine size={16} /> },
  { value: "rect", label: "Rectangle", shortcut: "⇧R", icon: <Square size={16} /> },
]

export function SchematicToolbar() {
  const tool = useUi((s) => s.schTool)
  const setTool = useUi((s) => s.setSchTool)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const oneBlock = useUi((s) => s.selection.filter((id) => id.startsWith("b:")).length === 1)
  const [status, setStatus] = useState<string | null>(null)
  const [tidying, setTidying] = useState(false)
  const held = useBoardLease(heldNote)

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
        <IconButton label="Wire" shortcut="W" disabled={viewer} active={tool === "wire"} onClick={() => setTool("wire")}>
          <Spline size={16} />
        </IconButton>
        <IconButton label="Label" shortcut="L" hint="A net label, a global label or a port: Tab switches" disabled={viewer} active={tool === "label"} onClick={() => setTool("label")}>
          <Tag size={16} />
        </IconButton>
        <ToolGroup label="Bus tools" active={tool} onPick={setTool} disabled={viewer} tools={SCH_BUS_TOOLS} />
        <span className="mx-1 h-5 w-px bg-line" />
        <ToolGroup label="Block and sheet tools" active={tool} onPick={setTool} disabled={viewer} tools={SCH_FRAME_TOOLS} />
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Text" shortcut="⇧T" disabled={viewer} hint="Titles, notes and callouts" active={tool === "text"} onClick={() => setTool("text")}>
          <Type size={16} />
        </IconButton>
        <ToolGroup label="Drawing tools" active={tool} onPick={setTool} disabled={viewer} tools={SCH_DRAW_TOOLS} />
        <span className="mx-1 h-5 w-px bg-line" />
        <IconButton label={oneBlock ? "Tidy this block" : "Tidy the schematic"} shortcut="T" hint={held ?? undefined} disabled={tidying || viewer || !!held} onClick={() => startTidy()}>
          {tidying ? <LoaderCircle size={16} className="animate-spin" /> : <BroomSparkles size={16} />}
        </IconButton>
        <CleanupButton />
      </div>
      {tool === "label" && !viewer && <LabelOptions />}
      <BoardHeldNote note={held} />
      {status && (
        <div role="status" className="pointer-events-auto rounded-[8px] border border-line bg-surface/95 px-2.5 py-1 text-[12px] text-ink-2 shadow-float">
          {status}
        </div>
      )}
    </div>
  )
}

/** What the label tool places: a net label, a global label or a port, which Main can't have (it has no sheet above). Tab cycles them. */
function LabelOptions() {
  const chosen = useUi((s) => s.labelKind)
  const setKind = useUi((s) => s.setLabelKind)
  const sheet = useUi((s) => s.sheet)
  const project = useProjectStore((s) => s.project)
  const onRoot = !project || useAt(project, shownPath(project, sheet)).parent === null
  const value: LabelChoice = chosen === "port" && onRoot ? "net" : chosen
  return (
    <div className={`${shell} gap-1.5 px-2`}>
      <span className="text-[12px] text-ink-2">Place a</span>
      <Segmented
        size="sm"
        value={value}
        onChange={setKind}
        options={[
          { value: "net", label: "Net label", title: "Joins the labels of its name on this sheet", shortcut: "Tab" },
          { value: "global", label: "Global label", title: "Joins the global labels of its name on every sheet", shortcut: "Tab" },
          { value: "port", label: "Port", title: onRoot ? "Main has no sheet above it: a port joins the entry of its name on the sheet symbol above" : "Joins the entry of its name on the sheet symbol above; the entry is added too", disabled: onRoot },
        ]}
      />
    </div>
  )
}

const LAYER_NAMES: [keyof LayerVisibility, string, string | null][] = [
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
  // Only the whole-board pours: a zone with a polygon, or a keepout, is drawn on purpose and stays.
  if (p.zones.some(isWholeBoardPour)) {
    projectApi().commit((x) => ({ ...x, zones: x.zones.filter((z) => !isWholeBoardPour(z)), vias: x.vias.filter((v) => !v.net), updatedAt: Date.now() }))
    return "Removed copper pours"
  }
  const net = groundNet(p)
  if (!net) return "Add a GND net in the schematic first"
  let added = 0
  projectApi().commit((x) => {
    const poured: Project = {
      ...x,
      zones: [
        ...x.zones,
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

/** Place the parts that aren't on the board yet, as `layout_pcb` does, leaving the placed ones where they are. */
function placeUnplaced(): string {
  const before = projectApi().project!
  const next = autoPlacePcb(before)
  if (next === before) return "Every part is on the board"
  projectApi().commit(() => next)
  const placed = unplacedParts(before).length - unplacedParts(next).length
  return `Placed ${placed} part${placed === 1 ? "" : "s"} on the board`
}

/**
 * Parts on the schematic and not on the board, which the PCB view doesn't draw: opening it places only those this tab added,
 * since someone else's (a collaborator's, or an assistant's over MCP placing them a call at a time) may be on their way. A
 * viewer is told, and can't place them.
 */
function UnplacedNote({ refs, viewer, held, onPlace }: { refs: string[]; viewer: boolean; held: string | null; onPlace: () => void }) {
  if (!refs.length) return null
  const shown = refs.length > 4 ? `${refs.slice(0, 3).join(", ")} and ${refs.length - 3} more` : refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}` : refs[0]
  return (
    <div role="status" data-unplaced className="pointer-events-auto flex items-center gap-2 rounded-[8px] border border-line bg-surface/95 py-1 pl-2.5 pr-1 text-[12px] text-ink-2 shadow-float">
      <span>
        {shown} {refs.length === 1 ? "isn't" : "aren't"} on the board yet
      </span>
      {!viewer && (
        <button
          className="rounded-[6px] px-2 py-0.5 font-medium text-ink hover:bg-chrome disabled:opacity-45"
          title={held ?? "Places them beside the parts they connect to, as Layout does; the parts on the board stay where they are"}
          disabled={!!held}
          onClick={onPlace}
        >
          {refs.length === 1 ? "Place it" : "Place them"}
        </button>
      )}
    </div>
  )
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

const DRAW_ICONS: Record<DrawTool, typeof Slash> = { line: Slash, arc: Spline, circle: Circle, rect: Square, polygon: Pentagon }
const DRAW_ORDER: DrawTool[] = ["line", "arc", "circle", "rect", "polygon"]

// The board's tools by what they make, a menu each: areas (copper, keepouts, placement), shapes (a slot is a shape cut through the board), and notes on it.
const PCB_ZONE_TOOLS: ToolChoice<PcbTool>[] = [
  { value: "zone", label: "Draw a copper zone", shortcut: ZONE_TOOL_KEY, hint: "Click the corners of a polygon on the layer shown, Enter to finish: copper poured there, in its own net, with its own settings", icon: <Hexagon size={16} /> },
  { value: "keepout", label: "Draw a keepout", shortcut: KEEPOUT_TOOL_KEY, hint: "Click the corners of an area that keeps tracks, vias and pours out; the Inspector says what it keeps out", icon: <Ban size={16} /> },
  { value: "placement", label: "Draw a placement area", shortcut: PLACEMENT_TOOL_KEY, hint: "Click the corners of an area where the parts of a sheet, a class or a group have to sit; the Inspector says whose", icon: <BoxSelect size={16} /> },
]
const PCB_DRAW_TOOLS: ToolChoice<PcbTool>[] = [
  ...DRAW_ORDER.map((t) => {
    const Icon = DRAW_ICONS[t]
    return { value: t, label: DRAW_TOOL_NAMES[t], shortcut: DRAW_TOOL_KEYS[t], icon: <Icon size={16} /> }
  }),
  { value: "slot", label: "Cut a slot", shortcut: "O", hint: "Click the two ends of a slot cut through the board; it is a cutout in the outline and goes in the drill file", icon: <Pill size={16} /> },
]
const PCB_NOTE_TOOLS: ToolChoice<PcbTool>[] = [
  { value: "text", label: "Add text", shortcut: TEXT_TOOL_KEY, icon: <Type size={16} /> },
  { value: "dimension", label: "Add dimension", shortcut: DIMENSION_TOOL_KEY, icon: <Ruler size={16} /> },
]

/** Which layer the drawing tools draw on, and how wide a stroke. */
function DrawOptions() {
  const layer = useUi((s) => s.drawLayer)
  const setLayer = useUi((s) => s.setDrawLayer)
  const width = useUi((s) => s.drawWidth)
  const setWidth = useUi((s) => s.setDrawWidth)
  const shown = width ?? defaultDrawWidth(layer)
  return (
    <div className={`${shell} gap-1.5 px-2`}>
      <span className="text-[12px] text-ink-2">Draw on</span>
      <select
        aria-label="Drawing layer"
        value={layer}
        onChange={(e) => setLayer(e.target.value)}
        className="h-7 max-w-[150px] rounded-[6px] border border-line bg-surface px-1 text-[12px] text-ink outline-none focus:border-select"
      >
        {drawLayerChoices().map((l) => (
          <option key={l.name} value={l.name}>
            {l.label}
          </option>
        ))}
      </select>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: shapeLayerColor(layer) }} aria-hidden />
      {layer === EDGE_CUTS_LAYER ? (
        <span className="max-w-[260px] text-[12px] text-ink-3">A closed shape inside the board is a cutout; one reaching outside a rectangle board replaces it</span>
      ) : null}
      <span className="text-[12px] text-ink-2">Width</span>
      <input
        type="number"
        aria-label="Stroke width in millimetres"
        min={0}
        step={0.05}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setWidth(Number.isFinite(v) && v >= 0 ? v : null)
        }}
        className="mono h-7 w-16 rounded-[6px] border border-line bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-select"
      />
      <span className="text-[12px] text-ink-3">mm</span>
    </div>
  )
}

/** How wide the slot tool cuts. */
function SlotOptions() {
  const width = useUi((s) => s.slotWidth)
  const setWidth = useUi((s) => s.setSlotWidth)
  return (
    <div className={`${shell} gap-1.5 px-2`}>
      <span className="text-[12px] text-ink-2">Slot width</span>
      <input
        type="number"
        aria-label="Slot width in millimetres"
        min={0.2}
        step={0.1}
        value={width}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v > 0) setWidth(v)
        }}
        className="mono h-7 w-16 rounded-[6px] border border-line bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-select"
      />
      <span className="text-[12px] text-ink-3">mm. Click both ends of the slot.</span>
    </div>
  )
}

/** Which layer the text tool puts a new text on. */
function TextOptions() {
  const layer = useUi((s) => s.drawLayer)
  const setLayer = useUi((s) => s.setDrawLayer)
  return (
    <div className={`${shell} gap-1.5 px-2`}>
      <span className="text-[12px] text-ink-2">Text on</span>
      <select
        aria-label="Text layer"
        value={layer}
        onChange={(e) => setLayer(e.target.value)}
        className="h-7 max-w-[150px] rounded-[6px] border border-line bg-surface px-1 text-[12px] text-ink outline-none focus:border-select"
      >
        {drawLayerChoices().map((l) => (
          <option key={l.name} value={l.name}>
            {l.label}
          </option>
        ))}
      </select>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: shapeLayerColor(layer) }} aria-hidden />
      <span className="text-[12px] text-ink-3">Click the board to place it</span>
    </div>
  )
}

/** The largest reference image the editor takes (bytes): a picture to trace over, not a scan to keep. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** What the dimension tool puts down, and on which layer. */
function DimensionOptions() {
  const kind = useUi((s) => s.dimensionKind)
  const setKind = useUi((s) => s.setDimensionKind)
  const layer = useUi((s) => s.drawLayer)
  const setLayer = useUi((s) => s.setDrawLayer)
  return (
    <div className={`${shell} gap-1.5 px-2`}>
      <span className="text-[12px] text-ink-2">Dimension</span>
      <select
        aria-label="Kind of dimension"
        value={kind}
        onChange={(e) => setKind(e.target.value as (typeof DIMENSION_KINDS)[number])}
        className="h-7 max-w-[130px] rounded-[6px] border border-line bg-surface px-1 text-[12px] text-ink outline-none focus:border-select"
      >
        {DIMENSION_KINDS.map((k) => (
          <option key={k} value={k}>
            {DIMENSION_NAMES[k]}
          </option>
        ))}
      </select>
      <span className="text-[12px] text-ink-2">on</span>
      <select
        aria-label="Dimension layer"
        value={layer}
        onChange={(e) => setLayer(e.target.value)}
        className="h-7 max-w-[150px] rounded-[6px] border border-line bg-surface px-1 text-[12px] text-ink outline-none focus:border-select"
      >
        {drawLayerChoices().map((l) => (
          <option key={l.name} value={l.name}>
            {l.label}
          </option>
        ))}
      </select>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: shapeLayerColor(layer) }} aria-hidden />
    </div>
  )
}

/** Puts a picture on the board as a reference image: its bytes go to the host's file store, the project holds their id. Resolves to a sentence for the user when it could not. */
export async function addReferenceImage(file: File): Promise<string | null> {
  if (file.size > MAX_IMAGE_BYTES) return `That picture is ${Math.round(file.size / 1024 / 1024)} MB, and a reference image can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
  let bytes: ArrayBuffer
  try {
    bytes = await file.arrayBuffer()
  } catch {
    return "The picture could not be read."
  }
  const facts = imageFacts(new Uint8Array(bytes))
  if (!facts.format) return "A reference image has to be a PNG or a JPEG."
  let id: string
  try {
    id = await putImageFile(file.name, bytes, projectApi().project?.id)
  } catch (e) {
    return e instanceof Error ? e.message : "The picture could not be kept."
  }
  const format = facts.format
  let made = ""
  projectApi().commit((p) => {
    const res = addImage(p, { x: p.board.x, y: p.board.y, layer: "Dwgs.User", scale: 1, file: id, format, px: facts.px, py: facts.py, ppi: facts.ppi })
    made = res.image.id
    return res.project
  })
  if (made) useUi.getState().select([`i:${made}`])
  return null
}

export function PcbToolbar() {
  const tool = useUi((s) => s.pcbTool)
  const setTool = useUi((s) => s.setPcbTool)
  const layer = useUi((s) => s.activeLayer)
  const setLayer = useUi((s) => s.setActiveLayer)
  const layers = useUi((s) => s.layers)
  const toggleLayer = useUi((s) => s.toggleLayer)
  const viaKind = useUi((s) => s.viaKind)
  const setViaKind = useUi((s) => s.setViaKind)
  const viaTo = useUi((s) => s.viaTo)
  const setViaTo = useUi((s) => s.setViaTo)
  const hiddenShapeLayers = useUi((s) => s.hiddenShapeLayers)
  const toggleShapeLayer = useUi((s) => s.toggleShapeLayer)
  const project = useProjectStore((s) => s.project)
  const drawingLayers = useMemo(() => (project ? usedShapeLayers(worldShapes(project), worldTexts(project).map((t) => t.layer)) : []), [project])
  const [showLayers, setShowLayers] = useState(false)
  const [pickLayer, setPickLayer] = useState(false)
  const stack = useMemo(() => (project ? copperLayers(project.board) : (["top", "bottom"] as const)), [project])
  const hasPours = useProjectStore((s) => (s.project?.zones.filter(isWholeBoardPour).length ?? 0) > 0)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const [routing, setRouting] = useState(false)
  const held = useBoardLease(heldNote)
  const [status, setStatus] = useState<string | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 4500)
    return () => clearTimeout(timer)
  }, [status])

  // Re-pack and Autoroute rewrite much of the board: one tab at a time (the board lease).
  const runAutoroute = () => {
    setRouting(true)
    void withBoard(
      "autoroute",
      () =>
        new Promise<void>((resolve) => {
          // Let the spinner paint before the router blocks the main thread.
          setTimeout(() => {
            try {
              renewBoardNow()
              const res = routeAroundStitching(projectApi().project!, (p) => autoroute(p))
              renewBoardNow()
              if (res.addedTraces || res.addedVias) projectApi().commit(() => res.project)
              if (!res.routed && !res.remaining) setStatus("Nothing left to route")
              else if (res.remaining) {
                const nets = [...new Set(res.open.map((o) => o.net))]
                setStatus(`Routed ${res.routed} connections; ${res.remaining} need routing by hand (${nets.slice(0, 3).join(", ")}${nets.length > 3 ? "…" : ""})`)
              }
              else setStatus(`Routed ${res.routed} connections with ${res.addedVias} vias`)
            } finally {
              setRouting(false)
              resolve()
            }
          }, 30)
        }),
    ).then((done) => {
      if (!done.ok) {
        setRouting(false)
        setStatus(done.message)
      }
    })
  }
  const runRepack = () => {
    void withBoard("repack", repack).then((done) => setStatus(done.ok ? done.value : done.message))
  }
  const unplaced = useMemo(() => (project ? unplacedParts(project).map((c) => c.ref) : []), [project])
  const runPlace = () => {
    void withBoard("layout_pcb", placeUnplaced).then((done) => setStatus(done.ok ? done.value : done.message))
  }

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-2">
      <div className="flex items-start gap-2">
        <div className={shell}>
          <IconButton label="Select and move" shortcut="S" active={tool === "select"} onClick={() => setTool("select")}>
            <MousePointer2 size={16} />
          </IconButton>
          <IconButton label="Route trace" shortcut="W" disabled={viewer} active={tool === "route"} onClick={() => setTool("route")}>
            <Route size={16} />
          </IconButton>
          <IconButton label="Place via" shortcut="V" disabled={viewer} active={tool === "via"} onClick={() => setTool("via")}>
            <CircleDot size={16} />
          </IconButton>
          <ToolGroup label="Zone tools" active={tool} onPick={setTool} disabled={viewer} tools={PCB_ZONE_TOOLS} />
          <span className="mx-1 h-5 w-px bg-line" />
          <ToolGroup label="Drawing tools" active={tool} onPick={setTool} disabled={viewer} tools={PCB_DRAW_TOOLS} />
          <ToolGroup
            label="Text and dimension tools"
            active={tool}
            onPick={setTool}
            disabled={viewer}
            tools={PCB_NOTE_TOOLS}
            actions={[{ label: "Add reference image", icon: <ImagePlus size={16} />, onClick: () => imageInput.current?.click() }]}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Reference image file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) void addReferenceImage(file).then((problem) => problem && setStatus(problem))
            }}
          />
          <span className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Re-pack parts" hint={held ?? "Lines up every part that isn't locked, decoupling capacitors beside their chips; clears unlocked traces and stitches pours again"} disabled={viewer || !!held} onClick={runRepack}>
            <Wand2 size={16} />
          </IconButton>
          <IconButton label="Autoroute" hint={held ?? "Draws traces for the connections that are still open"} disabled={routing || viewer || !!held} onClick={runAutoroute}>
            {routing ? <LoaderCircle size={16} className="animate-spin" /> : <Waypoints size={16} />}
          </IconButton>
          <IconButton label={hasPours ? "Remove copper pours" : "Pour ground"} hint={hasPours ? undefined : "Fills both layers with the ground net"} active={hasPours} disabled={viewer} onClick={() => setStatus(toggleGroundPour())}>
            <PaintBucket size={16} />
          </IconButton>
        </div>
        <div className={`${shell} gap-1.5 pl-2`}>
          <span className="text-[12px] text-ink-2">Layer</span>
          {stack.length <= 4 ? (
            <Segmented
              size="sm"
              value={layer}
              onChange={setLayer}
              options={stack.map((l) => ({
                value: l,
                label: (
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: copperColor(l) }} />
                    {project ? layerLabel(project.board, l) : l}
                  </span>
                ),
                title: `${project ? layerLabel(project.board, l) : l} copper`,
                shortcut: "L",
              }))}
            />
          ) : (
            <div className="relative">
              <button
                type="button"
                aria-label="Copper layer"
                aria-expanded={pickLayer}
                title="The copper layer tracks and zones are drawn on (L cycles)"
                onClick={() => setPickLayer(!pickLayer)}
                className="flex h-7 max-w-[160px] items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-line bg-surface px-2 text-[12.5px]"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: copperColor(layer) }} aria-hidden />
                <span className="min-w-0 truncate">{project ? layerLabel(project.board, layer) : layer}</span>
              </button>
              {pickLayer && project && (
                <div className="absolute left-0 top-9 z-10 w-[220px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-line bg-surface p-1.5 shadow-menu">
                  <CopperLayerList board={project.board} pick onPicked={() => setPickLayer(false)} />
                </div>
              )}
            </div>
          )}
          {stack.length > 2 && (
            <label className="flex items-center gap-1 text-[12px] text-ink-2" title="What V puts down while routing, and the via tool: a via through the board, a blind or buried one between two layers (told by which), or a micro via">
              Via
              <select aria-label="Via type" value={viaKind} onChange={(e) => setViaKind(e.target.value as ViaChoice)} className="h-7 rounded-[6px] border border-line bg-surface px-1.5 text-[12.5px]">
                <option value="through">Through</option>
                <option value="blind">Blind or buried</option>
                <option value="micro">Micro</option>
              </select>
              {viaKind !== "through" && (
                <select aria-label="Via goes to" value={viaTo ?? ""} onChange={(e) => setViaTo((e.target.value || null) as typeof layer | null)} className="h-7 rounded-[6px] border border-line bg-surface px-1.5 text-[12.5px]" title="The layer the via leads to from the layer being routed on">
                  <option value="">next layer</option>
                  {stack
                    .filter((l) => l !== layer)
                    .map((l) => (
                      <option key={l} value={l}>
                        to {project ? layerLabel(project.board, l) : l}
                      </option>
                    ))}
                </select>
              )}
            </label>
          )}
          <div className="relative">
            <IconButton label="Layers" hint="Choose which layers are drawn" active={showLayers} aria-expanded={showLayers} onClick={() => setShowLayers(!showLayers)}>
              <Eye size={16} />
            </IconButton>
            {showLayers && (
              <div className="absolute left-0 top-10 max-h-[70vh] w-[220px] max-w-[calc(100vw-24px)] overflow-y-auto overflow-x-hidden rounded-[10px] border border-line bg-surface p-1.5 shadow-menu">
                {project && <CopperLayerList board={project.board} />}
                <div className="mx-2 my-1 border-t border-line" />
                {LAYER_NAMES.map(([key, label, color], i) => (
                  <div key={key}>
                    {i > 0 && !color && LAYER_NAMES[i - 1][2] && <div className="mx-2 my-1 border-t border-line" />}
                    <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] hover:bg-chrome">
                      <input type="checkbox" checked={layers[key]} onChange={() => toggleLayer(key)} className="accent-select" />
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap">{label}</span>
                      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />}
                    </label>
                  </div>
                ))}
                {drawingLayers.length > 0 && (
                  <div className="mt-1 border-t border-line pt-1">
                    <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Drawings</div>
                    <div className="max-h-[240px] overflow-y-auto">
                      {drawingLayers.map((l) => (
                        <label key={l.name} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] hover:bg-chrome">
                          <input type="checkbox" checked={!hiddenShapeLayers[l.name]} onChange={() => toggleShapeLayer(l.name)} className="accent-select" />
                          <span className="min-w-0 flex-1 truncate whitespace-nowrap" title={l.label}>{l.label}</span>
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: shapeLayerColor(l.name) }} aria-hidden />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {DRAW_ORDER.includes(tool as DrawTool) && <DrawOptions />}
        {tool === "text" && <TextOptions />}
        {tool === "slot" && <SlotOptions />}
        {tool === "dimension" && <DimensionOptions />}
      </div>
      <BoardHeldNote note={held} />
      <UnplacedNote refs={unplaced} viewer={viewer} held={held} onPlace={runPlace} />
      {status && (
        <div role="status" className="pointer-events-auto rounded-[8px] border border-line bg-surface/95 px-2.5 py-1 text-[12px] text-ink-2 shadow-float">
          {status}
        </div>
      )}
    </div>
  )
}
