import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../../src/export/kicad"
import { computeConnectivity, pinKey } from "../../src/model/connectivity"
import { pcbPads } from "../../src/model/instances"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../../src/model/kicad/board"
import { importKicadProject, type KicadProjectResult, type ProjectFile } from "../../src/model/kicad/project"
import type { Project } from "../../src/model/types"
import { CORPUS } from "./shared"

// B3 of the final review over a local corpus (not in the repo): a project is imported, written out by the KiCad export and read again, and every pad of
// the board is on the net it was on. The pin numbers of a symbol (a diode's A and C, a connector's A1 to B12, an exposed pad EP, the power unit of a
// multi-unit part) must come back as they were, or the pad finds no pin ("the symbol has no pin ...") and loses its net.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/corpus/project-join.test.ts
//
// With no corpus the test is skipped.


/** The projects the final review found losing nets, and the folder of each (relative to the corpus's `projects`). */
const PROJECTS = [
  "alvarop__debugotron/hw/swd_over_c",
  "neurotech-berkeley__emg-neurowrist/KiCAD/voltage-regulator",
  "agkaminski__emuprom",
  "cormoran__PAW3222-breakout/kicad_projects/PAW3220LU-breakout",
  "Jana-Marie__EF-S-Adapter/hardware/v1.1",
  "joric__nrfmicro/hardware",
  "EECSB__Soldering-Sponge-Automatic-Water-Dispenser/Soldering Sponge Automatic Water Dispenser PCB",
  "JordanAceto__rust_ribbon_controller/hardware/main_pcb/kicad_7",
  "JordanAceto__micro_ox/circuit_boards/VCF_VCA_board/kicad_7",
]

const BUILT = new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11"])

/** Every file of the folder a project import reads, as the import screen gets them (a sheet below the root is in the same folder or below it). */
function projectFiles(dir: string): ProjectFile[] {
  const out: ProjectFile[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p, `${rel}${name}/`)
      else if (/\.(kicad_pcb|kicad_sch|kicad_pro|kicad_dru)$/.test(name)) out.push({ path: `${rel}${name}`, data: new Uint8Array(readFileSync(p)) })
    }
  }
  walk(dir, "")
  return out
}

const imported = (r: KicadProjectResult, what: string) => {
  if (r.status !== "imported") throw new Error(`${what} refused (${r.reason}): ${r.message}`)
  return r
}

/** The pads that share a net, as groups of `reference.number`; a pad on no net is a group of its own. Names do not matter, only who is joined to whom. */
function padGroups(p: Project): string[] {
  const conn = computeConnectivity(p)
  const groups = new Map<string, string[]>()
  let alone = 0
  for (const c of p.components) {
    if (!c.pcb.placed) continue
    for (const pad of pcbPads(c)) {
      const id = `${c.ref}.${pad.padNumber ?? pad.pin ?? ""}`
      const net = pad.pin ? conn.pinNet.get(pinKey(c.id, pad.pin)) : undefined
      const key = net ?? `alone-${alone++}`
      ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(id)
    }
  }
  return [...groups.values()].map((g) => g.sort().join(" ")).sort()
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("B3 over the corpus: import, export and import again keep every pad on its net", () => {
  for (const name of PROJECTS) {
    it(name, async () => {
      const dir = join(CORPUS!, "projects", ...name.split("/"))
      const first = imported(importKicadProject(projectFiles(dir), { built: BUILT, allowLossyBoard: true, limitBytes: Number.MAX_SAFE_INTEGER }), "the project")
      const written = await kicadFiles(first.project)
      const back = imported(
        importKicadProject(
          Object.entries(written.files).filter(([k]) => /\.(kicad_pcb|kicad_sch|kicad_pro)$/.test(k)).map(([path, data]) => ({ path, data })),
          { built: BUILT, allowLossyBoard: true, limitBytes: Number.MAX_SAFE_INTEGER },
        ),
        "our own export",
      )
      expect(back.differences.filter((d) => /the symbol has no pin/.test(d.why)).map((d) => d.why)).toEqual(first.differences.filter((d) => /the symbol has no pin/.test(d.why)).map((d) => d.why))
      expect(padGroups(back.project)).toEqual(padGroups(first.project))
    }, 600000)
  }
})
