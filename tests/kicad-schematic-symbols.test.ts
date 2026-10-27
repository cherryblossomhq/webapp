import { describe, expect, it } from "vitest"
import { readKicadSchematic, resolveLibSymbol, toSheet } from "../src/model/kicad/schematic"
import { drawingFromLib, expandPinNumber, pinsOfUnit, portDir, specFromSymbol } from "../src/model/kicad/schematic/symbols"
import { drawingKey } from "../src/model/customParts"
import { drawnPart, drawingSymbol, pinGraphics, pinTexts, symbolOf } from "../src/model/symbolDrawing"
import type { PartDef } from "../src/model/types"
import { LIB_R, LIB_U, schematic } from "./kicad-schematic-fixtures"

// Symbol sources: the symbols a schematic embeds, as the symbol drawings the editor keeps (S10) and
// the pins and symbols a part has from them. The pins are exact (place, number, name, direction,
// scaled to the editor's grid); the drawing keeps every shape with its width, dash, colour and fill.

const lib = (text: string, version = 20230121) => readKicadSchematic(schematic({ version, libs: [text] })).schematic.libSymbols
const draw = (text: string) => {
  const [l] = lib(text)
  return drawingFromLib(resolveLibSymbol(l, () => undefined))
}

describe("a cached symbol as the symbol drawing the editor keeps", () => {
  it("puts every pin where KiCad has it, in the editor's units (1.27 mm is 0.1) and with y up, the wire leaving away from the body", () => {
    const part = drawnPart(draw(LIB_R).drawing)
    expect(part.symbol.ports.map((p) => [p.pin, p.x, p.y, p.dir])).toEqual([
      ["1", 0, 0.3, "up"],
      ["2", 0, -0.3, "down"],
    ])
    expect(part.pins).toEqual([
      { number: "1", name: "1", kind: "passive", type: "passive", unnamed: true },
      { number: "2", name: "2", kind: "passive", type: "passive", unnamed: true },
    ])
    expect(drawnPart(draw(LIB_U).drawing).symbol.ports.map((p) => [p.pin, p.x, p.y, p.dir])).toEqual([
      ["1", -0.5, 0.2, "left"],
      ["2", 0.5, 0.2, "right"],
      ["3", 0, -0.5, "down"],
    ])
    expect(portDir(0)).toBe("left")
    expect(portDir(90)).toBe("down")
    expect(portDir(180)).toBe("right")
    expect(portDir(270)).toBe("up")
  })

  it("names a pin as the library import does: an overbar is a trailing #, a subscript is dropped, an empty name is the number; and gives it the role of its type", () => {
    const text = `(symbol "T:Q"
      (symbol "Q_1_1"
        (pin input line (at 0 0 0) (length 2.54) (name "~{RESET}") (number "1"))
        (pin output line (at 0 2.54 0) (length 2.54) (name "V_{OUT}") (number "2"))
        (pin passive line (at 0 5.08 0) (length 2.54) (name "~") (number "3"))
        (pin bidirectional line (at 0 7.62 0) (length 2.54) (name "IO") (number "4"))
        (pin power_in line (at 0 10.16 0) (length 2.54) (name "GND") (number "5"))
        (pin power_in line (at 0 12.7 0) (length 2.54) (name "VCC") (number "6"))
        (pin no_connect line (at 0 15.24 0) (length 2.54) (name "NC") (number "7"))))`
    expect(drawnPart(draw(text).drawing).pins.map((p) => [p.number, p.name, p.kind, p.type])).toEqual([
      ["1", "RESET#", "input", "input"],
      ["2", "VOUT", "output", "output"],
      ["3", "3", "passive", "passive"],
      ["4", "IO", "io", "bidirectional"],
      ["5", "GND", "ground", "power_in"],
      ["6", "VCC", "power", "power_in"],
      ["7", "NC", "nc", "no_connect"],
    ])
    // the drawing keeps the name as KiCad writes it
    expect(draw(text).drawing.pins[0].name).toBe("~{RESET}")
  })

  it("a part has the pins of its unit, with the pins shared by every unit, and of its body style", () => {
    const text = `(symbol "T:Quad"
      (symbol "Quad_1_1" (pin input line (at -5 0 0) (length 2.54) (name "A1") (number "1")))
      (symbol "Quad_2_1" (pin input line (at -5 0 0) (length 2.54) (name "A2") (number "2")))
      (symbol "Quad_0_1" (pin power_in line (at 0 5 270) (length 2.54) (name "V+") (number "8")))
      (symbol "Quad_1_2" (pin input line (at -5 0 0) (length 2.54) (name "A1d") (number "1"))))`
    const [q] = lib(text)
    expect(pinsOfUnit(q, 1, 1).map((p) => p.number)).toEqual(["1", "8"])
    expect(pinsOfUnit(q, 2, 1).map((p) => p.number)).toEqual(["2", "8"])
    expect(pinsOfUnit(q, 1, 2).map((p) => [p.number, p.name])).toEqual([["1", "A1d"]])
    expect(q.units).toBe(2)
    const part = drawnPart(draw(text).drawing)
    expect(part.units.count).toBe(2)
    expect(part.units.bodyStyles).toBe(2)
    const at = (unit: number, body: number) => part.units.symbols[`${unit}:${body}`].ports.map((p) => p.pin)
    expect(at(2, 1)).toEqual(["2", "8"])
    expect(at(1, 2)).toEqual(["1"])
    expect(part.pins.map((p) => p.number)).toEqual(["1", "2", "8"])
    // a unit or a body style the part does not have is drawn empty
    expect(symbolOf({ units: part.units, symbol: part.symbol } as PartDef, { unit: 5 }).ports).toEqual([])
  })

  it("stacked pin numbers are several pins with one place", () => {
    expect(expandPinNumber("[1-5]")).toEqual(["1", "2", "3", "4", "5"])
    expect(expandPinNumber("[6,7,9-11]")).toEqual(["6", "7", "9", "10", "11"])
    expect(expandPinNumber("[A1-A3]")).toEqual(["A1", "A2", "A3"])
    expect(expandPinNumber("[1,2,3]")).toEqual(["1", "2", "3"])
    expect(expandPinNumber("5")).toEqual(["5"])
    expect(expandPinNumber("[5-1]")).toEqual(["[5-1]"])
    expect(expandPinNumber("[]")).toEqual(["[]"])
    expect(expandPinNumber("[1-5000]")).toHaveLength(5000)
    // past KiCad's own cap of 10000 pads the text is the one pin's number
    expect(expandPinNumber("[1-10001]")).toEqual(["[1-10001]"])
    expect(expandPinNumber("[1-10000]")).toHaveLength(10000)
    // empty items are skipped, mixed prefixes are one pin with the text as its number, a bracket with no partner is plain
    expect(expandPinNumber("[1,,3]")).toEqual(["1", "3"])
    expect(expandPinNumber("[A1-B3]")).toEqual(["[A1-B3]"])
    expect(expandPinNumber("[1-5")).toEqual(["[1-5"])
    expect(expandPinNumber("1]")).toEqual(["1]"])
    // an escaped dash or comma belongs to the number
    expect(expandPinNumber(String.raw`[A\-1,B\,2]`)).toEqual(["A-1", "B,2"])
    const text = `(symbol "T:S" (symbol "S_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "G") (number "[1-3]"))))`
    const part = drawnPart(draw(text).drawing)
    expect(part.symbol.ports.map((p) => [p.pin, p.x, p.y])).toEqual([["1", 0, 0], ["2", 0, 0], ["3", 0, 0]])
    expect(part.pins.map((p) => p.number)).toEqual(["1", "2", "3"])
    // drawn once, as one pin
    expect(part.symbol.pinLabels).toHaveLength(1)
  })

  it("follows `extends`, and names a cycle or a base that is missing", () => {
    const [base, child] = lib(`${LIB_R.replace(`"Device:R"`, `"Device:Base"`)} ${`(symbol "Device:Child" (extends "Device:Base") (property "Value" "child" (at 0 0 0)))`}`)
    const resolved = resolveLibSymbol(child, (n) => (n === "Device:Base" ? base : undefined))
    expect(resolved.pins.map((p) => p.number)).toEqual(["1", "2"])
    expect(resolved.props.find((p) => p.name === "Value")?.value).toBe("child")
    expect(resolved.props.some((p) => p.name === "Reference")).toBe(true)
    expect(resolved.source).toBe(base)
    expect(() => resolveLibSymbol(child, () => undefined)).toThrow(/extends Device:Base, which is not in its library/)
    expect(() => resolveLibSymbol({ ...base, extendsName: "Device:Base" }, (n) => (n === "Device:Base" ? base : undefined))).toThrow(/a cycle/)
    // the drawing of the derived symbol is the base's, with the derived symbol's own fields
    const d = drawingFromLib(resolved).drawing
    expect(d.name).toBe("Device:Child")
    expect(d.fields.find((f) => f.name === "Value")?.value).toBe("child")
    expect(d.pins).toHaveLength(2)
  })

  it("keeps every shape with its width, dash, colour and fill", () => {
    const text = `(symbol "T:X"
      (symbol "X_0_1"
        (circle (center 0 0) (radius 1.27) (stroke (width 0.254) (type dash)) (fill (type outline)))
        (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0) (type default) (color 255 0 0 1)) (fill (type none)))
        (rectangle (start 0 0) (end 2.54 2.54) (radius 0.5) (stroke (width 0) (type solid)) (fill (type color) (color 0 128 0 1)))
        (arc (start 0 0) (mid 1 1) (end 2 0) (stroke (width 0) (type default)) (fill (type background)))
        (text "x" (at 1 2 900) (effects (font (size 1 1) bold italic) (justify left bottom)))))`
    const { drawing, problems } = draw(text)
    expect(problems).toEqual([])
    const k = 12.7
    expect(drawing.items[0]).toEqual({ kind: "circle", c: { x: 0, y: 0 }, r: 0.1, width: 0.02, dash: "dash", fill: "outline", body: 1 })
    expect(drawing.items[1]).toMatchObject({ kind: "bezier", color: "#ff0000" })
    expect((drawing.items[1] as { points: unknown[] }).points).toHaveLength(4)
    expect(drawing.items[2]).toMatchObject({ kind: "rectangle", fill: "color", fillColor: "#008000" })
    expect((drawing.items[2] as { radius: number }).radius).toBeCloseTo(0.5 / k, 6)
    expect(drawing.items[3]).toMatchObject({ kind: "arc", fill: "background" })
    // a symbol's text has its angle in tenths of a degree
    expect(drawing.items[4]).toMatchObject({ kind: "text", text: "x", angle: 90, bold: true, italic: true, h: "left", v: "bottom" })
    expect((drawing.items[4] as { size: number }).size).toBeCloseTo(1 / k, 6)
  })

  it("draws every shape as a primitive of its own kind, with its look", () => {
    const text = `(symbol "T:X"
      (symbol "X_0_1"
        (polyline (pts (xy 0 0) (xy 2.54 0) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))
        (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0.254) (type dot)) (fill (type background)))
        (circle (center 1.27 1.27) (radius 0.635) (stroke (width 0) (type default)) (fill (type none)))
        (arc (start 0 0) (mid 1.27 1.27) (end 2.54 0) (stroke (width 0) (type default)) (fill (type none)))
        (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0) (type default)) (fill (type none)))
        (text "x" (at 0 0 0) (effects (font (size 1.27 1.27)))))
      (symbol "X_1_1" (pin passive line (at -2.54 0 0) (length 2.54) (name "IN") (number "1"))))`
    const part = drawnPart(draw(text).drawing)
    const prims = part.symbol.primitives
    expect(prims.map((p) => p.type)).toEqual(["path", "path", "circle", "arc", "bezier", "text", "path"])
    expect(prims[1].type === "path" && prims[1].look).toEqual({ width: 0.02, dash: "dot", fillKind: "background" })
    const arc = prims[3]
    expect(arc.type === "arc" && [arc.start.x, arc.start.y, arc.mid.x, arc.mid.y, arc.end.x, arc.end.y].map((v) => Math.abs(v))).toEqual([0, 0, 0.1, 0.1, 0.2, 0])
    expect(part.symbol.bounds.maxY).toBeGreaterThan(0.1)
    // names and numbers are laid out by the pin's way on the sheet, not drawn into the symbol
    expect(part.symbol.pinLabels?.[0]).toMatchObject({ number: "1", name: "IN", dx: 1, dy: 0, showName: true, showNumber: true })
  })

  it("does not draw a symbol's hidden pins or its hidden text, and keeps them in the drawing; a private shape is not brought", () => {
    const text = `(symbol "T:H" (pin_numbers hide)
      (symbol "H_0_1"
        (polyline (pts (xy 0 0) (xy 1 1)) (stroke (width 0) (type default)) (fill (type none)))
        (polyline private (pts (xy 0 0) (xy 5 5)) (stroke (width 0) (type default)) (fill (type none)))
        (text "gone" (at 0 0 0) (effects (font (size 1.27 1.27)) hide)))
      (symbol "H_1_1" (pin power_in line (at 0 0 0) (length 2.54) hide (name "VCC") (number "1"))
        (pin passive line (at 2.54 0 180) (length 2.54) (name "A") (number "2"))))`
    const { drawing } = draw(text)
    expect(drawing.items).toHaveLength(2)
    expect(drawing.pins[0].hidden).toBe(true)
    const part = drawnPart(drawing)
    expect(part.symbol.primitives.filter((p) => p.type === "text")).toEqual([])
    expect(part.symbol.primitives.filter((p) => p.type === "path")).toHaveLength(2)
    expect(part.symbol.ports.map((p) => [p.pin, p.hidden ?? false])).toEqual([["1", true], ["2", false]])
    expect(part.symbol.pinLabels?.map((l) => l.number)).toEqual(["2"])
    expect(part.symbol.pinLabels?.[0].showNumber).toBe(false)
  })

  it("gives a part a stable id from its drawing and its footprint, and a prefix and category from its reference", () => {
    const [r] = lib(LIB_R)
    const a = draw(LIB_R).drawing
    const b = draw(LIB_R).drawing
    expect(drawingKey(a)).toBe(drawingKey(b))
    expect(drawingKey(draw(LIB_U).drawing)).not.toBe(drawingKey(a))
    const spec = specFromSymbol(r, a, "")
    expect(specFromSymbol(r, a, "land-1").spec.footprint).toBe("land-1")
    expect([spec.spec.name, spec.spec.refPrefix, spec.spec.category, spec.spec.valueProp, spec.spec.footprint]).toEqual(["R", "R", "Passives", "value", ""])
    expect(specFromSymbol(lib(LIB_U)[0], draw(LIB_U).drawing, "").spec.category).toBe("ICs")
    expect(spec.key).toBe(drawingKey(a))
  })
})

