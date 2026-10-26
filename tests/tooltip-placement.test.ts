import { describe, expect, it } from "vitest"
import { GAP, MARGIN, placeTooltip, SHOW_DELAY_MS, showDelay, WARM_MS } from "../src/ui/tooltipPlacement"

const viewport = { width: 1200, height: 800 }
const tip = { width: 120, height: 40 }
const button = (left: number, top: number) => ({ left, top, width: 32, height: 32 })

describe("showDelay", () => {
  it("waits when nothing was shown lately", () => {
    expect(showDelay(10_000, -Infinity)).toBe(SHOW_DELAY_MS)
    expect(showDelay(10_000, 10_000 - WARM_MS)).toBe(SHOW_DELAY_MS)
  })

  it("shows at once right after another tooltip went away", () => {
    expect(showDelay(10_000, 10_000 - 50)).toBe(0)
    expect(showDelay(10_000, 10_000 - WARM_MS + 1)).toBe(0)
  })
})

describe("placeTooltip", () => {
  it("goes below the control, centred on it", () => {
    const p = placeTooltip(button(500, 100), tip, viewport)
    expect(p.side).toBe("bottom")
    expect(p.top).toBe(100 + 32 + GAP)
    expect(p.left).toBe(500 + 16 - 60)
  })

  it("flips above a control at the bottom of the window", () => {
    const p = placeTooltip(button(500, 760), tip, viewport)
    expect(p.side).toBe("top")
    expect(p.top).toBe(760 - GAP - tip.height)
  })

  it("is pulled in from the left edge", () => {
    expect(placeTooltip(button(4, 12), tip, viewport).left).toBe(MARGIN)
  })

  it("is pulled in from the right edge", () => {
    const p = placeTooltip(button(1190, 12), tip, viewport)
    expect(p.left + tip.width).toBe(viewport.width - MARGIN)
  })

  it("picks the roomier side when neither fits", () => {
    const tall = { width: 300, height: 100 }
    const small = { width: 800, height: 120 }
    expect(placeTooltip(button(100, 70), tall, small).side).toBe("top")
    expect(placeTooltip(button(100, 10), tall, small).side).toBe("bottom")
  })

  it("never starts above the window", () => {
    expect(placeTooltip(button(100, 2), { width: 100, height: 400 }, { width: 800, height: 300 }).top).toBeGreaterThanOrEqual(MARGIN)
  })
})
