import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { settleKicadSheet } from "../src/model/kicadJoin"
import { addWire, findRubberBands, moveComponent, moveSchematicItems, removeItems } from "../src/model/ops"
import { dragSelection, mirrorSelection, pasteItems, rotateSelection, type Clipboard } from "../src/model/schematicEdit"
import { tidySchematic } from "../src/model/tidy"
import type { Mirror, Project } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { LIB_R, schematic, type SymSpec } from "./kicad-schematic-fixtures"

// S11, the edits: a sheet joined by KiCad's rules (`SchematicSheet.kicadRules`) keeps KiCad's integer points (100 nm) through every edit, and every edit follows
// KiCad's rules for what a wire joins: a wire an edit puts on another wire's side is cut there (KiCad breaks the wires at the new T when it finishes an edit), an old
// T that joins nothing is left alone, and nothing an edit moves is parted from what it was joined to by the editor's rounding to four digits.
//
// The nets of an edited sheet are compared with the independent derivation of the same sheet written out as a KiCad file (`tests/kicad-census/netlist-sch.mjs`, which
// shares no code with `src`), on a sheet whose points are on KiCad's 1.27 mm grid, where the editor's four digits and KiCad's points are the same points.

const BUILT = new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"])
const dir = mkdtempSync(join(tmpdir(), "kicad-s11-edits-"))
let counter = 0

const R = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at, ref, uuid: `33333333-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()))

/** The pins that share a net with another, as `REF.pin` groups, in the editor's reading of a project. */
function editorGroups(project: Project): string[][] {
  const { pinNet } = computeConnectivity(project)
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of pinNet) {
    const at = key.lastIndexOf(":")
    const id = key.slice(0, at)
    if (!refOf.has(id)) continue
    const pin = `${refOf.get(id)}.${key.slice(at + 1)}`
    const list = byNet.get(netId) ?? []
    if (!list.includes(pin)) list.push(pin)
    byNet.set(netId, list)
  }
  return sorted([...byNet.values()].filter((l) => l.length > 1))
}

const mm = (v: number) => (v * 12.7).toFixed(4)

/** The project's sheet written out as a KiCad file, and KiCad's groups of it by the independent derivation. */
function kicadGroups(project: Project): string[][] {
  const refs = new Map<string, string>()
  const symbols = project.components.map((c, i) => {
    const spec = R(c.ref, `${mm(c.sch.x)} ${mm(-c.sch.y)} ${c.sch.rot}`, i + 1, c.sch.mirror ? { mirror: c.sch.mirror } : {})
    refs.set(spec.uuid, c.ref)
    return spec
  })
  const wires = project.wires.flatMap((w) => w.points.slice(1).map((p, i) => `${mm(w.points[i].x)} ${mm(-w.points[i].y)} ${mm(p.x)} ${mm(-p.y)}`))
  const d = join(dir, `t${counter++}`)
  mkdirSync(d)
  const file = join(d, "root.kicad_sch")
  writeFileSync(file, schematic({ libs: [LIB_R], symbols, wires }))
  const derived = deriveNets(file, { hiddenPower: true, localJoinsGlobal: "same" })
  const byGroup = new Map<number, string[]>()
  for (const [key, g] of derived.pins) {
    const [, uuid, pin] = /^\/([^#]+)#(.*)$/.exec(key)!
    for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${refs.get(uuid)}.${pin}`)
  }
  return sorted([...byGroup.values()].filter((l) => l.length > 1))
}

function load(text: string): Project {
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error("not imported")
  expect(imported.project.sheets?.some((s) => s.kicadRules)).toBe(true)
  return imported.project
}

const id = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
/** The wire with a point at (x, y) millimetres (KiCad's frame). */
const wireAt = (p: Project, x: number, y: number) => p.wires.find((w) => w.points.some((q) => Math.abs(q.x * 12.7 - x) < 1e-3 && Math.abs(-q.y * 12.7 - y) < 1e-3))!

