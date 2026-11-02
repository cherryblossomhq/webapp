import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { executeTool, runTool, TOOL_DEFINITIONS, toolActivityLabel } from "../src/ai/tools"
import { setLookRenderer, type Board3dView, type LookImage, type LookRenderer } from "../src/ai/vision/encode"
import { LOOK_SIZES, MAX_IMAGE_BYTES, MAX_LOOKS_PER_REQUEST, newLookBudget } from "../src/ai/vision/limits"
import { addComponent, createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { connectModelFiles } from "../src/store/modelFiles"

interface Drawn {
  kind: "svg" | "3d"
  width: number
  height: number
  maxBytes: number
  svg?: string
  view?: Board3dView
}

let drawn: Drawn[] = []
let fail: string | null = null

const picture = (width: number, height: number): LookImage => ({ mediaType: "image/png", base64: Buffer.from(`picture-${drawn.length}`).toString("base64"), width, height, bytes: 12 })

const fake: LookRenderer = {
  async svg(svg, size, maxBytes) {
    if (fail) throw new Error(fail)
    drawn.push({ kind: "svg", ...size, maxBytes, svg })
    return picture(size.width, size.height)
  },
  async board3d(_project, view, size, maxBytes) {
    if (fail) throw new Error(fail)
    drawn.push({ kind: "3d", ...size, maxBytes, view })
    return picture(size.width, size.height)
  },
}

const step = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out.project
}

function circuit(): Project {
  let p = createProject("look")
  p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
  p = step(p, "add_component", { part_id: "led", x: 4, y: 0 })
  p = step(p, "connect", { pins: ["R1.2", "D1.A"] })
  return p
}

const look = (p: Project, input: Record<string, unknown>, ctx: Parameters<typeof executeTool>[4] = { looks: newLookBudget() }) =>
  executeTool(p, () => p, "look", input, ctx)

beforeEach(() => {
  drawn = []
  fail = null
  setLookRenderer(fake)
})
afterEach(() => setLookRenderer(undefined))

