import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { base64Bytes, encodeWithinBytes, JPEG_QUALITIES, parseDataUrl, SCALE_STEPS, type DrawnCanvas } from "../src/ai/vision/encode"
import { frame, matchAspect } from "../src/ai/vision/framing"
import { fitSize, imageTokens, LOOK_SIZES, MAX_IMAGE_BYTES, MIN_EDGE } from "../src/ai/vision/limits"
import { describePcb, describeSchematic, measurePcb, measureSchematic, segmentCrossesBox } from "../src/ai/vision/measure"
import { dataUrl, OMITTED, pictureMessage, pruneImages } from "../src/ai/vision/messages"
import { DEFAULT_PCB_EXTRAS, pcbSvg, type PcbExtra } from "../src/ai/vision/pcbSvg"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { createProject, updateComponent } from "../src/model/ops"
import { PCB, SCH_LIGHT } from "../src/editor/theme"
import { getPcbAnalysis } from "../src/store/analysis"
import { pcbCourtyard } from "../src/model/instances"
import type { Project } from "../src/model/types"
import type { ChatMessage } from "../src/ai/managedAi"

/** R2 laid over R1: the tools refuse to do it, and this is a picture of what it looks like. */
const overlapR2 = (p: Project) => updateComponent(p, p.components.find((c) => c.ref === "R2")!.id, { sch: { x: 0.1, y: 0 } })

const step = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out.project
}

/** Two resistors, an LED and a capacitor wired up; R1 and R2 are far apart. */
function circuit(): Project {
  let p = createProject("look")
  p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
  p = step(p, "add_component", { part_id: "led", x: 4, y: 0 })
  p = step(p, "add_component", { part_id: "resistor", x: 0, y: -4 })
  p = step(p, "add_component", { part_id: "capacitor", x: 8, y: 6 })
  p = step(p, "connect", { pins: ["R1.2", "D1.A"] })
  p = step(p, "connect", { pins: ["D1.K", "R2.1"], net_name: "LED_K" })
  return p
}

const placed = (p: Project) => step(p, "layout_pcb", {})

describe("picture size", () => {
  it("never goes over the pixel or edge cap, for any shape", () => {
    for (const detail of ["normal", "high"] as const) {
      const { maxEdge, maxPixels } = LOOK_SIZES[detail]
      for (const aspect of [0.05, 0.2, 0.5, 0.75, 1, 4 / 3, 2, 5, 12, 40, 1000]) {
        const { width, height } = fitSize(aspect, detail)
        expect(width * height, `${aspect} ${detail}`).toBeLessThanOrEqual(maxPixels)
        expect(Math.max(width, height)).toBeLessThanOrEqual(maxEdge)
        expect(Math.min(width, height)).toBeGreaterThanOrEqual(MIN_EDGE)
      }
    }
  })

  it("is deterministic and keeps the shape of the view", () => {
    expect(fitSize(4 / 3)).toEqual(fitSize(4 / 3))
    const wide = fitSize(2)
    expect(wide.width / wide.height).toBeCloseTo(2, 1)
    const tall = fitSize(0.5)
    expect(tall.width / tall.height).toBeCloseTo(0.5, 1)
    expect(fitSize(Number.NaN)).toEqual(fitSize(1))
  })

  it("prices a normal picture at about 1 to 2k tokens and a high one near 2k", () => {
    for (const aspect of [1, 4 / 3, 2, 0.6]) expect(imageTokens(fitSize(aspect))).toBeLessThanOrEqual(1500)
    expect(imageTokens(fitSize(4 / 3))).toBeGreaterThan(1300)
    expect(imageTokens(fitSize(4 / 3, "high"))).toBeLessThanOrEqual(2300)
  })
})

