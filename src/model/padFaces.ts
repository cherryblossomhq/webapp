import type { CopperLayer, PadDef, PadSides } from "./types"

// X7: which sides of a part a pad has copper, solder mask, paste and silkscreen on. The editor's kinds of pad have their own
// (`gerber.ts` drew these before the pad had layers of its own); `PadDef.layers` replaces any of them.

export interface PadFaces {
  copper: PadSides
  mask: PadSides
  paste: PadSides
  silk: PadSides
}

/**
 * What a surface-mount pad, a through-hole pad and a non-plated hole have, relative to the part's own side. A non-plated hole is on both
 * copper layers as KiCad's own mounting holes are (`*.Cu *.Mask`): that decides which margins it takes, and whether copper is plotted
 * round it is `nonPlatedCopper`'s.
 */
export function defaultFaces(pad: Pick<PadDef, "layer" | "plated">): PadFaces {
  if (pad.plated === false) return { copper: "both", mask: "both", paste: "none", silk: "none" }
  if (pad.layer === "through") return { copper: "both", mask: "both", paste: "none", silk: "none" }
  return { copper: "top", mask: "top", paste: "top", silk: "none" }
}

/** The sides a pad is on, with its own where it has them. */
export function padFaces(pad: Pick<PadDef, "layer" | "plated" | "layers">): PadFaces {
  const d = defaultFaces(pad)
  const l = pad.layers
  return l ? { copper: l.copper ?? d.copper, mask: l.mask ?? d.mask, paste: l.paste ?? d.paste, silk: l.silk ?? d.silk } : d
}

/** The sides of the board for sides of a part: a part on the bottom has its own side there and its other side on top. */
export function boardSides(sides: PadSides, partSide: CopperLayer): CopperLayer[] {
  if (sides === "none") return []
  if (sides === "both") return ["top", "bottom"]
  return [(sides === "top") === (partSide === "top") ? "top" : "bottom"]
}

/**
 * Whether copper is plotted round a non-plated hole: not where the hole swallows the pad, a round pad no larger than its round hole
 * or an oval one no larger than its slot, centred (`PAD::FlashLayer`, pad.cpp 10.0.0 `:455-475`).
 */
export function nonPlatedCopper(pad: Pick<PadDef, "shape" | "width" | "height" | "holeDiameter" | "slotLength" | "holeOffset" | "custom" | "round" | "chamfer">): boolean {
  const d = pad.holeDiameter
  if (d === undefined) return true
  const centred = !pad.holeOffset || (pad.holeOffset.x === 0 && pad.holeOffset.y === 0)
  const slot = pad.slotLength !== undefined && pad.slotLength > d + 1e-9
  if (pad.shape === "circle" && !pad.custom && !slot && centred && d >= pad.width - 1e-9) return false
  if (pad.shape === "pill" && slot && centred && pad.slotLength! >= Math.max(pad.width, pad.height) - 1e-9 && d >= Math.min(pad.width, pad.height) - 1e-9) return false
  return true
}
