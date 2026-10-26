import type { PartIndexPin, SupplierLand } from "@cherryblossom/api-contract"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { convertSymbol, type ConvertContext } from "../src/model/kicad/convert"
import { convertFootprint } from "../src/model/kicad/footprint"
import { convertLibraries, type Imported } from "../src/model/kicad/library"
import { parseSexpr } from "../src/model/kicad/sexpr"
import { cleanPinName, parseSymbols, resolveExtends, type RawSymbol } from "../src/model/kicad/symbol"

// The KiCad converter: the s-expression reader, symbols, footprints, and the two paired into a
// part. The library tests run on real files from the KiCad Official Libraries
// (`fixtures/kicad`, release 10.0.7), picked for what is hard about them.

const FIXTURES = join(__dirname, "fixtures", "kicad")

let imported: Imported
beforeAll(async () => {
  imported = await convertLibraries({ symbols: join(FIXTURES, "symbols"), footprints: join(FIXTURES, "footprints"), release: "10.0.7" })
})

const part = (key: string) => {
  const p = imported.parts.find((x) => x.key === key)
  if (!p) throw new Error(`${key} wasn't converted`)
  return p
}
const landOf = (key: string): SupplierLand => {
  const row = imported.lands.find((l) => l.key === part(key).landKey)
  if (!row) throw new Error(`no land for ${key}`)
  return row.land
}
const padsOf = (key: string, number: string) => landOf(key).pads.filter((p) => p.number === number)
const pin = (key: string, number: string): PartIndexPin => {
  const p = part(key).pins.find((x) => x.number === number)
  if (!p) throw new Error(`${key} has no pin ${number}`)
  return p
}
const describe_ = (key: string) => part(key).pins.map((p) => `${p.number}:${p.name}`)
const skipped = (key: string) => imported.skipped.find((s) => s.key === key)

// ---------- the reader ----------

describe("s-expressions", () => {
  it("reads nested lists, quoted strings and escapes", () => {
    const [root] = parseSexpr(`(pad "1" smd rect (at -1.5 2) (size 0.6 1.2) (note "a \\"quoted\\" word"))`)
    expect(root).toEqual(["pad", "1", "smd", "rect", ["at", "-1.5", "2"], ["size", "0.6", "1.2"], ["note", 'a "quoted" word']])
  })

  it("refuses unbalanced input rather than guessing", () => {
    expect(() => parseSexpr("(a (b)")).toThrow()
    expect(() => parseSexpr("(a))")).toThrow()
    expect(() => parseSexpr('(a "open)')).toThrow()
  })
})

// ---------- symbols ----------

const SYMBOL = (body: string) => `(kicad_symbol_lib (version 20251024) (symbol "U1" ${body}))`

describe("symbols", () => {
  it("turns KiCad's overbar into a trailing #, and a lone ~ into the number", () => {
    expect(cleanPinName("~{RESET}", "1")).toBe("RESET#")
    expect(cleanPinName("~{INT}/OUT", "2")).toBe("INT#/OUT")
    expect(cleanPinName("~", "7")).toBe("7")
    expect(cleanPinName("VCC", "8")).toBe("VCC")
    expect(cleanPinName("V_{CC(B)}", "9")).toBe("VCC(B)")
    expect(cleanPinName("~{CS_{1}}", "10")).toBe("CS1#")
    expect(cleanPinName("x^{2}", "11")).toBe("x2")
  })

  it("keeps hidden pins, drops the De Morgan drawing and counts units", () => {
    const [s] = parseSymbols(
      SYMBOL(`
      (property "Reference" "U") (property "Footprint" "Package_SO:SOIC-8")
      (symbol "U1_0_1" (pin power_in line (at 0 5.08 270) (length 2.54) (hide yes) (name "VCC") (number "8")))
      (symbol "U1_1_1" (pin input line (at -5 0 0) (length 2.54) (name "~{CS}" (effects (font (size 1 1)))) (number "1")))
      (symbol "U1_1_2" (pin input line (at -5 0 0) (length 2.54) (name "~{CS}") (number "1")))
      (symbol "U1_2_1" (pin output line (at 5 0 180) (length 2.54) (name "OUT") (number "2") (alternate "ALT" input line) (alternate "TxD_{2}" output line) (alternate "~{RST}" input line)))`),
    )
    expect(s.pins.map((p) => `${p.unit}:${p.number}:${p.name}:${p.hidden}`)).toEqual(["0:8:VCC:true", "1:1:CS#:false", "2:2:OUT:false"])
    expect(s.units).toBe(2)
    expect(s.pins[2].alternates).toEqual(["ALT", "TxD2", "RST#"])
    expect(s.props.Footprint).toBe("Package_SO:SOIC-8")
  })

  it("follows extends, with the base's pins and the derived symbol's properties", () => {
    const syms = parseSymbols(`(kicad_symbol_lib
      (symbol "BASE" (property "Footprint" "A:B") (property "Value" "BASE") (symbol "BASE_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "1"))))
      (symbol "DERIVED" (extends "BASE") (property "Footprint" "C:D")))`)
    const byName = new Map(syms.map((s) => [s.name, s]))
    const derived = resolveExtends(byName.get("DERIVED")!, (n) => byName.get(n))
    expect(derived.pins.map((p) => p.number)).toEqual(["1"])
    expect(derived.props.Footprint).toBe("C:D")
    expect(derived.props.Value).toBe("BASE")
    expect(() => resolveExtends({ ...byName.get("DERIVED")!, extendsName: "MISSING" }, () => undefined)).toThrow(/not in its library/)
  })
})

// ---------- footprints ----------

const MOD = (pads: string, extra = "") => `(footprint "T" (layer "F.Cu") ${extra} ${pads})`
const pads = (text: string) => {
  const r = convertFootprint(text, "T:T")
  if (!r.ok) throw new Error(r.reason)
  return r.land.pads
}

