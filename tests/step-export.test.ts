// The STEP export read back by OCCT (occt-import-js, the kernel FreeCAD and KiCad's viewer use):
// what comes back is what the file says, in world coordinates, after OCCT's own repairs.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { beforeAll, describe, expect, test } from "vitest"
import { writeStep, type StepExportInput, type StepMesh, type StepModelInput } from "../src/export/step"
import { boardHoles, writeBoard } from "../src/export/step/board"
import { StepWriter } from "../src/export/step/writer"

const require = createRequire(import.meta.url)

interface OcctMesh {
  name: string
  color?: [number, number, number]
  brep_faces: { first: number; last: number; color: [number, number, number] | null }[]
  attributes: { position: { array: number[] } }
  index: { array: number[] }
}
interface OcctNode {
  name: string
  meshes: number[]
  children: OcctNode[]
}
interface OcctResult {
  success: boolean
  root: OcctNode
  meshes: OcctMesh[]
}

interface OcctParams {
  linearDeflectionType: "absolute_value"
  linearDeflection: number
}

let occt: { ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult }
beforeAll(async () => {
  occt = await require("occt-import-js")()
})

/**
 * Reads a file back. occt-import-js triangulates to a fraction of the whole file's size by
 * default, so a part's curves come out coarser beside a big board; `fine` meshes to 0.01 mm.
 */
const read = (text: string, fine = false) =>
  occt.ReadStepFile(new TextEncoder().encode(text), fine ? { linearDeflectionType: "absolute_value", linearDeflection: 0.01 } : null)

/** The CAx-IF and other files occt-import-js ships for its own tests, read where npm put them. */
const TESTFILES = require.resolve("occt-import-js").replace(/dist[\\/]occt-import-js\.js$/, "test/testfiles/")
const testfile = (name: string) => readFileSync(TESTFILES + name, "latin1")

type Box = { min: number[]; max: number[] }

function bounds(meshes: OcctMesh[]): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    const a = m.attributes.position.array
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], a[i + k])
        max[k] = Math.max(max[k], a[i + k])
      }
    }
  }
  return { min, max }
}

/** Signed volume of the triangles, positive when every face points out. */
function volume(m: OcctMesh): number {
  const p = m.attributes.position.array
  const idx = m.index.array
  let v = 0
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}

/** The box a transform puts a box in: exact for quarter turns. */
function moved(box: Box, m: number[]): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        for (let k = 0; k < 3; k++) {
          const v = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k]
          min[k] = Math.min(min[k], v)
          max[k] = Math.max(max[k], v)
        }
      }
    }
  }
  return { min, max }
}

function expectBox(actual: Box, expected: Box, tol = 1e-4) {
  for (let k = 0; k < 3; k++) {
    expect(actual.min[k]).toBeCloseTo(expected.min[k], -Math.log10(tol) - 1)
    expect(actual.max[k]).toBeCloseTo(expected.max[k], -Math.log10(tol) - 1)
  }
}

/** OCCT reads COLOUR_RGB as sRGB and hands back linear values. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const meshesOf = (r: OcctResult, node: OcctNode) => node.meshes.map((i) => r.meshes[i])
/** The assembly's children: the board, then the parts. */
const instances = (r: OcctResult) => r.root.children[0].children

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length

const BOARD = {
  outline: { x: 0, y: 0, width: 400, height: 400, cornerRadius: 0 },
  thickness: 1.6,
  holes: [],
  color: { r: 0.1, g: 0.4, b: 0.2 },
}
const T = "2026-10-21T00:00:00"

function exportOne(model: StepModelInput, matrices: number[][], extra: Partial<StepExportInput> = {}) {
  return writeStep({
    name: "Test",
    board: BOARD,
    models: [model],
    placements: matrices.map((matrix, i) => ({ ref: `U${i + 1}`, model: model.key, matrix })),
    timestamp: T,
    ...extra,
  })
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** A quarter turn about z, then a move to (10, 20, 30). */
const TURNED = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]
/** Flipped to the bottom side: half a turn about y, moved to (-50, 5, 0). */
const FLIPPED = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, -50, 5, 0, 1]

