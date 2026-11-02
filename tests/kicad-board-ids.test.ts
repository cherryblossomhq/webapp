import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { pasteItems } from "../src/model/schematicEdit"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ALL } from "./kicad-test-helpers"

// A board from KiCad written whole (the export of an older file, or one an edit changed) keeps the uuids KiCad gave its footprints and pads, and their
// places to the nanometre: KiCad keys a check the user dismissed by them (`drc_exclusions`, rule|x|y|uuid|uuid), and a board written with new ones
// brought back every check its user had dismissed (a footprint's type, a pad inside a keepout).

const FP = "38c68c5f-5977-448e-8ed0-d70962d9710a"
const PAD1 = "fe09f575-c65f-4669-a70a-9487f1519ee9"
const PAD2 = "cde8c416-b19d-4850-878a-7c3d13d2f4a1"

function project(): Project {
  const r = importKicadBoard(
    board({
      nets: ['(net 0 "")', '(net 1 "A")'],
      body: [
        footprint({
          ref: "U3",
          at: "12.806536 5.000013 90",
          extra: `(uuid "${FP}")`,
          pads: [pad({ number: "1", at: "-0.8 0", net: '(net 1 "A")', extra: `(uuid "${PAD1}")` }), pad({ number: "2", at: "0.8 0", extra: `(uuid "${PAD2}")` })],
        }),
      ],
    }),
    { built: ALL },
  )
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r.project
}

const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

describe("a board from KiCad written whole", () => {
  it("keeps the footprint's and its pads' uuids, and the footprint's place to the nanometre", async () => {
    const text = await pcbOf(project())
    expect(text).toContain(`(uuid ${FP})`)
    expect(text).toContain(`(uuid ${PAD1})`)
    expect(text).toContain(`(uuid ${PAD2})`)
    expect(text).toContain("(at 12.806536 5.000013 90)")
  })

  it("gives a copy of the part uuids of its own, and never writes one uuid twice", async () => {
    const p = project()
    const c = p.components.find((x) => x.ref === "U3")!
    const pasted = pasteItems(p, { project: p, components: [c.id], wires: [], labels: [], blocks: [] }, { x: 10, y: 0 })
    if (!pasted.ok) throw new Error(pasted.message)
    const copy = pasted.project.components.find((x) => x.id !== c.id && x.partId === c.partId)!
    expect(copy.fpUuid).toBeUndefined()
    expect(copy.padUuids).toBeUndefined()
    // Two parts that say the same uuids (a file may repeat one): the second is written with new ones.
    const twice: Project = { ...pasted.project, components: pasted.project.components.map((x) => (x.id === copy.id ? { ...x, fpUuid: c.fpUuid, padUuids: c.padUuids, pcb: { ...x.pcb, placed: true } } : x)) }
    const text = await pcbOf(twice)
    for (const id of [FP, PAD1, PAD2]) expect(text.split(`(uuid ${id})`).length - 1).toBe(1)
  })

  it("keeps a KiCad 5 tstamp as KiCad's legacy id, the shape a KiCad 9 file writes it in, and a uuid a footprint's own pads repeat as the file had it", async () => {
    const legacy = importKicadBoard(board({ version: 20171130, nets: ['(net 0 "")'], body: [footprint({ token: "module", ref: "R1", at: "5 5", extra: "(tstamp 5EF57B96)", pads: [pad({ number: "1", at: "0 0" })] })] }), { built: ALL })
    if (legacy.status !== "imported") throw new Error(legacy.status)
    expect(legacy.project.components[0].fpUuid).toBe("00000000-0000-0000-0000-00005ef57b96")
    const twice = importKicadBoard(
      board({ nets: ['(net 0 "")'], body: [footprint({ ref: "J1", at: "5 5", pads: [pad({ number: "1", at: "0 0", extra: `(uuid "${PAD1}")` }), pad({ number: "2", at: "2 0", extra: `(uuid "${PAD1}")` })] })] }),
      { built: ALL },
    )
    if (twice.status !== "imported") throw new Error(twice.status)
    expect((await pcbOf(twice.project)).split(`(uuid ${PAD1})`).length - 1).toBe(2)
  })

  it("brings a part's texts back where they were, again and again, wherever the part is to the nanometre", async () => {
    let p = project()
    const texts = p.components[0].texts
    for (let n = 0; n < 3; n++) {
      const again = importKicadBoard(await pcbOf(p), { built: ALL })
      if (again.status !== "imported") throw new Error(again.status)
      p = again.project
    }
    expect(p.components[0].texts).toEqual(texts)
    expect(p.components[0].pcb).toMatchObject({ x: 12.806536, y: -5.000013 })
  })
})