describe("footprints", () => {
  it("flips y (KiCad draws y down) and keeps millimetres", () => {
    const [p] = pads(MOD(`(pad "1" smd rect (at -1.5 2) (size 0.6 1.2) (layers "F.Cu" "F.Mask" "F.Paste"))`))
    expect(p).toMatchObject({ number: "1", shape: "rect", x: -1.5, y: -2, width: 0.6, height: 1.2, layer: "top" })
  })

  it("swaps a pad's size for a quarter turn and draws any other turn as a polygon", () => {
    const [q] = pads(MOD(`(pad "1" smd rect (at 0 0 90) (size 0.6 1.2) (layers "F.Cu"))`))
    expect(q).toMatchObject({ shape: "rect", width: 1.2, height: 0.6 })
    const [d] = pads(MOD(`(pad "1" smd rect (at 0 0 45) (size 1 2) (layers "F.Cu"))`))
    expect(d.shape).toBe("polygon")
    expect(d.points).toHaveLength(4)
    // A 45 degree turn of 1 x 2 is a diamond-ish shape 2.12 across.
    expect(d.width).toBeCloseTo(2.1213, 3)
    expect(d.height).toBeCloseTo(2.1213, 3)
  })

  it("keeps a turn's direction: counter-clockwise stays counter-clockwise after the flip", () => {
    // A long pad pointing along x, turned 30 degrees counter-clockwise on screen, has its right end
    // up the screen: y up in our frame.
    const [p] = pads(MOD(`(pad "1" smd rect (at 0 0 30) (size 4 0.2) (layers "F.Cu"))`))
    const right = p.points!.filter((q) => q.x > 0)
    expect(Math.max(...right.map((q) => q.y))).toBeGreaterThan(0.9)
  })

  it("draws a roundrect as a rect, and one rounded to a half as a pill", () => {
    const [a] = pads(MOD(`(pad "1" smd roundrect (at 0 0) (size 1 2) (layers "F.Cu") (roundrect_rratio 0.25))`))
    expect(a.shape).toBe("rect")
    const [b] = pads(MOD(`(pad "1" smd roundrect (at 0 0) (size 1 2) (layers "F.Cu") (roundrect_rratio 0.5))`))
    expect(b.shape).toBe("oval")
  })

  it("reads a round hole, an oval hole as a slot, and refuses a slot across its pad", () => {
    const [round] = pads(MOD(`(pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask"))`))
    expect(round).toMatchObject({ shape: "circle", holeDiameter: 1, layer: "through" })
    const [slot] = pads(MOD(`(pad "SH" thru_hole oval (at 0 0) (size 1.0 2.1) (drill oval 0.6 1.7) (layers "*.Cu" "*.Mask"))`))
    expect(slot).toMatchObject({ shape: "oval", holeDiameter: 0.6, slotLength: 1.7, width: 1, height: 2.1 })
    const across = convertFootprint(MOD(`(pad "1" thru_hole oval (at 0 0) (size 2.1 1.0) (drill oval 0.6 1.7) (layers "*.Cu"))`), "T:T")
    expect(across).toMatchObject({ ok: false })
    // A quarter turn carries the slot with the pad.
    const [turned] = pads(MOD(`(pad "1" thru_hole oval (at 0 0 90) (size 1.0 2.1) (drill oval 0.6 1.7) (layers "*.Cu"))`))
    expect(turned).toMatchObject({ width: 2.1, height: 1, slotLength: 1.7 })
  })

  it("keeps a non-plated hole with no number and no copper, and ignores paste and mask openings", () => {
    const out = pads(
      MOD(`(pad "" np_thru_hole circle (at 1 1) (size 0.65 0.65) (drill 0.65) (layers "*.Cu" "*.Mask"))
           (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
           (pad "" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Paste"))`),
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ number: "", plated: false, holeDiameter: 0.65, width: 0.65, height: 0.65, layer: "through" })
  })

  it("keeps pads that share a number as separate pads", () => {
    const out = pads(MOD(`(pad "2" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu")) (pad "1" smd rect (at -3 0) (size 1 1) (layers "F.Cu"))`))
    expect(out.map((p) => p.number)).toEqual(["2", "2", "1"])
  })

  it("makes a custom pad of its anchor and its polygons, all with its number", () => {
    const out = pads(
      MOD(`(pad "3" smd custom (at 1 1) (size 0.3 0.3) (layers "F.Cu") (options (clearance outline) (anchor circle))
            (primitives (gr_poly (pts (xy -0.5 0) (xy 0.5 0) (xy 0 1)) (width 0) (fill yes))))`),
    )
    expect(out.map((p) => p.shape)).toEqual(["circle", "polygon"])
    expect(out.every((p) => p.number === "3")).toBe(true)
    expect(out[1].points).toHaveLength(3)
  })

  it("grows a filled primitive drawn with a line width by half of it, as KiCad's chamfered pad 1 needs", () => {
    const out = pads(
      MOD(`(pad "1" smd custom (at 0 0) (size 0.1 0.1) (layers "F.Cu") (options (clearance outline) (anchor circle))
            (primitives (gr_poly (pts (xy -1 -1) (xy 1 -1) (xy 1 1) (xy -1 1)) (width 0.2) (fill yes))))`),
    )
    expect(out[1].width).toBeCloseTo(2.2, 3)
    expect(out[1].height).toBeCloseTo(2.2, 3)
    // An outline with no fill is a ring of copper, not a pad: refused.
    const ring = convertFootprint(MOD(`(pad "1" smd custom (at 0 0) (size 0.1 0.1) (layers "F.Cu") (primitives (gr_poly (pts (xy -1 -1) (xy 1 -1) (xy 1 1)) (width 0.1) (fill no))))`), "T:T")
    expect(ring).toMatchObject({ ok: false })
  })

  it("refuses a custom through-hole pad in pieces, which would be drilled once per piece (RaspberryPi_Pico)", () => {
    const pico = convertFootprint(
      MOD(`(pad "3" thru_hole custom (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu") (options (clearance outline) (anchor circle))
            (primitives (gr_poly (pts (xy 0 -0.85) (xy 1.5 -0.85) (xy 1.5 0.85) (xy 0 0.85)) (width 0) (fill yes))))`),
      "T:T",
    )
    expect(pico).toMatchObject({ ok: false, reason: expect.stringMatching(/custom shape in 2 pieces/) })
  })

  it("refuses, with the reason, what it can't draw: a bottom-side pad, an off-centre hole, a trapezoid", () => {
    const refusal = (pad: string) => {
      const r = convertFootprint(MOD(pad), "T:T")
      return r.ok ? null : r.reason
    }
    expect(refusal(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu"))`)).toMatch(/bottom copper/)
    expect(refusal(`(pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1 (offset 0.2 0)) (layers "*.Cu"))`)).toMatch(/off-centre/)
    expect(refusal(`(pad "1" smd trapezoid (at 0 0) (size 1 1) (layers "F.Cu") (rect_delta 0 0.2))`)).toMatch(/trapezoid/)
    expect(refusal(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "2" thru_hole oval (at 0 0 30) (size 1 2) (drill oval 0.6 1.7) (layers "*.Cu"))`)).toMatch(/slot/)
  })

  it("takes silkscreen from F.SilkS, joins lines that meet, and the courtyard from F.CrtYd", () => {
    const r = convertFootprint(
      MOD(
        `(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`,
        `(fp_line (start -2 -2) (end 2 -2) (layer "F.SilkS")) (fp_line (start 2 -2) (end 2 2) (layer "F.SilkS")) (fp_line (start 5 5) (end 6 6) (layer "B.SilkS"))
         (fp_rect (start -3 -3) (end 3 3) (layer "F.CrtYd")) (fp_rect (start -2.5 -2.5) (end 2.5 2.5) (layer "F.Fab"))`,
      ),
      "T:T",
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.land.silk).toEqual([
      [
        { x: -2, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: -2 },
      ],
    ])
    expect(r.land.courtyard).toEqual({ minX: -3, minY: -3, maxX: 3, maxY: 3 })
    expect(r.stats.courtyard).toBe("courtyard")
  })

  it("falls back to the fabrication outline, with a margin, when there is no courtyard", () => {
    const r = convertFootprint(MOD(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`, `(fp_rect (start -2 -1) (end 2 1) (layer "F.Fab"))`), "T:T")
    if (!r.ok) throw new Error(r.reason)
    expect(r.stats.courtyard).toBe("fab")
    expect(r.land.courtyard).toEqual({ minX: -2.25, minY: -1.25, maxX: 2.25, maxY: 1.25 })
  })

  it("draws a circle and an arc of silkscreen as polylines", () => {
    const r = convertFootprint(
      MOD(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`, `(fp_circle (center 0 0) (end 1 0) (layer "F.SilkS")) (fp_arc (start 2 0) (mid 0 2) (end -2 0) (layer "F.SilkS"))`),
      "T:T",
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.land.silk).toHaveLength(2)
    const arc = r.land.silk.find((l) => l.length < 20)!
    // The arc runs from (2, 0) through (0, -2) in our frame (KiCad's y was down) to (-2, 0).
    expect(arc[0]).toEqual({ x: 2, y: 0 })
    expect(arc[arc.length - 1]).toEqual({ x: -2, y: 0 })
    expect(arc.some((p) => Math.abs(p.x) < 0.01 && p.y < -1.99)).toBe(true)
  })
})

// ---------- a symbol and its footprint ----------

function sym(pins: string[], extra = ""): RawSymbol {
  const [s] = parseSymbols(
    SYMBOL(`(property "Reference" "U") (property "Value" "X") (property "Footprint" "L:F") ${extra}
      (symbol "U1_1_1" ${pins.map((n, i) => `(pin passive line (at 0 ${i} 0) (length 1) (name "P${n}") (number "${n}"))`).join(" ")})`),
  )
  return s
}
const land = (...numbers: string[]) => {
  const r = convertFootprint(MOD(numbers.map((n, i) => `(pad "${n}" smd rect (at ${i} 0) (size 1 1) (layers "F.Cu"))`).join(" ")), "L:F")
  if (!r.ok) throw new Error(r.reason)
  return r
}
const ctx = (r: ReturnType<typeof land> | undefined): ConvertContext => ({ library: "Lib", release: "10.0.7", footprint: () => r })

describe("pairing a symbol with its footprint", () => {
  it("makes a part when every pin has its pad and every pad its pin", () => {
    const r = convertSymbol(sym(["1", "2"]), ctx(land("1", "2")))
    expect(r.ok && r.part.pins.map((p) => p.number).sort()).toEqual(["1", "2"])
  })

  it("skips, with the reason, a symbol with no footprint, a footprint that isn't there, a pin with no pad and a pad with no pin", () => {
    const code = (r: ReturnType<typeof convertSymbol>) => (r.ok ? "ok" : r.code)
    expect(code(convertSymbol({ ...sym(["1"]), props: { Reference: "U" } }, ctx(land("1"))))).toBe("no_footprint")
    expect(code(convertSymbol(sym(["1"]), ctx(undefined)))).toBe("footprint_missing")
    expect(code(convertSymbol(sym(["1", "2"]), ctx(land("1"))))).toBe("pin_without_pad")
    expect(code(convertSymbol(sym(["1"]), ctx(land("1", "2"))))).toBe("pad_without_pin")
    expect(code(convertSymbol(sym([]), ctx(land("1"))))).toBe("no_pins")
    expect(code(convertSymbol({ ...sym(["1"]), power: true }, ctx(land("1"))))).toBe("power_symbol")
    expect(code(convertSymbol(sym(["1"]), { ...ctx(land("1")), footprint: () => ({ ok: false, reason: "pad 1 is a trapezoid" }) }))).toBe("footprint_unsupported")
  })

  it("skips a symbol that gives one pin number two names", () => {
    const s = sym(["1"], `(symbol "U1_2_1" (pin passive line (at 0 0 0) (length 1) (name "OTHER") (number "1")))`)
    const r = convertSymbol(s, ctx(land("1")))
    expect(r).toMatchObject({ ok: false, code: "pin_conflict" })
  })

  it("makes an exposed pad the symbol leaves out a pin EP, marks the pad, and gives the part its own land", () => {
    const withEp = convertFootprint(
      MOD(`(pad "1" smd rect (at 0 0) (size 0.3 0.3) (layers "F.Cu")) (pad "2" smd rect (at 1 0) (size 0.3 0.3) (layers "F.Cu")) (pad "3" smd rect (at 0.5 0.5) (size 2 2) (layers "F.Cu"))`),
      "L:F",
    )
    if (!withEp.ok) throw new Error(withEp.reason)
    const r = convertSymbol(sym(["1", "2"]), ctx(withEp as ReturnType<typeof land>))
    if (!r.ok) throw new Error(r.detail)
    expect(r.part.pins.at(-1)).toMatchObject({ number: "3", name: "EP", role: "exposed_pad" })
    expect(r.land.land.pads.filter((p) => p.exposed).map((p) => p.number)).toEqual(["3"])
    expect(r.part.landKey).toMatch(/^L:F#/)
    expect(r.stats.exposedPinAdded).toBe(true)
  })

  it("keeps mounting pads as copper with no pin, as KiCad leaves them", () => {
    const f = convertFootprint(
      MOD(`(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "MP" smd rect (at 5 0) (size 1 1) (layers "F.Cu")) (pad "MP" smd rect (at -5 0) (size 1 1) (layers "F.Cu"))`),
      "L:F",
    )
    if (!f.ok) throw new Error(f.reason)
    const r = convertSymbol(sym(["1"]), ctx(f as ReturnType<typeof land>))
    if (!r.ok) throw new Error(r.detail)
    expect(r.land.land.pads.map((p) => p.number)).toEqual(["1", "", ""])
    expect(r.stats.mountingPads).toBe(2)
  })

  it("maps electrical types and names to roles and kinds, by the supplier's own role rules", () => {
    const [s] = parseSymbols(
      SYMBOL(`(property "Footprint" "L:F")
        (symbol "U1_1_1"
          (pin power_in line (at 0 0 90) (length 1) (name "GND") (number "1"))
          (pin power_in line (at 0 1 270) (length 1) (name "VCC") (number "2"))
          (pin power_out line (at 5 0 180) (length 1) (name "VOUT") (number "3"))
          (pin no_connect line (at 5 1 180) (length 1) (name "NC") (number "4"))
          (pin input line (at -5 0 0) (length 1) (name "EN") (number "5"))
          (pin output line (at 5 2 180) (length 1) (name "PG") (number "6"))
          (pin bidirectional line (at 5 3 180) (length 1) (name "SDA") (number "7"))
          (pin power_in line (at 0 2 270) (length 1) (name "V-") (number "8")))`),
    )
    const r = convertSymbol(s, ctx(land("1", "2", "3", "4", "5", "6", "7", "8")))
    if (!r.ok) throw new Error(r.detail)
    const by = new Map(r.part.pins.map((p) => [p.name, p]))
    expect(by.get("GND")).toMatchObject({ role: "ground", side: "bottom" })
    expect(by.get("VCC")).toMatchObject({ role: "power_in", side: "top" })
    expect(by.get("VOUT")).toMatchObject({ role: "power_out", side: "right" })
    expect(by.get("NC")).toMatchObject({ role: "nc" })
    expect(by.get("EN")).toMatchObject({ role: "signal", kind: "input", side: "left" })
    expect(by.get("PG")).toMatchObject({ role: "signal", kind: "output" })
    expect(by.get("SDA")).toMatchObject({ role: "signal", kind: "io" })
    // A negative supply is a supply, not a signal.
    expect(by.get("V-")).toMatchObject({ role: "power_in" })
  })

  // Parts whose pin names look like supplies but which KiCad draws as signals (found in the first
  // review of the full conversion: 728 pins in 559 parts). Each symbol below is drawn the way KiCad draws
  // the real one: the pin names and electrical types are the library's, the geometry is made up.
  describe("KiCad's electrical type decides the role, the name only refines what KiCad leaves open", () => {
    const roles = (pins: [type: string, name: string][]) => {
      const [s] = parseSymbols(
        SYMBOL(`(property "Footprint" "L:F")
          (symbol "U1_1_1" ${pins.map(([t, n], i) => `(pin ${t} line (at 0 ${i} 0) (length 1) (name "${n}") (number "${i + 1}"))`).join(" ")})`),
      )
      const r = convertSymbol(s, ctx(land(...pins.map((_, i) => String(i + 1)))))
      if (!r.ok) throw new Error(r.detail)
      return new Map(r.part.pins.map((p) => [p.name, p]))
    }

    it("AD7321/23/27: analog inputs named V_{IN}0 are signals, not supplies, and lose KiCad's subscript markup", () => {
      const by = roles([["input", "V_{IN}0"], ["input", "V_{IN}1"], ["power_in", "V_{DD}"], ["power_in", "AGND"]])
      expect(by.get("VIN0")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("VIN1")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("VDD")).toMatchObject({ role: "power_in" })
      expect(by.get("AGND")).toMatchObject({ role: "ground" })
    })

    it("HT9170D: the VP and VN inputs of its op-amp are signals", () => {
      const by = roles([["input", "VP"], ["input", "VN"], ["power_in", "VDD"]])
      expect(by.get("VP")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("VN")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("VDD")).toMatchObject({ role: "power_in" })
    })

    it("INA226: Vbus, the bus voltage it measures, is a signal; Vs, its supply, is a supply", () => {
      const by = roles([["input", "Vbus"], ["power_in", "Vs"], ["input", "IN+"]])
      expect(by.get("Vbus")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("Vs")).toMatchObject({ role: "power_in" })
    })

    it("HY1602E: Vo, the display's contrast input, is a signal and not a supply output", () => {
      const by = roles([["input", "Vo"], ["power_in", "Vdd"], ["power_in", "Vss"]])
      expect(by.get("Vo")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("Vdd")).toMatchObject({ role: "power_in" })
      expect(by.get("Vss")).toMatchObject({ role: "ground" })
    })

    it("HV9921 and L7983: a VDD or VCC that KiCad draws as an output is not a supply input", () => {
      const by = roles([["output", "VDD"], ["output", "VCC"], ["power_in", "VIN"]])
      expect(by.get("VDD")).toMatchObject({ role: "signal", kind: "output" })
      expect(by.get("VCC")).toMatchObject({ role: "signal", kind: "output" })
      expect(by.get("VIN")).toMatchObject({ role: "power_in" })
    })

    it("uses the name only for pins KiCad draws as passive, unspecified or free", () => {
      const by = roles([["passive", "VCC"], ["unspecified", "GND"], ["free", "VOUT"], ["passive", "SW"], ["unspecified", "NC"]])
      expect(by.get("VCC")).toMatchObject({ role: "power_in" })
      expect(by.get("GND")).toMatchObject({ role: "ground" })
      expect(by.get("VOUT")).toMatchObject({ role: "power_out" })
      expect(by.get("SW")).toMatchObject({ role: "signal", kind: "passive" })
      expect(by.get("NC")).toMatchObject({ role: "nc" })
    })

    it("keeps KiCad's other electrical types as signals when the name says only a supply or an output", () => {
      const by = roles([["bidirectional", "VBUS"], ["tri_state", "VOUT"], ["open_collector", "VCC"], ["open_emitter", "VDD"]])
      for (const p of by.values()) expect(p.role).toBe("signal")
    })

    // The review of the full run (KiCad 10.0.7) found the type overriding names it has no business
    // overriding: a pin named for ground, the exposed pad or not connected is that, whatever type
    // KiCad gave it, because the type says what the die does and these roles say what the board does.
    it("TM4C, LM4F, LTC1100, MCF521x, LMR62421: a ground pin KiCad types as input or bidirectional is still ground", () => {
      const by = roles([["bidirectional", "GND"], ["input", "VSSA"], ["input", "AGND"], ["output", "DGND"], ["bidirectional", "PGND"], ["input", "VSSD"], ["input", "GNDA"]])
      for (const p of by.values()) expect(p).toMatchObject({ role: "ground" })
      expect(by.get("GND")?.kind).toBeUndefined()
    })

    it("HIP2100, TCA9535, TXB0104, MA730: an exposed pad KiCad types as input or output is still the exposed pad", () => {
      const by = roles([["output", "EP"], ["input", "EPAD"], ["input", "Pad"], ["input", "PAD"], ["input", "TAB"], ["input", "SW"]])
      for (const n of ["EP", "EPAD", "Pad", "PAD", "TAB"]) expect(by.get(n)).toMatchObject({ role: "exposed_pad" })
      expect(by.get("SW")).toMatchObject({ role: "signal", kind: "input" })
    })

    it("EA eDIP and PIC18: a DNC, N/C or DO NOT CONNECT pin KiCad types as output or bidirectional is still not connected", () => {
      const by = roles([["output", "DNC"], ["bidirectional", "N/C"], ["output", "NC"], ["input", "DO NOT CONNECT"]])
      for (const p of by.values()) expect(p).toMatchObject({ role: "nc" })
    })

    it("keeps the review parts: an analog switch's NC1 and NC2 contacts and the THAT2180's E+ are signals", () => {
      const by = roles([["bidirectional", "NC1"], ["bidirectional", "NC2"], ["bidirectional", "COM1"], ["input", "E+"], ["input", "E-"]])
      expect(by.get("NC1")).toMatchObject({ role: "signal", kind: "io" })
      expect(by.get("NC2")).toMatchObject({ role: "signal", kind: "io" })
      expect(by.get("E+")).toMatchObject({ role: "signal", kind: "input" })
      expect(by.get("E-")).toMatchObject({ role: "signal", kind: "input" })
    })

    it("marks the land's pad exposed when the exposed-pad pin was typed as a signal", () => {
      const [s] = parseSymbols(
        SYMBOL(`(property "Footprint" "L:F")
          (symbol "U1_1_1"
            (pin input line (at 0 0 0) (length 1) (name "IN") (number "1"))
            (pin output line (at 0 1 0) (length 1) (name "OUT") (number "2"))
            (pin input line (at 0 2 0) (length 1) (name "EP") (number "3")))`),
      )
      const r = convertSymbol(s, ctx(land("1", "2", "3")))
      if (!r.ok) throw new Error(r.detail)
      expect(r.part.pins.find((p) => p.name === "EP")).toMatchObject({ role: "exposed_pad" })
      expect(r.land.land.pads.filter((p) => p.exposed).map((p) => p.number)).toEqual(["3"])
    })
  })

  it("skips the whole symbol, with the reason, when a pin has no number (Valve:ECH81)", () => {
    const [s] = parseSymbols(
      SYMBOL(`(property "Footprint" "L:F")
        (symbol "U1_1_1"
          (pin passive line (at 0 0 0) (length 1) (name "A") (number "1"))
          (pin passive line (at 0 1 0) (length 1) (name "K") (number ""))
          (pin passive line (at 0 2 0) (length 1) (name "G") (number "2")))`),
    )
    expect(s.pins.map((p) => p.number)).toEqual(["1", "2"])
    expect(s.unnumbered).toBe(1)
    const r = convertSymbol(s, ctx(land("1", "2")))
    expect(r).toMatchObject({ ok: false, code: "pin_without_number", detail: "1 pin with no number" })
    // A symbol whose only pins are unnumbered is skipped for that, not as a part with no pins.
    const [only] = parseSymbols(SYMBOL(`(property "Footprint" "L:F") (symbol "U1_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "")))`))
    expect(convertSymbol(only, ctx(land("1")))).toMatchObject({ ok: false, code: "pin_without_number" })
  })

  it("carries the unnumbered pins of a base symbol into the symbol that extends it", () => {
    const syms = parseSymbols(`(kicad_symbol_lib
      (symbol "BASE" (property "Footprint" "L:F") (symbol "BASE_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "")) (pin passive line (at 0 1 0) (length 1) (name "B") (number "1"))))
      (symbol "DERIVED" (extends "BASE")))`)
    const byName = new Map(syms.map((x) => [x.name, x]))
    const derived = resolveExtends(byName.get("DERIVED")!, (n) => byName.get(n))
    expect(derived.unnumbered).toBe(1)
    expect(convertSymbol(derived, ctx(land("1")))).toMatchObject({ ok: false, code: "pin_without_number" })
  })
})

// ---------- the real libraries ----------

describe("KiCad fixtures: what converts, and what is skipped and why", () => {
  it("converts the parts that pair one to one, and says why it skipped the rest", () => {
    // 31 symbols pair: the 26 named for the tests and the bases some of them extend.
    expect(imported.parts.length).toBe(31)
    expect(skipped("Device:R")?.code).toBe("no_footprint")
    expect(skipped("power:+5V")?.code).toBe("power_symbol")
    expect(skipped("Connector:USB_C_Receptacle_USB2.0_16P")?.code).toBe("no_footprint")
    expect(skipped("Amplifier_Operational:TSV991AIQ1T")).toMatchObject({ code: "pad_without_pin" })
    expect(skipped("Amplifier_Operational:TSV991AIQ1T")?.detail).toMatch(/pad 3/)
    expect(skipped("Analog_ADC:MCP3427x-xMF")).toMatchObject({ code: "pin_without_pad" })
    expect(skipped("Diode:BAT54SDW")).toMatchObject({ code: "pin_conflict" })
    const report = imported.report
    expect(report.converted + Object.values(report.skipped).reduce((a, b) => a + b, 0)).toBe(report.symbols)
    expect(report.multiUnit).toBeGreaterThanOrEqual(3)
    expect(report.exposedPinAdded).toBeGreaterThanOrEqual(1)
  })

  it("is the same every time: rows are ordered and carry no clock", async () => {
    const again = await convertLibraries({ symbols: join(FIXTURES, "symbols"), footprints: join(FIXTURES, "footprints"), release: "10.0.7" })
    expect(again.parts).toEqual(imported.parts)
    expect(again.lands).toEqual(imported.lands)
  })

  it("AMS1117-3.3: a SOT-223 with its tab as a second pad 2, pins as the datasheet has them", () => {
    expect(describe_("Regulator_Linear:AMS1117-3.3").sort()).toEqual(["1:GND", "2:VO", "3:VI"])
    expect(pin("Regulator_Linear:AMS1117-3.3", "1").role).toBe("ground")
    expect(pin("Regulator_Linear:AMS1117-3.3", "2").role).toBe("power_out")
    expect(pin("Regulator_Linear:AMS1117-3.3", "3").role).toBe("power_in")
    expect(padsOf("Regulator_Linear:AMS1117-3.3", "2")).toHaveLength(2)
    // The tab is the bigger of the two pads numbered 2.
    const [a, b] = padsOf("Regulator_Linear:AMS1117-3.3", "2")
    expect(Math.max(a.height, b.height)).toBeGreaterThan(3)
    expect(part("Regulator_Linear:AMS1117-3.3").package).toBe("SOT-223-3_TabPin2")
    expect(landOf("Regulator_Linear:AMS1117-3.3").courtyard).toEqual({ minX: -4.4, minY: -3.6, maxX: 4.4, maxY: 3.6 })
  })

  it("ATmega328P-A: 32 pins on a TQFP-32, supplies and grounds by role, alternate functions kept", () => {
    const key = "MCU_Microchip_ATmega:ATmega328P-A"
    expect(part(key).pins).toHaveLength(32)
    expect(landOf(key).pads).toHaveLength(32)
    for (const n of ["4", "6"]) expect(pin(key, n)).toMatchObject({ name: "VCC", role: "power_in" })
    for (const n of ["3", "5", "21"]) expect(pin(key, n)).toMatchObject({ name: "GND", role: "ground" })
    expect(pin(key, "18")).toMatchObject({ name: "AVCC", role: "power_in" })
    expect(pin(key, "29").name).toBe("RESET#/PC6")
    expect(pin(key, "7").name).toBe("XTAL1/PB6")
    // Pin 1 sits at the top left and pin 8 on the left side, bottom: y is up here, so pin 1 is the higher.
    const y = (n: string) => padsOf(key, n)[0].y
    expect(y("1")).toBeGreaterThan(y("8"))
    expect(padsOf(key, "1")[0].x).toBeLessThan(0)
    expect(padsOf(key, "17")[0].x).toBeGreaterThan(0)
  })

  it("STM32F103C8Tx: LQFP-48, alternate functions as aliases", () => {
    const key = "MCU_ST_STM32F1:STM32F103C8Tx"
    expect(part(key).pins).toHaveLength(48)
    expect(pin(key, "42")).toMatchObject({ name: "PB6" })
    expect(pin(key, "42").aliases).toEqual(expect.arrayContaining(["I2C1_SCL", "TIM4_CH1"]))
    expect(pin(key, "44").name).toBe("BOOT0")
    expect(imported.report.withAlternateFunctions).toBeGreaterThanOrEqual(1)
  })

  it("RP2040: a QFN-56 whose exposed pad is pin 57, ground", () => {
    const key = "MCU_RaspberryPi:RP2040"
    expect(part(key).pins).toHaveLength(57)
    expect(pin(key, "57")).toMatchObject({ name: "GND", role: "ground" })
    const [ep] = padsOf(key, "57")
    expect(ep.width).toBeCloseTo(3.2, 1)
    expect(ep.height).toBeCloseTo(3.2, 1)
    expect(pin(key, "48")).toMatchObject({ name: "USB_VDD", role: "power_in" })
  })

  it("MCP6002-xMC and OPA2156xD: multi-unit op-amps are one part with every unit's pins", () => {
    const dfn = "Amplifier_Operational:MCP6002-xMC"
    expect(part(dfn).units).toBe(3)
    // Two amplifiers (1-3, 5-7) and the supply (4, 8), plus the exposed pad the symbol lists as pin 9.
    expect(describe_(dfn).sort()).toEqual(["1:1", "2:-", "3:+", "4:V-", "5:+", "6:-", "7:7", "8:V+", "9:V-"])
    expect(pin(dfn, "8").role).toBe("power_in")
    expect(pin(dfn, "3")).toMatchObject({ kind: "input", side: "left" })
    expect(pin(dfn, "1")).toMatchObject({ kind: "output", side: "right" })
    const soic = "Amplifier_Operational:OPA2156xD"
    expect(part(soic).pins).toHaveLength(8)
    expect(landOf(soic).pads).toHaveLength(8)
    // Unit A's pins come before unit B's, then the supplies.
    expect(part(soic).pins.map((p) => p.number).slice(0, 3)).toEqual(["3", "2", "1"])
  })

  it("SHT31-DIS: a DFN whose exposed pad is pin 9, drawn as a circle and a polygon of one piece of copper", () => {
    const key = "Sensor_Humidity:SHT31-DIS"
    expect(padsOf(key, "9")).toHaveLength(2)
    expect(padsOf(key, "9").some((p) => p.shape === "polygon")).toBe(true)
    expect(pin(key, "9").name).toBe("VSS")
  })

  it("TLV9061xDPW: a land of turned and custom pads, every pad still numbered", () => {
    const key = "Amplifier_Operational:TLV9061xDPW"
    const l = landOf(key)
    expect(l.pads.some((p) => p.shape === "polygon")).toBe(true)
    expect(new Set(l.pads.map((p) => p.number))).toEqual(new Set(["1", "2", "3", "4", "5"]))
  })

  it("TPS61040DRV: a boost converter whose symbol leaves out its exposed pad, which becomes pin EP", () => {
    const key = "Regulator_Switching:TPS61040DRV"
    // The symbol draws six pins on a WSON-6; the thermal pad is pad 7.
    expect(describe_(key).sort()).toEqual(["1:GND", "2:VIN", "3:EN", "4:FB", "5:NC", "6:SW", "7:EP"])
    expect(pin(key, "7")).toMatchObject({ name: "EP", role: "exposed_pad", side: "bottom" })
    expect(pin(key, "2").role).toBe("power_in")
    expect(pin(key, "1").role).toBe("ground")
    expect(pin(key, "5").role).toBe("nc")
    // The pad is marked exposed on this symbol's own land, and only the one pad.
    expect(part(key).landKey).toMatch(/#/)
    expect(landOf(key).pads.filter((p) => p.exposed).map((p) => p.number)).toEqual(["7"])
    // The footprint's own land is untouched: another symbol on it may use pad 7 differently.
    expect(imported.lands.some((l) => l.key === part(key).footprintKey)).toBe(false)
  })

  it("MCP2515, CH340G, NE555P, ATtiny85, ESP32, BME280: more pin maps against their datasheets", () => {
    // MCP2515-x/SO, SOIC-18W: 1 TXCAN 2 RXCAN 3 CLKOUT 4-6 TXnRTS 7 OSC2 8 OSC1 9 VSS 10 RX1BF 11 RX0BF 12 INT 13 SCK 14 SI 15 SO 16 CS 17 RESET 18 VDD
    const can = "Interface_CAN_LIN:MCP2515-xSO"
    expect(pin(can, "1").name).toBe("TXCAN")
    expect(pin(can, "2").name).toBe("RXCAN")
    expect(pin(can, "9")).toMatchObject({ name: "VSS", role: "ground" })
    expect(pin(can, "18")).toMatchObject({ name: "VDD", role: "power_in" })
    expect(pin(can, "16").name).toBe("CS#")
    expect(pin(can, "17").name).toBe("RESET#")
    // CH340G, SOIC-16: 1 GND 2 TXD 3 RXD 4 V3 5 UD+ 6 UD- 7 XI 8 XO 9 CTS# ... 16 VCC
    const ch = "Interface_USB:CH340G"
    expect(pin(ch, "1")).toMatchObject({ name: "GND", role: "ground" })
    expect(pin(ch, "16")).toMatchObject({ name: "VCC", role: "power_in" })
    expect(pin(ch, "2").name).toBe("TXD")
    expect(pin(ch, "5").name).toBe("UD+")
    expect(pin(ch, "6").name).toBe("UD-")
    // NE555P, DIP-8: 1 GND 2 TRIG 3 OUT 4 RESET 5 CTRL 6 THR 7 DIS 8 VCC
    const ne = "Timer:NE555P"
    expect(describe_(ne).sort()).toEqual(["1:GND", "2:TRIG", "3:OUT", "4:RST#", "5:CONT", "6:THRES", "7:DISCH", "8:VCC"])
    // ATtiny85-20P, DIP-8: 1 PB5/RESET 2 PB3 3 PB4 4 GND 5 PB0 6 PB1 7 PB2 8 VCC
    const tiny = "MCU_Microchip_ATtiny:ATtiny85-20P"
    expect(pin(tiny, "4")).toMatchObject({ name: "GND", role: "ground" })
    expect(pin(tiny, "8")).toMatchObject({ name: "VCC", role: "power_in" })
    expect(pin(tiny, "1").name).toBe("RESET#/PB5")
    // ESP32-WROOM-32: 1 GND 2 3V3 3 EN 4 SENSOR_VP 5 SENSOR_VN ... 25 IO0 ... 38 GND 39 GND
    const esp = "RF_Module:ESP32-WROOM-32"
    expect(pin(esp, "1")).toMatchObject({ name: "GND", role: "ground" })
    expect(pin(esp, "2")).toMatchObject({ role: "power_in" })
    expect(pin(esp, "3").name).toBe("EN")
    expect(pin(esp, "25").name).toBe("IO0")
    expect(pin(esp, "35").name).toBe("TXD0/IO1")
    expect(pin(esp, "34").name).toBe("RXD0/IO3")
    expect(part(esp).pins).toHaveLength(39)
    // BME280, Bosch LGA-8: 1 GND 2 CSB 3 SDI 4 SCK 5 SDO 6 VDDIO 7 GND 8 VDD
    const bme = "Sensor:BME280"
    expect(describe_(bme).sort()).toEqual(["1:GND", "2:CSB", "3:SDI", "4:SCK", "5:SDO", "6:VDDIO", "7:GND", "8:VDD"])
    // AP2112K-3.3, SOT-23-5: 1 VIN 2 GND 3 EN 4 NC 5 VOUT
    const ldo = "Regulator_Linear:AP2112K-3.3"
    expect(describe_(ldo).sort()).toEqual(["1:VIN", "2:GND", "3:EN", "4:NC", "5:VOUT"])
    expect(pin(ldo, "4").role).toBe("nc")
    // ADS1115, TSSOP/MSOP-10: 1 ADDR 2 ALERT 3 GND 4 AIN0 ... 8 VDD 9 SDA 10 SCL
    const adc = "Analog_ADC:ADS1115IDGS"
    expect(pin(adc, "3")).toMatchObject({ name: "GND", role: "ground" })
    expect(pin(adc, "8")).toMatchObject({ name: "VDD", role: "power_in" })
    expect(pin(adc, "9").name).toBe("SDA")
    expect(pin(adc, "10").name).toBe("SCL")
  })

  it("ESP32-WROOM-32: the module's ground pad 39 is one pin of many pads, the antenna keep-out holes are not pins", () => {
    const esp = "RF_Module:ESP32-WROOM-32"
    expect(padsOf(esp, "39").length).toBeGreaterThan(5)
    expect(landOf(esp).pads.filter((p) => !p.number && p.plated !== false)).toHaveLength(0)
  })

  it("through-hole DIP: a square pad 1, round pads, drills", () => {
    const key = "Timer:NE555P"
    const l = landOf(key)
    expect(l.pads).toHaveLength(8)
    expect(l.pads.every((p) => p.layer === "through" && (p.holeDiameter ?? 0) > 0.7)).toBe(true)
    expect(padsOf(key, "1")[0].shape).not.toBe("circle")
    expect(padsOf(key, "2")[0].shape).toBe("circle")
    // DIP-8 pins 1-4 down the left and 5-8 up the right, 7.62 mm apart.
    expect(Math.abs(padsOf(key, "8")[0].x - padsOf(key, "1")[0].x)).toBeCloseTo(7.62, 2)
  })

  it("BGA: pads numbered A1 to D3, every ball a pin", () => {
    const key = "Analog_Switch:TS3A24159YZP"
    expect(part(key).pins.map((p) => p.number).sort()).toEqual(["A1", "A2", "A3", "B1", "B3", "C1", "C3", "D1", "D2", "D3"])
    expect(new Set(landOf(key).pads.map((p) => p.number))).toEqual(new Set(part(key).pins.map((p) => p.number)))
    expect(pin(key, "D2")).toMatchObject({ name: "VCC", role: "power_in" })
    expect(pin(key, "A2")).toMatchObject({ name: "GND", role: "ground" })
  })

  it("a connector with slots and non-plated holes: oval drills, no pin for the holes", () => {
    const key = "Connector:CUI_PD-30S"
    const l = landOf(key)
    const slots = l.pads.filter((p) => p.slotLength)
    expect(slots.length).toBeGreaterThanOrEqual(5)
    for (const s of slots) {
      expect(s.slotLength!).toBeGreaterThan(s.holeDiameter!)
      expect(s.layer).toBe("through")
    }
    const npth = l.pads.filter((p) => p.plated === false)
    expect(npth.length).toBeGreaterThanOrEqual(2)
    for (const h of npth) expect(h).toMatchObject({ number: "", width: h.holeDiameter, height: h.holeDiameter })
    // One pin named SH owns four pads.
    expect(padsOf(key, "SH")).toHaveLength(4)
  })

  it("RJ45: mounting pads kept as unnumbered copper, in a land of its own", () => {
    const key = "Connector:RJ45_Bel_V895-1001-AW"
    expect(part(key).landKey).toMatch(/#/)
    expect(part(key).footprintKey).toBe("Connector_RJ:RJ45_Bel_V895-1001-AW_Vertical")
    expect(landOf(key).pads.filter((p) => !p.number && p.plated !== false).length).toBeGreaterThanOrEqual(1)
    expect(imported.report.withMountingPads).toBeGreaterThanOrEqual(1)
  })

  it("USB-C paired with a real USB-C footprint: letters, slots, non-plated holes and a four-pad shield", async () => {
    const [raw] = parseSymbols(
      (await import("node:fs")).readFileSync(join(FIXTURES, "symbols", "Connector.kicad_symdir", "USB_C_Receptacle_USB2.0_16P.kicad_sym"), "utf8"),
    )
    const footprint = "Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12"
    const text = (await import("node:fs")).readFileSync(join(FIXTURES, "footprints", "Connector_USB.pretty", "USB_C_Receptacle_HRO_TYPE-C-31-M-12.kicad_mod"), "utf8")
    const fp = convertFootprint(text, footprint)
    if (!fp.ok) throw new Error(fp.reason)
    const r = convertSymbol({ ...raw, props: { ...raw.props, Footprint: footprint } }, { library: "Connector", release: "10.0.7", footprint: () => fp })
    if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
    expect(r.part.pins.map((p) => p.number).sort()).toEqual(["A1", "A12", "A4", "A5", "A6", "A7", "A8", "A9", "B1", "B12", "B4", "B5", "B6", "B7", "B8", "B9", "SH"].sort())
    const pads = r.land.land.pads
    expect(pads.filter((p) => p.number === "SH")).toHaveLength(4)
    expect(pads.filter((p) => p.number === "SH" && p.slotLength)).toHaveLength(4)
    expect(pads.filter((p) => p.plated === false)).toHaveLength(2)
    expect(pads.filter((p) => /^[AB]\d+$/.test(p.number) && p.layer === "top")).toHaveLength(16)
    // A6/B6 and A7/B7 are separate pads and separate pins.
    expect(r.part.pins.filter((p) => /^[AB]6$/.test(p.number))).toHaveLength(2)
  })
})
