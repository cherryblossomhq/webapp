import type { SupplierPart } from "@cherryblossom/api-contract"
import { describe, expect, it } from "vitest"
import type { SupplierPartsSource } from "../src/ai/supplierParts"
import { executeTool, runTool } from "../src/ai/tools"
import { buildCustomPart, customPartProblems } from "../src/model/customParts"
import { createProject } from "../src/model/ops"
import type { CustomPartSpec, Project } from "../src/model/types"

// A bidirectional TVS drawn as the one-way TVS. create_part with LCSC C148229 (Littelfuse SMAJ300CA,
// 300 V bidirectional) made a part with one triangle: EasyEDA draws it as two diodes back to back,
// but names its pins K and A, and only the names reached the editor, which had no bidirectional
// symbol to pick anyway. A one-way TVS from an AC phase to ground reads as a short on every
// negative half-cycle. The parts API now reads the drawing (`symbol: "bidirectional_diode"`).

const record = (lcsc: string, mpn: string, pkg: string, extra: Partial<SupplierPart> = {}): SupplierPart => ({
  lcsc,
  mpn,
  manufacturer: "Littelfuse",
  package: pkg,
  description: "TVS DIODE DO-214AC(SMA)",
  datasheet: null,
  stock: 83,
  // As LCSC C148229 names them: 2 is A, 1 is K.
  pins: [
    { number: "2", name: "A", aliases: [], role: "signal" },
    { number: "1", name: "K", aliases: [], role: "signal" },
  ],
  land: {
    pads: [
      { number: "1", shape: "rect", x: -2, y: 0, width: 2, height: 1.8, layer: "top" },
      { number: "2", shape: "rect", x: 2, y: 0, width: 2, height: 1.8, layer: "top" },
    ],
    silk: [],
    from: lcsc,
  },
  model3d: null,
  provenance: {
    source: "easyeda",
    fetchedAt: "2026-11-11T00:00:00.000Z",
    confidence: "single_source",
    vendors: 1,
    references: [lcsc],
    disputes: [],
    attribution: "Pins, land patterns and 3D models from the JLCEDA/EasyEDA Official Library",
  },
  ...extra,
})

const RECORDS: Record<string, SupplierPart> = {
  C148229: record("C148229", "SMAJ300CA", "SMA_L4.4-W2.6-LS5.0-BI", { symbol: "bidirectional_diode" }),
  C10766: record("C10766", "SMAJ300A", "SMA_L4.3-W2.6-LS5.2-RD"),
}

const source: SupplierPartsSource = {
  async search() {
    throw new Error("no search in this test")
  },
  async part(lcsc) {
    return structuredClone(RECORDS[lcsc.trim().toUpperCase()] ?? null)
  },
}

async function create(input: object) {
  const project: Project = createProject("p")
  const out = await executeTool(project, () => project, "create_part", input, { parts: source })
  expect(out.isError, out.result).toBe(false)
  const spec = out.project.parts!.at(-1)!
  return { out, spec, part: buildCustomPart(spec) }
}

/** The filled-in shapes a symbol draws with three corners: a diode's triangles. */
const triangles = (part: ReturnType<typeof buildCustomPart>) =>
  part.symbol.primitives.filter((p) => p.type === "path" && p.points.length === 4 && p.points[0].x === p.points[3].x && p.points[0].y === p.points[3].y)

describe("a part the supplier draws as two diodes back to back", () => {
  it("is drawn as a bidirectional TVS when no symbol is asked for", async () => {
    const { out, spec, part } = await create({ lcsc: "C148229" })
    expect(spec.symbol).toBe("tvs_bidirectional")
    expect(spec.refPrefix).toBe("D")
    expect(spec.pins.map((p) => `${p.number}:${p.name}`).sort()).toEqual(["1:K", "2:A"])
    expect(triangles(part)).toHaveLength(2)
    expect(part.symbol.ports.map((p) => p.pin).sort()).toEqual(["1", "2"])
    expect(out.result).toContain("two diodes back to back")
    expect(out.result).toContain("tvs_bidirectional")
  })

  it("is drawn as one in place of the one-way TVS asked for, and says so", async () => {
    const { out, spec, part } = await create({ lcsc: "C148229", symbol: "tvs" })
    expect(spec.symbol).toBe("tvs_bidirectional")
    expect(triangles(part)).toHaveLength(2)
    expect(out.result).toContain("not the one-way tvs asked for")
    // Any one-way diode symbol is as wrong.
    for (const asked of ["diode", "zener", "schottky"]) expect((await create({ lcsc: "C148229", symbol: asked })).spec.symbol).toBe("tvs_bidirectional")
  })

  it("keeps the one-way TVS for a one-way part, and draws nothing new for one asked for nothing", async () => {
    const oneWay = await create({ lcsc: "C10766", symbol: "tvs" })
    expect(oneWay.spec.symbol).toBe("tvs")
    expect(triangles(oneWay.part)).toHaveLength(1)
    expect(oneWay.out.result).not.toContain("back to back")
    expect((await create({ lcsc: "C10766" })).spec.symbol).toBeUndefined()
  })

  it("is said by get_part_data", async () => {
    const project = createProject("p")
    const read = await executeTool(project, () => project, "get_part_data", { lcsc: "C148229" }, { parts: source })
    expect(read.result).toContain("two diodes back to back, so the part is bidirectional")
    const oneWay = await executeTool(project, () => project, "get_part_data", { lcsc: "C10766" }, { parts: source })
    expect(oneWay.result).not.toContain("bidirectional")
  })
})

describe("the bidirectional TVS symbol", () => {
  const spec = (pins: string[]): CustomPartSpec => ({
    id: "x",
    name: "SMAJ300CA",
    description: "300 V bidirectional TVS",
    category: "Diodes",
    refPrefix: "D",
    footprint: "sma",
    pins: pins.map((name, i) => ({ number: String(i + 1), name })),
    symbol: "tvs_bidirectional",
    props: {},
  })

  it("takes two pins of any name, KiCad's A1 and A2 included", () => {
    for (const pins of [["A1", "A2"], ["K", "A"], ["1", "2"]]) expect(customPartProblems(spec(pins))).toEqual([])
    expect(customPartProblems(spec(["A1", "A2", "A3"]))).toContain("the tvs_bidirectional symbol needs exactly 2 pins, got 3")
  })

  it("can be chosen for a part made from memory", () => {
    const out = runTool(createProject("p"), "create_part", {
      name: "SMAJ300CA",
      description: "300 V bidirectional TVS",
      category: "Diodes",
      footprint: "sma",
      symbol: "tvs_bidirectional",
      pins: [
        { number: "1", name: "A1" },
        { number: "2", name: "A2" },
      ],
    })
    expect(out.isError, out.result).toBe(false)
    expect(out.project.parts![0].symbol).toBe("tvs_bidirectional")
  })
})
