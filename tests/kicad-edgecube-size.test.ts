import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STORED_PROJECT_LIMIT_BYTES } from "../src/kicadImport/save"
import { importKicadBoard } from "../src/model/kicad/board"
import { serializeProject } from "../src/model/projectFile"

// The corpus's largest project, EdgeCubeH3 board (265 footprint units), has to stay under what a project may hold once saved. Skipped with no corpus.
//   KICAD_CORPUS=<corpus dir> npx vitest run tests/kicad-edgecube-size.test.ts
const CORPUS = process.env.KICAD_CORPUS
const DIR = join(CORPUS ?? "", "projects", "sentoxo__EdgeCubeH3", "EdgeCubeH3")

describe.skipIf(!CORPUS || !existsSync(DIR))("EdgeCubeH3 size", () => {
  it("stays under the stored project limit", () => {
    const r = importKicadBoard(readFileSync(join(DIR, "EdgeCubeH3.kicad_pcb")), { limitBytes: Number.MAX_SAFE_INTEGER })
    if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
    const bytes = new TextEncoder().encode(serializeProject(r.project)).length
    console.log(`EdgeCubeH3 stored size: ${bytes} bytes (limit ${STORED_PROJECT_LIMIT_BYTES})`)
    expect(bytes).toBeLessThan(STORED_PROJECT_LIMIT_BYTES)
  })
})