// Boxes as three.js's BoxGeometry builds them: four vertices of its own per face, counter-clockwise outward.
function box(size: [number, number, number], opts: { skip?: number; at?: number[]; indexed?: boolean; segments?: number } = {}): StepMesh {
  const pos: number[] = []
  const idx: number[] = []
  const at = opts.at ?? [0, 0, 0]
  const seg = opts.segments ?? 1
  // [u axis, v axis, normal axis, sign]: u x v points along the normal.
  const faces: [number, number, number, number][] = [
    [1, 2, 0, 1],
    [2, 1, 0, -1],
    [2, 0, 1, 1],
    [0, 2, 1, -1],
    [0, 1, 2, 1],
    [1, 0, 2, -1],
  ]
  faces.forEach(([u, v, n, s], f) => {
    if (f === opts.skip) return
    const base = pos.length / 3
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const p = [0, 0, 0]
        p[u] = (i / seg - 0.5) * size[u] + at[u]
        p[v] = (j / seg - 0.5) * size[v] + at[v]
        p[n] = (s * size[n]) / 2 + at[n]
        pos.push(...p)
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i
        idx.push(a, a + 1, a + seg + 2, a, a + seg + 2, a + seg + 1)
      }
    }
  })
  const color = { r: 0.25, g: 0.25, b: 0.25 }
  if (opts.indexed === false) {
    const flat = idx.flatMap((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
    return { positions: new Float32Array(flat), color, name: "body" }
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx), color, name: "body" }
}

function torus(R: number, r: number, nu: number, nv: number): StepMesh {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = (i / nu) * Math.PI * 2
      const v = (j / nv) * Math.PI * 2
      pos.push((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v))
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * nv + j
      const b = ((i + 1) % nu) * nv + j
      const c = ((i + 1) % nu) * nv + ((j + 1) % nv)
      const d = i * nv + ((j + 1) % nv)
      idx.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx), color: { r: 0.8, g: 0.6, b: 0.1 } }
}

const meshModel = (meshes: StepMesh[], name = "Body"): StepModelInput => ({ key: "m", name, source: { kind: "mesh", meshes } })