// ---- the sheet of the proof: KiCad's points at 100 mm, which the editor keeps to six digits (7.874016, -9.448819) ----
// R1 above a wire from R2 to R4 (a T with a junction: three pins on one net), and a second T with no junction (R5 above a wire from R6): KiCad joins nothing there,
// which is what makes the sheet one joined by KiCad's rules.
const PROOF = () =>
  load(
    schematic({
      libs: [LIB_R],
      symbols: [R("R1", "100 100 0", 1), R("R2", "80 116.19 0", 2), R("R4", "120 116.19 0", 4), R("R5", "140 100 0", 5), R("R6", "130 116.19 0", 6)],
      wires: ["80 120 120 120", "100 103.81 100 120", "130 120 160 120", "140 103.81 140 120"],
      junctions: ["100 120"],
    }),
  )

// ---- the sheet for the oracle: every point on KiCad's 1.27 mm grid (n steps of 1.27 mm), so the editor's four digits are KiCad's points ----
const G = (n: number) => (n * 1.27).toFixed(2)
const at = (x: number, y: number, rot = 0) => `${G(x)} ${G(y)} ${rot}`
const seg = (x1: number, y1: number, x2: number, y2: number) => `${G(x1)} ${G(y1)} ${G(x2)} ${G(y2)}`
// A resistor at (x, y) has its pins at (x, y - 3) and (x, y + 3) steps. R1 over the junctioned wire from R2 to R4 at y 95; R5 over R6's wire (the second T, no junction);
// R7 above the wire R6 - (120, 95), with a wire from its pin down to y 90 that ends in the air.
const GRID = () =>
  load(
    schematic({
      libs: [LIB_R],
      symbols: [R("R1", at(80, 80), 1), R("R2", at(64, 92), 2), R("R4", at(96, 92), 4), R("R5", at(114, 80), 5), R("R6", at(104, 92), 6), R("R7", at(108, 80), 7)],
      wires: [seg(64, 95, 96, 95), seg(80, 83, 80, 95), seg(104, 95, 120, 95), seg(114, 83, 114, 95), seg(108, 83, 108, 90)],
      junctions: [`${G(80)} ${G(95)}`],
    }),
  )

const KICAD_NETS = [["R1.2", "R2.2", "R4.2"]]

/** Every group there was is still whole, and no two of them are one: a part turned may touch a loose pin's net (drawing), never part or join the nets that stand. */
function kept(want: string[][], got: string[][]): boolean {
  const whole = want.every((g) => got.some((h) => g.every((x) => h.includes(x))))
  const apart = got.every((h) => want.filter((g) => g.some((x) => h.includes(x))).length <= 1)
  return whole && apart
}
const step = (n: number) => (n * 1.27) / 12.7

describe("the sheets of these tests are what they claim", () => {
  it("the proof sheet: three pins on one net, and the second T joins nothing, in the editor's reading", () => {
    const p = PROOF()
    expect(editorGroups(p)).toEqual(KICAD_NETS)
    // the wires are at KiCad's six digits, not the editor's four
    expect(wireAt(p, 100, 120).points.some((q) => q.x === 7.874016 && q.y === -9.448819)).toBe(true)
  })

  it("the grid sheet: the editor's nets are the oracle's", () => {
    const p = GRID()
    expect(editorGroups(p)).toEqual(KICAD_NETS)
    expect(kicadGroups(p)).toEqual(KICAD_NETS)
  })
})