describe("byte cap", () => {
  const canvas = (width: number, height: number, bytes: { png: number; jpeg: number }): DrawnCanvas => ({
    width,
    height,
    toDataURL: (type = "image/png") => `data:${type};base64,${"A".repeat(Math.ceil(((type === "image/png" ? bytes.png : bytes.jpeg) * 4) / 3))}`,
  })

  it("sends a PNG when it fits", async () => {
    const image = await encodeWithinBytes(async (s) => canvas(100 * s, 50 * s, { png: 1000, jpeg: 500 }), 2000)
    expect(image.mediaType).toBe("image/png")
    expect(image.bytes).toBeLessThanOrEqual(2000)
    expect(base64Bytes(image.base64)).toBe(image.bytes)
  })

  it("falls back to JPEG when the PNG is over the cap", async () => {
    const image = await encodeWithinBytes(async () => canvas(100, 50, { png: 9000, jpeg: 1500 }), 2000)
    expect(image.mediaType).toBe("image/jpeg")
  })

  it("redraws smaller until it fits, and never returns one over the cap", async () => {
    const scales: number[] = []
    const image = await encodeWithinBytes(async (s) => {
      scales.push(s)
      // Weight follows the area drawn.
      return canvas(Math.round(1000 * s), Math.round(500 * s), { png: 4000 * s * s, jpeg: 4000 * s * s })
    }, 1500)
    expect(scales).toEqual(SCALE_STEPS.slice(0, scales.length))
    expect(scales.length).toBeGreaterThan(1)
    expect(image.bytes).toBeLessThanOrEqual(1500)
    expect(image.width).toBe(Math.round(1000 * scales[scales.length - 1]))
  })

  it("throws, rather than send a picture over the cap", async () => {
    await expect(encodeWithinBytes(async () => canvas(10, 10, { png: 10_000, jpeg: 10_000 }), 1000)).rejects.toThrow(/smaller than/)
    expect(JPEG_QUALITIES.length).toBeGreaterThan(0)
  })

  it("keeps the cap well under the proxy's per-picture limit", () => {
    expect(Math.ceil((MAX_IMAGE_BYTES * 4) / 3)).toBeLessThan(1_000_000)
  })

  it("reads only png and jpeg data URLs", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({ mediaType: "image/png", base64: "AAAA" })
    expect(parseDataUrl("data:image/svg+xml;base64,AAAA")).toBeNull()
    expect(parseDataUrl("https://example.com/a.png")).toBeNull()
  })
})

