import { writeFileSync } from "node:fs"
import { describe, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { importKicadProject } from "../src/model/kicad/project"
import { rememberImage } from "../src/store/imageFiles"
import { projectFiles } from "./kicad-keep-corpus.test"

describe.skipIf(!process.env.PROBE)("probe", () => {
  it("two imports export the same?", async () => {
    await loadKicadFont({ cjk: true })
    const { files } = projectFiles(process.env.PROBE!)
    const out: Record<string, string>[] = []
    for (let i = 0; i < 2; i++) {
      const r = importKicadProject(files, { limitBytes: Number.MAX_SAFE_INTEGER, name: "x" })
      if (r.status !== "imported") throw new Error("no")
      for (const f of r.files ?? []) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
      out.push((await kicadFiles(r.project)).files)
    }
    for (const name of Object.keys(out[0])) {
      const a = out[0][name].split("\n")
      const b = out[1][name].split("\n")
      let diff = 0
      const ex: string[] = []
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { diff++; if (ex.length < 6) ex.push(`${i}: ${a[i]?.trim().slice(0, 100)}  |  ${b[i]?.trim().slice(0, 100)}`) }
      console.log(name, a.length, b.length, "diff lines", diff, "\n  " + ex.join("\n  "))
      if (diff) { writeFileSync(`kicad-keep-scratch/a_${name}`, out[0][name]); writeFileSync(`kicad-keep-scratch/b_${name}`, out[1][name]) }
    }
  }, 600000)
})
