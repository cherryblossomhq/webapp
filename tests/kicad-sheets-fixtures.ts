import { importKicadSchematic } from "../src/model/kicad/schematic"
import { LIB_GND, LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"

// A project with a sheet below the root, in the files KiCad 7 writes: R1 on the root, a sheet symbol with one pin VIN wired to it, and a
// child sheet with R9 (used once or twice: each use has its own reference) and the hierarchical label VIN on its pin.

export const CHILD_UUID = "00000000-0000-4000-8000-0000000000c1"
export const S1 = "00000000-0000-4000-8000-0000000000a1"
export const S2 = "00000000-0000-4000-8000-0000000000a2"

const sheet = (uuid: string, name: string, file: string, y: number, pins: string[], pages: string[]) =>
  `(sheet (at 60.96 ${y}) (size 20.32 10.16) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${uuid})
    (property "Sheetname" "${name}" (at 60.96 ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "${file}" (at 60.96 ${y + 11} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    ${pins.join("\n")}
    (instances (project "demo" (path "/${ROOT_UUID}" (page "${pages[0]}")))))`

const pin = (name: string, y: number) => `(pin "${name}" input (at 60.96 ${y} 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid p-${name}-${y}))`

export function files(uses: { uuid: string; name: string; y: number }[]) {
  const rootSyms = [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }]
  const root = schematic({
    libs: [LIB_R, LIB_GND],
    symbols: rootSyms,
    wires: ["50.8 54.61 50.8 66.04", "50.8 66.04 60.96 66.04"],
    body: uses.map((u, i) => sheet(u.uuid, u.name, "child.kicad_sch", u.y, [pin("VIN", u.y + 5.08)], [String(i + 2)])),
  })
  const child = schematic({
    uuid: CHILD_UUID,
    libs: [LIB_R, LIB_GND],
    symbols: [
      {
        lib: "Device:R",
        at: "50.8 50.8",
        ref: "R9",
        uuid: "bbbbbbbb-0000-4000-8000-000000000001",
        instances: uses.map((u, i) => `/${ROOT_UUID}/${u.uuid}|R${i + 2}`),
      },
    ],
    body: [`(hierarchical_label "VIN" (shape input) (at 50.8 54.61 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl1))`],
  })
  return new Map<string, string>([
    ["root.kicad_sch", root],
    ["child.kicad_sch", child],
  ])
}

export const imp = (uses = [{ uuid: S1, name: "Power", y: 60.96 }]) => {
  const r = importKicadSchematic({ files: files(uses), root: "root.kicad_sch" })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r
}

