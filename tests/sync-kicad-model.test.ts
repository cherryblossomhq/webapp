import { applyChanges, jsonEqual } from "@cherryblossom/project-changes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addDrawings } from "../src/model/drawings"
import { addComponent, addWire, createProject } from "../src/model/ops"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import { addSheet, addSheetUse, moveSheetSymbols, removeSheetSymbols, resizeSheetSymbol, addSheetPin, setSheetSymbol } from "../src/model/sheetOps"
import { settleStructure } from "../src/model/settleStructure"
import { commitOnUse, ROOT_SHEET, sheetUses, useOf } from "../src/model/sheets"
import { withCopperCount } from "../src/model/stack"
import type { Project, Zone } from "../src/model/types"
import { addVariant, setActiveVariant, setVariantOverride } from "../src/model/variants"
import { PROJECT_SHAPE, projectChanges } from "../src/store/changes"
import { connectProjectStorage, useProjectStore } from "../src/store/projectStore"
import { openStoredProject, projectRecord } from "../src/store/storage"
import { ProjectSync, type SaveStatus, type SyncHost } from "../src/store/sync"
import { memoryStorage } from "./memoryStorage"

/**
 * Live editing of the KiCad model: every field a KiCad import adds to a project travels, two
 * copies that edit it at once end up equal, the rules that keep a KiCad sheet right survive a remote
 * change, and a viewer's copy refuses an edit of any of it.
 */

// ---------- every field of a project, and how it travels ----------

/**
 * How each field of `Project` is kept in step between copies. Typed on `keyof Project`, so a field added to the model
 * fails to compile here until someone says how it travels (and `PROJECT_SHAPE`, in `store/changes.ts`, agrees).
 *  - item: a list of items edited one by one, each named by its id (or the field named in `KEYS`)
 *  - value: the field as a value, down to each of its keys; a list with no ids in it is one value, the later edit wins
 *  - never: where a copy is kept, not what it is
 */
const HOW: Record<keyof Project, "item" | "value" | "never"> = {
  id: "never",
  createdAt: "never",
  updatedAt: "never",
  name: "value",
  description: "value",
  components: "item",
  wires: "item",
  labels: "item",
  sheets: "item",
  sheetSymbols: "item",
  busAliases: "item",
  variants: "value",
  scope: "never",
  traces: "item",
  vias: "item",
  zones: "item",
  texts: "item",
  graphics: "item",
  dimensions: "item",
  groups: "item",
  images: "item",
  board: "value",
  rules: "value",
  blocks: "item",
  drawings: "item",
  netNames: "value",
  parts: "item",
  symbols: "value",
  footprints: "item",
  models: "value",
  properties: "item",
  ignoredChecks: "value",
  importMarks: "value",
  points: "value",
  netChains: "item",
  fonts: "value",
  kicad: "value",
  netStyles: "value",
}
const KEYS: Partial<Record<keyof Project, string>> = { footprints: "name", properties: "key", netChains: "name" }