describe("framing", () => {
  it("shows the whole sheet, or only the parts asked for", () => {
    const p = circuit()
    const whole = frame(p, "schematic", {})
    expect(whole.what).toBe("the whole sheet")
    const zoom = frame(p, "schematic", { refs: ["d1"] })
    expect(zoom.what).toBe("D1")
    const w = (b: { minX: number; maxX: number }) => b.maxX - b.minX
    expect(w(zoom.box)).toBeLessThan(w(whole.box))
    // D1 is at x=4: inside the zoomed box, while C1 at x=8 is not.
    expect(zoom.box.minX).toBeLessThan(4)
    expect(zoom.box.maxX).toBeGreaterThan(4)
    expect(zoom.box.maxX).toBeLessThan(8)
  })

  it("says which refs it could not find, and still shows something", () => {
    const f = frame(circuit(), "schematic", { refs: ["D1", "Q9"] })
    expect(f.problem).toContain("Q9")
    expect(f.what).toBe("D1")
    const none = frame(circuit(), "schematic", { refs: ["Q9"] })
    expect(none.what).toBe("the whole sheet")
    expect(none.problem).toContain("Q9")
  })

  it("frames a rectangle exactly, and refuses an empty one", () => {
    const p = circuit()
    const f = frame(p, "schematic", { region: { x: 1, y: 2, width: 3, height: 4 } })
    expect(f.box).toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 6 })
    expect(frame(p, "schematic", { region: { x: 0, y: 0, width: 0, height: 4 } }).problem).toMatch(/positive/)
  })

  it("frames the user's selection, and falls back with a reason when there is none", () => {
    const p = circuit()
    const d1 = p.components.find((c) => c.ref === "D1")!
    const f = frame(p, "schematic", { selection: true }, [`c:${d1.id}`])
    expect(f.what).toBe("the selection (D1)")
    expect(f.box).toEqual(frame(p, "schematic", { refs: ["D1"] }).box)
    const empty = frame(p, "schematic", { selection: true }, [])
    expect(empty.what).toBe("the whole sheet")
    expect(empty.problem).toMatch(/Nothing is selected/)
  })

  it("does not blow a lone part up to fill the picture, and matches the picture's shape", () => {
    const p = circuit()
    const f = frame(p, "schematic", { refs: ["R1"] })
    expect(f.box.maxX - f.box.minX).toBeGreaterThanOrEqual(3)
    const b = matchAspect(f.box, 2)
    expect((b.maxX - b.minX) / (b.maxY - b.minY)).toBeCloseTo(2, 6)
    // Only widened: the original is inside.
    expect(b.minX).toBeLessThanOrEqual(f.box.minX)
    expect(b.maxY).toBeGreaterThanOrEqual(f.box.maxY)
  })

  it("leaves out a part that is not on the PCB, and includes parts that fell off the board", () => {
    let p = placed(circuit())
    const c1 = p.components.find((c) => c.ref === "C1")!
    expect(frame(circuit(), "pcb", { refs: ["C1"] }).problem).toMatch(/not placed/)
    p = { ...p, components: p.components.map((c) => (c.id === c1.id ? { ...c, pcb: { ...c.pcb, x: 500 } } : c)) }
    const whole = frame(p, "pcb", {})
    expect(whole.box.maxX).toBeGreaterThan(500)
  })
})

