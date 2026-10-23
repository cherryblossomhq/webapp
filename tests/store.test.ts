import { beforeEach, describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { addComponent, createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { normalizeProject } from "../src/model/projectFile"
import { useProjectStore } from "../src/store/projectStore"

const api = () => useProjectStore.getState()
const nudge = (dx: number) => (p: Project): Project => ({
  ...p,
  components: p.components.map((c) => ({ ...c, sch: { ...c.sch, x: c.sch.x + dx } })),
})

describe("project history", () => {
  beforeEach(() => {
    api().open(addComponent(createProject("x"), "resistor").project)
  })

  it("keeps a change committed mid-drag, as the copilot's can be", () => {
    api().beginTransient()
    api().setTransient(nudge(1))
    const current = api().project!
    api().commit(() => ({ ...current, labels: [{ id: "L1", name: "GND", x: 0, y: 0, rot: 0 }] }))
    api().setTransient(nudge(2))
    api().endTransient()
    expect(api().project!.labels).toHaveLength(1)
    api().undo()
    expect(api().project!.labels).toHaveLength(0)
  })

  it("ignores undo and redo while a drag is in progress", () => {
    api().commit((p) => ({ ...p, name: "A" }))
    api().commit((p) => ({ ...p, name: "B" }))
    api().beginTransient()
    api().setTransient(nudge(1))
    api().undo()
    api().endTransient()
    expect(api().project!.name).toBe("B")
    expect(api().past).toHaveLength(3)
    // The drag comes off first, then each rename.
    api().undo()
    expect(api().project!.components[0].sch.x).toBe(0)
    api().undo()
    expect(api().project!.name).toBe("A")
    api().undo()
    expect(api().project!.name).toBe("x")
  })

  it("patches the project without a step of its own, as a background check does", () => {
    api().commit(nudge(1))
    const before = api().past.length
    api().patch((p) => ({ ...p, name: "checked" }))
    expect(api().project!.name).toBe("checked")
    expect(api().past).toHaveLength(before)
    // Undo still undoes the user's own last edit.
    api().undo()
    expect(api().project!.components[0].sch.x).toBe(0)
  })

  it("records no step for a press that never moved", () => {
    api().commit((p) => ({ ...p, name: "A" }))
    api().undo()
    api().beginTransient()
    api().endTransient()
    expect(api().future).toHaveLength(1)
  })
})

describe("normalizeProject", () => {
  it("fills what a hand-written file leaves out, down to each component", () => {
    const p = normalizeProject({
      id: "p",
      wires: null,
      components: [{ id: "c1", partId: "resistor", ref: "R1", props: {}, footprint: "" }, null],
    } as unknown as Project)
    expect(p.wires).toEqual([])
    expect(p.components).toHaveLength(1)
    expect(p.components[0].footprint).not.toBe("")
    expect(() => computeConnectivity(p)).not.toThrow()
  })
})

describe("jumping from the Checks panel", () => {
  it("keeps a selection made after focusing another view, which clears the one before it", async () => {
    const { useUi } = await import("../src/store/uiStore")
    const ui = useUi.getState()
    ui.setView("schematic")
    ui.select(["c_1"])
    ui.focus("pcb", 1, 1)
    expect(useUi.getState().selection).toEqual([])
    useUi.getState().select(["c_1"])
    expect(useUi.getState()).toMatchObject({ view: "pcb", selection: ["c_1"] })
    // Focusing within the same view keeps what is selected.
    useUi.getState().focus("pcb", 2, 2)
    expect(useUi.getState().selection).toEqual(["c_1"])
    useUi.getState().setView("3d")
    expect(useUi.getState().selection).toEqual([])
  })
})

describe("jumping to a part from the Inspector", () => {
  it("carries the part's box, and is dropped when the view is changed by hand so a view opened later fits", async () => {
    const { useUi } = await import("../src/store/uiStore")
    const box = { minX: 0, minY: 0, maxX: 2, maxY: 1 }
    useUi.getState().setView("schematic")
    useUi.getState().focus("pcb", 1, 0.5, box)
    expect(useUi.getState().focusRequest).toMatchObject({ view: "pcb", x: 1, y: 0.5, box })
    useUi.getState().setView("schematic")
    expect(useUi.getState().focusRequest).toBeNull()
  })
})