describe("what a pin looks like and where its texts go", () => {
  const pin = (shape: string, angle = 0) => ({ number: "1", name: "A", type: "input" as const, shape: shape as never, x: 0, y: 0, angle, length: 0.2 })

  it("a pin is its line, with KiCad's mark on the end that meets the body", () => {
    const line = pinGraphics(pin("line"))
    expect(line).toEqual([{ type: "path", points: [{ x: 0.2, y: 0 }, { x: 0, y: 0 }], fill: false }])
    // inverted: a bubble of the pin number's half size, then the line from its far side
    const inverted = pinGraphics(pin("inverted"))
    expect(inverted.map((p) => p.type)).toEqual(["circle", "path"])
    expect(inverted[0]).toMatchObject({ type: "circle", x: 0.15, y: 0, radius: 0.05 })
    expect(pinGraphics(pin("clock")).map((p) => p.type)).toEqual(["path", "path"])
    expect(pinGraphics(pin("non_logic")).map((p) => p.type)).toEqual(["path", "path", "path"])
    expect(pinGraphics({ ...pin("line"), type: "no_connect" as const })).toHaveLength(3)
    expect(pinGraphics({ ...pin("line"), hidden: true })).toEqual([])
  })

  it("names and numbers: the number above the pin, the name above or inside the body, and the layout follows the pin, not the symbol", () => {
    const label = { number: "1", name: "A", x: 0, y: 0, dx: 1, dy: 0, length: 0.2, nameSize: 0.1, numberSize: 0.1, maxNameSize: 0.1, showName: true, showNumber: true }
    const flat = pinTexts(label, { rot: 0 }, 0)
    // name and number both outside: the name above the pin, the number below it
    expect(flat.find((t) => !t.number)!.y).toBeGreaterThan(0)
    expect(flat.find((t) => t.number)!.y).toBeLessThan(0)
    // turned half a turn the texts stay above and below
    const half = pinTexts(label, { rot: 180 }, 0)
    expect(half.find((t) => !t.number)!.y).toBeGreaterThan(0)
    expect(half.find((t) => t.number)!.x).toBeCloseTo(-0.1)
    // a name inside the body runs into it from the pin's end, left aligned when the body is to the right
    const inside = pinTexts({ ...label, showNumber: false }, { rot: 0 }, 0.04)[0]
    expect([inside.x, inside.y, inside.h]).toEqual([0.24, 0, "left"])
    expect(pinTexts({ ...label, showNumber: false }, { rot: 180 }, 0.04)[0]).toMatchObject({ x: -0.24, h: "right" })
    // a vertical pin reads upward, the name to the left of the line
    const up = pinTexts({ ...label, dx: 0, dy: 1, showNumber: false }, { rot: 0 }, 0)[0]
    expect([up.angle, up.x < 0]).toEqual([90, true])
    expect(pinTexts({ ...label, showName: false, showNumber: false }, { rot: 0 }, 0)).toEqual([])
    // a pin switched to another function is named for it
    expect(pinTexts(label, { rot: 0 }, 0.04, "SCL").find((t) => !t.number)!.text).toBe("SCL")
  })

  it("the symbol of a unit has the shapes of that unit and the ones every unit shares", () => {
    const { drawing } = draw(`(symbol "T:Y"
      (symbol "Y_0_1" (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "Y_1_1" (polyline (pts (xy 0 0) (xy 1 1)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "Y_2_1" (circle (center 0 0) (radius 1) (stroke (width 0) (type default)) (fill (type none)))))`)
    expect(drawingSymbol(drawing, 1, 1).primitives.map((p) => p.type)).toEqual(["path", "path"])
    expect(drawingSymbol(drawing, 2, 1).primitives.map((p) => p.type)).toEqual(["path", "circle"])
  })
})

describe("where a symbol's point is on the sheet", () => {
  // KiCad's matrices, by hand: the lib point (px, py) is (px, -py) on the y-down sheet; a turn is counter-clockwise on screen;
  // a mirror about x flips the sheet's y after the turn, a mirror about y its x.
  const at = (angle: number, mirror: "" | "x" | "y" = "") => toSheet({ x: 3, y: 1 }, { at: { x: 100, y: 200 }, angle, mirror })
  it("the four quarter turns and the mirrors, each against the matrix worked out by hand", () => {
    expect(at(0)).toEqual({ x: 103, y: 199 })
    expect(at(90)).toEqual({ x: 99, y: 197 })
    expect(at(180)).toEqual({ x: 97, y: 201 })
    expect(at(270)).toEqual({ x: 101, y: 203 })
    expect(at(0, "x")).toEqual({ x: 103, y: 201 })
    expect(at(0, "y")).toEqual({ x: 97, y: 199 })
    // the turn first, then the mirror
    expect(at(90, "x")).toEqual({ x: 99, y: 203 })
    expect(at(90, "y")).toEqual({ x: 101, y: 197 })
    expect(at(360)).toEqual(at(0))
    expect(at(-90)).toEqual(at(270))
  })
})