describe("the board", () => {
  test("a square board alone: six faces, the outline times the thickness", () => {
    const r = writeStep({ name: "Plain", board: { ...BOARD, outline: { x: 10, y: 5, width: 30, height: 20, cornerRadius: 0 } }, models: [], placements: [], timestamp: T })
    expect(r.notes).toEqual([])
    const back = read(r.text)
    expect(back.success).toBe(true)
    expect(back.root.children[0].name).toBe("Plain")
    expect(instances(back).map((n) => n.name)).toEqual(["PCB"])
    const [mesh] = back.meshes
    expect(mesh.brep_faces).toHaveLength(6)
    expectBox(bounds([mesh]), { min: [-5, -5, 0], max: [25, 15, 1.6] })
    expect(volume(mesh)).toBeCloseTo(30 * 20 * 1.6, 6)
    expect(mesh.color).toEqual([linear(0.1), linear(0.4), linear(0.2)].map((c) => expect.closeTo(c, 4)))
  })

  test("rounded corners, round holes and a slot: open holes, faces pointing out", () => {
    const holes = [
      { x: -5, y: 0, diameter: 3 },
      { x: 5, y: 2, diameter: 1 },
      { x: 3, y: -4, diameter: 1.2, slot: { a: { x: 2, y: -4 }, b: { x: 6, y: -3 } } },
    ]
    const board = { ...BOARD, outline: { x: 0, y: 0, width: 20, height: 12, cornerRadius: 2 }, holes }
    const r = writeStep({ name: "Holes", board, models: [], placements: [], timestamp: T })
    expect(r.notes).toEqual([])
    const back = read(r.text)
    expect(back.success).toBe(true)
    const [mesh] = back.meshes
    // top, bottom, 4 sides and 4 corners, two half cylinders a hole, a slot's two planes and two caps
    expect(mesh.brep_faces).toHaveLength(2 + 8 + 2 * 2 + 4)
    expectBox(bounds([mesh]), { min: [-10, -6, 0], max: [10, 6, 1.6] })
    const slotLength = Math.hypot(4, 1)
    const area = 20 * 12 - (4 - Math.PI) * 4 - Math.PI * (1.5 ** 2 + 0.5 ** 2 + 0.6 ** 2) - 1.2 * slotLength
    // Positive (every face turned out) and within OCCT's triangulation of the curves.
    expect(volume(mesh) / (area * 1.6)).toBeCloseTo(1, 2)

    // Nothing covers a hole's centre on the top face.
    const p = mesh.attributes.position.array
    const idx = mesh.index.array
    const covers = (x: number, y: number) => {
      for (let i = 0; i < idx.length; i += 3) {
        const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
        if ([a, b, c].some((v) => Math.abs(p[v + 2] - 1.6) > 1e-6)) continue
        const side = (u: number, v: number) => (p[v] - p[u]) * (y - p[u + 1]) - (p[v + 1] - p[u + 1]) * (x - p[u])
        const [s1, s2, s3] = [side(a, b), side(b, c), side(c, a)]
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true
      }
      return false
    }
    expect(covers(-5, 0)).toBe(false)
    expect(covers(5, 2)).toBe(false)
    expect(covers(4, -3.5)).toBe(false)
    expect(covers(0, 4)).toBe(true)
  })

  test("cut edges and hole walls are FR4, the rest the mask colour", () => {
    // occt-import-js finds a face's colour only outside an assembly, so this reads the board alone.
    const w = new StepWriter()
    const board = { ...BOARD, outline: { x: 0, y: 0, width: 20, height: 12, cornerRadius: 0 }, holes: [{ x: 0, y: 0, diameter: 2 }] }
    writeBoard(w, board, boardHoles(board).kept)
    const [mesh] = read(w.text({ name: "b", author: "", timestamp: T })).meshes
    const fr4 = [linear(0.8), linear(0.72), linear(0.53)].map((c) => expect.closeTo(c, 4))
    expect(mesh.color).toEqual([linear(0.1), linear(0.4), linear(0.2)].map((c) => expect.closeTo(c, 4)))
    expect(mesh.brep_faces.map((f) => f.color)).toEqual([null, null, fr4, fr4, fr4, fr4, fr4, fr4])
  })

  test("holes that overlap or reach the edge are left out, with a note", () => {
    const holes = [
      { x: 0, y: 0, diameter: 2 },
      { x: 0.5, y: 0, diameter: 1 }, // inside the first
      { x: 0, y: 0, diameter: 2 }, // the same hole twice
      { x: 9.6, y: 0, diameter: 1 }, // past the edge
      { x: 3, y: 3, diameter: 0 },
      { x: -4, y: -3, diameter: 1 },
    ]
    const board = { ...BOARD, outline: { x: 0, y: 0, width: 20, height: 12, cornerRadius: 1 }, holes }
    const r = writeStep({ name: "Bad holes", board, models: [], placements: [], timestamp: T })
    expect(r.notes).toEqual([
      "4 holes are left out of the board solid: 2 overlap another hole, 1 reaches the board edge and 1 has no size.",
    ])
    const back = read(r.text)
    expect(back.success).toBe(true)
    expect(back.meshes[0].brep_faces).toHaveLength(2 + 8 + 2 * 2)
  })

  /** Holes 0.8 mm across on a 2 mm grid, `nx` by `ny`, on a board just big enough. */
  function grid(nx: number, ny: number) {
    const holes = []
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) holes.push({ x: -nx + 1 + i * 2, y: -ny + 1 + j * 2, diameter: 0.8 })
    const board = { ...BOARD, outline: { x: 0, y: 0, width: nx * 2 + 4, height: ny * 2 + 4, cornerRadius: 3 }, holes }
    const area = board.outline.width * board.outline.height - (4 - Math.PI) * 9 - nx * ny * Math.PI * 0.16
    return { input: { name: "Many holes", board, models: [], placements: [], timestamp: T }, area }
  }

  test("3,000 holes write in a few seconds at most", () => {
    const { input } = grid(60, 50)
    writeStep(input)
    const start = performance.now()
    const r = writeStep(input)
    // About 100 ms on a laptop and 1.4 s on CI's shared cores (October 2026), which failed the
    // old 1 s limit on every run. The limit is for catching a slip into quadratic time, not noise.
    expect(performance.now() - start).toBeLessThan(5000)
    expect(r.notes).toEqual([])
    // Every hole is two half cylinders, and the top and bottom come in strips of about a hundred
    // holes (OCCT takes a minute over one face with 3,000 holes, nine seconds over strips).
    const faces = count(r.text, /=ADVANCED_FACE\(/g)
    const strips = (faces - 2 * 3000 - 8 + 2) / 4
    expect(Number.isInteger(strips) && strips >= 20 && strips <= 40).toBe(true)
    expect(count(r.text, /=CYLINDRICAL_SURFACE\(/g)).toBe(3000 + 4)
  })

  test("a board cut in strips is still one closed solid with every hole", () => {
    const { input, area } = grid(30, 20)
    const r = writeStep(input)
    const faces = count(r.text, /=ADVANCED_FACE\(/g)
    expect(faces).toBeGreaterThan(2 * 600 + 8 + 2)
    const back = read(r.text)
    expect(back.success).toBe(true)
    const [mesh] = back.meshes
    expect(mesh.brep_faces).toHaveLength(faces)
    expect(volume(mesh) / (area * 1.6)).toBeCloseTo(1, 2)
  })
})

describe("embedded STEP models", () => {
  const io1 = () => testfile("cax-if/io1-cm-214.stp")

  test("an AP214 part lands where its matrix says, turned and flipped, embedded once for two instances", () => {
    const text = io1()
    const source = bounds(read(text, true).meshes)
    const r = exportOne({ key: "m", name: "IO1", source: { kind: "step", text } }, [TURNED, FLIPPED])
    expect(r.notes).toEqual([])
    const back = read(r.text, true)
    expect(back.success).toBe(true)
    const [board, u1, u2] = instances(back)
    expect([board.name, u1.name, u2.name]).toEqual(["PCB", "IO1", "IO1"])
    expectBox(bounds(meshesOf(back, u1)), moved(source, TURNED), 1e-2)
    expectBox(bounds(meshesOf(back, u2)), moved(source, FLIPPED), 1e-2)
    // The model's geometry is in the file once, and each instance is named by its designator.
    expect(count(r.text, /=ADVANCED_FACE\(/g)).toBe(count(text, /= ?ADVANCED_FACE ?\(/g) + 6)
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('U1','U1','',")
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('U2','U2','',")
  })

  test("an AP203 assembly in inches keeps its tree, its units and its colours", () => {
    const text = testfile("cax-if/as1_pe_203.stp")
    const source = read(text)
    const r = exportOne({ key: "m", name: "AS1", source: { kind: "step", text } }, [TURNED])
    expect(r.notes).toEqual([])
    const back = read(r.text)
    expect(back.success).toBe(true)
    const [, part] = instances(back)
    expect(part.name).toBe("AS1")
    expect(part.meshes).toHaveLength(source.meshes.length)
    expectBox(bounds(meshesOf(back, part)), moved(bounds(source.meshes), TURNED), 1e-2)
    expect(meshesOf(back, part).map((m) => m.color)).toEqual(source.meshes.map((m) => m.color))
    // AP203's own entities don't come along into an AP214 file.
    expect(r.text).not.toMatch(/=(CC_DESIGN_[A-Z_]+|DESIGN_CONTEXT|MECHANICAL_CONTEXT)\(/)
    expect(count(r.text, /=APPLICATION_CONTEXT\(/g)).toBe(1)
  })

  test("colours of an AP214 assembly's parts survive", () => {
    const text = testfile("cax-if/dm1-id-214.stp")
    const source = read(text)
    const back = read(exportOne({ key: "m", name: "DM1", source: { kind: "step", text } }, [FLIPPED]).text)
    const [, part] = instances(back)
    expect(meshesOf(back, part).map((m) => m.color)).toEqual(source.meshes.map((m) => m.color))
  })

  test("a file with an NX-style shape representation and comments, CRLF and strange strings", () => {
    // cube.stp has CRLF line ends and comments; give it strings a careless renumbering would break.
    const text = testfile("simple-basic-cube/cube.stp")
      .replace("#14=PRODUCT_DEFINITION(' ',", "#14=PRODUCT_DEFINITION('id #12; it''s /* x */',")
      .replace("#17=PRODUCT_RELATED_PRODUCT_CATEGORY('part',''", "#17=PRODUCT_RELATED_PRODUCT_CATEGORY('part','#22=X(#1);'")
    const source = bounds(read(text, true).meshes)
    const r = exportOne({ key: "m", name: "Cube 'A' \\ é", source: { kind: "step", text } }, [TURNED])
    expect(r.text).toContain("PRODUCT_DEFINITION('id #12; it''s /* x */',")
    expect(r.text).toContain("PRODUCT_RELATED_PRODUCT_CATEGORY('part','#22=X(#1);',")
    expect(r.text).toContain("PRODUCT('Cube ''A'' \\\\ \\X2\\00E9\\X0\\','Cube ''A'' \\\\ \\X2\\00E9\\X0\\'")
    const back = read(r.text, true)
    expect(back.success).toBe(true)
    const [, part] = instances(back)
    expect(part.name).toBe("Cube 'A' \\ é")
    expectBox(bounds(meshesOf(back, part)), moved(source, TURNED), 1e-3)
  })

  test("a file with several root products is grouped under one product of the model", () => {
    // Two copies of the cube's DATA, the second renumbered, make a file with two roots.
    const text = testfile("simple-basic-cube/cube.stp")
    const data = text.slice(text.indexOf("DATA;") + 5, text.lastIndexOf("ENDSEC;"))
    const shifted = data.replace(/#(\d+)/g, (_, n) => `#${Number(n) + 1000}`)
    const two = text.replace(data, data + shifted)
    const r = exportOne({ key: "m", name: "Two", source: { kind: "step", text: two } }, [IDENTITY])
    const back = read(r.text)
    expect(back.success).toBe(true)
    const [, part] = instances(back)
    expect(part.name).toBe("Two")
    expect(part.meshes).toHaveLength(2)
  })

  test("entities it can't read are left out, with a note", () => {
    const text = io1().replace("DATA;", "DATA;\n#999999=NOT_CLOSED((1.,2.);")
    const r = exportOne({ key: "m", name: "IO1", source: { kind: "step", text } }, [IDENTITY])
    expect(r.notes).toEqual(["1 entity in IO1's STEP file couldn't be read and was left out."])
    expect(read(r.text).success).toBe(true)
  })

  test("the same model placed twice is two instances of one product", () => {
    const text = io1()
    const back = read(exportOne({ key: "m", name: "IO1", source: { kind: "step", text } }, [IDENTITY, TURNED]).text)
    expect(instances(back)).toHaveLength(3)
    expect(back.meshes).toHaveLength(3)
  })

  test("an AP242 file, or one of another schema, is embedded with a note", () => {
    const schema = (name: string) => io1().replace("'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'", `'${name}'`)
    const ap242 = exportOne({ key: "m", name: "IO1", source: { kind: "step", text: schema("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }") } }, [IDENTITY])
    expect(ap242.notes).toEqual([
      "IO1's STEP file is AP242; it is included as it is, but programs that read only AP214 may not show all of it.",
    ])
    expect(read(ap242.text).meshes).toHaveLength(2)
    const other = exportOne({ key: "m", name: "IO1", source: { kind: "step", text: schema("STRUCTURAL_FRAME_SCHEMA") } }, [IDENTITY])
    expect(other.notes).toEqual([
      "IO1's STEP file is STRUCTURAL_FRAME_SCHEMA, not AP203 or AP214; it is included as it is, but other programs may not read it.",
    ])
    const ap203 = exportOne({ key: "m", name: "IO1", source: { kind: "step", text: schema("CONFIG_CONTROL_DESIGN") } }, [IDENTITY])
    expect(ap203.notes).toEqual([])
  })

  test("a STEP file that can't be used falls back to the mesh, with a note", () => {
    const model: StepModelInput = {
      key: "m",
      name: "Header",
      source: { kind: "step", text: "this is not a STEP file" },
      fallback: [box([2, 3, 4])],
    }
    const r = exportOne(model, [IDENTITY])
    expect(r.notes).toEqual(["Header's STEP file couldn't be used (it has no entities), so U1 uses its mesh instead."])
    const back = read(r.text)
    const [, part] = instances(back)
    expect(meshesOf(back, part)[0].brep_faces).toHaveLength(6)
  })

  test("without a fallback the parts are left out, with a note", () => {
    const geometryOnly = io1().replace(/#\d+ ?= ?(PRODUCT_DEFINITION_SHAPE|SHAPE_DEFINITION_REPRESENTATION) ?\([^;]*;/g, "")
    const r = exportOne({ key: "m", name: "IO1", source: { kind: "step", text: geometryOnly } }, [IDENTITY, TURNED])
    expect(r.notes).toEqual(["IO1's STEP file couldn't be used (no product in it has a shape), so U1 and U2 are left out."])
    const back = read(r.text)
    expect(instances(back).map((n) => n.name)).toEqual(["PCB"])
  })
})

describe("mesh models", () => {
  test("a closed box is a solid of six faces, in its colour", () => {
    const r = exportOne(meshModel([box([2, 3, 4])]), [TURNED])
    expect(r.notes).toEqual([])
    expect(count(r.text, /=FACETED_BREP\(/g)).toBe(1)
    expect(r.text).toContain("FACETED_BREP_SHAPE_REPRESENTATION('Body',")
    const back = read(r.text)
    const [, part] = instances(back)
    const [mesh] = meshesOf(back, part)
    expect(part.name).toBe("Body")
    expect(mesh.brep_faces).toHaveLength(6)
    expect(volume(mesh)).toBeCloseTo(24, 4)
    expectBox(bounds([mesh]), moved({ min: [-1, -1.5, -2], max: [1, 1.5, 2] }, TURNED))
    expect(mesh.color).toEqual([linear(0.25), linear(0.25), linear(0.25)].map((c) => expect.closeTo(c, 4)))
  })

  test("without an index, inside out, or with each side cut in a grid, it is still six faces", () => {
    const inverted = box([2, 3, 4])
    const idx = inverted.index!
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
    for (const mesh of [box([2, 3, 4], { indexed: false }), inverted, box([2, 3, 4], { segments: 3 })]) {
      const r = exportOne(meshModel([mesh]), [IDENTITY])
      const back = read(r.text)
      const [, part] = instances(back)
      const [m] = meshesOf(back, part)
      expect(m.brep_faces).toHaveLength(6)
      expect(volume(m)).toBeCloseTo(24, 4)
      // The grid's vertices along each edge are gone: every face is a four-point loop.
      expect(r.text.match(/POLY_LOOP\('',\(([^)]*)\)\)/g)!.map((l) => l.split(",").length - 1)).toEqual([4, 4, 4, 4, 4, 4])
    }
  })

  test("a plate with a hole through it has faces with holes", () => {
    // A 10 x 10 plate with a 4 x 4 hole, triangulated between the two rings.
    const plate: StepMesh = { ...frame(10, 4, 1), color: { r: 0.5, g: 0.5, b: 0.5 } }
    const r = exportOne(meshModel([plate]), [IDENTITY])
    expect(r.notes).toEqual([])
    expect(count(r.text, /=FACE_BOUND\(/g)).toBe(2)
    const back = read(r.text)
    const [, part] = instances(back)
    const [m] = meshesOf(back, part)
    expect(m.brep_faces).toHaveLength(10)
    expect(volume(m)).toBeCloseTo(100 - 16, 4)
  })

  test("an open shape is surfaces", () => {
    const r = exportOne(meshModel([box([2, 3, 4], { skip: 0 })], "Shield"), [IDENTITY])
    expect(r.notes).toEqual([])
    expect(count(r.text, /=SHELL_BASED_SURFACE_MODEL\(/g)).toBe(1)
    expect(count(r.text, /=OPEN_SHELL\(/g)).toBe(1)
    const back = read(r.text)
    const [, part] = instances(back)
    const [m] = meshesOf(back, part)
    expect(m.brep_faces).toHaveLength(5)
    expect(m.color).toEqual([linear(0.25), linear(0.25), linear(0.25)].map((c) => expect.closeTo(c, 4)))
  })

  test("two meshes and two pieces in one: a solid each, each in its own colour", () => {
    const a = box([1, 1, 1])
    const b = box([1, 1, 1], { at: [3, 0, 0] })
    const both: StepMesh = {
      positions: new Float32Array([...a.positions, ...b.positions]),
      index: new Uint32Array([...a.index!, ...[...b.index!].map((i) => i + a.positions.length / 3)]),
      color: { r: 1, g: 0, b: 0 },
    }
    const c = { ...box([1, 1, 1], { at: [0, 3, 0] }), color: { r: 0, g: 0, b: 1 } }
    const r = exportOne(meshModel([both, c]), [IDENTITY])
    expect(count(r.text, /=FACETED_BREP\(/g)).toBe(3)
    expect(r.text).toContain("COLOUR_RGB('',1.,0.,0.)")
    expect(r.text).toContain("COLOUR_RGB('',0.,0.,1.)")
    const back = read(r.text)
    const [, part] = instances(back)
    expect(meshesOf(back, part).map((m) => m.brep_faces.length)).toEqual([6, 6, 6])
  })

  test("degenerate and broken triangles are dropped; a mesh of nothing else leaves its parts out", () => {
    const flat: StepMesh = { positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, NaN, 0, 0, 1, 0, 0]), color: { r: 1, g: 1, b: 1 } }
    const r = exportOne(meshModel([flat], "Nothing"), [IDENTITY])
    expect(r.notes).toEqual(["Nothing's model has no triangles, so U1 is left out."])
    expect(instances(read(r.text)).map((n) => n.name)).toEqual(["PCB"])
  })

  test("a curved mesh reads back as its triangles", () => {
    const r = exportOne(meshModel([torus(10, 3, 40, 30)], "Torus"), [IDENTITY])
    const back = read(r.text)
    const [, part] = instances(back)
    const [m] = meshesOf(back, part)
    // Each quad is flat, so its two triangles are one face; and with 30 steps around the tube the
    // rings of quads between 84 and 96 degrees, top and bottom, are flat annuli: one face each.
    expect(m.brep_faces.length).toBe(40 * 30 - 2 * 40 + 2)
    expect(count(r.text, /=FACE_BOUND\(/g)).toBe(2)
    const exact = 2 * Math.PI ** 2 * 10 * 9
    expect(volume(m) / exact).toBeCloseTo(1, 1)
  })

  test("a 100k-triangle mesh writes in a couple of seconds, at about 200 bytes a triangle", () => {
    const big = torus(10, 3, 250, 200)
    exportOne(meshModel([torus(10, 3, 20, 20)]), [IDENTITY])
    const start = performance.now()
    const r = exportOne(meshModel([big]), [IDENTITY])
    // About 300 ms and 17.5 MB on a laptop; CI's shared cores are several times slower.
    expect(performance.now() - start).toBeLessThan(4000)
    expect(r.text.length).toBeLessThan(100_000 * 200)
  })
})

describe("the assembly", () => {
  const model = (): StepModelInput => meshModel([box([1, 1, 1])])

  test("placements that scale or mirror, or name no model, are left out with a note", () => {
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]
    const mirrored = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const r = writeStep({
      name: "Bad",
      board: BOARD,
      models: [model()],
      placements: [
        { ref: "R1", model: "m", matrix: IDENTITY },
        { ref: "R2", model: "m", matrix: scaled },
        { ref: "R3", model: "m", matrix: mirrored },
        { ref: "R4", model: "gone", matrix: IDENTITY },
        { ref: "R5", model: "m", matrix: [1, 0, 0] },
      ],
      timestamp: T,
    })
    expect(r.notes).toEqual([
      "R4 is left out: no 3D model was given for it.",
      "R2, R3 and R5 are left out: their placements scale or mirror their model, and a STEP assembly can only turn and move one.",
    ])
    expect(instances(read(r.text)).map((n) => n.name)).toEqual(["PCB", "Body"])
  })

  test("instances are named by designator, each with an id of its own", () => {
    const r = writeStep({
      name: "Names",
      board: BOARD,
      models: [model()],
      placements: ["C1", "C1", "PCB"].map((ref) => ({ ref, model: "m", matrix: IDENTITY })),
      timestamp: T,
    })
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('PCB','PCB','',")
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('C1','C1','',")
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('C1-2','C1','',")
    expect(r.text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('PCB-2','PCB','',")
  })

  test("the file is plain ASCII AP214, the same every time for the same input", () => {
    const input: StepExportInput = {
      name: "Überboard 電源",
      board: { ...BOARD, holes: [{ x: 1, y: 1, diameter: 1 }] },
      models: [model(), { key: "s", name: "IO1", source: { kind: "step", text: testfile("cax-if/io1-cm-214.stp") } }],
      placements: [
        { ref: "U1", model: "m", matrix: TURNED },
        { ref: "J1", model: "s", matrix: FLIPPED },
      ],
      author: "Ada",
      timestamp: T,
    }
    const a = writeStep(input).text
    expect(writeStep(input).text).toBe(a)
    expect(a).toMatch(/^[\x20-\x7e\n]*$/)
    expect(a.startsWith("ISO-10303-21;\nHEADER;")).toBe(true)
    expect(a).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));")
    expect(a).toContain(`FILE_NAME('\\X2\\00DC\\X0\\berboard \\X2\\96FB6E90\\X0\\.step','${T}',('Ada')`)
    expect(a.endsWith("ENDSEC;\nEND-ISO-10303-21;\n")).toBe(true)
    const back = read(a)
    expect(back.root.children[0].name).toBe("Überboard 電源")
    expect(instances(back).map((n) => n.name)).toEqual(["PCB", "Body", "IO1"])
  })

  test("without a timestamp it is now", () => {
    const r = writeStep({ name: "Now", board: BOARD, models: [], placements: [] })
    expect(r.text).toMatch(/FILE_NAME\('Now\.step','\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'/)
  })
})

/** A square plate `size` across with a square hole `hole` across through it, `t` thick, as one mesh. */
function frame(size: number, hole: number, t: number): Omit<StepMesh, "color"> {
  const s = size / 2
  const h = hole / 2
  // Corners of the outer and inner squares at the bottom (z = 0) and top (z = t).
  const outer = [[-s, -s], [s, -s], [s, s], [-s, s]]
  const inner = [[-h, -h], [h, -h], [h, h], [-h, h]]
  const pos: number[] = []
  for (const z of [0, t]) for (const [x, y] of [...outer, ...inner]) pos.push(x, y, z)
  const v = (ring: "o" | "i", i: number, top: boolean) => (top ? 8 : 0) + (ring === "i" ? 4 : 0) + (i % 4)
  const idx: number[] = []
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d)
  for (let i = 0; i < 4; i++) {
    // top: counter-clockwise from above, between the outer and inner rings
    quad(v("o", i, true), v("o", i + 1, true), v("i", i + 1, true), v("i", i, true))
    quad(v("o", i, false), v("i", i, false), v("i", i + 1, false), v("o", i + 1, false))
    // outer walls face out, inner walls face into the hole
    quad(v("o", i, false), v("o", i + 1, false), v("o", i + 1, true), v("o", i, true))
    quad(v("i", i + 1, false), v("i", i, false), v("i", i, true), v("i", i + 1, true))
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) }
}