describe("moving a part on a sheet joined by KiCad's rules keeps its points, so it drops no join", () => {
  it("R2 moved by (-0.5, 0) keeps R1.2 + R2.2 + R4.2 on one net (findRubberBands, moveSchematicItems)", () => {
    const p = PROOF()
    const ids = { components: [id(p, "R2")], labels: [], wires: [] }
    const moved = moveSchematicItems(p, ids, { x: -0.5, y: 0 }, findRubberBands(p, ids.components, [], []))
    expect(editorGroups(moved)).toEqual(KICAD_NETS)
  })

  it("every part, moved every way a drag moves it, keeps the nets it had (moveComponent, dragSelection)", () => {
    const p = PROOF()
    for (const ref of ["R1", "R2", "R4", "R5", "R6"]) {
      for (const [dx, dy] of [[-0.5, 0], [0.3, 0], [0, -0.4], [0, 0.55], [-0.2, 0.2], [0.1, 0.1]]) {
        const c = p.components.find((x) => x.ref === ref)!
        const a = moveComponent(p, c.id, { x: c.sch.x + dx, y: c.sch.y + dy })
        expect(editorGroups(a), `${ref} by ${dx},${dy} (moveComponent)`).toEqual(KICAD_NETS)
        const b = dragSelection(p, { components: [c.id], labels: [], wires: [] }, { x: dx, y: dy })
        if (b.ok) expect(editorGroups(b.project), `${ref} by ${dx},${dy} (dragSelection)`).toEqual(KICAD_NETS)
      }
    }
  })

  it("a part, its wires and what is on them carried together keep their joins, and the points they leave alone stay exactly where they were", () => {
    const p = PROOF()
    const comps = ["R1", "R2", "R4"].map((r) => id(p, r))
    const wires = ["80 120", "100 103.81", "100 120"].flatMap((s) => {
      const [x, y] = s.split(" ").map(Number)
      return wireAt(p, x, y) ? [wireAt(p, x, y).id] : []
    })
    const ids = { components: comps, labels: [], wires: [...new Set(wires)] }
    const moved = moveSchematicItems(p, ids, { x: 0.3, y: -0.2 }, findRubberBands(p, comps, [], ids.wires))
    expect(editorGroups(moved)).toEqual(KICAD_NETS)
    // R5 and R6 and their wires did not move: their points are the very same objects' values, at six digits
    const still = wireAt(p, 140, 103.81)
    expect(moved.wires.find((w) => w.id === still.id)).toEqual(still)
  })

  it("the sheet's old T (R5 over R6's wire) is not joined by an edit that has nothing to do with it", () => {
    const p = PROOF()
    const c = p.components.find((x) => x.ref === "R1")!
    const moved = moveComponent(p, c.id, { x: c.sch.x - 0.3, y: c.sch.y })
    expect(editorGroups(moved).flat()).not.toContain("R5.2")
  })

  it("a sheet drawn in the editor keeps the editor's four digits: nothing is changed for it", () => {
    const p: Project = { ...PROOF(), sheets: undefined }
    const ids = { components: [id(p, "R2")], labels: [], wires: [] }
    const moved = moveSchematicItems(p, ids, { x: -0.5, y: 0 }, findRubberBands(p, ids.components, [], []))
    const was = new Set(p.wires.flatMap((w) => w.points.flatMap((q) => [q.x, q.y])))
    for (const w of moved.wires) for (const q of w.points) for (const v of [q.x, q.y]) if (!was.has(v)) expect(Math.round(v * 1e4) / 1e4).toBe(v)
    expect(settleKicadSheet(p, moved)).toBe(moved)
  })
})

