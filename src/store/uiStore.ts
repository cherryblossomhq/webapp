import { create } from "zustand"
import type { Box } from "../lib/geometry"
import { DEFAULT_TEXT_SIZE } from "../model/drawings"
import { composeOrientation } from "../model/ops"
import type { CopperLayer, DimensionKind, DrawingStyle, DrawingText, Mirror, Rotation } from "../model/types"
import { loadSettings, saveSettings, type Settings } from "./settings"

export type View = "schematic" | "pcb" | "3d"
/** The schematic's tools: editing, then the block tool, then the drawing tools. */
export type SchTool = "select" | "wire" | "label" | "block" | "text" | "line" | "rect" | "sheet" | "entry" | "bus" | "busentry"
/** What the label tool places: a net label, a global label or a port (a hierarchical label, which needs a sheet above). */
export type LabelChoice = "net" | "global" | "port"
const LABEL_CHOICES: LabelChoice[] = ["net", "global", "port"]
export type PcbTool = "select" | "route" | "via" | "line" | "arc" | "circle" | "rect" | "polygon" | "text" | "slot" | "dimension" | "zone" | "keepout" | "placement"
export type SidePanel = "inspector" | "checks"

/** Properties and footprint a placed part starts with, e.g. from a "10k 0603" search. */
export interface PartPreset {
  props?: Record<string, string>
  footprint?: string
}

export interface Placing extends PartPreset {
  partId: string
  rot: Rotation
  /** The mirror the part is held with (X and Y while placing). */
  mirror?: Mirror
}

/** Drag-and-drop from the library: the part id, and its preset as JSON beside it. */
export const PART_MIME = "application/x-cherryblossom-part"
export const PRESET_MIME = "application/x-cherryblossom-part-preset"

export function readPreset(data: DataTransfer): PartPreset {
  try {
    const raw = JSON.parse(data.getData(PRESET_MIME) || "{}") as PartPreset
    return { props: raw.props, footprint: raw.footprint }
  } catch {
    return {}
  }
}

/**
 * How new drawings look: the colours, line and border last given to a shape or a text in the
 * Inspector, so a sheet's notes and boxes come out alike without setting each one. A text's size
 * and face aren't kept: a title is one of a kind.
 */
export interface DrawDefaults {
  shape: DrawingStyle
  text: DrawingStyle & Pick<DrawingText, "size" | "border">
}

export const INITIAL_DRAW_DEFAULTS: DrawDefaults = { shape: {}, text: { size: DEFAULT_TEXT_SIZE } }

/** Whether a copper layer is shown: the outer two by `layers`, an inner one unless it is in `hiddenCopper`. */
export const copperShown = (s: { layers: LayerVisibility; hiddenCopper: Record<string, boolean> }, l: CopperLayer): boolean => (l === "top" || l === "bottom" ? s.layers[l] : !s.hiddenCopper[l])

/** What kind of via is placed: through, blind or buried (told by the layers), or micro. */
export type ViaChoice = "through" | "blind" | "micro"

export interface LayerVisibility {
  top: boolean
  bottom: boolean
  silk: boolean
  ratsnest: boolean
  courtyard: boolean
  board: boolean
  /** Pin names on pads and net names along traces. */
  labels: boolean
}

