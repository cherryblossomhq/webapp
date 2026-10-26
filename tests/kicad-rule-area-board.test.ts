import { describe, expect, it } from "vitest"
import { drillHoles, excellonDrill } from "../src/export/excellon"
import { gerberLayers } from "../src/export/gerber"
import { writeKicadBoard } from "../src/export/kicadBoard"
import { bomCsv } from "../src/export/bom"
import { pnpCsv } from "../src/export/pnp"
import { placedComponents } from "../src/editor/three/buildBoard"
import { ROOT_SHEET } from "../src/model/sheets"
import { onBoard } from "../src/model/partFlags"
import { pcbPads } from "../src/model/instances"
import { resolvedComponents, ruleAreaFlags, symbolBox } from "../src/model/ruleAreas"
import type { ComponentInstance, DrawingLine, Project } from "../src/model/types"
import { built } from "./built"

// S8: a rule area's flags are those of the symbols it touches for everything that reads them, the board side too (Gerber, drill, the 3D view, the board
// file, the PCB editor's lists), not only the BOM, the position file and the exports of the schematic.

const base = built("regulator")
const areaOver = (c: ComponentInstance, ruleArea: NonNullable<DrawingLine["ruleArea"]>): DrawingLine => {
  // A small square on the symbol's centre: it touches this symbol's box and few others'.
  const b = symbolBox(c)
  const x = (b.minX + b.maxX) / 2
  const y = (b.minY + b.maxY) / 2
  const d = 0.01
  return { id: `area-${c.id}`, type: "line", closed: true, points: [{ x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }], ruleArea }
}
/** A placed part with a hole, alone in its box: the area over it touches no other symbol. */
const pick = (() => {
  for (const c of base.components) {
    if (!c.pcb.placed || !onBoard(c) || !pcbPads(c).some((p) => p.holeDiameter !== undefined)) continue
    const p = { ...base, drawings: [...(base.drawings ?? []), areaOver(c, { notOnBoard: true })] }
    if (ruleAreaFlags(p).size === 1) return c
  }
  throw new Error("no through-hole part of the regulator stands alone")
})()
const withArea = (ruleArea: NonNullable<DrawingLine["ruleArea"]>): Project => ({ ...base, drawings: [...(base.drawings ?? []), areaOver(pick, ruleArea)] })
/** The same part with the flag on the part itself: what KiCad's resolution gives the part. */
const withFlag = (flags: NonNullable<ComponentInstance["flags"]>): Project => ({ ...base, components: base.components.map((c) => (c.id === pick.id ? { ...c, flags: { ...c.flags, ...flags } } : c)) })

describe("S8: a rule area's flags on the board side", () => {
  it("resolves the flags once, for the project's own components when no area sets one", () => {
    expect(resolvedComponents(base)).toBe(base.components)
    const p = withArea({ notOnBoard: true })
    expect(resolvedComponents(p)).toBe(resolvedComponents(p))
    expect(resolvedComponents(p).find((c) => c.id === pick.id)!.flags?.notOnBoard).toBe(true)
    expect(p.components.find((c) => c.id === pick.id)!.flags?.notOnBoard).toBeUndefined()
  })

  it("on_board no takes the part out of the Gerber files, the drill file, the 3D view and the KiCad board file, as the part's own flag does", () => {
    const area = withArea({ notOnBoard: true })
    const flagged = withFlag({ notOnBoard: true })
    expect(placedComponents(area).some((c) => c.id === pick.id)).toBe(false)
    expect(placedComponents(area).map((c) => c.id)).toEqual(placedComponents(flagged).map((c) => c.id))
    expect(gerberLayers(area)).toEqual(gerberLayers(flagged))
    expect(gerberLayers(area)).not.toEqual(gerberLayers(base))
    expect(drillHoles(area)).toEqual(drillHoles(flagged))
    expect(drillHoles(area).length).toBeLessThan(drillHoles(base).length)
    expect(excellonDrill(area)).toEqual(excellonDrill(flagged))
    const board = writeKicadBoard(area).text
    expect(board).toEqual(writeKicadBoard(flagged).text)
    expect(board).not.toContain(`"Reference" "${pick.ref}"`)
    expect(writeKicadBoard(base).text).toContain(`"Reference" "${pick.ref}"`)
  })

  it("dnp does on the board side what the part's own dnp does: still plotted and drilled, written with its attribute, out of the BOM and the position file", () => {
    const area = withArea({ dnp: true })
    const flagged = withFlag({ dnp: true })
    expect(gerberLayers(area)).toEqual(gerberLayers(flagged))
    expect(gerberLayers(area)).toEqual(gerberLayers(base))
    expect(drillHoles(area)).toEqual(drillHoles(base))
    expect(writeKicadBoard(area).text).toEqual(writeKicadBoard(flagged).text)
    expect(writeKicadBoard(area).text).toContain("dnp")
    expect(bomCsv(area)).toEqual(bomCsv(flagged))
    expect(pnpCsv(area)).toEqual(pnpCsv(flagged))
  })
})

describe("a sheet symbol's flags on the board side", () => {
  // The regulator template, with the target part moved onto a sheet below a flagged sheet symbol.
  const onSheet = (flags: NonNullable<ComponentInstance["flags"]>): Project => ({
    ...base,
    sheetSymbols: [{ id: "sym", sheet: ROOT_SHEET, child: "child", name: "child", file: "child", x: 0, y: 0, w: 1, h: 1, pins: [], flags }] as unknown as Project["sheetSymbols"],
    components: base.components.map((c) => (c.id === pick.id ? { ...c, inst: "/sym" } : c)),
  })
  const direct = (flags: NonNullable<ComponentInstance["flags"]>): Project => ({ ...base, components: base.components.map((c) => (c.id === pick.id ? { ...c, flags: { ...c.flags, ...flags } } : c)) })

  it("on_board no on the sheet symbol gives the same board outputs as the flag on the part", () => {
    const sheet = onSheet({ notOnBoard: true })
    expect(resolvedComponents(sheet).find((c) => c.id === pick.id)!.flags?.notOnBoard).toBe(true)
    const flagged = direct({ notOnBoard: true })
    expect(placedComponents(sheet).map((c) => c.id)).toEqual(placedComponents(flagged).map((c) => c.id))
    expect(drillHoles(sheet)).toEqual(drillHoles(flagged))
    expect(gerberLayers(sheet)).toEqual(gerberLayers(flagged))
    expect(writeKicadBoard(sheet).text).not.toContain(`"Reference" "${pick.ref}"`)
  })

  it("dnp on the sheet symbol leaves the part out of the BOM and the position file", () => {
    const sheet = onSheet({ dnp: true })
    expect(bomCsv(sheet)).toEqual(bomCsv(direct({ dnp: true })))
    expect(pnpCsv(sheet)).toEqual(pnpCsv(direct({ dnp: true })))
  })
})
