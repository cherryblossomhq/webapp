import { describe, expect, it } from "vitest"
import { describeSource } from "../src/ai/partTools"
import { createBlock } from "../src/model/blocks"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { fileModel, modelAssignment, setModel } from "../src/model/models3d"
import { addComponent, addWire, createProject } from "../src/model/ops"
import { needsCheck, partFindings } from "../src/model/partChecks"
import { partSourceLine } from "../src/model/partSource"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { draftChanged, draftOf, editPart, editedSource, partUsers, removeParts, unusedParts, type PartDraft } from "../src/model/projectParts"
import type { CustomPartSpec, FootprintDef, PartSource, Project } from "../src/model/types"

// The project's own parts as a library the user keeps (`model/projectParts.ts`): which components
// each is placed as, removing the ones a project no longer needs with what only they used, and
// editing one, every component placed from it following.

const LDO: Omit<CustomPartSpec, "id"> = {
  name: "TPS7A0233",
  description: "200 mA 3.3 V LDO",
  category: "Power",
  refPrefix: "U",
  footprint: "sot23_5",
  pins: [
    { number: "1", name: "IN", kind: "power" },
    { number: "2", name: "GND", kind: "ground" },
    { number: "3", name: "EN", kind: "input" },
    { number: "4", name: "NC", kind: "nc" },
    { number: "5", name: "OUT", kind: "output" },
  ],
  props: { mpn: "TPS7A0233", manufacturer: "Texas Instruments" },
  valueProp: "mpn",
}

