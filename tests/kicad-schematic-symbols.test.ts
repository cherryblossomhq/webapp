import { describe, expect, it } from "vitest"
import { convertCachedSymbol, drawingNeeds, partFromSymbol, readKicadSchematic, resolveLibSymbol, toSheet } from "../src/model/kicad/schematic"
import { expandPinNumber, pinsOfUnit, portDir } from "../src/model/kicad/schematic/symbols"
import { LIB_R, LIB_U, schematic } from "./kicad-schematic-fixtures"

// Symbol sources: the symbols a schematic embeds, as the editor's `SymbolDef` and `PinDef`. The pins
// are exact (place, number, name, direction, scaled to the editor's grid); the drawing is what the
// editor can draw, and `drawingNeeds` says what it cannot.

const lib = (text: string, version = 20230121) => readKicadSchematic(schematic({ version, libs: [text] })).schematic.libSymbols

describe("a cached symbol as the editor's symbol", () => {
  it("puts every pin where KiCad has it, in the editor's units (1.27 mm is 0.1) and with y up, the wire leaving away from the body", () => {
    const [r] = lib(LIB_R)
    const { symbol, pins } = convertCachedSymbol(r, 1, 1)
    expect(symbol.ports).toEqual([
      { pin: "1", x: 0, y: 0.3, dir: "up" },
      { pin: "2", x: 0, y: -0.3, dir: "down" },
    ])
    expect(pins).toEqual([
      { number: "1", name: "1", kind: "passive" },
      { number: "2", name: "2", kind: "passive" },
    ])
    const [u] = lib(LIB_U)
    expect(convertCachedSymbol(u, 1, 1).symbol.ports.map((p) => [p.pin, p.x, p.y, p.dir])).toEqual([
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
    const { pins } = convertCachedSymbol(lib(text)[0], 1, 1)
    expect(pins).toEqual([
      { number: "1", name: "RESET#", kind: "input" },
      { number: "2", name: "VOUT", kind: "output" },
      { number: "3", name: "3", kind: "passive" },
      { number: "4", name: "IO", kind: "io" },
      { number: "5", name: "GND", kind: "ground" },
      { number: "6", name: "VCC", kind: "power" },
      { number: "7", name: "NC", kind: "nc" },
    ])
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
    expect(partFromSymbol(q, 2, 1).pins.map((p) => p.number)).toEqual(["2", "8"])
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
    const { symbol, pins } = convertCachedSymbol(lib(text)[0], 1, 1)
    expect(symbol.ports.map((p) => [p.pin, p.x, p.y])).toEqual([["1", 0, 0], ["2", 0, 0], ["3", 0, 0]])
    expect(pins.map((p) => p.number)).toEqual(["1", "2", "3"])
  })

  it("follows `extends`, and names a cycle or a base that is missing", () => {
    const [base, child] = lib(`${LIB_R.replace(`"Device:R"`, `"Device:Base"`)} ${`(symbol "Device:Child" (extends "Device:Base") (property "Value" "child" (at 0 0 0)))`}`)
    const resolved = resolveLibSymbol(child, (n) => (n === "Device:Base" ? base : undefined))
    expect(resolved.pins.map((p) => p.number)).toEqual(["1", "2"])
    expect(resolved.props.find((p) => p.name === "Value")?.value).toBe("child")
    expect(resolved.props.some((p) => p.name === "Reference")).toBe(true)
    expect(() => resolveLibSymbol(child, () => undefined)).toThrow(/extends Device:Base, which is not in its library/)
    expect(() => resolveLibSymbol({ ...base, extendsName: "Device:Base" }, (n) => (n === "Device:Base" ? base : undefined))).toThrow(/a cycle/)
  })

  it("what the editor cannot draw of a symbol is named", () => {
    expect(drawingNeeds(lib(LIB_R)[0])).toEqual(["a stroke width of its own"])
    expect(drawingNeeds(lib(LIB_U)[0]).sort()).toEqual(["a background fill", "a stroke width of its own", "an arc"])
    const text = `(symbol "T:X"
      (symbol "X_1_1"
        (circle (center 0 0) (radius 1) (stroke (width 0) (type dash)) (fill (type outline)))
        (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0) (type default)) (fill (type none)))
        (pin passive inverted (at 0 0 0) (length 2.54) (name "A" ) (number "1") (alternate "B" input line))))`
    expect(drawingNeeds(lib(text)[0]).sort()).toEqual(["a curve", "a dash line", "a inverted pin", "a outline fill", "alternate pin functions"])
  })

  it("draws paths, circles and text, with the pins' lines and names", () => {
    const text = `(symbol "T:X"
      (symbol "X_0_1"
        (polyline (pts (xy 0 0) (xy 2.54 0) (xy 2.54 2.54)) (stroke (width 0) (type default)) (fill (type none)))
        (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0) (type default)) (fill (type background)))
        (circle (center 1.27 1.27) (radius 0.635) (stroke (width 0) (type default)) (fill (type none)))
        (text "x" (at 0 0 0) (effects (font (size 1.27 1.27)))))
      (symbol "X_1_1" (pin passive line (at -2.54 0 0) (length 2.54) (name "IN") (number "1"))))`
    const { symbol } = convertCachedSymbol(lib(text)[0], 1, 1)
    expect(symbol.primitives.map((p) => p.type)).toEqual(["path", "path", "circle", "text", "path", "text", "text"])
    const poly = symbol.primitives[0]
    expect(poly.type === "path" && poly.points).toEqual([{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0.2 }])
    const rect = symbol.primitives[1]
    expect(rect.type === "path" && rect.fill && rect.points.length).toBe(5)
    expect(symbol.bounds.minX).toBeLessThan(0)
  })

  it("makes a part with a stable id for its unit, body style and shape, and a prefix and category from its reference", () => {
    const [r] = lib(LIB_R)
    const a = partFromSymbol(r, 1, 1)
    const b = partFromSymbol(r, 1, 1)
    expect(a.id).toBe(b.id)
    expect(partFromSymbol(r, 2, 1).id).not.toBe(a.id)
    expect(partFromSymbol(r, 1, 1, undefined, ["land-1"]).id).not.toBe(a.id)
    expect(partFromSymbol(r, 1, 1, { at: { x: 0, y: 0 }, angle: 90, mirror: "x" }).id).not.toBe(a.id)
    expect([a.name, a.refPrefix, a.category, a.custom, a.footprints, a.valueProp]).toEqual(["R", "R", "Passives", true, [], "value"])
    expect(partFromSymbol(lib(LIB_U)[0], 1, 1).category).toBe("ICs")
    expect(partFromSymbol(r, 1, 1, undefined, ["land-1"]).footprints).toEqual(["land-1"])
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