describe("the look tool", () => {
  it("is offered to the model as a function tool with a required target", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.function.name === "look")!
    expect(tool.type).toBe("function")
    expect(tool.function.parameters.required).toEqual(["target"])
    expect(toolActivityLabel("look", { target: "pcb" })).toBe("Looking at the PCB")
    expect(toolActivityLabel("look", { target: "schematic" })).toBe("Looking at the schematic")
  })

  it("returns the picture and the numbers behind it, and changes nothing", async () => {
    const p = circuit()
    const out = await look(p, { target: "schematic" })
    expect(out.isError).toBe(false)
    expect(out.project).toBe(p)
    expect(out.images).toHaveLength(1)
    expect(out.images![0].mediaType).toBe("image/png")
    expect(out.result).toContain("is in the next message")
    expect(out.result).toContain("2 parts")
    expect(out.result).toContain("Problems:")
    expect(out.summary).toMatch(/^Looked at the schematic, the whole sheet/)
    // The renderer is told the byte cap, and the size it is given is inside the pixel cap.
    expect(drawn).toHaveLength(1)
    expect(drawn[0].maxBytes).toBe(MAX_IMAGE_BYTES)
    expect(drawn[0].width * drawn[0].height).toBeLessThanOrEqual(LOOK_SIZES.normal.maxPixels)
    expect(drawn[0].svg).toContain("<svg")
  })

  it("names what is wrong in numbers, and counts it in the transcript line", async () => {
    let p = circuit()
    // The tools refuse to lay a part over another, so it is made on the model.
    p = addComponent(p, "resistor", { sch: { x: 0.1, y: 0, rot: 0 } }).project
    const out = await look(p, { target: "schematic" })
    expect(out.result).toMatch(/symbol overlap\(s\): .*R1\/R2/)
    expect(out.summary).toMatch(/\d+ problem\(s\)$/)
    expect(drawn[0].svg).toContain("stroke-dasharray")
  })

  it("zooms to refs, a selection or a region", async () => {
    const p = circuit()
    const d1 = p.components.find((c) => c.ref === "D1")!
    const whole = await look(p, { target: "schematic" })
    const refs = await look(p, { target: "schematic", refs: ["D1"] })
    const selected = await look(p, { target: "schematic", selection: true }, { looks: newLookBudget(), selection: () => [`c:${d1.id}`] })
    const region = await look(p, { target: "schematic", region: { x: 3, y: -1, width: 3, height: 2 } })
    expect(refs.result).toContain("showing D1")
    expect(selected.result).toContain("showing the selection (D1)")
    expect(region.result).toContain("the region x 3 to 6, y -1 to 1")
    const viewBox = (i: number) => /viewBox="([^"]+)"/.exec(drawn[i].svg!)![1]
    expect(whole.isError || refs.isError || selected.isError || region.isError).toBe(false)
    // Whole sheet, the part, and the rectangle are three different views.
    expect(new Set([0, 1, 2, 3].map(viewBox)).size).toBe(3)
    // The same part framed by ref and by selection is the same picture.
    expect(drawn[2].svg).toBe(drawn[1].svg)
  })

  it("tells the model about an unknown ref and still looks", async () => {
    const out = await look(circuit(), { target: "schematic", refs: ["D1", "Q7"] })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("Not shown: Q7")
  })

  it("draws the PCB by side and layer, and says what it drew", async () => {
    const p = step(circuit(), "layout_pcb", {})
    const out = await look(p, { target: "pcb", side: "top", layers: ["silkscreen"] })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("the top copper layer only, silkscreen")
    expect(out.result).toContain("2 of 2 parts placed")
    expect(out.result).toMatch(/unrouted connection\(s\)/)
    const bare = await look(p, { target: "pcb", layers: [] })
    expect(bare.result).toContain("both copper layers (top in front), copper only")
    expect(drawn[1].svg!.length).toBeLessThan(drawn[0].svg!.length + 1)
  })

  it("renders the 3D board off screen from a preset view, and refuses an empty one", async () => {
    const empty = await look(circuit(), { target: "3d" })
    expect(empty.isError).toBe(true)
    expect(empty.result).toContain("layout_pcb")
    expect(drawn).toHaveLength(0)

    const p = step(circuit(), "layout_pcb", {})
    const out = await look(p, { target: "3d", side: "bottom", refs: ["R1"] })
    expect(out.isError).toBe(false)
    expect(drawn[0]).toMatchObject({ kind: "3d", view: "bottom", maxBytes: MAX_IMAGE_BYTES })
    expect(out.result).toContain("from below")
    expect(out.result).toContain("always shows the whole board")
    expect((await look(p, { target: "3d" })).result).toContain("three-quarter")
    expect(drawn[1].view).toBe("home")
  })

  it("makes a bigger picture only when asked, and still inside the cap", async () => {
    const p = circuit()
    await look(p, { target: "schematic" })
    await look(p, { target: "schematic", detail: "high" })
    expect(drawn[1].width * drawn[1].height).toBeGreaterThan(drawn[0].width * drawn[0].height)
    expect(drawn[1].width * drawn[1].height).toBeLessThanOrEqual(LOOK_SIZES.high.maxPixels)
  })

  it("stops at the cap: the fourth look is refused in code and draws nothing", async () => {
    const p = circuit()
    const ctx = { looks: newLookBudget() }
    for (let i = 0; i < MAX_LOOKS_PER_REQUEST; i++) expect((await look(p, { target: "schematic" }, ctx)).isError).toBe(false)
    expect(drawn).toHaveLength(MAX_LOOKS_PER_REQUEST)
    const refused = await look(p, { target: "schematic" }, ctx)
    expect(refused.isError).toBe(true)
    expect(refused.images).toBeUndefined()
    expect(refused.summary).toBe("Look limit reached for this request")
    expect(refused.result).toContain(`all ${MAX_LOOKS_PER_REQUEST} pictures`)
    expect(refused.result).toContain("tell the user plainly what you saw and what you changed")
    expect(drawn).toHaveLength(MAX_LOOKS_PER_REQUEST)
    // A new request starts with a full allowance.
    expect((await look(p, { target: "schematic" }, { looks: newLookBudget() })).isError).toBe(false)
  })

  it("counts a look that failed against the cap, so a broken view cannot be retried forever", async () => {
    const p = circuit()
    const ctx = { looks: newLookBudget(2) }
    await look(p, { target: "3d" }, ctx)
    await look(p, { target: "3d" }, ctx)
    expect((await look(p, { target: "schematic" }, ctx)).summary).toBe("Look limit reached for this request")
  })

  it("keeps the numbers when the picture cannot be made", async () => {
    fail = "The drawing could not be turned into a picture."
    const out = await look(circuit(), { target: "schematic" })
    expect(out.isError).toBe(false)
    expect(out.images).toBeUndefined()
    expect(out.result).toContain("No picture could be made: The drawing could not be turned into a picture.")
    expect(out.result).toContain("2 parts")
    expect(out.summary).toContain("(numbers only)")

    setLookRenderer(null)
    const none = await look(circuit(), { target: "pcb" })
    expect(none.images).toBeUndefined()
    expect(none.result).toContain("nowhere to draw one")
  })

  it("is for the copilot's run only", async () => {
    // runTool has no lookups and no budget: a look there is refused, not made.
    const out = runTool(circuit(), "look", { target: "schematic" })
    expect(out.isError).toBe(true)
    expect(drawn).toHaveLength(0)
    const noBudget = await look(circuit(), { target: "schematic" }, {})
    expect(noBudget.isError).toBe(true)
    expect(drawn).toHaveLength(0)
  })

  it("rejects input it cannot use", async () => {
    expect((await look(circuit(), { target: "sheet" })).result).toContain("target must be one of")
    expect((await look(circuit(), { target: "pcb", layers: ["gerber"] })).result).toContain("must be one of")
    expect((await look(circuit(), { target: "pcb", region: { x: 0, y: 0 } })).result).toContain("is required")
    expect(drawn).toHaveLength(0)
  })

  it("draws a sheet's picture kept in the file store, not the empty frame that stands in until its file is read", async () => {
    const file = "ab".repeat(32)
    const asked: string[] = []
    connectModelFiles({ put: async () => file, get: async (id) => (asked.push(id), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer) })
    try {
      const p: Project = { ...circuit(), drawings: [{ id: "pic", type: "image", x: 2, y: -3, scale: 1, file, px: 30, py: 20, ppi: 300 }] }
      const out = await look(p, { target: "schematic" })
      expect(out.isError, out.result).toBe(false)
      expect(asked).toEqual([file])
      expect(drawn[0].svg).toContain("data:image/png;base64,")
    } finally {
      connectModelFiles(null)
    }
  })

  it("stops before drawing when the run is stopped", async () => {
    const controller = new AbortController()
    controller.abort()
    const out = await look(circuit(), { target: "schematic" }, { looks: newLookBudget(), signal: controller.signal })
    expect(out.isError).toBe(true)
    expect(drawn).toHaveLength(0)
  })
})
