import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../../src/export/kicad"
import { EXTENSION_NAMES, importKicadBoard } from "../../src/model/kicad/board"
import { importKicadProject } from "../../src/model/kicad/project"
import { partPointWorld } from "../../src/model/pcbPoints"
import { parseProjectFile, serializeProject } from "../../src/model/projectFile"
import { resolvedComponents } from "../../src/model/ruleAreas"
import { setActiveVariant } from "../../src/model/variants"
import { BY_DESIGN, REPAIRED, diffProjects } from "../kicad-roundtrip-check"
import { unknownNodes } from "../kicad9-nodes"
import { CORPUS, walkPcb as walk } from "./shared"

/** Every extension, built or not (X19 has no entry in the names, it is built): some of these boards need others besides X23. */
const ALL_EXTENSIONS = new Set([...Object.keys(EXTENSION_NAMES), "X19"])

// X23 over the corpus boards that use it (board variants, footprint units, PCB points): each must import, or, when it still needs other extensions that are not built, must no longer name
// X23 (nor X23X, custom properties, which none of them has); and what it imports must equal what the file says, saved and loaded, and written back with only what a KiCad 9 file cannot say left out.
//
// The oracle shares nothing with `src`: its own tokenizer reads the raw file, and the variants, units and points are taken from it as KiCad's parser does (`parseFOOTPRINT`: a `variant` has
// `name`, `description`, the flags `dnp`, `exclude_from_bom`, `exclude_from_pos_files`, `exclude_from_sim`, and `field`s; `units` holds `(unit (name) (pins ...))`; a `point` has `at`, `size`
// and `layer`, in the board's frame before stamp 20260616 and the footprint's after). A point is compared where it is on the board, which is the same for both frames.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/corpus/part-points.test.ts


type Node = string | Node[]

/** A tiny s-expression reader: lists, quoted strings (with escapes) and bare words. */
function read(text: string): Node[] {
  const stack: Node[][] = [[]]
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === "(") {
      stack.push([])
      i++
    } else if (c === ")") {
      const done = stack.pop()!
      stack[stack.length - 1].push(done)
      i++
    } else if (c === '"') {
      let s = ""
      i++
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++
        s += text[i++]
      }
      i++
      stack[stack.length - 1].push(s)
    } else if (/\s/.test(c)) i++
    else {
      let j = i
      while (j < n && !/[\s()]/.test(text[j])) j++
      stack[stack.length - 1].push(text.slice(i, j))
      i = j
    }
  }
  return stack[0]
}

const kids = (node: Node | undefined, name: string): Node[][] => (Array.isArray(node) ? (node.filter((c) => Array.isArray(c) && c[0] === name) as Node[][]) : [])
const word = (node: Node | undefined, at = 1) => (Array.isArray(node) && typeof node[at] === "string" ? (node[at] as string) : undefined)
const yes = (node: Node[] | undefined, name: string): boolean | undefined => {
  const k = kids(node, name)[0]
  if (k) return k[1] === undefined || k[1] === "yes"
  return node?.includes(name) ? true : undefined
}

interface FileVariant {
  dnp?: boolean
  bom?: boolean
  pos?: boolean
  sim?: boolean
  fields: Record<string, string>
}
interface FileFacts {
  stamp: number
  variants: { name: string; description: string }[]
  /** The names of the variants every footprint says something of, in file order. */
  footprintVariants: string[]
  boardPoints: { at: [number, number]; size: number; layer: string }[]
  parts: Map<string, { attrs: string[]; at: [number, number]; angle: number; variants: Map<string, FileVariant>; units: { name: string; pins: string[] }[]; points: { at: [number, number]; size: number; layer: string }[] }>
}

