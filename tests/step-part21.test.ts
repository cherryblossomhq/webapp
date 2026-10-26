import { describe, expect, test } from "vitest"
import { rawString, real, str } from "../src/export/step/format"
import { parsePart21, Typed, writeInstance, type Instance } from "../src/export/step/part21"

// Every awkward thing a Part 21 file can hold, with CRLF line ends.
const SAMPLE = [
  "ISO-10303-21;",
  "HEADER;",
  "/* written by hand; #1 */",
  "FILE_NAME('a;b #4.stp','2026-10-21T00:00:00',('x'),(''),'','','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
  "ENDSEC;",
  "DATA;",
  "/* a comment with #99, a ; and 'quotes' */",
  "#1=PRODUCT('U#12; it''s','/* not a comment */',' ',(#2));",
  "#2 = PRODUCT_CONTEXT ( '' , #3 ,",
  "  'mechanical' ) ;",
  "#3=APPLICATION_CONTEXT('''quoted'' and \\X2\\00E9\\X0\\');",
  "#4=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );",
  "#5=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#4,'distance_accuracy_value','');",
  "#6=B_SPLINE_CURVE_WITH_KNOTS('',3,(#1,#2),.UNSPECIFIED.,.F.,.F.,(4,4),",
  "(0.,1.),.UNSPECIFIED.);",
  "#7=SOMETHING($,*,\"0FF\",-1.5E+3,(),('a','b'),#99);",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\r\n")

const byId = (instances: Instance[], id: number) => instances.find((i) => i.id === id)!

/** Renumbers by adding 100; #99 doesn't exist and is dropped. */
const shift = (id: number) => (id === 99 ? undefined : id + 100)
const write = (inst: Instance) => writeInstance(inst, shift, rawString)

describe("Part 21 reader", () => {
  const file = parsePart21(SAMPLE)

  test("reads the header and every instance", () => {
    expect(file.errors).toBe(0)
    expect(file.header.map((h) => h.type)).toEqual(["FILE_NAME", "FILE_SCHEMA"])
    expect(file.instances.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(byId(file.instances, 1).parts[0].type).toBe("PRODUCT")
  })

  test("keeps strings exactly, whatever they contain", () => {
    const product = byId(file.instances, 1).parts[0].params
    expect(product[0]).toBe("'U#12; it''s'")
    expect(product[1]).toBe("'/* not a comment */'")
    expect(byId(file.instances, 3).parts[0].params[0]).toBe("'''quoted'' and \\X2\\00E9\\X0\\'")
  })

  test("reads complex instances part by part", () => {
    const unit = byId(file.instances, 4)
    expect(unit.complex).toBe(true)
    expect(unit.parts.map((p) => p.type)).toEqual(["LENGTH_UNIT", "NAMED_UNIT", "SI_UNIT"])
    expect(unit.parts[2].params).toEqual([".MILLI.", ".METRE."])
  })

  test("reads typed parameters, unset and derived values, binaries, numbers and empty lists", () => {
    const measure = byId(file.instances, 5).parts[0].params[0]
    expect(measure).toBeInstanceOf(Typed)
    expect((measure as Typed).type).toBe("LENGTH_MEASURE")
    expect((measure as Typed).params).toEqual(["1.E-07"])
    expect(byId(file.instances, 7).parts[0].params).toEqual(["$", "*", '"0FF"', "-1.5E+3", [], ["'a'", "'b'"], 99])
  })

  test("renumbers references and nothing inside strings", () => {
    expect(write(byId(file.instances, 1))).toBe("PRODUCT('U#12; it''s','/* not a comment */',' ',(#102))")
    expect(write(byId(file.instances, 2))).toBe("PRODUCT_CONTEXT('',#103,'mechanical')")
    expect(write(byId(file.instances, 4))).toBe("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
    expect(write(byId(file.instances, 5))).toBe(
      "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#104,'distance_accuracy_value','')",
    )
    expect(write(byId(file.instances, 6))).toBe(
      "B_SPLINE_CURVE_WITH_KNOTS('',3,(#101,#102),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.)",
    )
  })

  test("a reference to nothing is unset, or left out of a list", () => {
    const inst: Instance = { id: 8, complex: false, parts: [new Typed("X", [99, [1, 99, 2]])] }
    expect(write(inst)).toBe("X($,(#101,#102))")
  })

  test("references already in the output's numbering are kept", () => {
    const inst: Instance = { id: 8, complex: false, parts: [new Typed("X", [[1, -7]])] }
    expect(write(inst)).toBe("X((#101,#7))")
  })

  test("reads it the same with LF line ends", () => {
    const lf = parsePart21(SAMPLE.replace(/\r\n/g, "\n"))
    expect(lf.instances.map(write)).toEqual(file.instances.map(write))
  })

  test("skips a statement it can't read and goes on", () => {
    const broken = parsePart21(SAMPLE.replace("#5=UNCERTAINTY", "#5=UNCERTAINTY((("))
    expect(broken.errors).toBe(1)
    expect(broken.instances.map((i) => i.id)).toEqual([1, 2, 3, 4, 6, 7])
  })

  test("keeps going after an unterminated string at the end", () => {
    const cut = parsePart21("ISO-10303-21;\nDATA;\n#1=A('x');\n#2=B('unterminated")
    expect(cut.instances.map((i) => i.id)).toEqual([1])
    expect(cut.errors).toBe(1)
  })
})

describe("Part 21 values", () => {
  test("reals always have a decimal point and no trailing zeros", () => {
    expect(real(1, 7)).toBe("1.")
    expect(real(-0.25, 7)).toBe("-0.25")
    expect(real(0, 7)).toBe("0.")
    expect(real(-1e-12, 7)).toBe("0.")
    expect(real(1e-6, 7)).toBe("0.000001")
    expect(real(12.3456789123, 7)).toBe("12.3456789")
    expect(real(2.5e21, 7)).toBe("2.5E21")
    expect(real(NaN, 7)).toBe("0.")
  })

  test("strings double quotes and backslashes and escape everything not printable ASCII", () => {
    expect(str("it's")).toBe("'it''s'")
    expect(str("a\\b")).toBe("'a\\\\b'")
    expect(str("Résistance")).toBe("'R\\X2\\00E9\\X0\\sistance'")
    expect(str("電源")).toBe("'\\X2\\96FB6E90\\X0\\'")
    expect(str("a😀b")).toBe("'a\\X4\\0001F600\\X0\\b'")
    expect(str("line\nbreak")).toBe("'linebreak'")
  })

  test("a string copied from another file stays as it was when it is ASCII", () => {
    expect(rawString("'U#12; it''s \\X2\\00E9\\X0\\'")).toBe("'U#12; it''s \\X2\\00E9\\X0\\'")
    expect(rawString("'δ'")).toBe("'\\X2\\03B4\\X0\\'")
  })
})
