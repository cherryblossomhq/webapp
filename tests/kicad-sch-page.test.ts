import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { KICAD_LINE_PITCH, kicadTextWidth } from "../src/export/kicadFont"
import { textSize } from "../src/model/drawings"
import type { Project, SchematicDrawing } from "../src/model/types"
import { built } from "./built"

// How a sheet drawn in the editor lands on KiCad's page. A user's export (an INA125P load cell amplifier, November 2026)
// opened in KiCad with its grounds drawn over each other and the labels between them on the chip's pins, every pin and
// wire end off KiCad's grid, the notes under the design wrapped out of their box and onto the title block, and a text
// beside a connector run into its ground.

const EXAMPLES = ["blinker", "regulator", "mcu", "node", "esp32-robot"]

const schematics = async (p: Project) => Object.entries((await kicadFiles(p)).files).filter(([name]) => name.endsWith(".kicad_sch")).map(([, text]) => text)
const nums = (s: string) => s.split(/\s+/).map(Number)
const onGrid = (mm: number) => Math.abs(mm / 1.27 - Math.round(mm / 1.27)) < 1e-4

describe("the editor's power and ground ports in KiCad", () => {
  it("are drawn at the editor's size, from their pin, with the pin's name hidden", async () => {
    let seen = 0
    for (const id of EXAMPLES) {
      for (const sch of await schematics(built(id))) {
        for (const m of sch.matchAll(/\n {4}\(symbol "Custom:(ground|vcc)_(up|down|left|right)(?:_local)?"\n[\s\S]*?\n {4}\)(?=\n)/g)) {
          seen++
          const block = m[0]
          const angle = { right: 0, up: 90, left: 180, down: 270 }[m[2] as "up"]
          expect(block, `${id} ${m[1]}_${m[2]}`).toMatch(new RegExp(String.raw`\(pin power_in line\n {10}\(at 0 0 ${angle}\)\n {10}\(length 0\)`))
          expect(block).toMatch(/\(pin_names\n {8}\(offset 0\)\n {8}\(hide yes\)\n {6}\)/)
          // The editor's ground is three bars 2.54 mm wide under a 1.27 mm stem, its supply an arrow at the end of a 2.54 mm one: the converter's reached 4.95 mm.
          const points = [...block.matchAll(/\(xy (\S+) (\S+)\)/g)].flatMap((p) => [Number(p[1]), Number(p[2])])
          expect(points.length).toBeGreaterThan(0)
          expect(Math.max(...points.map(Math.abs))).toBeLessThanOrEqual(2.54 + 1e-6)
        }
      }
    }
    expect(seen).toBeGreaterThan(5)
  })
})