function fileFacts(text: string): FileFacts {
  const root = read(text)[0] as Node[]
  const stamp = Number(word(kids(root, "version")[0]) ?? 0)
  const parts: FileFacts["parts"] = new Map()
  const duplicated = new Set<string>()
  const footprintVariants: string[] = []
  const pointOf = (p: Node[]) => ({ at: [Number(word(kids(p, "at")[0], 1)), Number(word(kids(p, "at")[0], 2))] as [number, number], size: Number(word(kids(p, "size")[0])), layer: word(kids(p, "layer")[0]) ?? "" })
  for (const f of kids(root, "footprint")) {
    const ref = kids(f, "property").find((q) => q[1] === "Reference")?.[2] as string | undefined
    if (ref === undefined) continue
    for (const v of kids(f, "variant")) footprintVariants.push(word(kids(v, "name")[0]) ?? "")
    // two footprints with one reference are told apart by the importer (`R2_2`): neither is compared
    if (parts.has(ref)) {
      duplicated.add(ref)
      continue
    }
    const at = kids(f, "at")[0] ?? kids(kids(f, "transform")[0], "translate")[0]
    const angle = Number(word(kids(f, "at")[0], 3) ?? word(kids(kids(f, "transform")[0], "rotate")[0]) ?? 0)
    const variants = new Map<string, FileVariant>()
    for (const v of kids(f, "variant")) {
      variants.set(word(kids(v, "name")[0]) ?? "", {
        dnp: yes(v, "dnp"),
        bom: yes(v, "exclude_from_bom"),
        pos: yes(v, "exclude_from_pos_files"),
        sim: yes(v, "exclude_from_sim"),
        fields: Object.fromEntries(kids(v, "field").map((q) => [word(kids(q, "name")[0]) ?? "", word(kids(q, "value")[0]) ?? ""])),
      })
    }
    parts.set(ref, {
      attrs: (kids(f, "attr")[0] ?? []).slice(1) as string[],
      at: [Number(word(at, 1)), Number(word(at, 2))],
      angle,
      variants,
      units: kids(kids(f, "units")[0], "unit").map((u) => ({ name: word(kids(u, "name")[0]) ?? "", pins: (kids(u, "pins")[0] ?? []).slice(1) as string[] })),
      points: kids(f, "point").map(pointOf),
    })
  }
  for (const ref of duplicated) parts.delete(ref)
  return {
    stamp,
    footprintVariants,
    variants: kids(kids(root, "variants")[0], "variant").map((v) => ({ name: word(kids(v, "name")[0]) ?? "", description: word(kids(v, "description")[0]) ?? "" })),
    boardPoints: kids(root, "point").map(pointOf),
    parts,
  }
}

/** Where a footprint's point is in the file's frame (y down): as written before stamp 20260616, else the footprint's own frame turned and moved to the footprint. */
function fileWorld(facts: FileFacts, part: FileFacts["parts"] extends Map<string, infer V> ? V : never, p: { at: [number, number] }): [number, number] {
  if (facts.stamp < 20260616) return p.at
  const a = (part.angle * Math.PI) / 180
  return [part.at[0] + p.at[0] * Math.cos(a) + p.at[1] * Math.sin(a), part.at[1] - p.at[0] * Math.sin(a) + p.at[1] * Math.cos(a)]
}

