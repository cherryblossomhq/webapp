import { beforeAll, describe, expect, it } from "vitest"
import { runFuzz, summarize, type FuzzStats, type Placement } from "./schematic-fuzz"

/**
 * Sakura's schematic tools on random designs, judged by an oracle that knows which nets every pin
 * was asked to be on (see schematic-fuzz.ts). Two layouts: every part placed without x/y, and
 * parts dropped at random spots. Calls mix add_component, connect, update_component (moves,
 * turns, rails) and remove_component. 300 designs of each pass; this runs a few so the suite
 * stays quick (FUZZ_DESIGNS=300 for the full run).
 */
const DESIGNS = Number(process.env.FUZZ_DESIGNS ?? 24)

describe.each<Placement>(["auto", "mixed"])("schematic tools on random designs (%s placement)", (placement) => {
  let stats: FuzzStats
  beforeAll(() => {
    stats = runFuzz(DESIGNS, [placement])[placement]
  }, 300_000)

  it("never make a net nobody asked for, or park a pin under another net's wire", () => {
    expect(stats.unasked.slice(0, 3)).toEqual([])
    expect(stats.looks.slice(0, 3)).toEqual([])
  })
  it("never refuse a connect that could be made, and never leave a pin out without saying", () => {
    expect(stats.falseRefusals.slice(0, 3)).toEqual([])
    expect(stats.partial.slice(0, 3)).toEqual([])
  })
  it("leave the project alone when they refuse, and finish what they say they finished", () => {
    expect(stats.inconsistent.slice(0, 3)).toEqual([])
  })
  it("never cut a net without saying which pins came loose", () => {
    expect(stats.lost.slice(0, 3)).toEqual([])
  })
  it("only offer a spot that works", () => {
    expect(stats.badSuggestions.slice(0, 3)).toEqual([])
    expect(summarize(stats).designs).toBe(DESIGNS)
  })
})
