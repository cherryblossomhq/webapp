// Schematics for the KiCad importer's tests, written by hand: a few lines each, in the spelling of
// the release being tested, so that each switch of the reader has a file that needs it.

export const ROOT_UUID = "00000000-0000-4000-8000-000000000001"

/** The cached drawing of KiCad's `Device:R`: two passive pins 7.62 mm apart, on the symbol's y axis. */
export const LIB_R = `(symbol "Device:R" (pin_numbers hide) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
  (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
  (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`

/** `power:GND`: one hidden power-input pin at the symbol's origin, pointing down. */
export const LIB_GND = `(symbol "power:GND" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) hide))
  (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
  (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) hide (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

/** `power:VCC`: one hidden power-input pin at the origin, pointing up. */
export const LIB_VCC = `(symbol "power:VCC" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) hide))
  (property "Value" "VCC" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
  (symbol "VCC_0_1" (polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))) (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "VCC_1_1" (pin power_in line (at 0 0 90) (length 0) hide (name "VCC" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

/** A three-pin part with an arc in its drawing and a pin of the type "no connect". */
export const LIB_U = `(symbol "Test:U" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
  (property "Value" "U" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
  (symbol "U_0_1" (rectangle (start -3.81 3.81) (end 3.81 -3.81) (stroke (width 0.254) (type default)) (fill (type background))) (arc (start -1.27 0) (mid 0 1.27) (end 1.27 0) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "U_1_1"
    (pin input line (at -6.35 2.54 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin output line (at 6.35 2.54 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
    (pin no_connect line (at 0 -6.35 90) (length 2.54) (name "NC" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))))`

export interface SymSpec {
  lib: string
  /** `x y` or `x y angle`. */
  at: string
  ref: string
  value?: string
  footprint?: string
  uuid: string
  mirror?: "x" | "y"
  unit?: number
  /** Extra nodes inside the symbol (a flag, `dnp`...). */
  extra?: string
  /** The unit the instance data gives, where the symbol's own `(unit N)` says another. */
  instanceUnit?: number
  /** Instance data as `path|reference` (KiCad 7 and later), where the default is the root sheet and `ref`. An empty list writes none. */
  instances?: string[]
  /** S9: variant nodes inside each instance's `path`, written as given: `(variant (name "A") (dnp yes))`. */
  variants?: string
}

export interface SchSpec {
  version?: number
  libs?: string[]
  symbols?: SymSpec[]
  /** Wires as `x1 y1 x2 y2`. */
  wires?: string[]
  junctions?: string[]
  noConnects?: string[]
  /** Local labels as `NAME x y angle`. */
  labels?: string[]
  /** Anything else at the top level: sheets, text, buses. */
  body?: string[]
  uuid?: string
  generator?: string
  /** The project's name in instance data (KiCad 7 and later). */
  project?: string
  /** Text between the header and the library cache (the title block, the paper). */
  head?: string
  /** Lists to leave out of the end of the file (the root symbol_instances list of KiCad 6 is written unless `false`). */
  rootList?: boolean
  /** The paths of KiCad 6's root list, as `path|reference` and `|value|footprint` where they have them, instead of one per symbol of this file. */
  rootEntries?: string[]
}

const stampOf = (spec: SchSpec) => spec.version ?? 20230121

/** The `hide` of a property's effects in the spelling of the stamp. */
const hide = (version: number) => (version >= 20241004 ? "(hide yes)" : "hide")

function placed(s: SymSpec, spec: SchSpec): string {
  const version = stampOf(spec)
  const root = spec.uuid ?? ROOT_UUID
  const own = s.instances ?? [`/${root}|${s.ref}`]
  const instances = version >= 20221002 && own.length ? `(instances (project "${spec.project ?? "demo"}" ${own.map((i) => `(path "${i.split("|")[0]}" (reference "${i.split("|")[1]}") (unit ${s.instanceUnit ?? s.unit ?? 1})${s.variants ? ` ${s.variants}` : ""})`).join(" ")}))` : ""
  const yn = (v: boolean) => (version >= 20241004 ? (v ? "yes" : "no") : v ? "yes" : "no")
  return `(symbol (lib_id "${s.lib}") (at ${s.at}${s.at.split(/\s+/).length === 2 ? " 0" : ""})${s.mirror ? ` (mirror ${s.mirror})` : ""} (unit ${s.unit ?? 1}) (in_bom ${yn(true)}) (on_board ${yn(true)}) ${s.extra ?? ""}
    (uuid ${s.uuid})
    (property "Reference" "${s.ref}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${s.value ?? s.lib.split(":")[1]}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "${s.footprint ?? ""}" (at 0 0 0) (effects (font (size 1.27 1.27)) ${hide(version)}))
    ${s.lib === "Device:R" ? `(pin "1" (uuid ${s.uuid}-p1)) (pin "2" (uuid ${s.uuid}-p2))` : ""}
    ${instances})`
}

/** A schematic file in the spelling of `spec.version`. */
export function schematic(spec: SchSpec = {}): string {
  const version = stampOf(spec)
  const root = spec.uuid ?? ROOT_UUID
  const modern = version >= 20231120
  const generator = modern ? `(generator "eeschema")` : `(generator eeschema)`
  const wires = (spec.wires ?? []).map((w, i) => {
    const [a, b, c, d] = w.split(/\s+/)
    return `(wire (pts (xy ${a} ${b}) (xy ${c} ${d})) (stroke (width 0) (type default)) (uuid w${i}))`
  })
  const junctions = (spec.junctions ?? []).map((j, i) => `(junction (at ${j}) (diameter 0) (color 0 0 0 0) (uuid j${i}))`)
  const noConnects = (spec.noConnects ?? []).map((j, i) => `(no_connect (at ${j}) (uuid n${i}))`)
  const labels = (spec.labels ?? []).map((l, i) => {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s*(\S*)$/.exec(l)!
    const angle = m[4] || "0"
    const justify = angle === "180" || angle === "270" ? "right bottom" : "left bottom"
    return `(label "${m[1]}" (at ${m[2]} ${m[3]} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid l${i}))`
  })
  const symbols = (spec.symbols ?? []).map((s) => placed(s, spec))
  const rootList =
    version < 20221002 && spec.rootList !== false
      ? `(symbol_instances ${
          spec.rootEntries
            ? spec.rootEntries.map((e) => { const [path, ref, value, fp] = e.split("|"); return `(path "${path}" (reference "${ref}") (unit 1)${value === undefined ? "" : ` (value "${value}")`}${fp === undefined ? "" : ` (footprint "${fp}")`})` }).join(" ")
            : (spec.symbols ?? []).map((s) => `(path "/${s.uuid}" (reference "${s.ref}") (unit ${s.instanceUnit ?? s.unit ?? 1}) (value "${s.value ?? s.lib.split(":")[1]}") (footprint "${s.footprint ?? ""}"))`).join(" ")
        })`
      : ""
  return `(kicad_sch (version ${version}) ${generator}${modern ? ` (generator_version "8.0")` : ""}
  (uuid ${root})
  (paper "A4")
  ${spec.head ?? ""}
  (lib_symbols ${(spec.libs ?? []).join("\n")})
  ${junctions.join("\n  ")}
  ${noConnects.join("\n  ")}
  ${wires.join("\n  ")}
  ${labels.join("\n  ")}
  ${(spec.body ?? []).join("\n  ")}
  ${symbols.join("\n  ")}
  (sheet_instances (path "/" (page "1")))
  ${rootList}
)`
}

/** The common case: R1 and R2 in a divider between VCC and GND, with a label on the middle and a junction on the wire to R2. */
export function divider(version = 20230121): string {
  // R1 at (50.8, 50.8): pins at (50.8, 46.99) and (50.8, 54.61). R2 at (50.8, 68.58): pins at (50.8, 64.77) and (50.8, 72.39).
  return schematic({
    version,
    libs: [LIB_R, LIB_GND, LIB_VCC],
    symbols: [
      { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", uuid: "11111111-0000-4000-8000-000000000001" },
      { lib: "Device:R", at: "50.8 68.58", ref: "R2", value: "4.7k", footprint: "Resistor_SMD:R_0603_1608Metric", uuid: "11111111-0000-4000-8000-000000000002" },
      { lib: "power:VCC", at: "50.8 43.18", ref: "#PWR01", value: "VCC", uuid: "11111111-0000-4000-8000-000000000003" },
      { lib: "power:GND", at: "50.8 76.2", ref: "#PWR02", value: "GND", uuid: "11111111-0000-4000-8000-000000000004" },
    ],
    wires: ["50.8 43.18 50.8 46.99", "50.8 54.61 50.8 64.77", "50.8 72.39 50.8 76.2", "50.8 59.69 60.96 59.69"],
    junctions: ["50.8 59.69"],
    labels: ["MID 60.96 59.69 0"],
  })
}
