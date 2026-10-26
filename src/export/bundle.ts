import JSZip from "jszip"
import { computeConnectivity } from "../model/connectivity"
import { analyzePcb } from "../model/pcb"
import { ensureTextFont } from "../model/textFont"
import type { Project } from "../model/types"
import { bomCsv } from "./bom"
import { drillSets, excellonDrill, npthHoles } from "./excellon"
import { gerberLayers, type GerberLayerName } from "./gerber"
import { fabricationNotes } from "./notes"
import { pnpCsv } from "./pnp"

const FIXED_EXTENSIONS = {
  F_Cu: "gtl",
  B_Cu: "gbl",
  F_Mask: "gts",
  B_Mask: "gbs",
  F_Silkscreen: "gto",
  B_Silkscreen: "gbo",
  F_Paste: "gtp",
  B_Paste: "gbp",
  Edge_Cuts: "gm1",
} as const

/** The extensions of the fixed layers; an inner copper layer's comes from `gerberExtension`. */
export const GERBER_EXTENSIONS: Record<string, string> = FIXED_EXTENSIONS

/** The Protel extension of a Gerber layer: the fixed ones, and `.g1` to `.g30` for the inner copper layers (KiCad's). */
export const gerberExtension = (name: GerberLayerName): string => {
  const m = /^In(\d+)_Cu$/.exec(name)
  return m ? `g${m[1]}` : FIXED_EXTENSIONS[name as keyof typeof FIXED_EXTENSIONS]
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "cherryblossom"
}

export const projectFileName = (project: Project, ext: string) => `${slugify(project.name)}.${ext.replace(/^\./, "")}`

/** Every fabrication output keyed by file name. */
export function buildFabricationFiles(project: Project): Record<string, string> {
  const base = slugify(project.name)
  const files: Record<string, string> = {}
  const pcb = analyzePcb(project, computeConnectivity(project))
  const layers = gerberLayers(project, pcb.zoneFills, pcb.items)
  for (const name of Object.keys(layers) as GerberLayerName[]) {
    files[`${base}-${name}.${gerberExtension(name)}`] = layers[name]
  }
  files[`${base}-PTH.drl`] = excellonDrill(project)
  // X5: the holes of the vias between two layers are drilled in a file of their own for each pair of layers, as KiCad does.
  for (const set of drillSets(project)) if (set.span) files[`${base}-${set.suffix}.drl`] = excellonDrill(project, { span: set.span })
  // Non-plated holes go in their own file, as fabs expect; only boards that have some get one.
  if (npthHoles(project).length) files[`${base}-NPTH.drl`] = excellonDrill(project, { plated: false })
  files["bom.csv"] = bomCsv(project)
  files["pnp.csv"] = pnpCsv(project)
  const notes = `${base}-fabrication.txt`
  files[notes] = fabricationNotes(project, Object.keys(files), pcb.items)
  return files
}

export async function buildFabricationZip(project: Project): Promise<Blob> {
  await ensureTextFont(project)
  const zip = new JSZip()
  for (const [name, content] of Object.entries(buildFabricationFiles(project))) zip.file(name, content)
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(text: string, filename: string, mime = "text/plain") {
  downloadBlob(new Blob([text], { type: mime }), filename)
}
