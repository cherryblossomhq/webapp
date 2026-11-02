import type { Project } from "../../types"
import type { ImportReport } from "./report"

// What the project holds from a KiCad board that the KiCad 9 file the export writes cannot say: KiCad 10's (and 11's) words, which the 9.0 parser refuses, so they stay in the project and are not in a
// board the export writes whole. Each kind is one entry of the import report with its count, so a KiCad 10 user is told before anything is written, not by what is missing from KiCad afterwards. (The export
// says the same in its notes; `tests/kicad-judge-corpus.test.ts` checks both against what KiCad reads back.) When the import keeps the user's own files, the export patches them, which keeps every word it
// does not write itself, so these are not lost: the import sets them aside (`ImportOutcome.wholeBoard`, by their codes, which all end in `-not-exported`) and the save puts them back in
// the report when the files cannot be kept after all (`save.ts`).

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function reportExportLimits(project: Project, report: ImportReport): void {
  const lands = project.footprints ?? []
  const padsOf = (id: string) => lands.find((l) => l.name === id)?.pads ?? []
  const comps = project.components
  const rows: { code: string; object: string; why: string; count: number }[] = []
  const add = (code: string, count: number, object: string, why: string) => count > 0 && rows.push({ code, object, why, count })
  const units = comps.filter((c) => c.units?.length).length
  add("units-not-exported", units, `${plural(units, "footprint")} with units (which pads belong to which unit of the symbol)`, "KiCad 10 records which pads belong to which unit of a part's symbol. The editor keeps them, and the KiCad 9 board file the export writes has nowhere to say them.")
  const points = (project.points?.length ?? 0) + comps.reduce((n, c) => n + (c.points?.length ?? 0), 0)
  add("points-not-exported", points, plural(points, "PCB point"), "KiCad 10's reference points are kept in the project and not written to the KiCad 9 board file.")
  const protectedVias = project.vias.filter((v) => v.protect || v.backdrill || v.tertiary || v.post).length
  add("via-machining-not-exported", protectedVias, `${plural(protectedVias, "via")} with protection (covering, plugging, capping, filling), a backdrill or post-machining`, "KiCad 10's via protection, backdrills and counterbores are kept in the project and not written to the KiCad 9 board file; the drill files and the fabrication notes carry them.")
  const machinedPads = comps.reduce((n, c) => n + padsOf(c.footprint).filter((p) => p.backdrill || p.tertiary || p.post || p.dieDelay !== undefined).length, 0)
  add("pad-machining-not-exported", machinedPads, `${plural(machinedPads, "pad")} with a backdrill, post-machining or die delay`, "KiCad 10's pad backdrills, counterbores and die delay are kept in the project and not written to the KiCad 9 board file.")
  const jumpers = comps.filter((c) => c.flags?.jumperDuplicates || c.flags?.jumperGroups?.length).length
  add("jumper-groups-not-exported", jumpers, `${plural(jumpers, "footprint")} with jumper pad groups`, "KiCad 10's jumper pad groups (pads that are one net inside the part) are kept in the project and not written to the KiCad 9 board file.")
  add("net-chains-not-exported", project.netChains?.length ?? 0, plural(project.netChains?.length ?? 0, "net chain"), "Net chains (KiCad 11's) are kept in the project and not written to the KiCad 9 board file.")
  const hrefs = project.texts.filter((t) => t.href).length + comps.reduce((n, c) => n + (c.texts?.filter((t) => t.href).length ?? 0), 0)
  add("hyperlinks-not-exported", hrefs, plural(hrefs, "text with a hyperlink", "texts with hyperlinks"), "A text's hyperlink is KiCad 10's: it is kept in the project and not written to the KiCad 9 board file.")
  const hatchAt = [...project.zones, ...lands.flatMap((l) => l.zones ?? [])].filter((z) => z.hatchAt).length
  add("hatch-position-not-exported", hatchAt, plural(hatchAt, "hatched pour with a hatch position", "hatched pours with a hatch position"), "KiCad 10's hatch position is kept in the project and not written to the KiCad 9 board file, which starts the grid at the board's origin.")
  const stackWords = (project.board.stack?.rows ?? []).filter((r) => r.model || r.specFreq !== undefined).length
  add("stackup-words-not-exported", stackWords, plural(stackWords, "stackup row with a dielectric model or frequency", "stackup rows with a dielectric model or frequency"), "KiCad 11's stackup words are kept in the project and not written to the KiCad 9 board file.")
  const variants = project.variants?.list?.length ?? 0
  add("variants-not-exported", variants, plural(variants, "variant"), "KiCad 10's variants (what each changes on a part) are kept in the project; the KiCad 9 files are written as the shown variant makes them.")
  for (const r of rows) report.entries.push({ code: r.code, severity: "changed", object: r.object, why: r.why, count: r.count })
}
