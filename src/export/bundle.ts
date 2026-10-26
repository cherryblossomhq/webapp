import JSZip from "jszip"
import { computeConnectivity } from "../model/connectivity"
import { analyzePcb } from "../model/pcb"
import type { Project } from "../model/types"
import { bomCsv } from "./bom"
import { excellonDrill, npthHoles } from "./excellon"
import { gerberLayers, type GerberLayerName } from "./gerber"
import { fabricationNotes } from "./notes"
import { pnpCsv } from "./pnp"

export const GERBER_EXTENSIONS: Record<GerberLayerName, string> = {
  F_Cu: "gtl",
  B_Cu: "gbl",
  F_Mask: "gts",
  B_Mask: "gbs",
  F_Silkscreen: "gto",
  B_Silkscreen: "gbo",
  F_Paste: "gtp",
  B_Paste: "gbp",
  Edge_Cuts: "gm1",
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
  const layers = gerberLayers(project, pcb.zoneFills)
  for (const name of Object.keys(GERBER_EXTENSIONS) as GerberLayerName[]) {
    files[`${base}-${name}.${GERBER_EXTENSIONS[name]}`] = layers[name]
  }
  files[`${base}-PTH.drl`] = excellonDrill(project)
  // Non-plated holes go in their own file, as fabs expect; only boards that have some get one.
  if (npthHoles(project).length) files[`${base}-NPTH.drl`] = excellonDrill(project, { plated: false })
  files["bom.csv"] = bomCsv(project)
  files["pnp.csv"] = pnpCsv(project)
  const notes = `${base}-fabrication.txt`
  files[notes] = fabricationNotes(project, Object.keys(files), pcb.items)
  return files
}

export async function buildFabricationZip(project: Project): Promise<Blob> {
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