/** A list of one of these opens its own line (a dimension's `(units 3)` does not), as KiCad 10 writes them. */
const usesX23 = (text: string) => /^\s*\((variants|variant|units|point)\s*$/m.test(text)

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X23 over the corpus", () => {
  const found = (() => {
    if (!CORPUS || !existsSync(CORPUS)) return []
    return walk(CORPUS)
      .filter((f) => usesX23(readFileSync(f, "utf8")))
      .sort()
  })()
  const rels = found.map((f) => relative(CORPUS!, f).split(String.fromCharCode(92)).join("/"))

  it("finds the boards that use variants, units or points", () => {
    expect(rels).toContain("kicad-source/qa/data/pcbnew/variant_test/variant_test.kicad_pcb")
    expect(rels).toContain("projects/smariel__SonosPlay1Hack/SonosHack.kicad_pcb")
    expect(rels).toContain("kicad-source/demos/pic_programmer/pic_programmer.kicad_pcb")
    expect(found.length).toBeGreaterThanOrEqual(10)
  })

  for (const file of found) {
    const rel = relative(CORPUS!, file).split(String.fromCharCode(92)).join("/")
    // KiCad's own kitchen sink has a track and an arc track on no layer and a Data Matrix barcode, which no importer can bring in exactly: it is refused whatever it needs, so there is nothing of it to compare.
    if (rel.endsWith("api_kitchen_sink.kicad_pcb")) {
      it(`${rel}: is refused for what is not X23's`, () => {
        const r = importKicadBoard(readFileSync(file), { built: ALL_EXTENSIONS, limitBytes: Infinity })
        expect(r.status).toBe("refused")
        expect(r.status === "refused" && r.message).toMatch(/a track on|a datamatrix barcode/)
      })
      continue
    }

    it(`${rel}: X23 is no longer named by the gate`, () => {
      const r = importKicadBoard(readFileSync(file), { limitBytes: Infinity })
      if (r.status === "refused") {
        expect(r.needs?.map((n) => n.ext) ?? [], r.message).not.toContain("X23")
        expect(r.needs?.map((n) => n.ext) ?? [], r.message).not.toContain("X23X")
      }
    })

    it(`${rel}: what it imports as equals the file's variants, units and points`, () => {
      // With every extension counted as built, so the other needs of the board do not stop it: this is about X23 alone.
      const bytes = readFileSync(file)
      const r = importKicadBoard(bytes, { built: ALL_EXTENSIONS, limitBytes: Infinity })
      if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
      const facts = fileFacts(bytes.toString("utf8"))
      const project = r.project
      // the list: what the board lists, then any name only a footprint uses
      const named = new Set(facts.variants.map((v) => v.name))
      const expectedNames = [...new Set([...facts.variants.map((v) => v.name), ...facts.footprintVariants.filter((n) => !named.has(n))])]
      expect(project.variants?.list.map((v) => v.name) ?? []).toEqual(expectedNames)
      for (const v of facts.variants) expect(project.variants!.list.find((x) => x.name === v.name)!.description ?? "", v.name).toBe(v.description)
      expect(project.variants?.active).toBeUndefined()

      const byRef = new Map(project.components.map((c) => [c.ref, c]))
      let withUnits = 0
      let withPoints = 0
      let withVariants = 0
      for (const [ref, part] of facts.parts) {
        const c = byRef.get(ref)
        // a footprint with no usable reference (`REF**`) is renamed by the importer: it is not compared
        if (!c || /\*/.test(ref)) continue
        expect(c.units ?? [], `${ref} units`).toEqual(part.units)
        withUnits += part.units.length ? 1 : 0
        expect(c.points?.length ?? 0, `${ref} points`).toBe(part.points.length)
        part.points.forEach((p, i) => {
          const w = partPointWorld(c, c.points![i], 2)
          const [fx, fy] = fileWorld(facts, part, p)
          expect(w.x, `${ref} point ${i} x`).toBeCloseTo(fx, 4)
          expect(w.y, `${ref} point ${i} y`).toBeCloseTo(-fy, 4)
          expect(c.points![i].size).toBe(p.size)
          expect(c.points![i].layer).toBe(p.layer)
        })
        withPoints += part.points.length ? 1 : 0
        // a variant that says something is on the part, as the file says it (a flag it does not say is not there)
        const got = c.variants ?? {}
        for (const [name, v] of part.variants) {
          const says = v.dnp !== undefined || v.bom !== undefined || v.pos !== undefined || v.sim !== undefined || Object.keys(v.fields).length > 0
          if (!says) {
            expect(got[name], `${ref} ${name}`).toBeUndefined()
            continue
          }
          withVariants++
          expect(got[name], `${ref} ${name}`).toEqual({
            ...(v.dnp !== undefined ? { dnp: v.dnp } : {}),
            ...(v.bom !== undefined ? { excludeFromBom: v.bom } : {}),
            ...(v.pos !== undefined ? { excludeFromPos: v.pos } : {}),
            ...(v.sim !== undefined ? { excludeFromSim: v.sim } : {}),
            ...(Object.keys(v.fields).length ? { fields: v.fields } : {}),
          })
        }
      }
      // the board's own points, in the board's frame
      expect((project.points ?? []).map((p) => [p.x, -p.y, p.size, p.layer])).toEqual(facts.boardPoints.map((p) => [p.at[0], p.at[1], p.size, p.layer]))
      expect(withUnits + withPoints + withVariants + (project.points?.length ?? 0) + facts.variants.length, "the board has something of X23").toBeGreaterThan(0)

      // the variant shown decides the flags: the file's attributes with the variant's word over them
      for (const name of project.variants?.list.map((v) => v.name) ?? []) {
        const shown = new Map(resolvedComponents(setActiveVariant(project, name)).map((c) => [c.ref, c]))
        for (const [ref, part] of facts.parts) {
          const c = shown.get(ref)
          if (!c || /\*/.test(ref)) continue
          const v = part.variants.get(name)
          expect(!!c.flags?.dnp, `${ref} dnp in ${name}`).toBe(v?.dnp ?? part.attrs.includes("dnp"))
          expect(!!c.flags?.excludeFromBom, `${ref} bom in ${name}`).toBe(v?.bom ?? part.attrs.includes("exclude_from_bom"))
          expect(!!c.flags?.excludeFromPos, `${ref} pos in ${name}`).toBe(v?.pos ?? part.attrs.includes("exclude_from_pos_files"))
        }
      }
    })

    it(`${rel}: saved and loaded, and written as a KiCad board, it keeps what a KiCad 9 file can hold`, async () => {
      const bytes = readFileSync(file)
      const a = importKicadBoard(bytes, { built: ALL_EXTENSIONS, limitBytes: Infinity })
      if (a.status !== "imported") throw new Error(`${a.status}: ${a.message}`)
      const origin = { id: "p", createdAt: 1, updatedAt: 1 }
      const saved = serializeProject(setActiveVariant(a.project, a.project.variants?.list[0]?.name))
      const loaded = parseProjectFile(saved, origin)
      expect(loaded.variants).toEqual(setActiveVariant(a.project, a.project.variants?.list[0]?.name).variants)
      expect(loaded.points).toEqual(a.project.points)
      expect(loaded.components.map((c) => [c.ref, c.variants, c.units, c.points])).toEqual(a.project.components.map((c) => [c.ref, c.variants, c.units, c.points]))
      expect(JSON.parse(saved).version).toBe(3)

      const written = await kicadFiles(a.project)
      const pcb = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
      expect(unknownNodes(pcb)).toEqual([])
      const b = importKicadBoard(pcb, { built: ALL_EXTENSIONS, limitBytes: Infinity })
      if (b.status !== "imported") throw new Error(`${b.status}: ${b.message}`)
      // A board that imports as it is differs from its written file by what a KiCad 9 file cannot say, and nothing else; one that only imports with the other extensions counted as built
      // (hatched fills, say) also differs by what those do not write back, which is not X23's to say.
      const differences = diffProjects(a.project, b.project)
      const plain = importKicadBoard(bytes, { limitBytes: Infinity }).status === "imported"
      const own = (d: { kind: string }) => /^project\.(variants|points)|^project\.components\[\]\.(variants|units|points)/.test(d.kind)
      expect(differences.filter((d) => ![...BY_DESIGN, ...REPAIRED].some((re) => re.test(d.kind)) && (plain || own(d))).map((d) => d.kind)).toEqual([])
      expect(b.project.variants).toBeUndefined()
      expect(b.project.components.some((c) => c.variants || c.units || c.points)).toBe(false)
    }, 120000)
  }
})