/** The KiCad half of a project, every field set. Shapes are only as real as sync needs: sync reads ids and values, never the model. */
function rich(): Project {
  let p = createProject("Rich")
  p = addComponent(p, "resistor").project
  p = addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Power").project
  p = addVariant(p, "Lite") ?? p
  p = setActiveVariant(p, "Lite")
  p = addDrawings(p, [{ type: "bus", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] } as never]).project
  return {
    ...p,
    busAliases: [{ id: "ba1", name: "DATA", members: ["D0", "D1"] }],
    graphics: [{ id: "g1", kind: "line", layer: "F.SilkS" }] as never,
    dimensions: [{ id: "dm1", kind: "aligned", layer: "Cmts.User", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }] as never,
    groups: [{ id: "gr1", name: "G", members: ["g1"] }],
    images: [{ id: "im1", x: 0, y: 0, layer: "F.Cu", scale: 1, file: "ab".repeat(32), format: "png", px: 10, py: 10, ppi: 300 }],
    wires: [{ id: "w1", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
    labels: [{ id: "l1", name: "A", x: 0, y: 0, rot: 0 }] as never,
    traces: [{ id: "t1", net: "A", layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] as never,
    vias: [{ id: "v1", x: 0, y: 0, net: "A", diameter: 0.6, drill: 0.3 }] as never,
    texts: [{ id: "tx1", text: "hi", x: 0, y: 0 }] as never,
    blocks: [{ id: "bl1", name: "Power", members: [] }] as never,
    parts: [{ id: "cp1", name: "Mine" }] as never,
    footprints: [{ name: "fp_a", pads: [], silk: [], courtyard: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }],
    netNames: "kicad",
    symbols: { k1: { pins: [] } as never },
    models: [{ part: "p", footprint: "f", model: { id: "m", name: "m", source: "file", format: "step" } as never }],
    properties: [{ key: "rev", value: "A" }],
    ignoredChecks: ["bare-led:c_1"],
    importMarks: { checks: ["bare-led:c_1"], noConnect: { c_1: ["1"] } },
    points: [{ x: 1, y: 2, size: 0.5, layer: "F.Fab" }],
    netChains: [{ name: "Chain", nets: ["A", "B"] }],
    fonts: { board: true, files: [] },
    kicad: { paper: '"A4"' },
    netStyles: { VBUS: "label" },
    zones: [{ id: "z1", net: "GND", layer: "top" } as Zone],
    board: withCopperCount({ ...p.board }, 4),
  }
}

describe("every field of a project", () => {
  it("is said to travel as the shape of the project has it", () => {
    for (const [field, how] of Object.entries(HOW)) {
      const named = PROJECT_SHAPE.collections[field]
      if (how === "item") expect(named, field).toBe(KEYS[field as keyof Project] ?? "id")
      else expect(named, field).toBeUndefined()
      expect(PROJECT_SHAPE.ignore?.includes(field) ?? false, field).toBe(how === "never")
    }
    // Lists inside objects: the variants of the schematic, by name.
    expect(PROJECT_SHAPE.collections["variants.list"]).toBe("name")
    // Nothing in the shape that the table does not know.
    for (const name of Object.keys(PROJECT_SHAPE.collections)) if (!name.includes(".")) expect(HOW, name).toHaveProperty(name)
  })

  it("travels: the changes from an empty project to a full one rebuild the full one", () => {
    const empty = createProject("Rich")
    const full = rich()
    const rebuilt = applyChanges(empty, projectChanges(empty, full))
    const strip = (p: Project) => {
      const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = p
      void _i, void _c, void _u
      return rest
    }
    expect(jsonEqual(strip(rebuilt), strip(full))).toBe(true)
    for (const [field, how] of Object.entries(HOW)) {
      if (how === "never" || field === "scope") continue
      expect(JSON.stringify((full as unknown as Record<string, unknown>)[field]) !== undefined, `${field} is set in the sample`).toBe(true)
    }
  })

  it("is the same document after the changes between any two states of it are applied", () => {
    const a = rich()
    const b = {
      ...a,
      sheets: [],
      variants: undefined,
      busAliases: [{ id: "ba1", name: "DATA", members: ["D0"] }, { id: "ba2", name: "ADDR", members: [] }],
      importMarks: undefined,
      symbols: { k2: { pins: [] } as never },
    } as Project
    const there = applyChanges(a, projectChanges(a, b))
    expect(jsonEqual({ ...there, id: "", updatedAt: 0, createdAt: 0 }, { ...b, id: "", updatedAt: 0, createdAt: 0 })).toBe(true)
    const back = applyChanges(b, projectChanges(b, a))
    expect(jsonEqual({ ...back, id: "", updatedAt: 0, createdAt: 0 }, { ...a, id: "", updatedAt: 0, createdAt: 0 })).toBe(true)
  })
})

// ---------- two copies editing the KiCad model ----------

const api = () => useProjectStore.getState()
const settle = () => vi.advanceTimersByTimeAsync(200)

describe("two copies of one project, editing the KiCad model", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A copy of its own: a sync and what it shows, without the store (which is one per page). */
  function tab(memory: ReturnType<typeof memoryStorage>, id: string, project: Project, revision: number) {
    const shown = { project, status: { state: "saved" } as SaveStatus }
    const host: SyncHost = {
      rebase: (p) => (shown.project = p),
      status: (s) => (shown.status = s),
      role: () => {},
      gone: () => {},
      refused: () => {},
      held: () => {},
    }
    const sync = new ProjectSync(id, project, revision, PROJECT_FILE_VERSION, "owner", memory.storage, host)
    sync.start()
    const edit = (fn: (p: Project) => Project) => {
      const next = fn(shown.project)
      sync.send(projectChanges(shown.project, next))
      shown.project = next
    }
    return { shown, edit }
  }

  async function pair(start: Project) {
    const memory = memoryStorage()
    const { id } = await memory.storage.create(projectRecord(start))
    const opened = openStoredProject((await memory.storage.load(id))!)
    const ada = tab(memory, id, opened, 1)
    const bob = tab(memory, id, opened, 1)
    await vi.advanceTimersByTimeAsync(0)
    /** Everything sent has landed and come back: the two copies and the stored document hold one project. */
    const equal = async () => {
      await vi.advanceTimersByTimeAsync(500)
      const strip = (p: Project) => ({ ...p, id: "", createdAt: 0, updatedAt: 0 })
      expect(ada.shown.status.state).toBe("saved")
      expect(bob.shown.status.state).toBe("saved")
      expect(jsonEqual(strip(ada.shown.project), strip(bob.shown.project))).toBe(true)
      // What storage holds, read back as a copy reads it.
      const stored = openStoredProject((await memory.storage.load(id))!)
      expect(jsonEqual(strip(stored), strip(ada.shown.project))).toBe(true)
      return ada.shown.project
    }
    return { memory, id, ada, bob, equal }
  }

  it("a sheet symbol: added, moved, resized and given a pin, by two people", async () => {
    const { ada, bob, equal } = await pair(createProject("Sheets"))
    let symbolId = ""
    ada.edit((p) => {
      const r = addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Power")
      symbolId = r.symbol.id
      return r.project
    })
    let seen = await equal()
    expect(seen.sheetSymbols).toHaveLength(1)
    expect(seen.sheets).toHaveLength(2)
    // At once: one moves the symbol, the other renames it and gives it a pin.
    ada.edit((p) => moveSheetSymbols(p, [symbolId], { x: 5, y: 5 }))
    bob.edit((p) => addSheetPin(setSheetSymbol(p, symbolId, { name: "Supply" }), symbolId, "VIN"))
    ada.edit((p) => resizeSheetSymbol(p, symbolId, 12, 8))
    seen = await equal()
    const sym = seen.sheetSymbols![0]
    expect(sym).toMatchObject({ name: "Supply", w: 12, h: 8 })
    expect(sym.x).not.toBe(0)
    expect(sym.pins.map((x) => x.name)).toEqual(["VIN"])
    expect(bob.shown.project.sheetSymbols![0]).toEqual(sym)
  })

  it("a variant: two people each add one at the same moment, and both stay", async () => {
    const start = addComponent(createProject("Variants"), "resistor").project
    const { ada, bob, equal } = await pair(start)
    ada.edit((p) => addVariant(p, "Lite")!)
    bob.edit((p) => addVariant(p, "Pro")!)
    let seen = await equal()
    expect(seen.variants!.list.map((v) => v.name).sort()).toEqual(["Lite", "Pro"])
    const c = seen.components[0]
    ada.edit((p) => setActiveVariant(p, "Pro"))
    bob.edit((p) => setVariantOverride(p, c.id, "Lite", { dnp: true })!)
    seen = await equal()
    expect(seen.variants!.active).toBe("Pro")
    expect(seen.components[0].variants?.Lite?.dnp).toBe(true)
  })

  it("a bus: a bus line and its alias, then a move of it", async () => {
    const { ada, bob, equal } = await pair(createProject("Buses"))
    let busId = ""
    ada.edit((p) => {
      const r = addDrawings(p, [{ type: "bus", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] } as never])
      busId = r.added[0].id
      return { ...r.project, busAliases: [{ id: "ba1", name: "DATA", members: ["D0", "D1"] }] }
    })
    bob.edit((p) => ({ ...p, busAliases: [...(p.busAliases ?? []), { id: "ba2", name: "ADDR", members: ["A0"] }] }))
    let seen = await equal()
    expect(seen.busAliases!.map((a) => a.name).sort()).toEqual(["ADDR", "DATA"])
    bob.edit((p) => ({ ...p, drawings: p.drawings!.map((d) => (d.id === busId ? ({ ...d, points: [{ x: 1, y: 1 }, { x: 5, y: 1 }] } as typeof d) : d)) }))
    seen = await equal()
    expect(seen.drawings![0]).toMatchObject({ type: "bus", points: [{ x: 1, y: 1 }, { x: 5, y: 1 }] })
  })

  it("a zone: one edits its net while the other edits its clearance", async () => {
    const start: Project = { ...createProject("Zones"), zones: [{ id: "z1", net: "GND", layer: "top" }] }
    const { ada, bob, equal } = await pair(start)
    ada.edit((p) => ({ ...p, zones: p.zones.map((z) => ({ ...z, net: "VCC" })) }))
    bob.edit((p) => ({ ...p, zones: [...p.zones.map((z) => ({ ...z, clearance: 0.4 })), { id: "z2", net: "GND", layer: "bottom", keepout: undefined }] }))
    const seen = await equal()
    expect(seen.zones.find((z) => z.id === "z1")).toMatchObject({ net: "VCC", clearance: 0.4 })
    expect(seen.zones.map((z) => z.id).sort()).toEqual(["z1", "z2"])
  })

  it("a four layer stack: set by one while the other routes", async () => {
    const start: Project = { ...createProject("Stack"), traces: [{ id: "t1", net: "N", layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } as never] }
    const { ada, bob, equal } = await pair(start)
    ada.edit((p) => ({ ...p, board: withCopperCount(p.board, 4) }))
    bob.edit((p) => ({ ...p, traces: [...p.traces, { id: "t2", net: "N", layer: "bottom", width: 0.2, points: [{ x: 0, y: 1 }, { x: 2, y: 1 }] } as never] }))
    let seen = await equal()
    expect(seen.board.stack?.copper).toHaveLength(4)
    expect(seen.traces).toHaveLength(2)
    // Back to two layers: the stack goes from both documents, not only from the editing one.
    bob.edit((p) => ({ ...p, board: withCopperCount(p.board, 2) }))
    seen = await equal()
    expect(seen.board.stack).toBeUndefined()
  })

  it("a sheet used twice: an edit of one use reaches the other once, and nothing is applied twice", async () => {
    let start = createProject("Reuse")
    const first = addSheet(start, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Cell")
    const second = addSheetUse(first.project, "", first.symbol.child, { minX: 20, minY: 0, maxX: 30, maxY: 6 }, "Cell B")!
    start = second.project
    const uses = sheetUses(start).filter((u) => u.path !== "")
    expect(uses).toHaveLength(2)
    const { ada, bob, equal } = await pair(start)
    // The copy sync runs where the edit is made: what travels is its result, as changes.
    ada.edit((p) => commitOnUse(p, uses[0].path, (v) => addComponent(v, "resistor").project))
    let seen = await equal()
    expect(seen.components).toHaveLength(2)
    expect(new Set(seen.components.map((c) => c.inst)).size).toBe(2)
    // Both edit a use at once: each use of the sheet ends with both parts, and the parts are not doubled.
    ada.edit((p) => commitOnUse(p, uses[0].path, (v) => addWire(v, [{ x: 0, y: 0 }, { x: 2, y: 0 }]).project))
    bob.edit((p) => commitOnUse(p, uses[1].path, (v) => addComponent(v, "capacitor").project))
    seen = await equal()
    for (const use of uses) {
      const here = seen.components.filter((c) => (c.inst ?? "") === use.path)
      expect(here.map((c) => c.partId).sort(), use.path).toEqual(["capacitor", "resistor"])
    }
    expect(seen.components).toHaveLength(4)
    expect(bob.shown.project.components).toHaveLength(4)
  })

  it("a sheet joined by KiCad's rules is cut at a new T on the copy that edits, and the other copy gets the cut", async () => {
    const start: Project = {
      ...createProject("Join"),
      sheets: [{ id: ROOT_SHEET, kicadRules: true }],
      wires: [{ id: "w1", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }],
    }
    // The store settles an edit as KiCad does before it is sent (`settleEdit`); the copies only apply what was sent.
    const memory = memoryStorage()
    connectProjectStorage(memory.storage)
    try {
      const { id } = await memory.storage.create(projectRecord(start))
      const stored = (await memory.storage.load(id))!
      api().open(openStoredProject(stored), stored)
      await settle()
      api().commit((p) => ({ ...p, wires: [...p.wires, { id: "w2", points: [{ x: 2, y: 3 }, { x: 2, y: 0 }] }] }))
      await settle()
      const mine = api().project!
      expect(mine.wires.length).toBeGreaterThan(2)
      const theirs = openStoredProject((await memory.storage.load(id))!)
      expect(jsonEqual({ ...theirs, id: "", createdAt: 0, updatedAt: 0 }, { ...mine, id: "", createdAt: 0, updatedAt: 0 })).toBe(true)
    } finally {
      api().close()
      connectProjectStorage(null)
    }
  })
})

// ---------- Undo of one's own steps ----------

describe("undo of KiCad-model edits", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    api().close()
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  it("takes back the user's own sheet edit and leaves the other person's variant alone", async () => {
    const memory = memoryStorage()
    connectProjectStorage(memory.storage)
    const { id } = await memory.storage.create(projectRecord(createProject("Undo")))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    let symbolId = ""
    api().commit((p) => {
      const r = addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Power")
      symbolId = r.symbol.id
      return r.project
    })
    api().commit((p) => moveSheetSymbols(p, [symbolId], { x: 5, y: 0 }))
    await settle()
    const now = openStoredProject((await memory.storage.load(id))!)
    await memory.pushAs("other", id, projectChanges(now, addVariant(now, "Lite")!))
    await settle()
    api().undo()
    await settle()
    expect(api().project!.sheetSymbols![0].x).not.toBe(5)
    expect(api().project!.variants!.list.map((v) => v.name)).toEqual(["Lite"])
    api().undo()
    await settle()
    expect(api().project!.sheetSymbols ?? []).toHaveLength(0)
    expect(api().project!.variants!.list.map((v) => v.name)).toEqual(["Lite"])
    expect(memory.project(id).variants.list).toHaveLength(1)
    api().redo()
    await settle()
    expect(memory.project(id).sheetSymbols).toHaveLength(1)
  })
})


