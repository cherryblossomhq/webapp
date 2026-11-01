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

/** Preferences for this browser. Projects are not here: see `storage.ts`. */
const SETTINGS_KEY = "cherryblossom:editor:settings"

export interface Settings {
  /** Copilot model chosen from the plan's models; the plan's strongest when null or no longer allowed. */
  model: string | null
  /** Unit lengths are shown and typed in across the Inspector; documents always store millimetres. */
  units: LengthUnit
  /** How the dashboard lists the projects: cards with a board preview, or rows. */
  projectsView: "grid" | "list"
}

export const DEFAULT_SETTINGS: Settings = { model: null, units: "mm", projectsView: "grid" }

export function loadSettings(): Settings {
  const stored = read<Record<string, unknown>>(SETTINGS_KEY)
  const settings: Settings = {
    model: typeof stored?.model === "string" ? stored.model : null,
    units: stored?.units === "mil" ? "mil" : "mm",
    projectsView: stored?.projectsView === "list" ? "list" : "grid",
  }
  // The copilot used to take an Anthropic key pasted in here; don't leave one sitting in storage.
  if (stored && "anthropicApiKey" in stored) saveSettings(settings)
  return settings
}

export function saveSettings(s: Settings) {
  write(SETTINGS_KEY, s)
}
