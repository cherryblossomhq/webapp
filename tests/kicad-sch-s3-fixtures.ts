import { importKicadSchematic } from "../src/model/kicad/schematic"
import type { Project } from "../src/model/types"
import { LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"

// S3 fixtures: schematics with buses, in the files KiCad 9 writes. Coordinates are KiCad's (millimetres, y down). A vertical `Device:R` at
// (x, y) has pin 1 at (x, y - 3.81) and pin 2 at (x, y + 3.81).

export const CHILD_UUID = "00000000-0000-4000-8000-0000000000c1"
export const SHEET_UUID = "00000000-0000-4000-8000-0000000000a1"

export const VERSION = 20250114
const FONT = "(effects (font (size 1.27 1.27)) (justify left bottom))"

export const bus = (x1: number, y1: number, x2: number, y2: number, extra = "(stroke (width 0) (type default))") => `(bus (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) ${extra} (uuid bus-${x1}-${y1}-${x2}-${y2}))`
export const entry = (x: number, y: number, dx: number, dy: number, extra = "(stroke (width 0) (type default))") => `(bus_entry (at ${x} ${y}) (size ${dx} ${dy}) ${extra} (uuid ent-${x}-${y}))`
export const label = (text: string, x: number, y: number, angle = 0) => `(label "${text}" (at ${x} ${y} ${angle}) ${FONT} (uuid lab-${text.replace(/\W/g, "_")}-${x}-${y}))`
export const globalLabel = (text: string, x: number, y: number, angle = 0) => `(global_label "${text}" (shape bidirectional) (at ${x} ${y} ${angle}) ${FONT} (uuid glab-${text.replace(/\W/g, "_")}-${x}-${y}))`
export const hierLabel = (text: string, x: number, y: number, angle = 0) => `(hierarchical_label "${text}" (shape input) (at ${x} ${y} ${angle}) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl-${text.replace(/\W/g, "_")}-${x}-${y}))`
export const alias = (name: string, members: string[]) => `(bus_alias "${name}" (members ${members.map((m) => `"${m}"`).join(" ")}))`
export const sheetSymbol = (uuid: string, name: string, file: string, y: number, pins: { name: string; y: number }[]) =>
  `(sheet (at 76.2 ${y}) (size 20.32 12.7) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${uuid})
    (property "Sheetname" "${name}" (at 76.2 ${y - 0.7} 0) ${FONT})
    (property "Sheetfile" "${file}" (at 76.2 ${y + 13.7} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    ${pins.map((p) => `(pin "${p.name}" input (at 76.2 ${p.y} 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid sp-${p.name.replace(/\W/g, "_")}-${p.y}))`).join("\n")}
    (instances (project "demo" (path "/${ROOT_UUID}" (page "2")))))`

/** R<n> at (x, y), the way `schematic` takes a symbol. */
export const resistor = (ref: string, x: number, y: number, uuid: string, instances?: string[]) => ({ lib: "Device:R", at: `${x} ${y}`, ref, uuid, ...(instances ? { instances } : {}) })

/** One sheet: R1 and R2 each on a wire that ends on a bus entry (R1 labelled `D3`, R2 `D4`), the bus labelled `D[0..7]`. */
export function oneSheet(over: { busLabel?: string; globalBus?: boolean; wireLabels?: [string, string]; extraBody?: string[]; version?: number } = {}): Map<string, string> {
  const [l1, l2] = over.wireLabels ?? ["D3", "D4"]
  const root = schematic({
    version: over.version ?? VERSION,
    libs: [LIB_R],
    symbols: [resistor("R1", 50.8, 50.8, "aaaaaaaa-0000-4000-8000-000000000001"), resistor("R2", 60.96, 50.8, "aaaaaaaa-0000-4000-8000-000000000002")],
    wires: ["50.8 46.99 50.8 40.64", "60.96 46.99 60.96 40.64"],
    body: [
      bus(40.64, 38.1, 76.2, 38.1),
      entry(50.8, 40.64, 2.54, -2.54),
      entry(60.96, 40.64, 2.54, -2.54),
      label(l1, 50.8, 40.64),
      label(l2, 60.96, 40.64),
      (over.globalBus ? globalLabel : label)(over.busLabel ?? "D[0..7]", 43.18, 38.1),
      ...(over.extraBody ?? []),
    ],
  })
  return new Map([["root.kicad_sch", root]])
}

/**
 * A root with R1 on a wire that leaves a bus by an entry (labelled `rootNet`), the bus (labelled `rootBus`) running into the pin `pinName` of a
 * sheet, and a child sheet with the hierarchical label `childBus` on a bus with R9 on a wire labelled `childNet`.
 */
export function twoSheets(opts: { rootBus?: string; pinName?: string; childBus?: string; rootNet?: string; childNet?: string; rootAliases?: string[]; childAliases?: string[]; rootLabelKind?: "label" | "global" } = {}): Map<string, string> {
  const rootBus = opts.rootBus ?? "D[0..7]"
  const pinName = opts.pinName ?? rootBus
  const childBus = opts.childBus ?? pinName
  const net = opts.rootNet ?? "D3"
  const cnet = opts.childNet ?? "D3"
  const root = schematic({
    version: VERSION,
    libs: [LIB_R],
    symbols: [resistor("R1", 50.8, 50.8, "aaaaaaaa-0000-4000-8000-000000000001")],
    wires: ["50.8 46.99 50.8 40.64"],
    body: [
      bus(40.64, 38.1, 76.2, 38.1),
      entry(50.8, 40.64, 2.54, -2.54),
      opts.rootLabelKind === "global" ? globalLabel(net, 50.8, 40.64) : label(net, 50.8, 40.64),
      label(rootBus, 43.18, 38.1),
      sheetSymbol(SHEET_UUID, "Sub", "child.kicad_sch", 33.02, [{ name: pinName, y: 38.1 }]),
      ...(opts.rootAliases ?? []),
    ],
  })
  const child = schematic({
    version: VERSION,
    uuid: CHILD_UUID,
    libs: [LIB_R],
    symbols: [resistor("R9", 50.8, 50.8, "bbbbbbbb-0000-4000-8000-000000000001", [`/${ROOT_UUID}/${SHEET_UUID}|R9`])],
    wires: ["50.8 46.99 50.8 40.64"],
    body: [bus(40.64, 38.1, 63.5, 38.1), hierLabel(childBus, 40.64, 38.1, 180), entry(50.8, 40.64, 2.54, -2.54), label(cnet, 50.8, 40.64), ...(opts.childAliases ?? [])],
  })
  return new Map([
    ["root.kicad_sch", root],
    ["child.kicad_sch", child],
  ])
}

export function load(files: Map<string, string>, root = "root.kicad_sch") {
  const r = importKicadSchematic({ files, root })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r
}

export const refusal = (files: Map<string, string>, root = "root.kicad_sch") => {
  const r = importKicadSchematic({ files, root })
  return r.status === "imported" ? null : r
}

/** The pins of a net as `REF.pin`, sorted. */
export const pinsOn = (project: Project, net: { pins: { componentId: string; pin: string }[] }) => net.pins.map((p) => `${project.components.find((c) => c.id === p.componentId)!.ref}.${p.pin}`).sort()