interface UiState {
  view: View
  /** S1: the use of a sheet the schematic shows, as a path of sheet symbols (`model/sheets.ts`); the root is "". */
  sheet: string
  schTool: SchTool
  /** What the label tool places, kept for the session; Tab cycles it. */
  labelKind: LabelChoice
  pcbTool: PcbTool
  placing: Placing | null
  /** Selection ids are prefixed: c: component, w: wire, l: label, b: schematic block, d: schematic drawing, t: trace, v: via, g: a drawing on the board, s: a drawing of a part's land (`s:<component id>:<index>`), m: a dimension, i: a reference image, h: a sheet symbol, e: a sheet entry (`e:<symbol id>:<pin id>`) */
  selection: string[]
  highlightNet: string | null
  activeLayer: CopperLayer
  layers: LayerVisibility
  /** X5: what a via the route or the via tool places is: through the board, blind or buried (by the layers it joins), or micro. */
  viaKind: ViaChoice
  /** The layer a via that is not a through via goes to from the layer being routed on; null is the layer next to it. */
  viaTo: CopperLayer | null
  /** Inner copper layers the user hid (`in1`, `in2`...); every inner layer is shown unless it is here. The outer two have `layers.top` and `layers.bottom`. */
  hiddenCopper: Record<string, boolean>
  /** Drawing layers the user hid, by KiCad's name (`F.Fab`, `User.3`); every other layer is shown. */
  hiddenShapeLayers: Record<string, boolean>
  /** The layer the drawing tools draw on (KiCad name), and their stroke width in mm; null is the usual width of the layer. */
  drawLayer: string
  drawWidth: number | null
  /** How wide the slot tool cuts (mm). */
  slotWidth: number
  /** The kind of dimension the dimension tool places. */
  dimensionKind: DimensionKind
  sidePanel: SidePanel
  /** Parts library on the left, closed by default (Sakura is the way in), and the inspector column on the right, closed by default in narrow windows. */
  libraryOpen: boolean
  panelOpen: boolean
  /** The copilot (Sakura), a column of its own between the parts library and the canvas; open by default except in narrow windows. */
  copilotOpen: boolean
  /** The copilot was opened by asking for it (its tab, ⌘L, a hand-off), so its composer takes the focus; open from the start, it leaves the focus to the canvas's shortcuts. */
  copilotAsked: boolean
  /** The menu of every sheet, over the left end of the sheet tabs (`panels/SheetMenu.tsx`); a project of one sheet has none. */
  sheetMenuOpen: boolean
  /** The use of a sheet whose tab is being renamed (a new sheet's starts so), or null. */
  renamingSheet: string | null
  /** Version history (`panels/HistoryPanel.tsx`), a column on the left. Starts closed, and is not remembered. */
  historyOpen: boolean
  cursor: { x: number; y: number } | null
  /**
   * Where a view should go when it next draws: a point at the current zoom, or a box to frame with
   * room around it, or (`fit`) to fill the view exactly, as following a collaborator does.
   */
  focusRequest: { x: number; y: number; box?: Box; fit?: boolean; view: View; n: number } | null
  settings: Settings
  /**
   * The project part open in the part editor (`panels/PartEditor.tsx`), by id, or null; `remove` opens it on the question whether to remove it.
   * Opening one stops placing a part: a save gives the part a new id, and the one in hand would be placed under the old.
   */
  partEditor: { id: string; remove?: true } | null
  /** Inspector sections folded away, by id, for the session. */
  folded: Record<string, boolean>
  /** A line over the canvas saying why an edit was refused, or (`info`) what an edit did besides; `n` makes the same line show again. */
  notice: { text: string; n: number; info?: true } | null
  showNotice: (text: string, tone?: "info") => void
  clearNotice: () => void
  drawDefaults: DrawDefaults
  setView: (v: View) => void
  /** Show another use of a sheet. The selection and what is being placed or drawn do not go with it. */
  setSheet: (path: string) => void
  setSchTool: (t: SchTool) => void
  setLabelKind: (k: LabelChoice) => void
  /** The next kind of label (the one before with `back`), past Port where there is no sheet above (`port` false). */
  cycleLabelKind: (back: boolean, port: boolean) => void
  setPcbTool: (t: PcbTool) => void
  startPlacing: (partId: string, preset?: PartPreset) => void
  rotatePlacing: () => void
  mirrorPlacing: (axis: Mirror) => void
  stopPlacing: () => void
  select: (ids: string[]) => void
  toggleSelect: (id: string) => void
  clearSelection: () => void
  setHighlightNet: (id: string | null) => void
  setActiveLayer: (l: CopperLayer) => void
  toggleLayer: (l: keyof LayerVisibility) => void
  setViaKind: (k: ViaChoice) => void
  setViaTo: (l: CopperLayer | null) => void
  /** Show or hide a copper layer of any place in the stack. */
  toggleCopper: (l: CopperLayer) => void
  toggleShapeLayer: (name: string) => void
  setDrawLayer: (name: string) => void
  setDrawWidth: (w: number | null) => void
  setSlotWidth: (width: number) => void
  setDimensionKind: (k: DimensionKind) => void
  setSidePanel: (p: SidePanel) => void
  toggleLibrary: () => void
  togglePanel: () => void
  setCopilotOpen: (open: boolean) => void
  toggleCopilot: () => void
  setSheetMenu: (open: boolean) => void
  setRenamingSheet: (path: string | null) => void
  toggleHistory: () => void
  setCursor: (c: { x: number; y: number } | null) => void
  focus: (view: View, x: number, y: number, box?: Box, fit?: boolean) => void
  updateSettings: (s: Partial<Settings>) => void
  openPartEditor: (partId: string | null, opts?: { remove?: boolean }) => void
  toggleFolded: (id: string) => void
  setDrawDefaults: (kind: keyof DrawDefaults, patch: Partial<DrawDefaults["text"]>) => void
}