const SENSOR: Omit<CustomPartSpec, "id"> = {
  name: "SHT31",
  description: "Humidity sensor",
  category: "ICs",
  refPrefix: "U",
  footprint: "soic8",
  pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}` })),
  props: { mpn: "SHT31" },
}

const SUPPLIER: PartSource = {
  pins: "supplier",
  land: "supplier",
  supplier: { lcsc: "C2861500", mpn: "TPS7A0233", confidence: "disputed", vendors: 2, fetchedAt: "2026-10-01", disputes: ["pin 3 is EN in one, NC in the other"], attribution: "Part data: EasyEDA" },
}

const KICAD: PartSource = {
  pins: "database",
  land: "database",
  database: { origin: "kicad", key: "Regulator_Linear:TPS7A0233", release: "10.0.7", licence: "CC-BY-SA-4.0", attribution: "From KiCad's libraries." },
  check: { at: "2026-10-01", lcsc: "C2861500", verdict: "agrees", findings: [] },
}

const spec = (d: Omit<CustomPartSpec, "id">): CustomPartSpec => ({ id: customPartId(d), ...d })

function projectWith(...specs: CustomPartSpec[]): Project {
  const p = { ...createProject("parts"), parts: specs }
  registerProjectParts(p)
  return p
}

const place = (p: Project, id: string, at = { x: 0, y: 0 }, props?: Record<string, string>) => addComponent(p, id, { sch: at, ...(props && { props }) }).project

const edit = (s: CustomPartSpec, patch: Partial<PartDraft>): PartDraft => ({ ...draftOf(s), ...patch })

describe("which parts a project uses", () => {
  it("counts every component placed from a part, and lists the ones nothing is placed from", () => {
    const ldo = spec(LDO)
    const sensor = spec(SENSOR)
    let p = projectWith(ldo, sensor)
    p = place(place(p, ldo.id), ldo.id, { x: 5, y: 0 })
    expect(partUsers(p, ldo.id).map((c) => c.ref)).toEqual(["U1", "U2"])
    expect(partUsers(p, sensor.id)).toEqual([])
    expect(unusedParts(p).map((s) => s.name)).toEqual(["SHT31"])
  })
})

describe("removing a part", () => {
  it("takes out an unused part and leaves the rest of the project as it was", () => {
    const ldo = spec(LDO)
    const sensor = spec(SENSOR)
    const p = place(projectWith(ldo, sensor), ldo.id)
    const next = removeParts(p, [sensor.id])
    expect(next.parts!.map((s) => s.id)).toEqual([ldo.id])
    expect(next.components).toEqual(p.components)
  })

  it("deletes the components placed from it, their block membership, its 3D models and the land only it used", () => {
    const land: FootprintDef = { name: "odd_land-abc123", pads: [{ pin: "1", shape: "rect", x: 0, y: 0, width: 1, height: 1, layer: "top" }], silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 } }
    const one = spec({ ...SENSOR, name: "ODD", footprint: land.name, pins: [{ number: "1", name: "A" }] })
    const ldo = spec(LDO)
    let p: Project = { ...projectWith(ldo), footprints: [land] }
    p = { ...p, parts: [...p.parts!, one] }
    registerProjectParts(p)
    p = place(place(p, one.id), ldo.id, { x: 6, y: 0 })
    const odd = p.components.find((c) => c.partId === one.id)!
    p = createBlock(p, "SENSORS", [odd.id, p.components[1].id]).project
    p = setModel(p, one.id, land.name, fileModel("a".repeat(64), "odd.step", "step"))
    p = setModel(p, ldo.id, "sot23_5", fileModel("b".repeat(64), "ldo.step", "step"))

    const next = removeParts(p, [one.id])
    expect(next.parts!.map((s) => s.name)).toEqual(["TPS7A0233"])
    expect(next.components.map((c) => c.partId)).toEqual([ldo.id])
    expect(next.blocks![0].components).toEqual([p.components[1].id])
    expect(next.footprints).toBeUndefined()
    expect(modelAssignment(next, one.id, land.name)).toBeNull()
    expect(modelAssignment(next, ldo.id, "sot23_5")).not.toBeNull()
  })

  it("keeps a land or a symbol drawing another part still names", () => {
    const land: FootprintDef = { name: "shared_land-abc123", pads: [{ pin: "1", shape: "rect", x: 0, y: 0, width: 1, height: 1, layer: "top" }], silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 } }
    const a = spec({ ...SENSOR, name: "A", footprint: land.name, pins: [{ number: "1", name: "X" }] })
    const b = spec({ ...SENSOR, name: "B", footprint: land.name, pins: [{ number: "1", name: "Y" }] })
    const p: Project = { ...createProject("shared"), parts: [a, b], footprints: [land] }
    registerProjectParts(p)
    expect(removeParts(p, [a.id]).footprints).toEqual([land])
    expect(removeParts(p, [a.id, b.id]).footprints).toBeUndefined()
    expect(removeParts(p, [a.id, b.id]).parts).toBeUndefined()
  })

  it("changes nothing for a part the project doesn't have", () => {
    const p = projectWith(spec(LDO))
    expect(removeParts(p, ["nope-000000"])).toBe(p)
  })
})

describe("editing a part", () => {
  it("is nothing at all when the draft says what the part already says", () => {
    const ldo = spec(LDO)
    const p = place(projectWith(ldo), ldo.id)
    expect(draftChanged(ldo, draftOf(ldo))).toBe(false)
    // Whitespace and an empty parameter are not a change.
    expect(draftChanged(ldo, edit(ldo, { name: " TPS7A0233 ", props: { ...LDO.props, note: "" } }))).toBe(false)
    const res = editPart(p, ldo.id, draftOf(ldo))
    expect(res).toEqual({ ok: true, project: p, id: ldo.id, moved: [] })
  })

  it("makes a new part in the old one's place, and switches every component placed from it", () => {
    const ldo = spec(LDO)
    const sensor = spec(SENSOR)
    let p = projectWith(ldo, sensor)
    p = place(place(p, ldo.id), ldo.id, { x: 6, y: 0 })
    const res = editPart(p, ldo.id, edit(ldo, { name: "TPS7A02 3.3V", description: "Nano-power LDO" }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    expect(res.id).not.toBe(ldo.id)
    expect(res.project.parts!.map((s) => s.name)).toEqual(["TPS7A02 3.3V", "SHT31"])
    expect(res.project.components.every((c) => c.partId === res.id)).toBe(true)
    expect(findPart(res.id)).toMatchObject({ name: "TPS7A02 3.3V", description: "Nano-power LDO" })
    // Its name says nothing about its pins or land: the provenance stays.
    const supplied = projectWith({ ...ldo, source: SUPPLIER })
    const kept = editPart(supplied, ldo.id, edit(ldo, { name: "Renamed" }))
    expect(kept.ok && kept.project.parts![0].source).toEqual(SUPPLIER)
  })

  it("gives the new parameters to components that still have the old ones, and leaves a component's own value", () => {
    const ldo = spec(LDO)
    let p = projectWith(ldo)
    p = place(p, ldo.id)
    p = place(p, ldo.id, { x: 6, y: 0 }, { manufacturer: "TI (second source)" })
    const res = editPart(p, ldo.id, edit(ldo, { props: { mpn: "TPS7A0233DBVR", manufacturer: "Texas Instruments Inc.", datasheet: "https://ti.com/lit/ds/tps7a02.pdf" } }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    const [u1, u2] = res.project.components
    expect(u1.props).toEqual({ mpn: "TPS7A0233DBVR", manufacturer: "Texas Instruments Inc.", datasheet: "https://ti.com/lit/ds/tps7a02.pdf" })
    expect(u2.props).toEqual({ mpn: "TPS7A0233DBVR", manufacturer: "TI (second source)", datasheet: "https://ti.com/lit/ds/tps7a02.pdf" })
    // A parameter the part no longer has goes from the components that had its value.
    const dropped = editPart(res.project, res.id, edit(res.project.parts![0], { props: { mpn: "TPS7A0233DBVR" } }))
    expect(dropped.ok && dropped.project.components.map((c) => c.props)).toEqual([{ mpn: "TPS7A0233DBVR" }, { mpn: "TPS7A0233DBVR", manufacturer: "TI (second source)" }])
  })

  it("moves components to a new footprint unless they were given another, and drops the 3D model fitted to the old one", () => {
    const ldo = spec(LDO)
    let p = projectWith(ldo)
    p = place(p, ldo.id)
    p = addComponent(p, ldo.id, { sch: { x: 6, y: 0 }, footprint: "sot23_5_w1.6mm" }).project
    p = setModel(p, ldo.id, "sot23_5", fileModel("c".repeat(64), "ldo.step", "step"))
    p = setModel(p, ldo.id, "sot23_5_w1.6mm", fileModel("d".repeat(64), "ldo-wide.step", "step"))
    const res = editPart(p, ldo.id, edit(ldo, { footprint: "sot23_5_p0.95mm" }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    expect(res.project.components.map((c) => c.footprint)).toEqual(["sot23_5_p0.95mm", "sot23_5_w1.6mm"])
    expect(res.project.models).toEqual([{ part: res.id, footprint: "sot23_5_w1.6mm", model: fileModel("d".repeat(64), "ldo-wide.step", "step") }])
  })

  it("keeps the part's 3D model when the footprint stays", () => {
    const ldo = spec(LDO)
    const p = setModel(place(projectWith(ldo), ldo.id), ldo.id, "sot23_5", fileModel("c".repeat(64), "ldo.step", "step"))
    const res = editPart(p, ldo.id, edit(ldo, { description: "Another description" }))
    expect(res.ok && modelAssignment(res.project, res.id, "sot23_5")).toEqual(fileModel("c".repeat(64), "ldo.step", "step"))
  })

  it("gives the part the 3D model chosen in the editor, on its footprint, with or without another change", () => {
    const ldo = spec(LDO)
    const step = fileModel("c".repeat(64), "ldo.step", "step")
    const p = place(projectWith(ldo), ldo.id)
    // The model alone: the part stays the part.
    const only = editPart(p, ldo.id, draftOf(ldo), { model: step })
    if (!only.ok) throw new Error(only.problems.join("; "))
    expect(only.id).toBe(ldo.id)
    expect(only.project.parts).toBe(p.parts)
    expect(only.project.models).toEqual([{ part: ldo.id, footprint: "sot23_5", model: step }])
    // The same model again, or none where there is none, changes nothing.
    expect(editPart(only.project, ldo.id, draftOf(ldo), { model: step })).toMatchObject({ project: only.project })
    expect(editPart(p, ldo.id, draftOf(ldo), { model: null })).toMatchObject({ project: p })
    // With a new footprint the model chosen goes on the new one, under the part's new id, where the old one's would be dropped.
    const moved = editPart(only.project, ldo.id, edit(ldo, { footprint: "sot23_5_p0.95mm" }), { model: { ...step, rotation: { x: 0, y: 0, z: 90 } } })
    if (!moved.ok) throw new Error(moved.problems.join("; "))
    expect(moved.project.models).toEqual([{ part: moved.id, footprint: "sot23_5_p0.95mm", model: { ...step, rotation: { x: 0, y: 0, z: 90 } } }])
    // Null is the generated body.
    const plain = editPart(only.project, ldo.id, edit(ldo, { description: "Plain" }), { model: null })
    expect(plain.ok && plain.project.models).toBeUndefined()
  })

  it("keeps the parameter shown as the value when the part gives it no default, as a KiCad part's is", () => {
    const board = spec({ ...SENSOR, name: "U_SENSOR", props: {}, valueProp: "value" })
    const p = place(projectWith(board), board.id, { x: 0, y: 0 }, { value: "SHT31" })
    expect(draftOf(board).valueProp).toBe("value")
    const res = editPart(p, board.id, edit(board, { description: "Renamed" }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    expect(res.project.parts![0].valueProp).toBe("value")
    expect(findPart(res.id)!.valueProp).toBe("value")
    expect(res.project.components[0].props).toEqual({ value: "SHT31" })
  })

  it("refuses a definition that can't be built, saying why", () => {
    const ldo = spec(LDO)
    const p = place(projectWith(ldo), ldo.id)
    const res = editPart(p, ldo.id, edit(ldo, { pins: [...LDO.pins, { number: "6", name: "EXTRA" }] }))
    expect(res.ok).toBe(false)
    expect(!res.ok && res.problems.join(" ")).toMatch(/pin\(s\) 6 have no pad/)
    expect(editPart(p, ldo.id, edit(ldo, { refPrefix: "u1" })).ok).toBe(false)
    expect(editPart(p, "gone-000000", draftOf(ldo))).toEqual({ ok: false, problems: [expect.stringMatching(/no longer in the project/)] })
  })

  it("says which components' pins moved with the symbol", () => {
    const ldo = spec(LDO)
    const p = place(projectWith(ldo), ldo.id)
    const pins = LDO.pins.map((pin) => (pin.name === "EN" ? { ...pin, side: "right" as const } : pin))
    const res = editPart(p, ldo.id, edit(ldo, { pins }))
    expect(res.ok && res.moved).toEqual(["U1"])
  })

  it("refuses an edit that would put a pin on another net's wire", () => {
    const ldo = spec(LDO)
    let p = place(projectWith(ldo), ldo.id)
    const pins = LDO.pins.map((pin) => (pin.name === "EN" ? { ...pin, side: "right" as const } : pin))
    // Where EN would be, a wire of two other pins' net passes through.
    const trial = editPart(p, ldo.id, edit(ldo, { pins }))
    if (!trial.ok) throw new Error(trial.problems.join("; "))
    const at = schematicPins(trial.project.components[0]).find((w) => w.name === "EN")!.pos
    p = addWire(p, [
      { x: at.x - 2, y: at.y },
      { x: at.x + 2, y: at.y },
    ]).project
    p = { ...p, labels: [{ id: "l1", name: "OTHER", x: at.x + 2, y: at.y, rot: 0 }] }
    const before = schematicPins(p.components[0]).find((w) => w.name === "EN")!.pos
    p = addWire(p, [before, { x: before.x - 1, y: before.y }]).project
    p = { ...p, labels: [...p.labels, { id: "l2", name: "ENABLE", x: before.x - 1, y: before.y, rot: 0 }] }
    const res = editPart(p, ldo.id, edit(ldo, { pins }))
    expect(res.ok).toBe(false)
    expect(!res.ok && res.problems[0]).toMatch(/^With its new symbol, it would join U1\.NC and ENABLE/)
  })

  it("comes out as a part the project already has when it is drawn the same, and switches to it", () => {
    const a = spec(LDO)
    const b = spec({ ...LDO, description: "Another" })
    const p = place(projectWith(a, b), a.id)
    const res = editPart(p, a.id, draftOf(b))
    if (!res.ok) throw new Error(res.problems.join("; "))
    expect(res.id).toBe(b.id)
    expect(res.project.parts!.map((s) => s.id)).toEqual([b.id])
    expect(res.project.components[0].partId).toBe(b.id)
  })
})

describe("the provenance of an edited part", () => {
  it("is the user's for pins or a land changed by hand, and drops a check of what was there", () => {
    expect(editedSource(KICAD, { pins: false, land: false })).toBe(KICAD)
    expect(editedSource(KICAD, { pins: true, land: false })).toEqual({ ...KICAD, pins: "user", check: undefined })
    expect(editedSource(KICAD, { pins: false, land: true })).toMatchObject({ pins: "database", land: "user" })
    expect(editedSource(KICAD, { pins: false, land: true })!.check).toBeUndefined()
    // A part made from memory stays unverified however it is edited.
    const memory: PartSource = { pins: "memory", land: "memory", check: { at: "x", verdict: "contradicted", findings: ["pin 1 is GND"] } }
    expect(editedSource(memory, { pins: true, land: true })).toEqual({ pins: "memory", land: "memory" })
    expect(editedSource(undefined, { pins: true, land: true })).toBeUndefined()
  })

  it("quiets Checks about a supplier's dispute it no longer follows, says so in the Inspector with the credit, and survives a save", () => {
    const ldo = spec({ ...LDO, source: SUPPLIER })
    const p = place(projectWith(ldo), ldo.id)
    expect(partFindings(p).map((f) => f.message).join(" ")).toMatch(/disagree about its pins/)
    const pins = LDO.pins.map((pin) => (pin.number === "3" ? { ...pin, name: "ENABLE" } : pin))
    const res = editPart(p, ldo.id, edit(ldo, { pins }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    const edited = res.project.parts![0]
    expect(edited.source).toMatchObject({ pins: "user", land: "supplier" })
    expect(partFindings(res.project)).toEqual([])
    expect(needsCheck(edited)).toBe(false)
    expect(partSourceLine(edited)).toEqual({ label: "Edited by hand", detail: "Pins changed from LCSC C2861500, supplier drawings disagree", credit: "Part data: EasyEDA" })
    expect(describeSource(edited)).toMatch(/^from LCSC C2861500, .*then its pins edited by hand by the user/)
    const reopened = parseProjectFile(serializeProject(res.project), { id: res.project.id })
    expect(reopened.parts![0].source).toEqual(edited.source)
  })

  it("keeps a part made from memory a warning after its pins are edited, and asks for a check again", () => {
    const memory = spec({ ...LDO, source: { pins: "memory", land: "memory", check: { at: "x", lcsc: "C1", verdict: "agrees", findings: [] } } })
    const p = place(projectWith(memory), memory.id)
    expect(partFindings(p)).toEqual([])
    const pins = LDO.pins.map((pin) => (pin.number === "4" ? { ...pin, name: "PG" } : pin))
    const res = editPart(p, memory.id, edit(memory, { pins }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    expect(needsCheck(res.project.parts![0])).toBe(true)
    expect(partFindings(res.project).map((f) => f.severity)).toEqual(["warning"])
  })

  it("names the land as changed by hand on a KiCad part whose footprint was swapped", () => {
    const kicad = spec({ ...LDO, source: KICAD })
    const p = place(projectWith(kicad), kicad.id)
    const res = editPart(p, kicad.id, edit(kicad, { footprint: "sot23_5_p0.95mm" }))
    if (!res.ok) throw new Error(res.problems.join("; "))
    const line = partSourceLine(res.project.parts![0])!
    expect(line.label).toBe("KiCad library")
    expect(line.detail).toBe("Regulator_Linear:TPS7A0233, release 10.0.7. Footprint changed by hand")
    expect(line.credit).toMatch(/KiCad's libraries/)
    expect(partFindings(res.project)).toEqual([])
  })
})
