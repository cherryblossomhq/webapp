import { registerProjectFootprints } from "./footprints"
import type { FootprintDef, PadDef, Project, ZoneConnect } from "./types"

// Edits of a pad of a part's own land (an imported footprint's, `Project.footprints`). As with the land's drawings, the land is the part's, not the
// instance's: every part drawn with it changes with it. The fields are the ones a pad can override for itself (X7): the margins of its solder mask
// opening and paste aperture, its clearance, and how a pour joins it; an absent field is the board's.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export interface PadPatch {
  maskMargin?: number | null
  pasteMargin?: number | null
  pasteRatio?: number | null
  clearance?: number | null
  zoneConnect?: ZoneConnect | null
  thermalGap?: number | null
  thermalWidth?: number | null
  thermalAngle?: number | null
}

const NUMBERS = ["maskMargin", "pasteMargin", "pasteRatio", "clearance", "thermalGap", "thermalWidth", "thermalAngle"] as const
const ZONES = new Set<string>(["none", "thermal", "solid", "tht"])

/** The pad with the patch applied: a `null` clears the field, a number that is not finite changes nothing. */
export function patchPad(pad: PadDef, patch: PadPatch): PadDef {
  const next: Record<string, unknown> = { ...pad }
  for (const k of NUMBERS) {
    const v = patch[k]
    if (v === undefined) continue
    if (v === null) delete next[k]
    else if (Number.isFinite(v)) next[k] = v
  }
  if (patch.zoneConnect !== undefined) {
    if (patch.zoneConnect === null) delete next.zoneConnect
    else if (ZONES.has(patch.zoneConnect)) next.zoneConnect = patch.zoneConnect
  }
  return next as unknown as PadDef
}

/** The land's pad at `index` patched; the project is returned as it is when the land is not the project's own, has no such pad, or the patch changes nothing. */
export function updateLandPad(project: Project, land: string, index: number, patch: PadPatch): Project {
  const def = project.footprints?.find((f) => f.name === land)
  const pad = def?.pads[index]
  if (!def || !pad) return project
  const changed = patchPad(pad, patch)
  if (JSON.stringify(changed) === JSON.stringify(pad)) return project
  const next: FootprintDef = { ...def, pads: def.pads.map((p, i) => (i === index ? changed : p)) }
  registerProjectFootprints({ footprints: [next] })
  return touch({ ...project, footprints: project.footprints!.map((f) => (f.name === land ? next : f)) })
}

/** A pad in a few words, for a list: its number, its shape and size, and what is special about it. */
export function padSummary(pad: PadDef): string {
  const number = pad.number !== undefined ? (pad.number === "" ? "(no number)" : pad.number) : (pad.pin ?? "(no number)")
  const size = `${round(pad.width)} x ${round(pad.height)}`
  const shape = pad.custom ? "custom" : pad.shape === "polygon" ? "polygon" : pad.chamfer ? "chamfered" : pad.round ? `rounded ${Math.round(pad.round * 1000) / 10}%` : pad.shape === "pill" ? "oval" : pad.shape
  const hole = pad.holeDiameter !== undefined ? `, ${pad.slotLength ? `slot ${round(pad.holeDiameter)} x ${round(pad.slotLength)}` : `drill ${round(pad.holeDiameter)}`}${pad.plated === false ? " (not plated)" : ""}${pad.holeOffset ? ", off centre" : ""}` : ""
  const turn = pad.rot ? `, turned ${round(pad.rot)}°` : ""
  return `${number}  ${shape} ${size}${turn}${hole}`
}

const round = (n: number) => Math.round(n * 1000) / 1000
