import JSZip from "jszip"
import type { AnyCircuitElement } from "circuit-json"
import { applyToPoint } from "transformation-matrix"
import type { Project } from "../model/types"
import { slugify } from "./bundle"
import { projectToCircuitJson } from "./circuitJson"
import { applyOutline } from "./kicadOutline"
import { applyDrawings } from "./kicadShapes"
import { applyTexts } from "./kicadTexts"
import { addNoConnects, addSymbolFields, applyBoardSettings, applyFootprintFlags, applyProjectSettings, boardFootprintIds, noConnectPins, symbolFields, titleBlock } from "./kicadPost"

// KiCad files from Circuit JSON, through tscircuit's `circuit-json-to-kicad` (MIT), loaded when
// the user asks for them: it and the packages it needs (the KiCad file writer and tscircuit's
// symbol drawings) are about 4 MB that nobody should download to edit a board.
//
// The converter draws a schematic unit as 15 mm; ours is 12.7 mm (ten of KiCad's 50 mil grid
// squares), so the schematic is scaled by 12.7 / 15 first, which puts every pin on KiCad's
// 1.27 mm grid exactly.

const KICAD_MM_PER_UNIT = 15
const EDITOR_MM_PER_UNIT = 12.7
const SCHEMATIC_SCALE = EDITOR_MM_PER_UNIT / KICAD_MM_PER_UNIT

type Point = { x: number; y: number }
const scalePoint = <T extends Point | undefined>(p: T): T => (p ? ({ ...p, x: p.x * SCHEMATIC_SCALE, y: p.y * SCHEMATIC_SCALE } as T) : p)

/** The schematic's elements at the converter's scale; the board's are in millimetres already. */
export function scaleSchematic(elements: AnyCircuitElement[]): AnyCircuitElement[] {
  const k = SCHEMATIC_SCALE
  return elements.map((e): AnyCircuitElement => {
    switch (e.type) {
      case "schematic_component":
        return { ...e, center: scalePoint(e.center), size: { width: e.size.width * k, height: e.size.height * k } }
      case "schematic_port":
        return { ...e, center: scalePoint(e.center) }
      case "schematic_path":
        return { ...e, points: e.points.map(scalePoint), ...(typeof e.stroke_width === "number" ? { stroke_width: e.stroke_width * k } : {}) }
      case "schematic_circle":
        return { ...e, center: scalePoint(e.center), radius: e.radius * k, ...(typeof e.stroke_width === "number" ? { stroke_width: e.stroke_width * k } : {}) }
      case "schematic_text":
        return { ...e, position: scalePoint(e.position), ...(typeof e.font_size === "number" ? { font_size: e.font_size * k } : {}) }
      case "schematic_trace":
        return { ...e, edges: e.edges.map((d) => ({ ...d, from: scalePoint(d.from), to: scalePoint(d.to) })), junctions: e.junctions.map(scalePoint) }
      case "schematic_net_label":
        return { ...e, center: scalePoint(e.center), anchor_position: scalePoint(e.anchor_position) }
      default:
        return e
    }
  })
}

/**
 * The converter works in floating point, so a pin and the wire that ends on it can differ in the
 * fourteenth decimal; KiCad reads them as the same nanometre, but other readers compare exactly.
 * Numbers are rounded to a nanometre. Text in quotes (silkscreen text, part numbers) is left as it is.
 */
export function tidyNumbers(text: string): string {
  // Also the 1.1e-16 that stands for 0 after a rotation.
  return text.replace(/"(?:[^"\\]|\\.)*"|(?<=[\s(])-?\d+(?:\.\d{7,}|(?:\.\d+)?e[+-]?\d+)(?=[\s)])/g, (m) => (m.startsWith('"') ? m : String(Number(Number(m).toFixed(6)) || 0)))
}

export interface KicadExport {
  files: Record<string, string>
  /** What didn't come across, in words for whoever exported it. */
  notes: string[]
}

