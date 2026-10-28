import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { findPart } from "../../src/model/library"
import { importKicadSchematic } from "../../src/model/kicad/schematic"
import { componentFields, fieldBox } from "../../src/model/symbolDrawing"
import { rawFields } from "../kicad-census/drawing-sch.mjs"
import { CORPUS, walkSch as walk } from "./shared"

const MM = 12.7

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("every field of the corpus, against KiCad's own rules from the raw file", () => {
  it("is drawn at the angle and in the box the independent derivation gives", () => {
    let checked = 0
    let turned = 0
    const wrong: string[] = []
    for (const path of walk(CORPUS!)) {
      const bytes = new Uint8Array(readFileSync(path))
      const r = importKicadSchematic(bytes)
      if (r.status !== "imported") continue
      const text = new TextDecoder().decode(bytes)
      const byUuid = new Map([...r.build.bySymbol].map(([s, c]) => [s.uuid, c]))
      const raws = rawFields(text)
      for (const f of raws) {
        const c = byUuid.get(f.uuid)
        const part = c && findPart(c.partId)
        if (!c || !part) continue
        const mine = componentFields(c, part).find((x) => x.name === f.name)
        if (!mine) continue
        checked++
        if (c.sch.rot === 90 || c.sch.rot === 270) turned++
        const want = f.layout(mine.text.length)
        const box = fieldBox(c, mine)
        // the model is y up, in editor units; the derivation is KiCad's, y down, in millimetres
        const got = { minX: box.minX * MM, maxX: box.maxX * MM, minY: -box.maxY * MM, maxY: -box.minY * MM }
        const off = Math.max(Math.abs(got.minX - want.box.minX), Math.abs(got.maxX - want.box.maxX), Math.abs(got.minY - want.box.minY), Math.abs(got.maxY - want.box.maxY))
        if (mine.vertical !== want.vertical || off > 0.01) wrong.push(`rot ${c.sch.rot} mirror ${c.sch.mirror ?? "-"} angle ${mine.place.angle} h ${mine.place.h ?? "c"} v ${mine.place.v ?? "c"}: vertical ${mine.vertical} against ${want.vertical}, off ${off.toFixed(2)} (size ${f.size}, len ${mine.text.length})`)
      }
    }
    expect(checked).toBeGreaterThan(500)
    expect(turned).toBeGreaterThan(50)
    expect(wrong.slice(0, 5)).toEqual([])
  }, 300_000)
})