describe("a sheet drawn in the editor on KiCad's page", () => {
  it("has every wire end and every port's pin on KiCad's 50 mil grid", async () => {
    for (const id of EXAMPLES) {
      for (const sch of await schematics(built(id))) {
        const wires = [...sch.matchAll(/\n {2}\(wire\n {4}\(pts\s*((?:\(xy [^)]*\)\s*)+)\)/g)].flatMap((m) => [...m[1].matchAll(/\(xy (\S+) (\S+)\)/g)].flatMap((p) => [Number(p[1]), Number(p[2])]))
        const ports = [...sch.matchAll(/\n {2}\(symbol\n {4}\(lib_id "Custom:[^"]+"\)\n {4}\(at (\S+ \S+) \S+\)/g)].flatMap((m) => nums(m[1]))
        expect(wires.length, id).toBeGreaterThan(0)
        expect(ports.length, id).toBeGreaterThan(0)
        expect([...wires, ...ports].filter((v) => !onGrid(v)), id).toEqual([])
      }
    }
  })

  // The design's title above it and its notes in a box below, as Sakura draws a sheet.
  const NOTES = [
    "NOTES DE CONCEPTION",
    "Load cell DYLF-102 : 2 mV/V. Excitation 10 V = VREF10 + boost Q1 (datasheet fig. 4 : ref interne limitee a ~5 mA).",
    "INA125 : G = 4 + 60k/RG = 4 + 60k/120 = 504  ->  VOUT FS = 20 mV x 504 = 10.08 V  (DAQ +-10 V).",
    "R1 = RG 120 ohm 1% metal film THT, soude directement (pas de support).",
    "Filtre RC : fc = 1 / (2 pi x 680 x 470 nF) = 498 Hz  (echantillonnage 1 kHz).",
    "Alim simple 12 V non regulee : VCC = VIN - 0.3 V (D1). VREF10 demande VCC >= 11.3 V.",
    "IAREF, VREFCOM, V- a GND (datasheet fig. 5) : sortie 0 a ~10.8 V, force dans un seul sens.",
    "VREFBG, VREF2.5, VREF5 non connectes (voulu).",
  ].join("\n")
  const title: SchematicDrawing = { id: "title", type: "text", text: "3.3 V SUPPLY - AMS1117", x: -4.7, y: 2.6, size: 0.5, bold: true }
  const notes: SchematicDrawing = { id: "notes", type: "text", text: NOTES, x: -4.7, y: -5, size: 0.14, border: true }
  const withDrawings = (p: Project): Project => ({ ...p, drawings: [...(p.drawings ?? []), title, notes] })

  it("keeps the notes under a design in their box, on the page and clear of the title block", async () => {
    const [sch] = await schematics(withDrawings(built("regulator")))
    const paper = sch.match(/\(paper\s+"?(A\d)"?/)![1]
    const [paperW, paperH] = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] }[paper as "A4"]
    const box = sch.match(/\(text_box "NOTES DE CONCEPTION[\s\S]*?\n {4}\(at (\S+ \S+) 0\)\n {4}\(size (\S+ \S+)\)\n {4}\(margins (\S+ \S+ \S+ \S+)\)[\s\S]*?\(font \(size ([\d.]+ [\d.]+)\)/)!
    const [x, y] = nums(box[1])
    const [w, h] = nums(box[2])
    const [ml, mt, mr, mb] = nums(box[3])
    const [height, width] = nums(box[4])
    // KiCad wraps a line longer than the box, and the lines after it run out of the bottom.
    const lines = NOTES.split("\n")
    for (const line of lines) expect(kicadTextWidth(line, width), line).toBeLessThanOrEqual(w - ml - mr)
    expect(height * (1.15 + (lines.length - 1) * KICAD_LINE_PITCH)).toBeLessThanOrEqual(h - mt - mb + 1e-6)
    expect(width).toBeLessThan(height)
    // On the paper, and above KiCad's title block (the bottom 44 mm of its right side).
    expect(x).toBeGreaterThan(10)
    expect(x + w).toBeLessThan(paperW - 10)
    expect(y).toBeGreaterThan(10)
    expect(y + h).toBeLessThan(paperH - 44)
  })

  it("draws a text of the drawing tools no wider than the editor's sheet does", async () => {
    const [sch] = await schematics(withDrawings(built("regulator")))
    const font = sch.match(/\(text "3\.3 V SUPPLY - AMS1117"[\s\S]*?\(font \(size ([\d.]+ [\d.]+)\)/)!
    const [height, width] = nums(font[1])
    expect(height).toBeCloseTo(0.5 * 12.7, 4)
    expect(kicadTextWidth(title.type === "text" ? title.text : "", width)).toBeLessThanOrEqual(textSize(title as Extract<SchematicDrawing, { type: "text" }>).width * 12.7)
  })
})

describe("kicadTextWidth", () => {
  it("measures KiCad's stroke font, in 21sts of the glyph width", () => {
    expect(kicadTextWidth("H", 21)).toBe(22)
    expect(kicadTextWidth(" ~", 21)).toBe(16 + 15)
    expect(kicadTextWidth("é", 21)).toBe(kicadTextWidth("e", 21))
    expect(kicadTextWidth("中", 21)).toBe(31)
    expect(kicadTextWidth("GND", 1.27)).toBeCloseTo(((21 + 22 + 21) / 21) * 1.27, 9)
  })
})
