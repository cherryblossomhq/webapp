import { importKicadSchematic } from "../src/model/kicad/schematic"
import type { Project } from "../src/model/types"
import { LIB_GND, LIB_R, LIB_VCC, schematic, type SchSpec, type SymSpec } from "./kicad-schematic-fixtures"

// Cached symbols for the tests of slice 3b-i (units, body styles, alternates, mirrors, hidden power
// pins, jumpers, fields, and the shapes a symbol can draw), in the spelling of KiCad 8, and a helper
// that imports a sheet of them with the extensions that need no work on net names raised.

const FONT = `(effects (font (size 1.27 1.27)))`
const pin = (type: string, at: string, length: number, name: string, number: string, extra = "") =>
  `(pin ${type} line (at ${at}) (length ${length}) ${extra} (name "${name}" ${FONT}) (number "${number}" ${FONT}))`

/** A dual operational amplifier: unit 1 and 2 are the amplifiers, unit 3 the power pins. */
export const LIB_OPAMP = `(symbol "Test:OPA2" (pin_names (offset 0.254)) (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 7.62 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Value" "OPA2" (at 0 -7.62 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (symbol "OPA2_1_1"
    (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08)) (stroke (width 0.254) (type default)) (fill (type background)))
    ${pin("output", "7.62 0 180", 2.54, "~", "1")}
    ${pin("input", "-7.62 -2.54 0", 2.54, "-", "2")}
    ${pin("input", "-7.62 2.54 0", 2.54, "+", "3")})
  (symbol "OPA2_2_1"
    (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08)) (stroke (width 0.254) (type default)) (fill (type background)))
    ${pin("output", "7.62 0 180", 2.54, "~", "7")}
    ${pin("input", "-7.62 -2.54 0", 2.54, "-", "6")}
    ${pin("input", "-7.62 2.54 0", 2.54, "+", "5")})
  (symbol "OPA2_3_1"
    (rectangle (start -2.54 5.08) (end 2.54 -5.08) (stroke (width 0.254) (type default)) (fill (type background)))
    ${pin("power_in", "0 7.62 270", 2.54, "V+", "8")}
    ${pin("power_in", "0 -7.62 90", 2.54, "V-", "4")}))`

/** A two input gate with De Morgan: body style 1 is an AND, style 2 an OR with inverted inputs. */
export const LIB_GATE = `(symbol "Test:AND2" (pin_names (offset 1.016) hide) (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${FONT})
  (property "Value" "AND2" (at 0 -5.08 0) ${FONT})
  (symbol "AND2_0_1" (arc (start 0 -3.81) (mid 3.81 0) (end 0 3.81) (stroke (width 0.254) (type default)) (fill (type background))) (polyline (pts (xy 0 3.81) (xy -3.81 3.81) (xy -3.81 -3.81) (xy 0 -3.81)) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "AND2_1_1"
    ${pin("input", "-7.62 2.54 0", 3.81, "A", "1")}
    ${pin("input", "-7.62 -2.54 0", 3.81, "B", "2")}
    ${pin("output", "7.62 0 180", 3.81, "Y", "3")})
  (symbol "AND2_1_2"
    (polyline (pts (xy -3.81 3.81) (xy 0 3.81) (xy 3.81 0) (xy 0 -3.81) (xy -3.81 -3.81) (xy -3.81 3.81)) (stroke (width 0.254) (type default)) (fill (type none)))
    ${pin("input", "-7.62 2.54 0", 3.81, "A", "1", "")}
    ${pin("input", "-7.62 -2.54 0", 3.81, "B", "2")}
    ${pin("output", "7.62 0 180", 3.81, "Y", "3")}))`

/** A microcontroller with a pin that has alternate functions, a hidden power pin, and a pin that is not connected. */
export const LIB_MCU = `(symbol "Test:MCU" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 8.89 0) ${FONT})
  (property "Value" "MCU" (at 0 -8.89 0) ${FONT})
  (symbol "MCU_0_1" (rectangle (start -5.08 7.62) (end 5.08 -7.62) (stroke (width 0.254) (type default)) (fill (type background))))
  (symbol "MCU_1_1"
    (pin bidirectional line (at -7.62 5.08 0) (length 2.54) (name "PA0" ${FONT}) (number "1" ${FONT}) (alternate "SCL" bidirectional line) (alternate "TX" output line) (alternate "VREF" power_in line))
    (pin input line (at -7.62 2.54 0) (length 2.54) (name "RST" ${FONT}) (number "2" ${FONT}))
    (pin no_connect line (at -7.62 0 0) (length 2.54) (name "NC" ${FONT}) (number "3" ${FONT}))
    (pin power_in line (at 0 10.16 270) (length 2.54) hide (name "VDD" ${FONT}) (number "4" ${FONT}))
    (pin power_in line (at 0 -10.16 90) (length 2.54) (name "GND" ${FONT}) (number "5" ${FONT}))))`

