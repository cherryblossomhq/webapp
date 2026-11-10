import type { LengthUnit } from "../model/rules"

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable; the settings last for this visit
  }
}

/** How the PCB view draws the copper layers other than the one worked on: in their colours, dimmed toward grey, or not at all (KiCad's inactive layer modes, Altium's single layer mode). */
export type OtherLayers = "show" | "dim" | "hide"
export const OTHER_LAYERS: OtherLayers[] = ["show", "dim", "hide"]

/** How the PCB view draws pours: filled, as the edge of their copper alone (KiCad's zone outlines), or not at all. What is checked and exported is the same. */
export type PourLook = "filled" | "outline" | "hidden"
export const POUR_LOOKS: PourLook[] = ["filled", "outline", "hidden"]

/** Preferences for this browser. Projects are not here: see `storage.ts`. */
const SETTINGS_KEY = "cherryblossom:editor:settings"

export interface Settings {
  /** Copilot model chosen from the plan's models; the plan's strongest when null or no longer allowed. */
  model: string | null
  /** Unit lengths are shown and typed in across the Inspector; documents always store millimetres. */
  units: LengthUnit
  /** How the dashboard lists the projects: cards with a board preview, or rows. */
  projectsView: "grid" | "list"
  /** Width of Sakura's panel in pixels, as its right edge was last dragged to. */
  copilotWidth: number
  /** The PCB view's other copper layers (`⇧S` goes through them). */
  otherLayers: OtherLayers
  pours: PourLook
}

/** How wide Sakura's panel can be dragged, and how wide it starts. */
export const COPILOT_WIDTH = { min: 280, max: 800, initial: 368 }

export const clampCopilotWidth = (w: number) => Math.round(Math.min(COPILOT_WIDTH.max, Math.max(COPILOT_WIDTH.min, w)))

export const DEFAULT_SETTINGS: Settings = { model: null, units: "mm", projectsView: "grid", copilotWidth: COPILOT_WIDTH.initial, otherLayers: "show", pours: "filled" }

const oneOf = <T extends string>(v: unknown, of: T[], fallback: T): T => (of.includes(v as T) ? (v as T) : fallback)

export function loadSettings(): Settings {
  const stored = read<Record<string, unknown>>(SETTINGS_KEY)
  const settings: Settings = {
    model: typeof stored?.model === "string" ? stored.model : null,
    units: stored?.units === "mil" ? "mil" : "mm",
    projectsView: stored?.projectsView === "list" ? "list" : "grid",
    copilotWidth: typeof stored?.copilotWidth === "number" && Number.isFinite(stored.copilotWidth) ? clampCopilotWidth(stored.copilotWidth) : COPILOT_WIDTH.initial,
    otherLayers: oneOf(stored?.otherLayers, OTHER_LAYERS, DEFAULT_SETTINGS.otherLayers),
    pours: oneOf(stored?.pours, POUR_LOOKS, DEFAULT_SETTINGS.pours),
  }
  // The copilot used to take an Anthropic key pasted in here; don't leave one sitting in storage.
  if (stored && "anthropicApiKey" in stored) saveSettings(settings)
  return settings
}

export function saveSettings(s: Settings) {
  write(SETTINGS_KEY, s)
}
