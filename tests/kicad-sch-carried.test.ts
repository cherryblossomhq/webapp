import { describe, expect, it } from "vitest"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import type { Project, SymbolDrawing } from "../src/model/types"
import { schematic } from "./kicad-schematic-fixtures"

// Nothing a symbol says is counted as imported unless the project holds it: every node under
// `lib_symbols` and every symbol node that the import accounts as imported is looked up here, in the
// symbol drawing or the placed component, with no list of paths that are let through. A path the
// table below does not know fails the test, so a new node cannot be counted without being carried.

const E = (inner = "") => `(effects (font (size 2 2) (thickness 0.3) bold italic (color 10 20 30 1)) (justify left top)${inner})`

const LIB_FULL = `(symbol "T:Full" (pin_names (offset 0.762)) (pin_numbers (hide yes)) (duplicate_pin_numbers_are_jumpers yes) (jumper_pin_groups ("1" "2")) (body_styles demorgan "Normal" "Alt")
  (in_bom yes) (on_board yes) (exclude_from_sim no) (in_pos_files yes)
  (property "Reference" "U" (at 1.27 2.54 90) ${E()} (show_name yes) (do_not_autoplace yes))
  (property "Value" "Full" (at -1.27 -2.54 0) (effects (font (size 1.27 1.27)) hide))
  (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27))) (hide yes))
  (symbol "Full_0_1"
    (polyline (pts (xy -2.54 0) (xy 2.54 0)) (stroke (width 0.254) (type dash) (color 1 2 3 1)) (fill (type outline)))
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (radius 0.5) (stroke (width 0.1) (type dot)) (fill (type color) (color 4 5 6 1)))
    (circle (center 0 0) (radius 1.27) (stroke (width 0) (type default)) (fill (type background)))
    (arc (start -1.27 0) (mid 0 1.27) (end 1.27 0) (stroke (width 0) (type default)) (fill (type none)))
    (bezier (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0) (type default)) (fill (type none)))
    (text "T" (at 1 1 900) ${E()}))
  (symbol "Full_1_1" (unit_name "First")
    (pin input inverted (at -5.08 0 0) (length 2.54) (name "~{A}" (effects (font (size 1.5 1.5)))) (number "1" (effects (font (size 1.6 1.6)))) (alternate "B" output clock))
    (pin power_in line (at 0 5.08 270) (length 2.54) hide (name "V" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
  (symbol "Full_2_1"
    (pin passive line (at 5.08 0 180) (length 2.54) (name "C" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27))))))
  (symbol "Full_1_2"
    (pin input line (at -5.08 0 0) (length 2.54) (name "A2" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

const LIB_PWR = `(symbol "T:Pwr" (power local) (symbol "Pwr_1_1" (pin power_in line (at 0 0 90) (length 0) hide (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

const sheet = (extra = "") =>
  schematic({
    version: 20231120,
    libs: [LIB_FULL, LIB_PWR],
    symbols: [
      {
        lib: "T:Full",
        at: "50.8 50.8 90",
        ref: "U1",
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        mirror: "x",
        unit: 2,
        extra: `(body_style 2) ${extra}`,
      },
    ],
  }).replace(`(property "Reference" "U1" (at 0 0 0) (effects (font (size 1.27 1.27))))`, `(property "Reference" "U1" (at 52 49 90) (effects (font (size 1.5 1.5) bold) (justify right)) (show_name yes) (do_not_autoplace yes))`).replace(`(pin "1" (uuid`, `(pin "1" (uuid`)

type Built = { project: Project; drawing: SymbolDrawing }
type Check = (b: Built) => boolean

const first = <T,>(v: T[] | undefined) => v?.[0]

const CHECKS: [RegExp, Check][] = [
  [/^lib_symbols$/, (b) => !!b.project.parts?.length],
  [/^lib_symbols>symbol$/, (b) => b.drawing.name === "T:Full"],
  [/^lib_symbols>symbol>power$/, (b) => Object.values(b.project.symbols ?? {}).some((d) => d.power === "local")],
  [/^lib_symbols>symbol>body_styles$/, (b) => b.drawing.bodyStyles === 2 && b.drawing.bodyStyleNames?.join() === "Normal,Alt"],
  [/^lib_symbols>symbol>duplicate_pin_numbers_are_jumpers$/, (b) => b.drawing.jumpers?.duplicates === true],
  [/^lib_symbols>symbol>jumper_pin_groups/, (b) => b.drawing.jumpers?.groups?.[0]?.join() === "1,2"],
  [/^lib_symbols>symbol>pin_names(>offset)?$/, (b) => Math.abs((b.drawing.pinNames?.offset ?? 0) - 0.762 / 12.7) < 1e-6],
  [/^lib_symbols>symbol>pin_numbers(>hide)?$/, (b) => b.drawing.pinNumbersHidden === true],
  [/^lib_symbols>symbol>property$/, (b) => b.drawing.fields.map((f) => f.name).join() === "Reference,Value,Footprint"],
  [/^lib_symbols>symbol>property>at$/, (b) => Math.abs(b.drawing.fields[0].place.x - 0.1) < 1e-6 && b.drawing.fields[0].place.angle === 90],
  [/^lib_symbols>symbol>property>effects$/, (b) => b.drawing.fields[1].place.hidden === true],
  [/^lib_symbols>symbol>property>effects>hide$/, (b) => b.drawing.fields[1].place.hidden === true],
  [/^lib_symbols>symbol>property>hide$/, (b) => b.drawing.fields[2].place.hidden === true],
  [/^lib_symbols>symbol>property>effects>font$/, (b) => b.drawing.fields[0].place.size !== undefined],
  [/^lib_symbols>symbol>property>effects>font>size$/, (b) => Math.abs((b.drawing.fields[0].place.size ?? 0) - 2 / 12.7) < 1e-6],
  [/^lib_symbols>symbol>property>effects>font>thickness$/, (b) => Math.abs((b.drawing.fields[0].place.thickness ?? 0) - 0.3 / 12.7) < 1e-6],
  [/^lib_symbols>symbol>property>effects>font>bold$/, (b) => b.drawing.fields[0].place.bold === true],
  [/^lib_symbols>symbol>property>effects>font>italic$/, (b) => b.drawing.fields[0].place.italic === true],
  [/^lib_symbols>symbol>property>effects>font>color$/, (b) => b.drawing.fields[0].place.color === "#0a141e"],
  [/^lib_symbols>symbol>property>effects>justify$/, (b) => b.drawing.fields[0].place.h === "left" && b.drawing.fields[0].place.v === "top"],
  [/^lib_symbols>symbol>property>show_name$/, (b) => b.drawing.fields[0].place.showName === true],
  [/^lib_symbols>symbol>symbol$/, (b) => b.drawing.units === 2],
  [/^lib_symbols>symbol>symbol>unit_name$/, (b) => b.drawing.unitNames?.[1] === "First"],
  // shapes
  [/^lib_symbols>symbol>symbol>polyline(>pts(>xy)?)?$/, (b) => b.drawing.items.some((i) => i.kind === "polyline" && i.points.length === 2)],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>stroke$/, (b) => b.drawing.items.length >= 5],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>stroke>width$/, (b) => b.drawing.items.some((i) => i.kind !== "text" && (i.width ?? 0) > 0)],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>stroke>type$/, (b) => b.drawing.items.some((i) => i.kind !== "text" && i.dash === "dash") && b.drawing.items.some((i) => i.kind !== "text" && i.dash === "dot")],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>stroke>color$/, (b) => b.drawing.items.some((i) => i.kind === "polyline" && i.color === "#010203")],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>fill$/, (b) => b.drawing.items.some((i) => i.kind !== "text" && i.fill !== undefined)],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>fill>type$/, (b) => ["outline", "color", "background"].every((k) => b.drawing.items.some((i) => i.kind !== "text" && i.fill === k))],
  [/^lib_symbols>symbol>symbol>(polyline|rectangle|circle|arc|bezier)>fill>color$/, (b) => b.drawing.items.some((i) => i.kind !== "text" && i.fillColor === "#040506")],
  [/^lib_symbols>symbol>symbol>rectangle(>start|>end)?$/, (b) => b.drawing.items.some((i) => i.kind === "rectangle")],
  [/^lib_symbols>symbol>symbol>rectangle>radius$/, (b) => b.drawing.items.some((i) => i.kind === "rectangle" && (i.radius ?? 0) > 0)],
  [/^lib_symbols>symbol>symbol>circle(>center|>radius)?$/, (b) => b.drawing.items.some((i) => i.kind === "circle" && i.r > 0)],
  [/^lib_symbols>symbol>symbol>arc(>start|>mid|>end)?$/, (b) => b.drawing.items.some((i) => i.kind === "arc")],
  [/^lib_symbols>symbol>symbol>bezier(>pts(>xy)?)?$/, (b) => b.drawing.items.some((i) => i.kind === "bezier" && i.points.length === 4)],
  [/^lib_symbols>symbol>symbol>text$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.text === "T")],
  [/^lib_symbols>symbol>symbol>text>at$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.angle === 90)],
  [/^lib_symbols>symbol>symbol>text>effects(>font)?$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.size !== undefined)],
  [/^lib_symbols>symbol>symbol>text>effects>font>size$/, (b) => b.drawing.items.some((i) => i.kind === "text" && Math.abs((i.size ?? 0) - 2 / 12.7) < 1e-6)],
  [/^lib_symbols>symbol>symbol>text>effects>font>thickness$/, (b) => b.drawing.items.some((i) => i.kind === "text" && Math.abs((i.thickness ?? 0) - 0.3 / 12.7) < 1e-6)],
  [/^lib_symbols>symbol>symbol>text>effects>font>(bold|italic)$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.bold && i.italic)],
  [/^lib_symbols>symbol>symbol>text>effects>font>color$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.color === "#0a141e")],
  [/^lib_symbols>symbol>symbol>text>effects>justify$/, (b) => b.drawing.items.some((i) => i.kind === "text" && i.h === "left" && i.v === "top")],
  // pins
  [/^lib_symbols>symbol>symbol>pin$/, (b) => b.drawing.pins.length === 4 && b.drawing.pins[0].shape === "inverted"],
  [/^lib_symbols>symbol>symbol>pin>at$/, (b) => b.drawing.pins[0].x === -5.08 / 12.7 && b.drawing.pins[1].angle === 270],
  [/^lib_symbols>symbol>symbol>pin>length$/, (b) => Math.abs(b.drawing.pins[0].length - 0.2) < 1e-6],
  [/^lib_symbols>symbol>symbol>pin>hide$/, (b) => b.drawing.pins[1].hidden === true],
  [/^lib_symbols>symbol>symbol>pin>name$/, (b) => b.drawing.pins[0].name === "~{A}"],
  [/^lib_symbols>symbol>symbol>pin>number$/, (b) => b.drawing.pins[0].number === "1"],
  [/^lib_symbols>symbol>symbol>pin>name>effects(>font(>size)?)?$/, (b) => Math.abs((b.drawing.pins[0].nameSize ?? 0) - 1.5 / 12.7) < 1e-6],
  [/^lib_symbols>symbol>symbol>pin>number>effects(>font(>size)?)?$/, (b) => Math.abs((b.drawing.pins[0].numberSize ?? 0) - 1.6 / 12.7) < 1e-6],
  [/^lib_symbols>symbol>symbol>pin>alternate$/, (b) => b.drawing.pins[0].alternates?.[0]?.name === "B" && b.drawing.pins[0].alternates[0].type === "output" && b.drawing.pins[0].alternates[0].shape === "clock"],
  // the derived or table-settled ones the import says are not needed
  // placed symbols
  [/^symbol$/, (b) => b.project.components.length === 1],
  [/^symbol>mirror$/, (b) => b.project.components[0].sch.mirror === "x"],
  [/^symbol>unit$/, (b) => b.project.components[0].unit === 2],
  [/^symbol>body_style$/, (b) => b.project.components[0].bodyStyle === 2],
  [/^symbol>property$/, (b) => first(Object.keys(b.project.components[0].fields ?? {})) === "Reference" && Object.keys(b.project.components[0].fields ?? {}).length === 3],
  [/^symbol>property>at$/, (b) => Math.abs((b.project.components[0].fields?.Reference.x ?? 0) - (52 - 50.8) / 12.7) < 1e-6 && Math.abs((b.project.components[0].fields?.Reference.y ?? 0) - (50.8 - 49) / 12.7) < 1e-6],
  [/^symbol>property>effects(>font(>size|>bold)?)?$/, (b) => b.project.components[0].fields?.Reference.bold === true && b.project.components[0].fields.Reference.size !== undefined],
  [/^symbol>property>effects>justify$/, (b) => b.project.components[0].fields?.Reference.h === "right"],
  [/^symbol>property>effects>hide$/, (b) => b.project.components[0].fields?.Footprint.hidden === true],
  [/^symbol>property>hide$/, (b) => b.project.components[0].fields?.Footprint.hidden === true],
  [/^symbol>property>show_name$/, (b) => b.project.components[0].fields?.Reference.showName === true],
  [/^symbol>pin$/, (b) => b.project.components[0].pinAlt?.["1"] === "B"],
  [/^symbol>pin>alternate$/, (b) => b.project.components[0].pinAlt?.["1"] === "B"],
]

