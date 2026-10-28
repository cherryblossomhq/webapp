import { existsSync, readFileSync } from "node:fs"
import { relative } from "node:path"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../../src/export/kicad"
import { EXTENSION_NAMES, importKicadBoard } from "../../src/model/kicad/board"
import { cachedExport, CORPUS, walkPcb as walk } from "./shared"

/** Every extension, built or not (X19 has no entry in the names, it is built): these three boards need some of them besides X20. */
const ALL_EXTENSIONS = new Set([...Object.keys(EXTENSION_NAMES), "X19"])

// X20 over the corpus boards that need it (a placement rule area that is switched on, or a footprint with component classes): there are three, none of which needs
// X20 alone. Each must import, or, when it still needs other extensions that are not built, must no longer name X20; and what it imports must equal what the file says.
//
// The oracle shares nothing with `src`: its own tokenizer reads the raw file, and the areas and classes are taken from it by KiCad's parser rules
// (`parseZONE`, 9.0.0 line 6911 and 10.0.0 line 8100: the last of `sheetname`, `component_class` and `group` is the source, `enabled` yes switches it on;
// `parseFOOTPRINT`: `component_classes` holds `(class name)`), the editor's frame being y up where the file's is y down.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/corpus/class-rules.test.ts


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

const kids = (node: Node, name: string): Node[][] => (Array.isArray(node) ? (node.filter((c) => Array.isArray(c) && c[0] === name) as Node[][]) : [])
const word = (node: Node | undefined, at = 1) => (Array.isArray(node) && typeof node[at] === "string" ? (node[at] as string) : undefined)

interface FileArea {
  by: "sheet" | "class" | "group"
  name: string
  enabled: boolean
  layers: string[]
  zoneName: string
  corners: [number, number][]
}

