/** Where a tooltip goes, and how long to wait before showing it. No DOM in here, so it is unit-tested. */

export type Box = { left: number; top: number; width: number; height: number }
export type Size = { width: number; height: number }
export type TooltipSide = "top" | "bottom"

/** How long the pointer rests on a control before its tooltip shows. */
export const SHOW_DELAY_MS = 250
/** After a tooltip hides, one on a neighbouring control shows with no delay for this long. */
export const WARM_MS = 400
/** Gap between a control and its tooltip, and the least space kept from the window's edge. */
export const GAP = 6
export const MARGIN = 8

/** Wait before showing a tooltip: none when another one has only just gone away. */
export function showDelay(now: number, lastHiddenAt: number): number {
  return now - lastHiddenAt < WARM_MS ? 0 : SHOW_DELAY_MS
}

/**
 * Below the control when it fits, else above, else on the side with more room. The tooltip is
 * centred on the control and then pulled back inside the window, so a button in a corner
 * still shows all of its tooltip.
 */
export function placeTooltip(anchor: Box, tip: Size, viewport: Size): { left: number; top: number; side: TooltipSide } {
  const below = anchor.top + anchor.height + GAP
  const above = anchor.top - GAP - tip.height
  const fitsBelow = below + tip.height + MARGIN <= viewport.height
  const fitsAbove = above >= MARGIN
  const spaceBelow = viewport.height - (anchor.top + anchor.height)
  const spaceAbove = anchor.top
  const side: TooltipSide = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove) ? "bottom" : "top"
  const top = side === "bottom" ? below : above

  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const maxLeft = viewport.width - MARGIN - tip.width
  const left = Math.max(MARGIN, Math.min(centred, maxLeft))
  return { left, top: Math.max(MARGIN, top), side }
}