describe("every symbol node counted as imported is held by the project", () => {
  const text = sheet().replace(`(pin "1" (uuid`, `(pin "1" (alternate "B") (uuid`)
  const r = importKicadSchematic(text, { built: new Set(["S2", "S5", "S6", "S10"]) })

  it("imports the file", () => {
    expect(r.status === "imported" ? "" : (r as { message: string }).message).toBe("")
  })

  it("finds each counted path in the drawing or the component", () => {
    if (r.status !== "imported") throw new Error("not imported")
    const project = r.project
    const drawing = Object.values(project.symbols ?? {})[0]
    const b: Built = { project, drawing }
    const paths = [...(r.report.account?.importedPaths.keys() ?? [])].filter((p) => /^(lib_symbols>symbol|lib_symbols$|symbol(>|$))/.test(p) && !/^symbol>(at|lib_id|lib_name|uuid|instances|in_bom|on_board|dnp|exclude_from_sim|in_pos_files|fields_autoplaced)/.test(p) && !/^lib_symbols>symbol>(in_bom|on_board|exclude_from_sim|in_pos_files)$/.test(p) && !/>uuid$/.test(p))
    expect(paths.length).toBeGreaterThan(40)
    const unknown: string[] = []
    const failed: string[] = []
    for (const path of paths) {
      const hits = CHECKS.filter(([re]) => re.test(path))
      if (!hits.length) unknown.push(path)
      else if (!hits.some(([, check]) => check(b))) failed.push(path)
    }
    expect(unknown).toEqual([])
    expect(failed).toEqual([])
  })

  it("says what a text asks for that the editor draws its own way", () => {
    const text2 = sheet().replace(`(property "Value" "Full" (at -1.27 -2.54 0) (effects (font (size 1.27 1.27)) hide))`, `(property "Value" "Full" (at -1.27 -2.54 0) (effects (font (face "Arial") (size 1.27 1.27)) hide))`)
    const r2 = importKicadSchematic(text2, { built: new Set(["S2", "S5", "S6", "S10"]) })
    if (r2.status !== "imported") throw new Error("not imported")
    expect(r2.report.entries.find((e) => e.code === "text-style-not-brought")?.why).toContain("a font of its own")
  })
})