function fileFacts(text: string) {
  const root = read(text)[0] as Node[]
  const areas: FileArea[] = []
  for (const z of kids(root, "zone")) {
    const p = kids(z, "placement")[0]
    if (!p) continue
    let by: FileArea["by"] = "sheet"
    let name = ""
    for (const c of p.slice(1)) {
      if (!Array.isArray(c)) continue
      if (c[0] === "sheetname") [by, name] = ["sheet", word(c) ?? ""]
      if (c[0] === "component_class") [by, name] = ["class", word(c) ?? ""]
      if (c[0] === "group") [by, name] = ["group", word(c) ?? ""]
    }
    const enabled = word(kids(p, "enabled")[0]) === "yes"
    if (!enabled && by === "sheet" && name === "") continue
    const layers = kids(z, "layers")[0] ? (kids(z, "layers")[0].slice(1) as string[]) : [word(kids(z, "layer")[0]) ?? ""]
    const pts = kids(kids(z, "polygon")[0], "pts")[0]
    const corners = kids(pts, "xy").map((c) => [Number(c[1]), Number(c[2])] as [number, number])
    areas.push({ by, name, enabled, layers, zoneName: word(kids(z, "name")[0]) ?? "", corners })
  }
  const classes = new Map<string, string[]>()
  for (const f of kids(root, "footprint")) {
    const ref = kids(f, "property").find((q) => q[1] === "Reference")?.[2] as string | undefined
    const names = kids(f, "component_classes").flatMap((c) => kids(c, "class").map((k) => k[1] as string))
    if (ref !== undefined && names.length) classes.set(ref, [...new Set(names)])
  }
  return { areas, classes }
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X20 over the corpus", () => {
  const found = (() => {
    if (!CORPUS || !existsSync(CORPUS)) return []
    return walk(CORPUS)
      .filter((f) => {
        const text = readFileSync(f, "utf8")
        return text.includes("(component_classes") || /\(placement\s+\(enabled yes\)/.test(text)
      })
      .sort()
  })()

  it("finds the three boards that need it", () => {
    expect(found.map((f) => relative(CORPUS!, f).split(String.fromCharCode(92)).join("/"))).toEqual([
      "kicad-source/demos/multichannel/multichannel_mixer.kicad_pcb",
      "kicad-source/qa/data/pcbnew/component_classes.kicad_pcb",
      "projects/sentoxo__EdgeCubeH3/EdgeCubeH3/EdgeCubeH3.kicad_pcb",
    ])
  })

  for (const file of found) {
    const rel = relative(CORPUS!, file).split(String.fromCharCode(92)).join("/")
    it(`${rel}: X20 is no longer named by the gate`, () => {
      const r = importKicadBoard(readFileSync(file))
      if (r.status === "refused") {
        expect(r.needs.map((n) => n.ext), r.message).not.toContain("X20")
        expect(r.message).not.toMatch(/placement rule areas or component classes/)
      }
    })

    it(`${rel}: what it imports as equals the file's areas and classes`, () => {
      // With every extension counted as built, so the other needs of the board do not stop it: this is about X20 alone.
      const text = readFileSync(file)
      const r = importKicadBoard(text, { built: ALL_EXTENSIONS })
      if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
      const facts = fileFacts(text.toString("utf8"))
      const placed = r.project.zones.filter((z) => z.placement)
      expect(placed.length).toBe(facts.areas.length)
      facts.areas.forEach((a, i) => {
        const z = placed[i]
        expect(z.placement, `area ${i}`).toEqual({ by: a.by, name: a.name, ...(a.enabled ? {} : { off: true }) })
        expect(z.name ?? "", `area ${i}`).toBe(a.zoneName)
        expect([...new Set((z.layers ?? [z.layer]).map((l) => (l === "top" ? "F.Cu" : l === "bottom" ? "B.Cu" : l.replace(/^in(\d+)$/, "In$1.Cu"))))].sort(), `area ${i}`).toEqual([...a.layers].sort())
        const ring = z.outline![0].segs.map((s) => (s.kind === "line" ? s.a : null))
        expect(ring.length, `area ${i}`).toBe(a.corners.length)
        a.corners.forEach(([x, y], k) => {
          expect(ring[k]!.x).toBeCloseTo(x, 6)
          expect(ring[k]!.y).toBeCloseTo(-y, 6)
        })
      })
      const byRef = new Map(r.project.components.map((c) => [c.ref, c.classes ?? []]))
      for (const [ref, names] of facts.classes) expect(byRef.get(ref), ref).toEqual(names)
      expect([...byRef].filter(([, v]) => v.length).length).toBe(facts.classes.size)
    })

    it(`${rel}: written as a KiCad board and read again, the areas and classes are the same`, async () => {
      const a = importKicadBoard(readFileSync(file), { built: ALL_EXTENSIONS })
      if (a.status !== "imported") throw new Error(a.status)
      const written = await cachedExport("kicadFiles", a.project, () => kicadFiles(a.project))
      const pcb = Object.entries(written.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
      const b = importKicadBoard(pcb, { built: ALL_EXTENSIONS })
      if (b.status !== "imported") throw new Error(`${b.status}: ${b.message}`)
      expect(b.project.zones.filter((z) => z.placement).map((z) => z.placement)).toEqual(a.project.zones.filter((z) => z.placement).map((z) => z.placement))
      const classes = (p: typeof a.project) => p.components.filter((c) => c.classes?.length).map((c) => [c.ref, c.classes, c.sheetPath])
      expect(classes(b.project)).toEqual(classes(a.project))
      // The facts of the written file, by the oracle again.
      const mine = fileFacts(pcb)
      const theirs = fileFacts(readFileSync(file, "utf8"))
      expect(mine.areas.map((x) => [x.by, x.name, x.enabled])).toEqual(theirs.areas.map((x) => [x.by, x.name, x.enabled]))
      const byRef = (m: Map<string, string[]>) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      expect(byRef(mine.classes)).toEqual(byRef(theirs.classes))
    }, 120000)
  }
})
