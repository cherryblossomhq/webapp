// Marking text for component models.

import { parseValue } from "../../../lib/values"

/** EIA 3-digit resistor code: 10k -> "103", 470 -> "471", 4.7 -> "4R7". */
export function resistorCode(raw: string | undefined): string | null {
  const ohms = parseValue(raw)
  if (ohms === null || ohms <= 0) return null
  if (ohms < 10) return ohms.toFixed(1).replace(".", "R")
  const exp = Math.floor(Math.log10(ohms)) - 1
  const digits = Math.round(ohms / 10 ** exp)
  if (digits >= 100) return `${String(digits).slice(0, 2)}${exp + 1}`
  return `${String(digits).padStart(2, "0")}${exp}`
}

const BAND = ["#1b1b1b", "#6e3b1c", "#c4261d", "#e46a14", "#f0c419", "#2f8a3d", "#2457b8", "#7a3fb2", "#8a8a8a", "#f1f1ee"]
export const GOLD_BAND = "#c49a3a"

/** Four colour bands (two digits, multiplier, gold tolerance) for an axial resistor. */
export function resistorBands(raw: string | undefined): string[] {
  const ohms = parseValue(raw) ?? 10_000
  const exp = Math.max(-2, Math.floor(Math.log10(Math.max(ohms, 0.1))) - 1)
  const digits = Math.min(99, Math.max(10, Math.round(ohms / 10 ** exp)))
  const mult = exp >= 0 ? BAND[Math.min(9, exp)] : GOLD_BAND
  return [BAND[Math.floor(digits / 10)], BAND[digits % 10], mult, GOLD_BAND]
}

const SOT_CODES: Record<string, string> = {
  MMBT3904: "1AM",
  MMBT3906: "2A",
  "2N7002": "702",
  AO3401: "A19T",
  AO3400: "A09T",
  BSS138: "SS",
  "1N4148W": "T4",
  SS34: "SS34",
  B5819W: "SL",
}

/** Short package code for small parts, falling back to a truncated MPN. */
export function shortCode(mpn: string | undefined, max = 4): string {
  const m = (mpn ?? "").trim().toUpperCase()
  if (!m) return ""
  return SOT_CODES[m] ?? m.replace(/[^A-Z0-9]/g, "").slice(0, max)
}

/** Top-line IC marking: MPN without packaging suffixes. */
export function icName(mpn: string | undefined): string {
  const m = (mpn ?? "").trim().toUpperCase()
  return m.replace(/-(AU|PU|MU|AUR|MMR)$/, "").replace(/(DR|DT|PWR|DBVR)$/, "").slice(0, 12)
}

/** "16MHz" -> "16.000". */
export function crystalText(raw: string | undefined): string {
  const hz = parseValue(raw?.replace(/hz$/i, ""))
  if (hz === null) return raw ?? ""
  const mhz = hz >= 1e5 ? hz / 1e6 : hz
  return mhz.toFixed(3)
}

export const LED_COLORS: Record<string, string> = {
  red: "#ff2b1f",
  green: "#25d84d",
  blue: "#2f6bff",
  yellow: "#ffd21a",
  white: "#f4f6ff",
  orange: "#ff7a12",
  amber: "#ffae00",
  pink: "#ff4fa0",
  purple: "#9b4dff",
}
