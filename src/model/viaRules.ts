import type { DesignRules, PcbSide, Via } from "./types"

// X5: what a via's own settings and the board's rules say of it.

/**
 * Whether a via's mask is closed over its pad on a side: its own `tent` for that side where it says one, else the board's rule for the side
 * (`tentSides`, which a board that tents one side only has), else `tentVias`. KiCad's `PCB_VIA::IsTented` (pcb_track.cpp 9.0.0 `:905`).
 */
export function viaTentedOn(rules: Pick<DesignRules, "tentVias" | "tentSides">, via: Pick<Via, "tent">, side: PcbSide): boolean {
  const key = side === "top" ? "front" : "back"
  const own = via.tent?.[key]
  if (own !== undefined) return own
  return rules.tentSides ? rules.tentSides[key] : rules.tentVias
}