// ---------- A sheet tree that stays whole ----------

describe("the sheet tree under undo and other people's edits", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    api().close()
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  const strip = (p: Project) => ({ ...p, id: "", createdAt: 0, updatedAt: 0 })

  /** Nothing on a sheet or use the tree does not have. */
  function expectWhole(p: Project) {
    const uses = sheetUses(p)
    const paths = new Set(uses.map((u) => u.path))
    const sheets = new Set(uses.map((u) => u.sheet))
    for (const c of p.components) expect(paths.has(useOf(c)), `part ${c.ref} on use "${c.inst}"`).toBe(true)
    for (const w of p.wires) expect(sheets.has(w.sheet ?? ROOT_SHEET), `wire ${w.id} on sheet ${w.sheet}`).toBe(true)
  }

  async function open(start: Project) {
    const memory = memoryStorage()
    connectProjectStorage(memory.storage)
    const { id } = await memory.storage.create(projectRecord(start))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    await settle()
    const load = async () => openStoredProject((await memory.storage.load(id))!)
    return { memory, id, load }
  }

  it("undo of a new sheet keeps the sheet while someone else has a part and a wire on it, and nothing is left orphaned", async () => {
    const { memory, id, load } = await open(createProject("Undo orphan"))
    api().commit((p) => addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Power").project)
    await settle()
    // Bob opens the sheet and adds R1 and a wire on it.
    const now = await load()
    const use = sheetUses(now).find((u) => u.path !== "")!
    const bobs = commitOnUse(now, use.path, (v) => addWire(addComponent(v, "resistor").project, [{ x: 0, y: 0 }, { x: 2, y: 0 }]).project)
    await memory.pushAs("bob", id, projectChanges(now, bobs))
    await settle()
    expect(api().project!.components).toHaveLength(1)
    api().undo()
    await settle()
    const mine = api().project!
    expectWhole(mine)
    // Bob's work is still there, on the sheet that is still there.
    expect(mine.components).toHaveLength(1)
    expect(mine.wires).toHaveLength(1)
    expect(mine.sheetSymbols).toHaveLength(1)
    const stored = await load()
    expectWhole(stored)
    expect(jsonEqual(strip(stored), strip(mine))).toBe(true)
    // Redo puts the sheet back as it was, still whole.
    api().redo()
    await settle()
    expectWhole(api().project!)
    expect(jsonEqual(strip(await load()), strip(api().project!))).toBe(true)
  })

  it("undo of a new sheet nobody else touched still removes it", async () => {
    const { memory, id } = await open(createProject("Undo clean"))
    api().commit((p) => addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Power").project)
    await settle()
    api().undo()
    await settle()
    expect(api().project!.sheetSymbols ?? []).toHaveLength(0)
    expect(memory.project(id).sheetSymbols ?? []).toHaveLength(0)
  })

  /** A project with a sheet used twice. */
  function reused(): { start: Project; uses: string[] } {
    const first = addSheet(createProject("Reuse"), "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "Cell")
    const start = addSheetUse(first.project, "", first.symbol.child, { minX: 20, minY: 0, maxX: 30, maxY: 6 }, "Cell B")!.project
    return { start, uses: sheetUses(start).filter((u) => u.path !== "").map((u) => u.path) }
  }

  it("a part added to a use that someone else deletes at the same moment does not stay on no sheet", async () => {
    const { start, uses } = reused()
    const { memory, id, load } = await open(start)
    // Ada adds a part to the first use (its copy lands on the second), her batch still on its way...
    api().commit((p) => commitOnUse(p, uses[0], (v) => addComponent(v, "resistor").project))
    // ...when Bob's deletion of the second use reaches storage first.
    const now = await load()
    const second = now.sheetSymbols!.find((s) => `/${s.id}` === uses[1])!
    await memory.pushAs("bob", id, projectChanges(now, removeSheetSymbols(now, [second.id])))
    await settle()
    await settle()
    const mine = api().project!
    expectWhole(mine)
    const stored = await load()
    expectWhole(stored)
    expect(jsonEqual(strip(stored), strip(mine))).toBe(true)
    // The first use keeps Ada's part.
    expect(mine.components.filter((c) => useOf(c) === uses[0])).toHaveLength(1)
  })

  it("a part added to a use while someone adds a third use ends on all three uses, once", async () => {
    const { start, uses } = reused()
    const { memory, id, load } = await open(start)
    const before = await load()
    api().commit((p) => commitOnUse(p, uses[0], (v) => addComponent(v, "resistor").project))
    // Bob adds a third use from the sheet as he has it, without Ada's part.
    const child = sheetUses(before).find((u) => u.path === uses[0])!.sheet
    const bobs = addSheetUse(before, "", child, { minX: 40, minY: 0, maxX: 50, maxY: 6 }, "Cell C")!.project
    await memory.pushAs("bob", id, projectChanges(before, bobs))
    await settle()
    await settle()
    const mine = api().project!
    const all = sheetUses(mine).filter((u) => u.path !== "").map((u) => u.path)
    expect(all).toHaveLength(3)
    for (const path of all) expect(mine.components.filter((c) => useOf(c) === path), path).toHaveLength(1)
    expect(new Set(mine.components.map((c) => c.ref)).size).toBe(3)
    expect(jsonEqual(strip(await load()), strip(mine))).toBe(true)
  })

  it("two copies settling one state agree, whatever order their lists are in, and settling again changes nothing", () => {
    const { start, uses } = reused()
    const edited = commitOnUse(start, uses[0], (v) => addComponent(addComponent(v, "resistor").project, "capacitor").project)
    // A third use that lacks both parts.
    const child = sheetUses(edited).find((u) => u.path === uses[0])!.sheet
    const third = addSheetUse(start, "", child, { minX: 40, minY: 0, maxX: 50, maxY: 6 }, "C")!.project
    const withC = { ...third, components: edited.components }
    const a = settleStructure(withC)
    const b = settleStructure({ ...withC, components: [...withC.components].reverse() })
    const byId = (p: Project) => [...p.components].sort((x, y) => (x.id < y.id ? -1 : 1))
    expect(byId(a).map((c) => [c.id, c.ref, c.inst])).toEqual(byId(b).map((c) => [c.id, c.ref, c.inst]))
    expect(a.components.length).toBeGreaterThan(withC.components.length)
    expect(settleStructure(a)).toBe(a)
  })

  it("undo then redo of a part added to a reused sheet, after someone added a third use, does not double the part", async () => {
    const { start, uses } = reused()
    const { memory, id, load } = await open(start)
    api().commit((p) => commitOnUse(p, uses[0], (v) => addComponent(v, "resistor").project))
    await settle()
    // Bob adds a third use, which copies the part.
    const before = await load()
    const child = sheetUses(before).find((u) => u.path === uses[0])!.sheet
    const bobs = addSheetUse(before, "", child, { minX: 40, minY: 0, maxX: 50, maxY: 6 }, "Cell C")!.project
    await memory.pushAs("bob", id, projectChanges(before, bobs))
    await settle()
    expect(api().project!.components).toHaveLength(3)
    api().undo()
    await settle()
    expect(api().project!.components).toHaveLength(0)
    api().redo()
    await settle()
    await settle()
    const mine = api().project!
    const all = sheetUses(mine).filter((u) => u.path !== "").map((u) => u.path)
    for (const path of all) expect(mine.components.filter((c) => useOf(c) === path), path).toHaveLength(1)
    expect(jsonEqual(strip(await load()), strip(mine))).toBe(true)
  })

  it("undo of a value edit reaches a third use that was added after it", async () => {
    const { start, uses } = reused()
    const { memory, id, load } = await open(start)
    api().commit((p) => commitOnUse(p, uses[0], (v) => addComponent(v, "resistor").project))
    await settle()
    api().commit((p) => commitOnUse(p, uses[0], (v) => ({ ...v, components: v.components.map((c) => ({ ...c, props: { ...c.props, value: "47k" } })) })))
    await settle()
    const before = await load()
    const child = sheetUses(before).find((u) => u.path === uses[0])!.sheet
    await memory.pushAs("bob", id, projectChanges(before, addSheetUse(before, "", child, { minX: 40, minY: 0, maxX: 50, maxY: 6 }, "Cell C")!.project))
    await settle()
    expect(api().project!.components.map((c) => c.props?.value)).toEqual(["47k", "47k", "47k"])
    api().undo()
    await settle()
    const mine = api().project!
    expect(mine.components).toHaveLength(3)
    expect(new Set(mine.components.map((c) => c.props?.value)).size).toBe(1)
    expect(mine.components[0].props?.value).not.toBe("47k")
    expect(jsonEqual(strip(await load()), strip(mine))).toBe(true)
  })

  it("a trace on a layer that another copy removed is dropped", async () => {
    const start: Project = { ...createProject("Layers"), board: withCopperCount(createProject("x").board, 4) }
    const { memory, id, load } = await open(start)
    api().commit((p) => ({ ...p, traces: [...p.traces, { id: "t1", net: "N", layer: "in1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] } as never] }))
    const now = await load()
    await memory.pushAs("bob", id, projectChanges(now, { ...now, board: withCopperCount(now.board, 2) }))
    await settle()
    await settle()
    expect(api().project!.board.stack).toBeUndefined()
    expect(api().project!.traces.filter((t) => t.layer === "in1")).toHaveLength(0)
    expect((await load()).traces.filter((t) => t.layer === "in1")).toHaveLength(0)
  })
})

// ---------- Viewers ----------

describe("a viewer's copy", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    api().close()
    connectProjectStorage(null)
    vi.useRealTimers()
  })

  it("refuses an edit of every part of the KiCad model, and sends nothing", async () => {
    const memory = memoryStorage()
    connectProjectStorage(memory.storage)
    const base = addComponent(createProject("Look"), "resistor").project
    const { id } = await memory.storage.create(projectRecord(base))
    const stored = (await memory.storage.load(id))!
    api().open(openStoredProject(stored), stored)
    memory.setRole(id, "viewer")
    await settle()
    expect(api().role).toBe("viewer")
    memory.calls.length = 0
    const before = api().project
    const c = before!.components[0]
    const edits: [string, (p: Project) => Project][] = [
      ["a sheet", (p) => addSheet(p, "", { minX: 0, minY: 0, maxX: 10, maxY: 6 }, "S").project],
      ["a variant", (p) => addVariant(p, "Lite")!],
      ["a variant override", (p) => setVariantOverride(addVariant(p, "Lite")!, c.id, "Lite", { dnp: true })!],
      ["a bus", (p) => addDrawings(p, [{ type: "bus", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] } as never]).project],
      ["a bus alias", (p) => ({ ...p, busAliases: [{ id: "a", name: "D", members: [] }] })],
      ["a zone", (p) => ({ ...p, zones: [{ id: "z", net: "GND", layer: "top" } as Zone] })],
      ["a four layer stack", (p) => ({ ...p, board: withCopperCount(p.board, 4) })],
      ["a board graphic", (p) => ({ ...p, graphics: [{ id: "g", kind: "line" }] as never })],
      ["a net name rule", (p) => ({ ...p, netNames: "kicad" })],
    ]
    for (const [, fn] of edits) api().commit(fn)
    expect(api().project).toBe(before)
    expect(api().refusedEdits).toBe(edits.length)
    // A drag, too: the press is silent, the first move says so.
    api().beginTransient()
    api().setTransient((p) => ({ ...p, sheetSymbols: [] }))
    expect(api().project).toBe(before)
    api().endTransient()
    api().patch((p) => ({ ...p, name: "x" }))
    expect(api().project).toBe(before)
    await settle()
    expect(memory.calls.filter((x) => x.op === "push")).toHaveLength(0)
    expect(memory.project(id).name).toBe("Look")
  })
})
