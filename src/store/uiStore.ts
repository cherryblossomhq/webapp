import { create } from "zustand"
import type { Box } from "../lib/geometry"
import { DEFAULT_TEXT_SIZE } from "../model/drawings"
import type { CopperLayer, DrawingStyle, DrawingText, Rotation } from "../model/types"
import { loadSettings, saveSettings, type Settings } from "./settings"

export type View = "schematic" | "pcb" | "3d"
/** The schematic's tools: editing, then the block tool, then the drawing tools. */
export type SchTool = "select" | "wire" | "label" | "block" | "text" | "line" | "rect"
export type PcbTool = "select" | "route" | "via"
export type SidePanel = "inspector" | "checks"

/** Properties and footprint a placed part starts with, e.g. from a "10k 0603" search. */
export interface PartPreset {
  props?: Record<string, string>
  footprint?: string
}

export interface Placing extends PartPreset {
  partId: string
  rot: Rotation
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
  schTool: SchTool
  pcbTool: PcbTool
  placing: Placing | null
  /** Selection ids are prefixed: c: component, w: wire, l: label, b: schematic block, d: drawing, t: trace, v: via */
  selection: string[]
  highlightNet: string | null
  activeLayer: CopperLayer
  layers: LayerVisibility
  sidePanel: SidePanel
  /** Parts library on the left and the inspector column on the right; closed by default in narrow windows. */
  libraryOpen: boolean
  panelOpen: boolean
  /** The copilot (Sakura), a column of its own between the parts library and the canvas. */
  copilotOpen: boolean
  /** The tree of the schematic's sheets, the leftmost column; it has nothing to show for a project of one sheet. */
  sheetsOpen: boolean
  /** Version history (`panels/HistoryPanel.tsx`), a column beside the sheet tree. Starts closed, and is not remembered. */
  historyOpen: boolean
  cursor: { x: number; y: number } | null
  /**
   * Where a view should go when it next draws: a point at the current zoom, or a box to frame with
   * room around it, or (`fit`) to fill the view exactly, as following a collaborator does.
   */
  focusRequest: { x: number; y: number; box?: Box; fit?: boolean; view: View; n: number } | null
  settings: Settings
  settingsOpen: boolean
  /** Inspector sections folded away, by id, for the session. */
  folded: Record<string, boolean>
  /** A line over the canvas saying why an edit was refused; `n` makes the same line show again. */
  notice: { text: string; n: number } | null
  showNotice: (text: string) => void
  clearNotice: () => void
  drawDefaults: DrawDefaults
  setView: (v: View) => void
  setSchTool: (t: SchTool) => void
  setPcbTool: (t: PcbTool) => void
  startPlacing: (partId: string, preset?: PartPreset) => void
  rotatePlacing: () => void
  stopPlacing: () => void
  select: (ids: string[]) => void
  toggleSelect: (id: string) => void
  clearSelection: () => void
  setHighlightNet: (id: string | null) => void
  setActiveLayer: (l: CopperLayer) => void
  toggleLayer: (l: keyof LayerVisibility) => void
  setSidePanel: (p: SidePanel) => void
  toggleLibrary: () => void
  togglePanel: () => void
  setCopilotOpen: (open: boolean) => void
  toggleCopilot: () => void
  toggleSheets: () => void
  toggleHistory: () => void
  setCursor: (c: { x: number; y: number } | null) => void
  focus: (view: View, x: number, y: number, box?: Box, fit?: boolean) => void
  updateSettings: (s: Partial<Settings>) => void
  setSettingsOpen: (open: boolean) => void
  toggleFolded: (id: string) => void
  setDrawDefaults: (kind: keyof DrawDefaults, patch: Partial<DrawDefaults["text"]>) => void
}

const wide = () => typeof window === "undefined" || window.innerWidth >= 1180

export const useUi = create<UiState>((set, get) => ({
  view: "schematic",
  schTool: "select",
  pcbTool: "select",
  placing: null,
  selection: [],
  highlightNet: null,
  activeLayer: "top",
  layers: { top: true, bottom: true, silk: true, ratsnest: true, courtyard: false, board: true, labels: true },
  sidePanel: "inspector",
  libraryOpen: wide(),
  panelOpen: wide(),
  copilotOpen: false,
  sheetsOpen: false,
  historyOpen: false,
  cursor: null,
  focusRequest: null,
  settings: loadSettings(),
  settingsOpen: false,
  folded: {},
  notice: null,
  drawDefaults: INITIAL_DRAW_DEFAULTS,

  showNotice: (text) => set({ notice: { text, n: (get().notice?.n ?? 0) + 1 } }),
  clearNotice: () => set({ notice: null }),
  // Selection doesn't carry across views; schematic wires and PCB traces are different objects.
  // Nor does a focus request, or a view opened later would go back to it instead of fitting.
  setView: (view) => set({ view, placing: null, highlightNet: null, ...(view !== get().view && { selection: [], focusRequest: null }) }),
  setSchTool: (schTool) => set({ schTool, placing: null }),
  setPcbTool: (pcbTool) => set({ pcbTool }),
  startPlacing: (partId, preset) => set({ placing: { partId, rot: 0, ...preset }, schTool: "select", view: "schematic", ...(get().view !== "schematic" && { selection: [] }) }),
  rotatePlacing: () => {
    const p = get().placing
    if (p) set({ placing: { ...p, rot: (((p.rot + 90) % 360) as Rotation) } })
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
  setSidePanel: (sidePanel) => set({ sidePanel, panelOpen: true }),
  toggleLibrary: () => set({ libraryOpen: !get().libraryOpen }),
  togglePanel: () => set({ panelOpen: !get().panelOpen }),
  setCopilotOpen: (copilotOpen) => set({ copilotOpen }),
  toggleCopilot: () => set({ copilotOpen: !get().copilotOpen }),
  toggleSheets: () => set({ sheetsOpen: !get().sheetsOpen }),
  toggleHistory: () => set({ historyOpen: !get().historyOpen }),
  setCursor: (cursor) => set({ cursor }),
  focus: (view, x, y, box, fit) =>
    set({ view, ...(view !== get().view && { selection: [] }), focusRequest: { view, x, y, box, ...(fit && { fit }), n: (get().focusRequest?.n ?? 0) + 1 } }),
  updateSettings: (s) => {
    const settings = { ...get().settings, ...s }
    saveSettings(settings)
    set({ settings })
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleFolded: (id) => set({ folded: { ...get().folded, [id]: !get().folded[id] } }),
  setDrawDefaults: (kind, patch) => {
    const d = get().drawDefaults
    set({ drawDefaults: { ...d, [kind]: { ...d[kind], ...patch } } })
  },
}))

export const uiApi = () => useUi.getState()

export const selectionIds = (selection: string[], prefix: "c" | "w" | "l" | "b" | "d" | "t" | "v") =>
  selection.filter((s) => s.startsWith(`${prefix}:`)).map((s) => s.slice(2))
