import JSZip from "jszip"
import { bareName, computeConnectivity } from "../../model/connectivity"
import { findPart } from "../../model/library"
import { isAutoNetName } from "../../model/netNames"
import { analyzePcb } from "../../model/pcb"
import { withRuleAreaFlags } from "../../model/ruleAreas"
import { copyKey, isHierarchical, sheetsOf, sheetUses, ROOT_SHEET, rootSheetName } from "../../model/sheets"
import { ensureTextFont } from "../../model/textFont"
import type { Project } from "../../model/types"
import { slugify } from "../bundle"
import { writePcbDoc } from "./pcbDoc"
import { prjPcbText } from "./prjPcb"
import { uniqueId } from "./records"
import { writeSchDocs } from "./schDoc"

export interface AltiumExport {
  /** File name to bytes (`.SchDoc`, `.PcbDoc`) or text (`.PrjPcb`). */
  files: Record<string, Uint8Array | string>
  /** What didn't come across as it is, in words for whoever exported it. */
  notes: string[]
}

/**
 * The name Altium gives a net: the label's or the power port's text for a named net, and Altium's own `NetR1_2` (the reference and pin of one of its
 * pins) for one nothing names, as Altium names an unnamed net when it compiles the schematic. Names are kept apart where two nets would share one.
 */
export function altiumNetNames(nets: ReturnType<typeof computeConnectivity>["nets"]): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const net of nets) {
    const auto = isAutoNetName(net.name) || !net.named
    const kicadAuto = /^(?:Net|unconnected)-\((.+)-(?:Pad)?([^-]+)\)$/.exec(net.name)
    let base = auto ? (kicadAuto ? `Net${kicadAuto[1]}_${kicadAuto[2]}` : net.name) : bareName(net).replace(/^\/+/, "") || net.name
    base = base.replace(/[|\r\n]/g, "_")
    let name = base
    for (let i = 2; taken.has(name.toUpperCase()); i++) name = `${base}_${i}`
    taken.add(name.toUpperCase())
    out.set(net.id, name)
  }
  return out
}

/** The schematic, board and project files of an Altium project, written from the project. */
export async function altiumFiles(source: Project): Promise<AltiumExport> {
  // The board side follows the active variant and the flags of sheet symbols and rule areas, as the fabrication files do.
  const project = withRuleAreaFlags(source)
  await ensureTextFont(project)
  const sch = computeConnectivity(project)
  const pcb = analyzePcb(project, sch)
  const netNames = altiumNetNames(sch.nets)
  const base = slugify(project.name)
  const ids = new Set<string>()

  // Each sheet is a .SchDoc; a project with one sheet is one file named for the project.
  const hierarchical = isHierarchical(project)
  const sheetFiles = new Map<string, string>()
  const usedNames = new Set<string>()
  for (const s of sheetsOf(project)) {
    const stem = s.id === ROOT_SHEET ? base : slugify(s.name ?? s.id)
    let name = `${stem}.SchDoc`
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${stem}-${i}.SchDoc`
    usedNames.add(name.toLowerCase())
    sheetFiles.set(s.id, name)
  }
  // The unique ids that tie the board's parts to the schematic's: a part's own, and the sheet symbols' on the way to it.
  const componentIds = new Map<string, string>()
  for (const c of project.components) {
    const key = copyKey(c)
    if (!componentIds.has(key)) componentIds.set(key, uniqueId(`sch:${key}`, ids))
  }
  const symbolIds = new Map((project.sheetSymbols ?? []).map((s) => [s.id, uniqueId(`sym:${s.id}`, ids)]))
  const uses = hierarchical ? sheetUses(project) : []
  const sources = new Map<string, { uniqueId: string; sheet: string; libRef: string; description?: string }>()
  for (const c of project.components) {
    const part = findPart(c.partId)
    const path = (c.inst ?? "").split("/").filter(Boolean)
    const use = uses.find((u) => u.path === (c.inst ?? ""))
    sources.set(c.id, {
      uniqueId: `\\${[...path.map((id) => symbolIds.get(id) ?? id), componentIds.get(copyKey(c))].join("\\")}`,
      sheet: use?.name ?? rootSheetName(project),
      libRef: part?.name ?? c.ref,
      description: part?.description,
    })
  }

  const schematic = writeSchDocs({ project, sch, netNames, sheetFiles, componentIds, symbolIds, ids })
  const board = writePcbDoc({ project, sch, pcb, netNames, sources })
  const pcbName = `${base}.PcbDoc`
  const files: Record<string, Uint8Array | string> = {}
  for (const [name, bytes] of schematic.files) files[name] = bytes
  files[pcbName] = board.bytes
  files[`${base}.PrjPcb`] = prjPcbText(project, [...schematic.files.keys()], pcbName)
  return {
    files,
    notes: [
      ...schematic.notes,
      ...board.notes,
      "Every part carries its symbol and its footprint inside the documents, as placed; there is no .SchLib or .PcbLib beside them. Altium's Design, Make Schematic Library and Make PCB Library make them from the documents.",
      "Nets that the schematic does not name are called NetR1_2 (a part's reference and pin), as Altium names them.",
    ],
  }
}

export async function altiumZip(project: Project): Promise<{ blob: Blob; notes: string[] }> {
  const { files, notes } = await altiumFiles(project)
  const zip = new JSZip()
  const folder = zip.folder(slugify(project.name))!
  for (const [name, content] of Object.entries(files)) folder.file(name, content)
  return { blob: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), notes }
}
