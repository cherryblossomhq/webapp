import { describe, expect, it } from "vitest"
import { PARTS } from "../src/model/library"
import { parseValue, searchLibrary } from "../src/model/search"

const ids = (query: string) => searchLibrary(query).map((h) => h.part.id)
const top = (query: string) => searchLibrary(query)[0]

describe("parts search", () => {
  it("lists every part for an empty query", () => {
    expect(ids("  ")).toEqual(PARTS.map((p) => p.id))
  })

  it("finds parts by name, keyword, MPN fragment and synonym", () => {
    expect(ids("resistor")[0]).toBe("resistor")
    expect(ids("555")[0]).toBe("ne555")
    expect(ids("328p")[0]).toBe("atmega328p")
    expect(ids("op-amp")[0]).toBe("lm358")
    expect(ids("ldo")).toContain("ams1117_3v3")
    expect(ids("mosfet")).toEqual(expect.arrayContaining(["nmos", "pmos"]))
    expect(ids("usb serial")[0]).toBe("ch340c")
  })

  it("forgives typos and plurals", () => {
    expect(ids("regualtor")).toEqual(expect.arrayContaining(["ams1117_3v3", "lm7805"]))
    expect(ids("potentiometr")[0]).toBe("potentiometer")
    expect(ids("resistors")[0]).toBe("resistor")
    // A part number with a different digit is a different part, not a typo.
    expect(ids("ne556")).toEqual([])
  })

  it("reads values into the properties a placed part gets", () => {
    expect(top("10k")).toMatchObject({ part: { id: "resistor" }, props: { resistance: "10k" } })
    expect(top("4k7")).toMatchObject({ part: { id: "resistor" }, props: { resistance: "4.7k" } })
    expect(top("220 ohm")).toMatchObject({ part: { id: "resistor" }, props: { resistance: "220" } })
    expect(top("100n")).toMatchObject({ part: { id: "capacitor" }, props: { capacitance: "100nF" } })
    expect(top("10uF electrolytic")).toMatchObject({ part: { id: "capacitor_polarized" }, props: { capacitance: "10uF" } })
    expect(top("16 MHz")).toMatchObject({ part: { id: "crystal" }, props: { frequency: "16MHz" } })
    expect(top("red led")).toMatchObject({ part: { id: "led" }, props: { color: "red" } })
    expect(top("5.1v zener")).toMatchObject({ part: { id: "zener" }, props: { voltage: "5.1V" } })
  })

  it("reads packages and pin counts", () => {
    expect(top("100nF 0603")).toMatchObject({ part: { id: "capacitor" }, props: { capacitance: "100nF" }, footprint: "0603" })
    expect(top("10k 1206")).toMatchObject({ part: { id: "resistor" }, footprint: "1206" })
    expect(ids("sot-23")).toEqual(expect.arrayContaining(["npn", "pnp", "nmos", "pmos"]))
    expect(top("to-220")).toMatchObject({ part: { id: "lm7805" }, footprint: "to220_3" })
    expect(ids("6 pin header")[0]).toBe("header_1x6")
    expect(ids("header 4")[0]).toBe("header_1x4")
  })

  it("normalizes voltages, so 3.3V finds the 3v3 regulator", () => {
    expect(ids("3.3V regulator")).toEqual(["ams1117_3v3", "ap2112k_3v3"])
    expect(ids("5v regulator")).toEqual(["lm7805", "ams1117_5v0"])
  })

  it("falls back to the closest parts, marked partial, when not every word matches", () => {
    const hits = searchLibrary("ldo tps7a02")
    expect(hits[0]).toMatchObject({ part: { id: "ams1117_3v3" }, partial: true })
    expect(searchLibrary("bme280")).toEqual([])
  })

  it("searches the project's own parts first", () => {
    const own = { ...PARTS.find((p) => p.id === "lm358")!, id: "bme280-abc123", name: "BME280", mpn: "BME280", custom: true }
    expect(searchLibrary("bme280", [own])[0].part.id).toBe("bme280-abc123")
    expect(searchLibrary("", [own])[0].part.id).toBe("bme280-abc123")
  })
})

describe("engineering values", () => {
  it("parses schematic notation and leaves part numbers alone", () => {
    expect(parseValue("1m")).toEqual({ prop: "resistance", value: "1M" })
    expect(parseValue("2u2")).toEqual({ prop: "capacitance", value: "2.2uF" })
    expect(parseValue("10uh")).toEqual({ prop: "inductance", value: "10uH" })
    expect(parseValue("32.768khz")).toEqual({ prop: "frequency", value: "32.768kHz" })
    expect(parseValue("3v3")).toEqual({ prop: "voltage", value: "3.3V" })
    expect(parseValue("2n3904")).toBeUndefined()
    expect(parseValue("0805")).toBeUndefined()
  })
})
