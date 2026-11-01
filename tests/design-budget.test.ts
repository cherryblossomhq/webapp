import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { KICAD_NET_NOTE, SHEETS_NOTE, UNITS_NOTE } from "../src/ai/designGuide"
import { DESIGN_BUDGET, runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { findPart } from "../src/model/library"
import { parseProjectFile } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { largeDesign } from "./tidy-designs"

// get_design is what an assistant reads first. Claude Code shows a tool's text up to 50,000 characters (or 25k tokens) and puts a
// longer one in a file: a design past the budget answers with its parts and nets by name, to read a block or some parts at a time.

type Net = { name: string; pins: string[] }
type Design = { too_big?: string; components: { ref: string; pins?: { net: string | null }[] }[]; nets: Net[]; blocks?: { name: string }[] }
type Overview = { too_big: string; components: string[]; power_symbols?: unknown; nets: string[]; blocks?: { name: string; ports?: unknown }[] }

const read = (p: Project, input: Record<string, unknown> = {}) => {
  const out = runTool(p, "get_design", input)
  return { out, design: (out.isError ? null : JSON.parse(out.result)) as Design }
}
const realRefs = (p: Project, ids?: string[]) =>
  p.components
    .filter((c) => !findPart(c.partId)?.powerNet && (!ids || ids.includes(c.id)))
    .map((c) => c.ref)
    .sort()

describe("get_design's size", () => {
  const BLOG = readdirSync(new URL("./fixtures/blog-boards/", import.meta.url)).filter((f) => f.endsWith(".json"))
  const boards: [string, Project][] = [
    ...EXAMPLES.map((e): [string, Project] => [e.id, e.project]),
    ...BLOG.map((f): [string, Project] => [f, parseProjectFile(readFileSync(new URL(`./fixtures/blog-boards/${f}`, import.meta.url), "utf8"), { id: f })]),
  ]
  it.each(boards)("reads %s whole", (_, p) => {
    const { out, design } = read(p)
    expect(out.result.length).toBeLessThanOrEqual(DESIGN_BUDGET)
    expect(design.too_big).toBeUndefined()
  })

  it("leaves room for the notes the MCP server adds under Claude Code's 50,000 characters", () => {
    expect(DESIGN_BUDGET + UNITS_NOTE.length + KICAD_NET_NOTE.length + SHEETS_NOTE.length + 100).toBeLessThan(50_000)
  })

  const big = largeDesign(150)

  it("answers a design past the budget with its parts and nets by name", () => {
    const out = runTool(big, "get_design", {})
    const overview = JSON.parse(out.result) as Overview
    expect(out.isError).toBe(false)
    expect(out.result.length).toBeLessThanOrEqual(DESIGN_BUDGET)
    expect(overview.too_big).toMatch(/Ask again with block or refs/)
    expect(overview.components.map((c) => c.split(" ")[0]).sort()).toEqual(realRefs(big))
    expect(overview.components).toContain("C1 capacitor 100nF")
    expect(overview.power_symbols).toBeUndefined()
    const names = computeConnectivity(big).nets.filter((n) => n.named || n.pins.length > 1).map((n) => n.name)
    expect(overview.nets).toEqual(names)
    expect(overview.blocks!.map((b) => b.name)).toEqual(big.blocks!.map((b) => b.name))
    expect(overview.blocks!.some((b) => b.ports)).toBe(false)
  })

  it("reads each block of it whole, with every net its parts are on", () => {
    for (const b of big.blocks!) {
      const { out, design } = read(big, { block: b.name })
      expect(design.too_big, b.name).toBeUndefined()
      expect(out.result.length).toBeLessThanOrEqual(DESIGN_BUDGET)
      expect(design.components.map((c) => c.ref).sort()).toEqual(realRefs(big, b.components))
      expect(design.blocks!.map((x) => x.name)).toEqual([b.name])
      const nets = new Set(design.nets.map((n) => n.name))
      for (const c of design.components) for (const pin of c.pins ?? []) if (pin.net) expect(nets.has(pin.net), `${c.ref} on ${pin.net}`).toBe(true)
      const refs = new Set(design.components.map((c) => c.ref))
      for (const n of design.nets) expect(n.pins.some((p) => refs.has(p.split(".")[0])), n.name).toBe(true)
    }
  })

  it("reads parts by designator", () => {
    const refs = realRefs(big).slice(0, 2)
    const { design } = read(big, { refs })
    expect(design.too_big).toBeUndefined()
    expect(design.components.map((c) => c.ref).sort()).toEqual(refs)
    expect(design.components.every((c) => c.pins?.length)).toBe(true)
  })

  it("refuses a block or a part that isn't there, and block with refs", () => {
    expect(read(big, { block: "NOPE" }).out.result).toMatch(/No block NOPE/)
    expect(read(big, { refs: ["ZZ9"] }).out.result).toMatch(/No component ZZ9/)
    expect(read(big, { block: big.blocks![0].name, refs: ["R1"] }).out.result).toMatch(/not both/)
  })

  it("keeps the overview of a 600-part design within the budget", () => {
    const { out, design } = read(largeDesign(600))
    expect(design.too_big).toBeDefined()
    expect(out.result.length).toBeLessThanOrEqual(DESIGN_BUDGET)
  })
})