const wide = () => typeof window === "undefined" || window.innerWidth >= 1180

export const useUi = create<UiState>((set, get) => ({
  view: "schematic",
  sheet: "",
  schTool: "select",
  labelKind: "net",
  pcbTool: "select",
  placing: null,
  selection: [],
  highlightNet: null,
  activeLayer: "top",
  layers: { top: true, bottom: true, silk: true, ratsnest: true, courtyard: false, board: true, labels: true },
  hiddenCopper: {},
  viaKind: "through",
  viaTo: null,
  hiddenShapeLayers: {},
  drawLayer: "F.SilkS",
  drawWidth: null,
  slotWidth: 2,
  dimensionKind: "aligned",
  sidePanel: "inspector",
  libraryOpen: false,
  panelOpen: wide(),
  copilotOpen: wide(),
  copilotAsked: false,
  sheetMenuOpen: false,
  renamingSheet: null,
  historyOpen: false,
  cursor: null,
  focusRequest: null,
  settings: loadSettings(),
  partEditor: null,
  folded: {},
  notice: null,
  drawDefaults: INITIAL_DRAW_DEFAULTS,

  showNotice: (text, tone) => set({ notice: { text, n: (get().notice?.n ?? 0) + 1, ...(tone === "info" && { info: true as const }) } }),
  clearNotice: () => set({ notice: null }),
  // Selection doesn't carry across views; schematic wires and PCB traces are different objects.
  // Nor does a focus request, or a view opened later would go back to it instead of fitting.
  setView: (view) => set({ view, placing: null, highlightNet: null, ...(view !== get().view && { selection: [], focusRequest: null }) }),
  setSheet: (sheet) => set(sheet === get().sheet ? {} : { sheet, selection: [], highlightNet: null, placing: null, focusRequest: null }),
  setSchTool: (schTool) => set({ schTool, placing: null }),
  setLabelKind: (labelKind) => set({ labelKind }),
  cycleLabelKind: (back, port) => {
    const choices = port ? LABEL_CHOICES : LABEL_CHOICES.filter((k) => k !== "port")
    const at = choices.indexOf(get().labelKind)
    set({ labelKind: choices[(Math.max(at, 0) + (back ? choices.length - 1 : 1)) % choices.length] })
  },
  setPcbTool: (pcbTool) => set({ pcbTool }),
  startPlacing: (partId, preset) => set({ placing: { partId, rot: 0, ...preset }, schTool: "select", view: "schematic", ...(get().view !== "schematic" && { selection: [] }) }),
  rotatePlacing: () => {
    const p = get().placing
    if (!p) return
    // A mirrored part's own turn runs the other way: a quarter turn on screen is a step back in its placement.
    set({ placing: { ...p, rot: composeOrientation({ rot: p.rot, mirror: p.mirror }, { kind: "turn", by: 90 }).rot } })
  },
  mirrorPlacing: (axis) => {
    const p = get().placing
    if (!p) return
    // Mirroring one way and then the other is a half turn: the placement's own turn and mirror compose as the sheet's do.
    const next = composeOrientation({ rot: p.rot, mirror: p.mirror }, { kind: "mirror", axis })
    set({ placing: { ...p, rot: next.rot, mirror: next.mirror } })
  },
  stopPlacing: () => set({ placing: null }),
  select: (selection) => set({ selection }),
  toggleSelect: (id) => {
    const s = get().selection
    set({ selection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] })
  },
  clearSelection: () => set({ selection: [] }),
  setHighlightNet: (highlightNet) => set({ highlightNet }),
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  toggleLayer: (l) => set({ layers: { ...get().layers, [l]: !get().layers[l] } }),
  setViaKind: (viaKind) => set({ viaKind }),
  setViaTo: (viaTo) => set({ viaTo }),
  toggleCopper: (l) => (l === "top" || l === "bottom" ? set({ layers: { ...get().layers, [l]: !get().layers[l] } }) : set({ hiddenCopper: { ...get().hiddenCopper, [l]: !get().hiddenCopper[l] } })),
  toggleShapeLayer: (name) => set({ hiddenShapeLayers: { ...get().hiddenShapeLayers, [name]: !get().hiddenShapeLayers[name] } }),
  setDrawLayer: (drawLayer) => set({ drawLayer, drawWidth: null }),
  setDrawWidth: (drawWidth) => set({ drawWidth }),
  setSlotWidth: (slotWidth) => set({ slotWidth }),
  setDimensionKind: (dimensionKind) => set({ dimensionKind }),
  setSidePanel: (sidePanel) => set({ sidePanel, panelOpen: true }),
  toggleLibrary: () => set({ libraryOpen: !get().libraryOpen }),
  togglePanel: () => set({ panelOpen: !get().panelOpen }),
  setCopilotOpen: (copilotOpen) => set({ copilotOpen, ...(copilotOpen && { copilotAsked: true }) }),
  toggleCopilot: () => set({ copilotOpen: !get().copilotOpen, copilotAsked: true }),
  setSheetMenu: (sheetMenuOpen) => set({ sheetMenuOpen }),
  setRenamingSheet: (renamingSheet) => set({ renamingSheet }),
  toggleHistory: () => set({ historyOpen: !get().historyOpen }),
  setCursor: (cursor) => set({ cursor }),
  focus: (view, x, y, box, fit) =>
    set({ view, ...(view !== get().view && { selection: [] }), focusRequest: { view, x, y, box, ...(fit && { fit }), n: (get().focusRequest?.n ?? 0) + 1 } }),
  updateSettings: (s) => {
    const settings = { ...get().settings, ...s }
    saveSettings(settings)
    set({ settings })
  },
  openPartEditor: (id, opts) => set(id ? { partEditor: { id, ...(opts?.remove && { remove: true as const }) }, placing: null } : { partEditor: null }),
  toggleFolded: (id) => set({ folded: { ...get().folded, [id]: !get().folded[id] } }),
  setDrawDefaults: (kind, patch) => {
    const d = get().drawDefaults
    set({ drawDefaults: { ...d, [kind]: { ...d[kind], ...patch } } })
  },
}))

export const uiApi = () => useUi.getState()

export const selectionIds = (selection: string[], prefix: "c" | "w" | "l" | "b" | "d" | "t" | "v" | "g" | "m" | "i" | "z" | "h" | "e") =>
  selection.filter((s) => s.startsWith(`${prefix}:`)).map((s) => s.slice(2))
