import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { describeSchematic, measureSchematic, schematicProblems } from "../src/ai/vision/measure"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { schematicContent } from "../src/ai/vision/framing"
import { blockFrames } from "../src/model/blocks"
import { EXAMPLES } from "../src/model/examples"
import { createProject } from "../src/model/ops"
import type { DrawingText, Project } from "../src/model/types"
import { FROZEN_EXAMPLES } from "./frozen-examples"

// What `look` says about how a schematic is laid out, beyond overlaps of symbols and labels: block
// frames over each other, a text over a block's title or across its frame, and how full the sheet
// is. An assistant laying out a sheet by hand had a title text over a block's title, and nothing
// in the numbers said so.

const step = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out.project
}

const text = (id: string, words: string, x: number, y: number, size = 0.1): DrawingText => ({ id, type: "text", x, y, text: words, size })

/** Blocks A and B drawn over each other, C far off, D with two parts and room for a note. */
function sheet(): Project {
  let p = createProject("layout")
  for (const [x, y] of [[0, 0], [0, 0.6], [10, 0], [20, 0], [23, 0]]) p = step(p, "add_component", { part_id: "resistor", x, y })
  p = step(p, "group_parts", { block: "A", refs: ["R1"] })
  p = step(p, "group_parts", { block: "B", refs: ["R2"] })
  p = step(p, "group_parts", { block: "C", refs: ["R3"] })
  p = step(p, "group_parts", { block: "D", refs: ["R4", "R5"] })
  return p
}

const frameOf = (p: Project, name: string) => blockFrames(p).find((f) => f.name === name)!

describe("look's numbers on a sheet's layout", () => {
  it("names block frames drawn over each other, texts over a title or across a frame, and leaves a note inside a frame alone", () => {
    let p = sheet()
    const c = frameOf(p, "C")
    const d = frameOf(p, "D")
    p = {
      ...p,
      drawings: [
        text("title", "POWER BOARD", c.titleBox.minX, c.titleBox.maxY, 0.3),
        text("edge", "EDGE TEXT", c.box.maxX - 0.1, (c.box.minY + c.box.maxY) / 2),
        text("note", "note", (d.box.minX + d.box.maxX) / 2 - 0.1, d.box.minY + 0.25),
      ],
    }
    const m = measureSchematic(p)
    expect(m.frameOverlaps.map((x) => `${x.a}/${x.b}`)).toEqual(["A/B"])
    expect(m.textsOnFrames.map((x) => `${x.a} on ${x.b}`)).toEqual(['the text "POWER BOARD" on the title of C', 'the text "EDGE TEXT" on the frame of C'])
    expect(schematicProblems(m)).toBeGreaterThanOrEqual(3)

    const lines = describeSchematic(m).join("\n")
    expect(lines).toContain("1 block frame(s) over each other: A/B")
    expect(lines).toContain(`2 drawn text(s) over a block's title or across its frame: the text "POWER BOARD" on the title of C`)
    expect(lines).not.toContain("note")

    // The picture outlines them as it outlines every other problem.
    const svg = schematicSvg(p, schematicContent(p)!, { width: 800, height: 400 }, m)
    const outlined = svg.split('fill="rgba(207,58,61,0.12)"').length - 1
    expect(outlined).toBe(schematicProblems(m) - m.unconnectedPins - m.isolatedParts.length)
  })

  it("says frames nearer each other than Tidy leaves them, as information and not a problem", () => {
    let p = createProject("crowded")
    p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
    p = step(p, "add_component", { part_id: "resistor", x: 3, y: 0 })
    p = step(p, "group_parts", { block: "LEFT", refs: ["R1"] })
    p = step(p, "group_parts", { block: "RIGHT", refs: ["R2"] })
    const left = frameOf(p, "LEFT")
    const right = frameOf(p, "RIGHT")
    // Close the gap to 0.2 by moving the right block.
    p = step(p, "edit_block", { block: "RIGHT", move_by: { x: left.box.maxX + 0.2 - right.box.minX, y: 0 } })
    const m = measureSchematic(p)
    expect(m.frameOverlaps).toEqual([])
    expect(m.crowdedFrames).toEqual([{ a: "LEFT", b: "RIGHT", gap: 0.2 }])
    const before = measureSchematic(step(p, "edit_block", { block: "RIGHT", move_by: { x: 2, y: 0 } }))
    expect(schematicProblems(m)).toBe(schematicProblems(before))
    expect(describeSchematic(m).join("\n")).toContain("frames nearer than 0.5 (Tidy's gap): LEFT/RIGHT 0.2")
  })

  it("calls a sheet sparse when its blocks are spread far apart, and says where the biggest gap is", () => {
    const ex = EXAMPLES.find((e) => e.id === "regulator")!.project
    const name = blockFrames(ex)[0].name
    const spread = step(ex, "edit_block", { block: name, move_by: { x: -25, y: 15 } })
    const m = measureSchematic(spread)
    expect(m.fill?.sparse).toBe(true)
    expect(m.fill?.empty).not.toBeNull()
    const line = describeSchematic(m).find((l) => l.startsWith("Sheet use:"))!
    expect(line).toContain("sparse")
    expect(line).toContain("the largest empty area is x ")
  })

  it.each(EXAMPLES.map((e) => [e.id, e.project] as const))("finds nothing wrong with the layout of the %s example, which Tidy drew", (_id, project) => {
    const m = measureSchematic(project)
    expect(m.frameOverlaps).toEqual([])
    expect(m.textsOnFrames).toEqual([])
    expect(m.crowdedFrames).toEqual([])
    expect(m.fill?.framed).toBe(true)
    expect(m.fill?.sparse).toBe(false)
    expect(describeSchematic(m).join("\n")).toMatch(/^Sheet use: \d+% of the drawn area is used \(block frames count whole\)(;|$)/m)
  })

  it.each(FROZEN_EXAMPLES.map((e) => [e.id, e.project] as const))("does not call the %s example as drawn by hand before Tidy sparse", (_id, project) => {
    const m = measureSchematic(project)
    expect(m.fill?.framed).toBe(false)
    expect(m.fill?.sparse).toBe(false)
  })
})