// KiCad's own variant test is a project: its board, its schematic and its project file. The symbols' variants (the schematic's, S9) and the footprints' (the board's) are joined: the project lists the names
// of both, a linked part has the footprint's units and the variants the symbol says nothing of, and what the symbol says of a variant stands.
describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X23 over the corpus: a board joined with its schematic", () => {
  const dir = CORPUS ? join(CORPUS, "kicad-source/qa/data/pcbnew/variant_test") : ""
  it("variant_test keeps the footprints' units and both sides' variants", () => {
    const files = ["variant_test.kicad_pcb", "variant_test.kicad_sch", "variant_test.kicad_pro"].map((f) => ({ path: f, data: readFileSync(join(dir, f)) }))
    const r = importKicadProject(files)
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.variants?.list.map((v) => v.name)).toEqual(["Variant A"])
    const raw = readFileSync(join(dir, "variant_test.kicad_pcb"), "utf8")
    expect(r.project.components.filter((c) => c.units).length).toBe((raw.match(/^\s*\(units\s*$/gm) ?? []).length)
    const r1 = r.project.components.find((c) => c.ref === "R1")!
    // the symbol leaves the position file and sets a value; the footprint says the same value
    expect(r1.variants).toEqual({ "Variant A": { excludeFromPos: true, fields: { Datasheet: "test" } } })
    expect(r.project.components.every((c) => c.variants?.["Variant A"])).toBe(true)
  })
})