/** The schematic, board and project files of a KiCad 9 project. */
export async function kicadFiles(project: Project): Promise<KicadExport> {
  const { elements, notes } = projectToCircuitJson(project, { nameAllNets: true, forKicad: true })
  const circuit = scaleSchematic(elements)
  const { CircuitJsonToKicadSchConverter, CircuitJsonToKicadPcbConverter, CircuitJsonToKicadProConverter } = await import("circuit-json-to-kicad")
  const base = slugify(project.name)

  const sch = new CircuitJsonToKicadSchConverter(circuit, { titleBlock: titleBlock(project) })
  sch.runUntilFinished()
  const pcb = new CircuitJsonToKicadPcbConverter(circuit)
  pcb.runUntilFinished()
  const pro = new CircuitJsonToKicadProConverter(circuit, { projectName: base, schematicFilename: `${base}.kicad_sch`, pcbFilename: `${base}.kicad_pcb`, schematicSheetPlan: sch.schematicSheetPlan })
  pro.runUntilFinished()

  // What the converter has no place for: put into the files it wrote.
  const flagged = applyFootprintFlags(applyBoardSettings(pcb.getOutputString(), project), project)
  const drawings = applyDrawings(flagged, project)
  const outline = applyOutline(drawings.text, project)
  const texts = applyTexts(outline.text, project)
  const boardText = texts.text
  const footprintIds = boardFootprintIds(boardText)
  const fields = new Map(project.components.map((c) => [c.ref, symbolFields(c, footprintIds)]))
  const page = sch.ctx.c2kMatSch
  const flags = page ? noConnectPins(circuit).map((p) => applyToPoint(page, p)) : []
  const schText = addNoConnects(addSymbolFields(sch.getOutputString(), fields), flags)
  const settings = applyProjectSettings(pro.getOutputString(), project)

  return {
    files: {
      [`${base}.kicad_pro`]: settings.text,
      [`${base}.kicad_sch`]: tidyNumbers(schText),
      [`${base}.kicad_pcb`]: tidyNumbers(boardText),
    },
    notes: [
      ...notes,
      ...drawings.notes,
      ...outline.notes,
      ...texts.notes,
      "KiCad names every net, so nets the schematic leaves unnamed are called Net-(REF-PIN), as KiCad would.",
      "Parts keep our schematic symbols and land patterns; they are stored in the files, not in a KiCad library, and have no 3D models.",
      "Symbols carry the footprint, part number, LCSC number, manufacturer and every other part property as hidden fields; the board's footprints carry only the part and LCSC numbers.",
      ...(project.zones.length ? ["Pours arrive filled as Cherry Blossom filled them, with its clearance, thinnest neck and thermal settings; press B in KiCad to refill them. KiCad's thermal spokes are always four, at its own angle."] : []),
      "The design rules are in the KiCad project: clearance, trace width, via and drill sizes, annular ring, hole to hole, copper to the board edge, mask and paste openings, and trace widths by net as net classes. Vias in pads and via tenting have no setting there.",
      ...(project.rules.netClasses?.length ? ["Net classes are in the KiCad project (net settings): each class's clearance, trace width, via, micro via and differential pair sizes, with its nets as patterns that match them exactly. A width given to one net is a class of its own that sets only the width."] : []),
      ...settings.notes,
      ...(settings.unmatched.length ? [`Trace widths for nets with * or ? in the name were left out, since KiCad reads those as wildcards: ${settings.unmatched.join(", ")}.`] : []),
      "The project's name, revision, company, description and other properties are in the schematic's title block and the project's text variables.",
      ...(project.components.some((c) => c.flags) ? ["Part flags (surface mount or through-hole, not in the BOM or position file, board only, do not populate, allowed missing courtyard and mask bridges) and net ties are written as each footprint's attributes and pad groups."] : []),
    ],
  }
}

export async function kicadZip(project: Project): Promise<{ blob: Blob; notes: string[] }> {
  const { files, notes } = await kicadFiles(project)
  const zip = new JSZip()
  const folder = zip.folder(slugify(project.name))!
  for (const [name, content] of Object.entries(files)) folder.file(name, content)
  return { blob: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), notes }
}
