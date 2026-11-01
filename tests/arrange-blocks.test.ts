import { describe, expect, it } from "vitest"
import { arrangeBlocksTool } from "../src/ai/arrangeTool"
import { blockFrames } from "../src/model/blocks"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import type { Project } from "../src/model/types"

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const arrange = (p: Project, input: Record<string, unknown>) => arrangeBlocksTool.run(p, input)

/** Every net as its pins by designator, with its name: what an arrangement may never change. */
function netlist(p: Project): string[] {
  const conn = computeConnectivity(p)
  const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
  return conn.nets
    .filter((n) => n.named || n.pins.length > 1)
    .map((n) => `${n.name}: ${n.pins.map((x) => `${refOf.get(x.componentId)}.${x.pin}`).sort().join(" ")}`)
    .sort()
}

const frame = (p: Project, name: string) => blockFrames(p).find((f) => f.name === name)!.box
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

describe("arrange_blocks", () => {
  it("puts the named blocks in rows, top-aligned with the gap, and the rest in a last row", () => {
    const p = example("esp32-robot")
    const before = blockFrames(p)
    const named = ["MCU", "POWER", "OLED", "BUTTONS", "MOTOR DRIVER"]
    const left = Math.min(...before.filter((f) => named.includes(f.name)).map((f) => f.box.minX))
    const top = Math.max(...before.filter((f) => named.includes(f.name)).map((f) => f.box.maxY))

    const out = arrange(p, { rows: [["MCU", "POWER"], ["OLED", "BUTTONS", "MOTOR DRIVER"]], gap: 1 })
    expect(out.isError, out.result).toBe(false)
    const q = out.project
    expect(netlist(q)).toEqual(netlist(p))

    // First row: from the top-left of the named blocks, frames side by side with the gap, tops aligned.
    expect(frame(q, "MCU")).toMatchObject({ minX: left, maxY: top })
    expect(near(frame(q, "POWER").minX, frame(q, "MCU").maxX + 1)).toBe(true)
    expect(frame(q, "POWER").maxY).toBe(top)
    // Second row: under the taller frame of the first, by the gap.
    const row1Bottom = Math.min(frame(q, "MCU").minY, frame(q, "POWER").minY)
    for (const name of ["OLED", "BUTTONS", "MOTOR DRIVER"]) expect(near(frame(q, name).maxY, row1Bottom - 1)).toBe(true)
    expect(frame(q, "OLED").minX).toBe(left)
    expect(near(frame(q, "BUTTONS").minX, frame(q, "OLED").maxX + 1)).toBe(true)
    expect(near(frame(q, "MOTOR DRIVER").minX, frame(q, "BUTTONS").maxX + 1)).toBe(true)

    // The blocks not named, left to right as they stood, in a row of their own below.
    const rest = before.filter((f) => !named.includes(f.name)).sort((a, b) => a.box.minX - b.box.minX).map((f) => f.name)
    const row2Bottom = Math.min(...["OLED", "BUTTONS", "MOTOR DRIVER"].map((n) => frame(q, n).minY))
    expect(frame(q, rest[0]).minX).toBe(left)
    for (const name of rest) expect(near(frame(q, name).maxY, row2Bottom - 1)).toBe(true)
    for (let i = 1; i < rest.length; i++) expect(near(frame(q, rest[i]).minX, frame(q, rest[i - 1]).maxX + 1)).toBe(true)
    expect(out.result).toContain(`Not named, so put in the last row: ${rest.join(", ")}`)

    // Frames clear of each other, every one reported.
    const after = blockFrames(q)
    for (let i = 0; i < after.length; i++) {
      expect(out.result).toContain(`${after[i].name} x ${after[i].box.minX} to ${after[i].box.maxX}`)
      for (let j = i + 1; j < after.length; j++) {
        const a = after[i].box
        const b = after[j].box
        expect(a.maxX <= b.minX + 1e-6 || b.maxX <= a.minX + 1e-6 || a.maxY <= b.minY + 1e-6 || b.maxY <= a.minY + 1e-6, `${after[i].name} over ${after[j].name}`).toBe(true)
      }
    }

    // The same call again changes nothing.
    const again = arrange(q, { rows: [["MCU", "POWER"], ["OLED", "BUTTONS", "MOTOR DRIVER"]], gap: 1 })
    expect(again.isError).toBe(false)
    expect(again.project).toBe(q)
    expect(again.result).toContain("already in those rows")
  })

  it("rearranges every example's blocks without touching a net", () => {
    for (const { id, project } of EXAMPLES) {
      // Last first, two to a row: every block moves, most of them past one another.
      const names = blockFrames(project).map((f) => f.name).reverse()
      const rows = names.reduce<string[][]>((acc, n, i) => (i % 2 ? acc[acc.length - 1].push(n) : acc.push([n]), acc), [])
      const out = arrange(project, { rows })
      expect(out.isError, `${id}: ${out.result}`).toBe(false)
      expect(netlist(out.project), id).toEqual(netlist(project))
      expect(arrange(out.project, { rows }).project, id).toBe(out.project)
    }
  })

  it("moves drawings inside a frame with their block", () => {
    const p = example("blinker")
    const f = frame(p, "LED")
    const note = { id: "d_note", type: "text" as const, text: "LED", x: f.minX + 0.3, y: f.minY + 0.3, size: 0.1 }
    const withNote: Project = { ...p, drawings: [note] } as Project
    const out = arrange(withNote, { rows: [["LED", "555 TIMER", "POWER IN"]] })
    expect(out.isError, out.result).toBe(false)
    const g = frame(out.project, "LED")
    const moved = out.project.drawings!.find((d) => d.id === "d_note")! as typeof note
    expect(near(moved.x - g.minX, note.x - f.minX)).toBe(true)
    expect(near(moved.y - g.minY, note.y - f.minY)).toBe(true)
    expect(netlist(out.project)).toEqual(netlist(p))
  })

  it("refuses names it doesn't know, or given twice, and changes nothing", () => {
    const p = example("blinker")
    const unknown = arrange(p, { rows: [["LED", "NOPE"]] })
    expect(unknown.isError).toBe(true)
    expect(unknown.result).toContain("No block NOPE. Blocks: POWER IN, 555 TIMER, LED")
    expect(unknown.project).toBe(p)
    const twice = arrange(p, { rows: [["LED"], ["led"]] })
    expect(twice.isError).toBe(true)
    expect(twice.result).toContain("LED is named twice")
    expect(arrange(p, { rows: [["LED"]], gap: -1 }).isError).toBe(true)
  })
})