describe("a wire put on another wire's side by an edit is cut there, as KiCad cuts it", () => {
  /** R7's wire (108, 83 to 90) carried down five steps ends at (108, 95): on the side of the wire from R6.2 to (120, 95). */
  const w7 = (p: Project) => wireAt(p, 108 * 1.27, 90 * 1.27)

  it("dragging a part with its wire so the wire's end lands on a wire's side joins them, and the old T stays unjoined (moveSchematicItems, against the oracle)", () => {
    const p = GRID()
    const ids = { components: [id(p, "R7")], labels: [], wires: [w7(p).id] }
    const moved = moveSchematicItems(p, ids, { x: 0, y: -step(5) }, findRubberBands(p, ids.components, [], ids.wires))
    // y is up in the editor: -step is down on screen
    const mine = editorGroups(moved)
    expect(mine).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    expect(kicadGroups(moved)).toEqual(mine)
    // the wire from R6.2 is cut at the new end, so the two ends meet
    expect(moved.wires.length).toBe(p.wires.length + 1)
  })

  it("the same by dragSelection and by moveComponent", () => {
    const p = GRID()
    const a = dragSelection(p, { components: [id(p, "R7")], labels: [], wires: [w7(p).id] }, { x: 0, y: -step(5) })
    expect(a.ok).toBe(true)
    if (a.ok) expect(editorGroups(a.project)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    const c = p.components.find((x) => x.ref === "R7")!
    const b = moveComponent(p, c.id, { x: c.sch.x, y: c.sch.y - step(5) })
    expect(editorGroups(b)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
  })

  it("a wire drawn onto a wire's side is cut there (addWire)", () => {
    const p = GRID()
    const x = 108 * 0.1
    const { project } = addWire(p, [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }])
    expect(editorGroups(project)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    expect(kicadGroups(project)).toEqual(editorGroups(project))
  })

  it("a copy pasted so the end of its wire lies on a wire's side joins it (pasteItems, against the oracle)", () => {
    const p = GRID()
    const c = p.components.find((x) => x.ref === "R7")!
    const clip: Clipboard = { project: p, components: [c.id], wires: [w7(p).id], labels: [], blocks: [] }
    const res = pasteItems(p, clip, { x: step(2), y: -step(5) })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const copy = res.project.components.find((x) => !p.components.some((y) => y.id === x.id))!
    const group = editorGroups(res.project).find((g) => g.includes("R6.2"))
    expect(group).toEqual(["R6.2", `${copy.ref}.2`].sort())
    expect(kicadGroups(res.project)).toEqual(editorGroups(res.project))
  })

  it("a copy of a network keeps its joins at six digits (pasteItems)", () => {
    const p = PROOF()
    const comps = ["R1", "R2", "R4"].map((r) => id(p, r))
    const wires = [wireAt(p, 80, 120).id, wireAt(p, 100, 103.81).id, wireAt(p, 120, 120).id]
    const clip: Clipboard = { project: p, components: comps, wires: [...new Set(wires)], labels: [], blocks: [] }
    const res = pasteItems(p, clip, { x: 1.5, y: -1 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(editorGroups(res.project)).toHaveLength(2)
  })

  it("the store settles an edit that put a wire on another's side, whatever made it (commit)", () => {
    const p = GRID()
    projectApi().open(p)
    const x = 108 * 0.1
    const wire = { id: "wx", points: [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }] }
    projectApi().commit((q) => ({ ...q, wires: [...q.wires, wire] }))
    const made = projectApi().project!
    expect(editorGroups(made)).toEqual(sorted([...KICAD_NETS, ["R6.2", "R7.2"]]))
    projectApi().close()
  })
})

describe("settleKicadSheet", () => {
  it("returns an unflagged project, and an edit that changed no wire, as it is", () => {
    const p = PROOF()
    const plain: Project = { ...p, sheets: undefined }
    const edited = { ...plain, wires: [...plain.wires] }
    expect(settleKicadSheet(plain, edited)).toBe(edited)
    expect(settleKicadSheet(p, p)).toBe(p)
    const relabelled = { ...p, labels: [] }
    expect(settleKicadSheet(p, relabelled)).toBe(relabelled)
  })

  it("is idempotent: settling an edit a second time changes nothing, and an old T stays unjoined", () => {
    const p = GRID()
    const x = 108 * 0.1
    const { project: once } = addWire(p, [{ x, y: -(90 * 1.27) / 12.7 }, { x, y: -(95 * 1.27) / 12.7 }])
    const twice = settleKicadSheet(p, once)
    expect(twice.wires).toEqual(once.wires)
    expect(editorGroups(twice).flat()).not.toContain("R5.2")
  })
})

describe("turning and mirroring a part on a sheet joined by KiCad's rules keep its nets", () => {
  const turns = () => [PROOF(), GRID()]
  for (const [name, sheet] of [["the proof sheet", PROOF], ["the grid sheet", GRID]] as const) {
    it(`every part, turned a quarter at a time and mirrored both ways, on ${name}`, () => {
      const p = sheet()
      const want = editorGroups(p)
      for (const c of p.components) {
        let q = p
        for (let i = 0; i < 4; i++) {
          const r = rotateSelection(q, { components: [c.id], labels: [] })
          if (!r.ok) break
          q = r.project
          expect(kept(want, editorGroups(q)), `${c.ref} turned ${i + 1} times: ${JSON.stringify(editorGroups(q))}`).toBe(true)
          if (name === "the grid sheet") expect(kicadGroups(q), `${c.ref} turned ${i + 1} times (oracle)`).toEqual(editorGroups(q))
        }
        for (const axis of ["x", "y"] as Mirror[]) {
          const r = mirrorSelection(p, { components: [c.id] }, axis)
          if (!r.ok) continue
          expect(kept(want, editorGroups(r.project)), `${c.ref} mirrored ${axis}: ${JSON.stringify(editorGroups(r.project))}`).toBe(true)
          if (name === "the grid sheet") expect(kicadGroups(r.project), `${c.ref} mirrored ${axis} (oracle)`).toEqual(editorGroups(r.project))
        }
      }
    })
  }
  void turns
})

describe("deleting on a sheet joined by KiCad's rules leaves the other nets as they were", () => {
  it("a part or a wire deleted: the pins left are joined as KiCad joins them", () => {
    const p = GRID()
    for (const ref of ["R5", "R6", "R7"]) {
      const q = removeItems(p, { components: [id(p, ref)] })
      expect(editorGroups(q)).toEqual(KICAD_NETS)
      expect(kicadGroups(q)).toEqual(KICAD_NETS)
    }
    const q = removeItems(p, { wires: [wireAt(p, 64 * 1.27, 95 * 1.27).id] })
    expect(kicadGroups(q)).toEqual(editorGroups(q))
  })
})

describe("Tidy on a sheet joined by KiCad's rules", () => {
  it("when it succeeds, the nets it leaves are KiCad's and are the nets there were", () => {
    const p = GRID()
    const r = tidySchematic(p)
    if (!r.ok || !r.changed) return
    expect(editorGroups(r.project).filter((g) => !g.some((x) => /^R[5-7]/.test(x)))).toEqual(KICAD_NETS)
    expect(kicadGroups(r.project)).toEqual(editorGroups(r.project))
  })
})

describe("Sakura's tools on a sheet joined by KiCad's rules", () => {
  it("connect joins what it says, in KiCad's reading too, and leaves the old T alone", () => {
    const p = GRID()
    const out = runTool(p, "connect", { pins: ["R7.2", "R6.1"] })
    expect(out.isError).toBe(false)
    const mine = editorGroups(out.project)
    expect(mine.some((g) => g.includes("R7.2") && g.includes("R6.1"))).toBe(true)
    expect(mine.flat()).not.toContain("R5.2")
    expect(kicadGroups(out.project)).toEqual(mine)
  })

  it("moving a part keeps its nets (update_component) and removing one leaves the others' (remove_component)", () => {
    const p = PROOF()
    const out = runTool(p, "update_component", { ref: "R2", x: -3, y: 0 })
    expect(out.isError).toBe(false)
    expect(editorGroups(out.project)).toEqual(KICAD_NETS)
    const gone = runTool(p, "remove_component", { ref: "R6" })
    expect(editorGroups(gone.project)).toEqual(KICAD_NETS)
  })

  it("turning a part keeps its nets (update_component rotation)", () => {
    const p = PROOF()
    const out = runTool(p, "update_component", { ref: "R1", rotation: 90 })
    expect(out.isError).toBe(false)
    expect(editorGroups(out.project)).toEqual(KICAD_NETS)
  })
})
