import { describe, expect, it } from "vitest"
import { findPart } from "../src/model/library"
import { componentFields, textOnSheet } from "../src/model/symbolDrawing"
import { mirrorComponent, rotateComponent } from "../src/model/ops"
import { setFieldPlace } from "../src/model/schematicEdit"
import { kicadTransform, rawFields } from "./kicad-census/drawing-sch.mjs"
import { importSheet, place } from "./kicad-sch-parts"

// The fields of a turned and mirrored symbol are laid out by KiCad's rules (`SCH_FIELD::GetDrawRotation`,
// `GetBoundingBox`, `SCH_FIELD::GetPosition`): the angle and justification a field has are its symbol's, so a
// turn of a quarter swaps across and up, the box goes through the symbol's turn and mirror, and the field
// follows the symbol when the symbol is turned or mirrored.

describe("a field on a turned or mirrored symbol", () => {
  it("is drawn across or up by the symbol's turn: a field written at 90 on a symbol turned 90 reads across", () => {
    const flat = { rot: 0 as const }
    expect(textOnSheet(90, undefined, undefined, flat).vertical).toBe(true)
    expect(textOnSheet(90, undefined, undefined, { rot: 90 }).vertical).toBe(false)
    expect(textOnSheet(0, undefined, undefined, { rot: 90 }).vertical).toBe(true)
    expect(textOnSheet(0, undefined, undefined, { rot: 180 }).vertical).toBe(false)
    expect(textOnSheet(0, undefined, undefined, { rot: 270, mirror: "x" }).vertical).toBe(true)
  })

  it("keeps its box on the side of the anchor that KiCad's transform puts it on", () => {
    // left justified across: the box extends right of the anchor; turned half a turn or mirrored left to right, to its left
    expect(textOnSheet(0, "left", undefined, { rot: 0 }).extent).toEqual({ x: 1, y: 0 })
    expect(textOnSheet(0, "left", undefined, { rot: 180 }).extent).toEqual({ x: -1, y: 0 })
    expect(textOnSheet(0, "left", undefined, { rot: 0, mirror: "y" }).extent).toEqual({ x: -1, y: 0 })
    // a mirror top to bottom flips the side it hangs on
    expect(textOnSheet(0, undefined, "top", { rot: 0 }).extent).toEqual({ x: 0, y: -1 })
    expect(textOnSheet(0, undefined, "top", { rot: 0, mirror: "x" }).extent).toEqual({ x: 0, y: 1 })
    // left justified up the sheet (angle 90): the box extends up; the symbol turned 90 makes it across, to the left
    expect(textOnSheet(90, "left", undefined, { rot: 0 }).extent).toEqual({ x: 0, y: 1 })
    expect(textOnSheet(90, "left", undefined, { rot: 90 }).extent).toEqual({ x: -1, y: 0 })
  })

  it("matches the matrix KiCad turns a field's box by, on the net_chain case: R1 turned 90, Reference (at 74.93 54.61 90)", () => {
    const t = kicadTransform(90, "")
    expect(t.y1).not.toBe(0)
    const raw = `(kicad_sch (version 20250114) (generator "eeschema") (uuid 00000000-0000-4000-8000-000000000001)
      (symbol (lib_id "Device:R") (at 72.39 54.61 90) (uuid r1)
        (property "Reference" "R1" (at 74.93 54.61 90) (effects (font (size 1.27 1.27)) (justify left)))))`
    const [f] = rawFields(raw).filter((x) => x.name === "Reference")
    const { vertical } = f.layout(2)
    expect(vertical).toBe(false)
    expect(textOnSheet(90, "left", undefined, { rot: 90 }).vertical).toBe(false)
  })

  it("turns and mirrors with the symbol in the editor, as KiCad's field position does", () => {
    const p = importSheet({ symbols: [place("Device:R", "100 100", "R1")] })
    const c = p.components[0]
    const part = findPart(c.partId)!
    const before = componentFields(c, part).find((f) => f.name === "Reference")!
    const turned = rotateComponent(p, c.id, 90).components[0]
    const after = componentFields(turned, part).find((f) => f.name === "Reference")!
    // a quarter turn counter-clockwise takes (x, y) to (-y, x), and the angle and justification stay the symbol's
    expect(after.place.x).toBeCloseTo(-before.place.y, 5)
    expect(after.place.y).toBeCloseTo(before.place.x, 5)
    expect([after.place.angle, after.place.h, after.place.v]).toEqual([before.place.angle, before.place.h, before.place.v])
    expect(after.vertical).toBe(!before.vertical)
    const mirrored = mirrorComponent(p, c.id, "y").components[0]
    const m = componentFields(mirrored, part).find((f) => f.name === "Reference")!
    expect(m.place.x).toBeCloseTo(-before.place.x, 5)
    expect(m.place.y).toBeCloseTo(before.place.y, 5)
    // a field the user moved turns with the symbol too
    const moved = setFieldPlace(p, c.id, "Value", { x: 0.5, y: 0.25 })
    const both = rotateComponent(moved, c.id, 180).components[0]
    expect(both.fields?.Value.x).toBeCloseTo(-0.5, 5)
    expect(both.fields?.Value.y).toBeCloseTo(-0.25, 5)
    // a symbol with no places of its own takes the part's, turned with it
    const bare = { ...c, fields: undefined, sch: { ...c.sch, rot: 90 as const } }
    const d = componentFields(bare, part).find((f) => f.name === "Reference")!
    expect(d.place.x).toBeCloseTo(-part.fieldPlaces!.Reference.y, 5)
    expect(d.place.y).toBeCloseTo(part.fieldPlaces!.Reference.x, 5)
  })
})