describe("what the numbers say", () => {
  it("counts a drawing with nothing wrong as clean", () => {
    const m = measureSchematic(circuit())
    expect(m.symbolOverlaps).toEqual([])
    expect(m.labelsOnSymbols).toEqual([])
    expect(m.wiresThroughSymbols).toEqual([])
    expect(m.isolatedParts).toEqual(["C1"])
    expect(describeSchematic(m).join("\n")).toContain("part(s) with nothing connected: C1")
  })

  it("names symbols drawn over each other", () => {
    let p = circuit()
    p = overlapR2(p)
    const m = measureSchematic(p)
    expect(m.symbolOverlaps.map((c) => [c.a, c.b].sort().join("/"))).toContain("R1/R2")
    expect(describeSchematic(m).join("\n")).toMatch(/symbol overlap\(s\): .*R1\/R2/)
  })

  it("finds a wire drawn through a symbol", () => {
    let p = circuit()
    const r1 = p.components.find((c) => c.ref === "R1")!
    p = { ...p, wires: [...p.wires, { id: "w_test", points: [{ x: r1.sch.x - 1, y: r1.sch.y }, { x: r1.sch.x + 1, y: r1.sch.y }] }] }
    expect(measureSchematic(p).wiresThroughSymbols.some((c) => c.b === "R1")).toBe(true)
  })

  it("tests a segment against a box by its inside, not its edge", () => {
    const box = { minX: 0, minY: 0, maxX: 2, maxY: 2 }
    expect(segmentCrossesBox({ x: -1, y: 1 }, { x: 3, y: 1 }, box)).toBe(true)
    expect(segmentCrossesBox({ x: -1, y: 0 }, { x: 3, y: 0 }, box)).toBe(false)
    expect(segmentCrossesBox({ x: 3, y: 1 }, { x: 5, y: 1 }, box)).toBe(false)
    expect(segmentCrossesBox({ x: 1, y: 1 }, { x: 1.5, y: 1.2 }, box)).toBe(true)
  })

  it("counts unplaced, overlapping, off-board and unrouted parts, in step with the checks", () => {
    const fresh = circuit()
    const before = measurePcb(fresh)
    expect(before.placed).toBe(0)
    expect(before.unplaced.sort()).toEqual(["C1", "D1", "R1", "R2"])

    let p = placed(fresh)
    let m = measurePcb(p)
    expect(m.placed).toBe(4)
    expect(m.unplaced).toEqual([])
    expect(m.unrouted).toBeGreaterThan(0)
    expect(m.unroutedNets.length).toBeGreaterThan(0)

    // Put two parts on top of each other and one off the board.
    const [a, b, c] = p.components
    p = {
      ...p,
      components: p.components.map((x) =>
        x.id === a.id ? { ...x, pcb: { ...x.pcb, x: 0, y: 0 } } : x.id === b.id ? { ...x, pcb: { ...x.pcb, x: 0.2, y: 0 } } : x.id === c.id ? { ...x, pcb: { ...x.pcb, x: 400, y: 0 } } : x,
      ),
    }
    m = measurePcb(p)
    const violations = getPcbAnalysis(p).violations
    expect(m.overlaps.length).toBe(violations.filter((v) => v.kind === "overlap").length)
    expect(m.offBoard.length).toBe(violations.filter((v) => v.kind === "outside-board").length)
    expect(m.overlaps.map((o) => [o.a, o.b].sort().join("/"))).toContain([a.ref, b.ref].sort().join("/"))
    expect(m.offBoard).toContain(c.ref)
    expect(describePcb(m).join("\n")).toMatch(/off the board: .*/)
    expect(m.bounds.maxX).toBeGreaterThan(400)
  })

  it("tests a part turned to 72 degrees by its turned courtyard, as the checks do", () => {
    // An assistant was told of overlaps between parts at 72 degrees that didn't touch: look compared the boxes around them, Checks the parts.
    const p0 = placed(circuit())
    const [r1, r2] = ["R1", "R2"].map((r) => p0.components.find((c) => c.ref === r)!)
    const flat = pcbCourtyard({ ...r1, pcb: { ...r1.pcb, x: 0, y: 0, rot: 0 } })!
    const across = Math.min(flat.maxX - flat.minX, flat.maxY - flat.minY)
    const long = Math.max(flat.maxX - flat.minX, flat.maxY - flat.minY)
    const turn = flat.maxX - flat.minX > flat.maxY - flat.minY ? 72 : 162
    const at = (gap: number) =>
      [r1, r2].reduce((p, c, i) => updateComponent(p, c.id, { pcb: { x: i * gap, y: 0, rot: turn, side: "top", placed: true } }), p0)
    // Side by side along x, 0.3 mm apart square to their length: the boxes around them overlap, the parts don't.
    const apart = at((across + 0.3) / Math.cos((18 * Math.PI) / 180))
    const [a, b] = ["R1", "R2"].map((r) => pcbCourtyard(apart.components.find((c) => c.ref === r)!)!)
    expect(a.maxX - b.minX, "the boxes overlap").toBeGreaterThan(0.1)
    expect(long).toBeGreaterThan(across)
    const pair = (m: ReturnType<typeof measurePcb>) => m.overlaps.map((o) => [o.a, o.b].sort().join("/"))
    expect(pair(measurePcb(apart))).not.toContain("R1/R2")
    expect(getPcbAnalysis(apart).violations.filter((v) => v.kind === "overlap" && v.message.includes("R1") && v.message.includes("R2"))).toEqual([])
    // A real overlap at the same angle is still one, in both.
    const over = at(across / 2)
    expect(pair(measurePcb(over))).toContain("R1/R2")
    expect(getPcbAnalysis(over).violations.some((v) => v.kind === "overlap" && v.message.includes("R1") && v.message.includes("R2"))).toBe(true)
    // The picture draws the turned courtyard, not the box around it.
    const svg = pcbSvg(apart, measurePcb(apart).bounds, { width: 400, height: 400 }, { side: "top", extras: new Set<PcbExtra>(["courtyards"]) }, measurePcb(apart))
    expect(svg).toContain(`<polygon points=`)
  })

  it("reports a finished board as clean", () => {
    let p = createProject("done")
    p = step(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
    p = step(p, "add_component", { part_id: "led", x: 4, y: 0 })
    p = step(p, "connect", { pins: ["R1.2", "D1.A"] })
    p = placed(p)
    p = step(p, "route_pcb", {})
    const m = measurePcb(p)
    expect(m.unrouted).toBe(0)
    expect(describePcb(m).join("\n")).toContain("Problems: none found")
  })
})

describe("the schematic picture", () => {
  const draw = (p: Project, req: Parameters<typeof frame>[2] = {}) => {
    const f = frame(p, "schematic", req)
    const size = fitSize((f.box.maxX - f.box.minX) / (f.box.maxY - f.box.minY))
    const box = matchAspect(f.box, size.width / size.height)
    return { svg: schematicSvg(p, box, size, measureSchematic(p)), box, size }
  }

  it("is the same text every time, at the size asked for", () => {
    const p = circuit()
    const a = draw(p)
    expect(draw(p).svg).toBe(a.svg)
    expect(a.svg).toContain(`width="${a.size.width}" height="${a.size.height}"`)
    expect(a.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    // Designators and values are drawn.
    for (const text of ["R1", "D1", "LED_K"]) expect(a.svg).toContain(`>${text}<`)
  })

  it("looks at the region asked for", () => {
    const p = circuit()
    const whole = draw(p)
    const zoom = draw(p, { refs: ["D1"] })
    expect(zoom.svg).not.toBe(whole.svg)
    expect(zoom.box.maxX - zoom.box.minX).toBeLessThan(whole.box.maxX - whole.box.minX)
    expect(zoom.svg).toContain(`viewBox="${Math.round(zoom.box.minX * 10000) / 10000} `)
  })

  it("outlines a problem the numbers name, and nothing when there is none", () => {
    const p = overlapR2(circuit())
    expect(draw(p).svg).toContain("stroke-dasharray")
    expect(draw(circuit()).svg).not.toContain("rgba(207,58,61,0.12)")
  })

  it("draws the page under the drawing, its title block filled in, and frames the drawing as before", () => {
    // The circuit's page moved so its title block is beside the parts: in the box, it shows; the box is the drawing's whatever the page.
    const p = circuit()
    const near: Project = { ...p, sheets: [{ id: "root", paper: { size: "A5", x: -8, y: 10 } }] }
    const far: Project = { ...p, sheets: [{ id: "root", paper: { size: "A0", x: 500, y: 500 } }] }
    expect(frame(near, "schematic", {}).box).toEqual(frame(far, "schematic", {}).box)
    const box = { minX: -8, maxX: 12, minY: -5, maxY: 10 }
    const size = fitSize(20 / 15)
    expect(schematicSvg(near, box, size, measureSchematic(near))).toContain(">Title: look<")
    expect(schematicSvg(far, box, size, measureSchematic(far))).toContain(`fill="${SCH_LIGHT.outside}" fill-rule="evenodd"`)
  })

  it("escapes what the user typed", () => {
    let p = circuit()
    p = step(p, "connect", { pins: ["R1.1"], net_name: "A<B&C" })
    expect(draw(p).svg).toContain("A&lt;B&amp;C")
  })
})

describe("the PCB picture", () => {
  const draw = (p: Project, side: "top" | "bottom" | "both", extras: PcbExtra[] = DEFAULT_PCB_EXTRAS, req: Parameters<typeof frame>[2] = {}) => {
    const f = frame(p, "pcb", req)
    const size = fitSize((f.box.maxX - f.box.minX) / (f.box.maxY - f.box.minY))
    const box = matchAspect(f.box, size.width / size.height)
    return pcbSvg(p, box, size, { side, extras: new Set(extras) }, measurePcb(p))
  }

  const routed = () => step(placed(circuit()), "route_pcb", {})

  it("draws each copper layer on its own, or both with the top in front", () => {
    // A small board routes on the top layer alone: add a bottom trace to tell the layers apart.
    const base = routed()
    const p = { ...base, traces: [...base.traces, { id: "t_bottom", layer: "bottom" as const, width: 0.25, points: [{ x: -10, y: -8 }, { x: 10, y: -8 }] }] }
    const top = draw(p, "top")
    const bottom = draw(p, "bottom")
    const both = draw(p, "both")
    expect(top).toContain(PCB.topCopper)
    expect(top).not.toContain(PCB.bottomCopper)
    expect(bottom).toContain(PCB.bottomCopper)
    expect(bottom).not.toContain(PCB.topCopper)
    expect(both).toContain(PCB.topCopper)
    expect(both).toContain(PCB.bottomCopper)
    // Both layers: bottom is drawn first, so the top ends up in front.
    expect(both.indexOf(PCB.bottomCopper)).toBeLessThan(both.indexOf(PCB.topCopper))
  })

  it("draws only the layers asked for", () => {
    const p = routed()
    const full = draw(p, "both")
    const bare = draw(p, "both", [])
    expect(bare.length).toBeLessThan(full.length)
    expect(bare).not.toContain(PCB.silk)
    expect(full).toContain(PCB.silk)
    const withCourtyards = draw(p, "both", ["courtyards"])
    expect(withCourtyards).toContain(PCB.courtyard)
    expect(bare).not.toContain(PCB.courtyard)
    // The ratsnest only shows while something is unrouted.
    const unrouted = placed(circuit())
    expect(draw(unrouted, "both", ["ratsnest"])).toContain(PCB.ratsnest)
    expect(draw(unrouted, "both", [])).not.toContain(PCB.ratsnest)
  })

  it("is deterministic", () => {
    const p = routed()
    expect(draw(p, "both")).toBe(draw(p, "both"))
  })

  it("zooms to parts and marks a part off the board", () => {
    let p = routed()
    const zoom = draw(p, "both", DEFAULT_PCB_EXTRAS, { refs: ["D1"] })
    expect(zoom.length).toBeGreaterThan(0)
    expect(zoom).not.toBe(draw(p, "both"))
    const c1 = p.components.find((c) => c.ref === "C1")!
    p = { ...p, components: p.components.map((c) => (c.id === c1.id ? { ...c, pcb: { ...c.pcb, x: 300, y: 0 } } : c)) }
    expect(draw(p, "both")).toContain(PCB.danger)
  })
})

describe("pictures in the conversation", () => {
  const image = (tag: string) => ({ mediaType: "image/png" as const, base64: Buffer.from(tag).toString("base64"), width: 10, height: 10, bytes: tag.length })

  it("is a user message with the picture as an image_url data URL", () => {
    const m = pictureMessage([image("a"), image("b")])
    expect(m.role).toBe("user")
    const parts = m.content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "image_url"])
    expect(parts[1].image_url?.url).toBe(dataUrl(image("a")))
    expect(parts[1].image_url?.url).toMatch(/^data:image\/png;base64,/)
    expect(parts[0].text).toContain("not a message from the user")
  })

  it("keeps the newest pictures and swaps the rest for a line of text", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }, pictureMessage([image("1")]), { role: "assistant", content: "ok" }, pictureMessage([image("2")]), pictureMessage([image("3")])]
    pruneImages(history, 2)
    const urls = history.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []))
    expect(urls).toHaveLength(2)
    expect(JSON.stringify(history[1])).toContain(OMITTED)
    expect(JSON.stringify(history[1])).not.toContain("image_url")
    expect(JSON.stringify(history[3])).toContain("image_url")
    expect(history[0]).toEqual({ role: "user", content: "hi" })
  })
})
