import type { SupplierPart } from "@cherryblossom/api-contract"
import { EXAMPLES } from "../src/model/examples"
import { registerProjectParts } from "../src/model/customParts"
import { addDrawings } from "../src/model/drawings"
import { addDraftToProject } from "../src/model/indexPart"
import { addLabel, connectPins, createProject, updateComponent } from "../src/model/ops"
import { draftFromSupplierPart } from "../src/model/supplierPart"
import { autoPlacePcb } from "../src/model/autoplace"
import type { Project } from "../src/model/types"
import { recordedPart } from "./fixtures/supplier/source"

// The projects the editor round trip is measured on: the shipped examples (routed boards with a schematic), the same boards dressed the way a user dresses them
// (free text, shapes, a titled block, a label, a turned and a mirrored part), and boards built from parts with an LCSC number (the supplier records the suite
// recorded, with their land and, for one, their 3D model).

export interface Case {
  id: string
  project: Project
}

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project

/** The shipped examples, dressed: free text, a box and a line on the sheet, a free label, a turned part and a mirrored one. */
function dressed(id: string): Case {
  let p = example(id)
  const first = p.components.find((c) => !c.ref.startsWith("#"))!
  p = addDrawings(p, [
    { type: "text", x: first.sch.x - 1, y: first.sch.y - 2.5, text: "NOTE: check the supply before ordering", size: 0.1 },
    { type: "text", x: first.sch.x - 1, y: first.sch.y - 2.2, text: "Rev B", size: 0.15, bold: true, align: "left" },
    { type: "rect", x: first.sch.x - 1.2, y: first.sch.y - 2.8, width: 3, height: 0.8 },
    { type: "line", points: [{ x: first.sch.x - 1.2, y: first.sch.y - 1.9 }, { x: first.sch.x + 1.8, y: first.sch.y - 1.9 }] },
  ] as never).project
  p = addLabel(p, "TEST_POINT", { x: first.sch.x + 2, y: first.sch.y - 3 }, 0).project
  const second = p.components.filter((c) => !c.ref.startsWith("#"))[1]
  if (second) p = updateComponent(p, second.id, { sch: { rot: 90, mirror: "y" } })
  return { id: `${id}+dressed`, project: p }
}

/** A board of parts the supplier records know, on a sheet with their pins joined to a rail and the ground. */
function lcscBoard(name: string, numbers: string[]): Case {
  let p = createProject(name)
  const parts: SupplierPart[] = numbers.map((n) => recordedPart(n))
  let x = 0
  for (const part of parts) {
    const built = draftFromSupplierPart(part)
    if ("error" in built) throw new Error(built.error)
    const added = addDraftToProject(p, built)
    if ("error" in added) throw new Error(added.error)
    p = added.project
    p = { ...p, components: [...p.components, { id: `c_${part.lcsc}`, partId: added.spec.id, ref: `${added.spec.refPrefix}${p.components.length + 1}`, props: { ...added.spec.props }, footprint: added.spec.footprint, sch: { x, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false } }] }
    x += 6
  }
  registerProjectParts(p)
  const pins = p.components.map((c) => ({ componentId: c.id, pin: "1" }))
  for (let i = 1; i < pins.length; i++) p = connectPins(p, pins[0], pins[i])
  p = autoPlacePcb(p, true)
  return { id: `lcsc:${name}`, project: p }
}

export function cases(): Case[] {
  return [
    ...EXAMPLES.map((e) => ({ id: e.id, project: e.project })),
    dressed("blinker"),
    dressed("regulator"),
    lcscBoard("ldo-and-friends", ["C22365427", "C919459", "C80165", "C138706", "C908680"]),
    lcscBoard("mcu-and-flash", ["C8734", "C2984960", "C347222"]),
  ]
}