/** Pins that share a number, in a symbol that says they are one pad, and in one that does not. */
export const LIB_JUMPER = `(symbol "Test:JMP" (duplicate_pin_numbers_are_jumpers yes) (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 5.08 0) ${FONT})
  (property "Value" "JMP" (at 0 -5.08 0) ${FONT})
  (symbol "JMP_1_1"
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none)))
    ${pin("passive", "-5.08 1.27 0", 2.54, "1a", "1")}
    ${pin("passive", "-5.08 -1.27 0", 2.54, "1b", "1")}
    ${pin("passive", "5.08 0 180", 2.54, "2", "2")}))`

export const LIB_DUPS = `(symbol "Test:DUP" (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 5.08 0) ${FONT})
  (property "Value" "DUP" (at 0 -5.08 0) ${FONT})
  (symbol "DUP_1_1"
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none)))
    ${pin("passive", "-5.08 1.27 0", 2.54, "1a", "1")}
    ${pin("passive", "-5.08 -1.27 0", 2.54, "1b", "1")}
    ${pin("passive", "5.08 0 180", 2.54, "2", "2")}))`

/** Pins of different numbers that the symbol joins inside itself. */
export const LIB_GROUP = `(symbol "Test:GRP" (jumper_pin_groups ("1" "2")) (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 5.08 0) ${FONT})
  (property "Value" "GRP" (at 0 -5.08 0) ${FONT})
  (symbol "GRP_1_1"
    (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type none)))
    ${pin("passive", "-5.08 1.27 0", 2.54, "1", "1")}
    ${pin("passive", "-5.08 -1.27 0", 2.54, "2", "2")}
    ${pin("passive", "5.08 0 180", 2.54, "3", "3")}))`

/** Every shape a symbol can draw, with a stroke and a fill of its own on each, and pin shapes. */
export const LIB_SHAPES = `(symbol "Test:SHAPES" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 10.16 0) ${FONT})
  (property "Value" "SHAPES" (at 0 -10.16 0) ${FONT})
  (symbol "SHAPES_0_1"
    (rectangle (start -7.62 7.62) (end 7.62 -7.62) (radius 1.27) (stroke (width 0.508) (type dash)) (fill (type background)))
    (circle (center 0 0) (radius 2.54) (stroke (width 0.1) (type dot)) (fill (type outline)))
    (arc (start -2.54 -5.08) (mid 0 -6.35) (end 2.54 -5.08) (stroke (width 0) (type solid) (color 255 0 0 1)) (fill (type none)))
    (bezier (pts (xy -5.08 2.54) (xy -2.54 5.08) (xy 2.54 5.08) (xy 5.08 2.54)) (stroke (width 0.254) (type dash_dot)) (fill (type none)))
    (polyline (pts (xy -5.08 -2.54) (xy -3.81 -2.54) (xy -3.81 -1.27)) (stroke (width 0.254) (type dash_dot_dot)) (fill (type color) (color 0 128 0 1)))
    (text "TXT" (at 3.81 -3.81 900) (effects (font (size 1.016 1.016) bold italic) (justify left bottom))))
  (symbol "SHAPES_1_1"
    (pin input inverted (at -10.16 5.08 0) (length 2.54) (name "A" ${FONT}) (number "1" ${FONT}))
    (pin input clock (at -10.16 2.54 0) (length 2.54) (name "CLK" ${FONT}) (number "2" ${FONT}))
    (pin input input_low (at -10.16 0 0) (length 2.54) (name "~{EN}" ${FONT}) (number "3" ${FONT}))
    (pin output output_low (at 10.16 5.08 180) (length 2.54) (name "Q" ${FONT}) (number "4" ${FONT}))
    (pin input inverted_clock (at 10.16 2.54 180) (length 2.54) (name "CKB" ${FONT}) (number "5" ${FONT}))
    (pin input clock_low (at 10.16 0 180) (length 2.54) (name "CKL" ${FONT}) (number "6" ${FONT}))
    (pin input non_logic (at 0 10.16 270) (length 2.54) (name "X" ${FONT}) (number "7" ${FONT}))
    (pin power_in line (at 0 -10.16 90) (length 2.54) (name "GND" ${FONT}) (number "8" ${FONT}))))`

let n = 0
const uuid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`

/** A placed symbol with a fresh uuid. `at` is `x y` or `x y angle` in millimetres, y down. */
export const place = (lib: string, at: string, ref: string, extra: Partial<SymSpec> = {}): SymSpec => ({ lib, at, ref, uuid: uuid(), ...extra })

export const ALL_LIBS = [LIB_R, LIB_GND, LIB_VCC, LIB_OPAMP, LIB_GATE, LIB_MCU, LIB_JUMPER, LIB_DUPS, LIB_GROUP, LIB_SHAPES]



/** A sheet of the given symbols, wires and labels imported with the extensions built, S2 raised for measurement. */
export function importSheet(spec: SchSpec): Project {
  const r = importKicadSchematic(schematic({ libs: ALL_LIBS, ...spec }))
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r.project
}
