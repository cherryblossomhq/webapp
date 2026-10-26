import { describe, expect, it } from "vitest"
import { stepBoard } from "../src/export/step3d"
import { createProject } from "../src/model/ops"
import { withCopperCount } from "../src/model/stack"
import type { Project, Via } from "../src/model/types"

const via = (id: string, x: number, extra: Partial<Via> = {}): Via => ({ id, x, y: 0, net: "N", diameter: 0.6, drill: 0.3, ...extra }) as Via

describe("3D and STEP of multilayer boards", () => {
  it("drills only the through vias all the way", () => {
    const base = createProject("t")
    const p: Project = {
      ...base,
      board: withCopperCount(base.board, 4),
      vias: [via("a", 0), via("b", 2, { kind: "blind", from: "top", to: "in1" }), via("c", 4, { kind: "buried", from: "in1", to: "in2" }), via("d", 6, { kind: "micro", from: "top", to: "in1" })],
    }
    const holes = stepBoard(p).holes
    expect(holes.map((h) => h.x)).toEqual([0])
  })
})
