import { beforeEach, describe, expect, it } from "vitest"
import { addComponent, createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { useProjectStore } from "../src/store/projectStore"

const api = () => useProjectStore.getState()

// The panel records a background check's verdict with `patch`: it is not an undo step, but it must
// survive Undo and Redo, or the part comes back without it. A step holds the changes that undo and
// redo it, so the verdict is written into the part a step puts back whole.

/** A verdict on the part named "P": the edit leaves a project without that part as it was. */
const verdict = (v: string) => (p: Project): Project => {
  if (!p.parts?.some((s) => s.id === "P")) return p
  return { ...p, parts: p.parts.map((s) => (s.id === "P" ? { ...s, props: { ...s.props, verdict: v } } : s)) }
}
const withPart = (p: Project): Project => ({
  ...p,
  parts: [...(p.parts ?? []), { id: "P", name: "P", description: "", category: "ICs", refPrefix: "U", footprint: "soic8", pins: [], props: {} }],
})
const verdictOf = (p: Project | null) => p?.parts?.find((s) => s.id === "P")?.props.verdict

describe("patch and undo", () => {
  beforeEach(() => {
    api().open(addComponent(createProject("x"), "resistor").project)
  })

  it("keeps a verdict through undo and redo of the placement", () => {
    api().commit(withPart)
    api().patch(verdict("agrees"))
    expect(verdictOf(api().project)).toBe("agrees")
    api().undo()
    expect(api().project!.parts ?? []).toHaveLength(0)
    api().redo()
    expect(verdictOf(api().project)).toBe("agrees")
  })

  it("is not an undo step", () => {
    const before = api().project!
    api().commit(withPart)
    api().patch(verdict("agrees"))
    expect(api().past).toHaveLength(1)
    api().undo()
    expect(api().project!.parts ?? []).toHaveLength(0)
    expect(api().project!.components).toEqual(before.components)
  })

  it("reaches a part undone before its verdict arrived, so Redo brings it back checked", () => {
    api().commit(withPart)
    api().undo()
    api().patch(verdict("agrees"))
    expect(api().project!.parts ?? []).toHaveLength(0)
    api().redo()
    expect(verdictOf(api().project)).toBe("agrees")
  })

  it("gives a part placed again after an undo no verdict, since it is a new placement to check", () => {
    api().commit(withPart)
    api().patch(verdict("agrees"))
    api().undo()
    // Placing again is a new commit: the redo stack goes, and the new part is the user's own.
    api().commit(withPart)
    expect(api().future).toHaveLength(0)
    expect(verdictOf(api().project)).toBeUndefined()
  })

  it("leaves no empty undo step for a press that never moved, and the redo stack alone", () => {
    api().commit(withPart)
    api().commit((p) => ({ ...p, name: "B" }))
    api().undo()
    const redo = api().future.length
    const past = api().past.length
    api().beginTransient()
    api().patch(verdict("agrees"))
    api().endTransient()
    expect(api().past).toHaveLength(past)
    expect(api().future).toHaveLength(redo)
    expect(verdictOf(api().project)).toBe("agrees")
  })

  it("keeps the verdict in the drag's starting point, so Esc does not lose it", () => {
    api().commit(withPart)
    api().beginTransient()
    api().setTransient((p) => ({ ...p, name: "moved" }))
    api().patch(verdict("agrees"))
    api().cancelTransient()
    expect(verdictOf(api().project)).toBe("agrees")
  })

  it("is not a viewer's to make", () => {
    api().commit(withPart)
    useProjectStore.setState({ role: "viewer" })
    api().patch(verdict("agrees"))
    expect(verdictOf(api().project)).toBeUndefined()
  })
})
