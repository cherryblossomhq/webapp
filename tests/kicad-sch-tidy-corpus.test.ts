import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cleanupSheet } from "../src/model/cleanup"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { netlistChanges, physicalNetlist, tidySchematic } from "../src/model/tidy"
import { computeConnectivity } from "../src/model/connectivity"
import { isSchematicPart } from "../src/model/instances"
import { findPart } from "../src/model/library"

// Tidy and Clean up on every importable schematic of the corpus (not in the repo). A part imported
// from KiCad has no footprint until it is linked to a board, but it is a real part of the sheet:
// Tidy and Clean up must see its pins. Each of them either leaves every connection as it was, pin
// for pin, or refuses and says why; none may change a net.

const CORPUS = process.env.KICAD_CORPUS

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_sch")) out.push(p)
  }
  return out
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("Tidy and Clean up on the importable schematics of the corpus", () => {
  it("never change a net, and a refusal says what it refused", () => {
    let files = 0
    let withPins = 0
    let tidied = 0
    let cleaned = 0
    const refusals: string[] = []
    const wrong: string[] = []
    const mute: string[] = []
    const noPins: string[] = []
    const unstable: string[] = []
    for (const path of walk(CORPUS!)) {
      const r = importKicadSchematic(new Uint8Array(readFileSync(path)))
      if (r.status !== "imported") continue
      files++
      const name = path.split(/[\\/]/).slice(-2).join("/")
      const before = r.project
      // the check can only mean something when it sees the pins of the sheet: the parts are real parts
      const nets = physicalNetlist(before)
      if (nets.size > 0) withPins++
      else if (before.components.some((c) => isSchematicPart(findPart(c.partId))) && before.wires.length > 0) noPins.push(name)

      /** The name of the net each pin is on, KiCad's name for it: it must be the same after Tidy and after Clean up. */
      const named = (p: typeof before) => {
        const c = computeConnectivity(p)
        const byId = new Map(c.nets.map((n) => [n.id, n.name]))
        const refs = new Map(p.components.map((x) => [x.id, x.ref]))
        return [...c.pinNet].filter(([k]) => refs.has(k.slice(0, k.lastIndexOf(":"))) && !refs.get(k.slice(0, k.lastIndexOf(":")))!.startsWith("#")).map(([k, id]) => `${refs.get(k.slice(0, k.lastIndexOf(":")))}.${k.slice(k.lastIndexOf(":") + 1)}=${byId.get(id)}`).filter((x) => !/=N\$|=unconnected-\(/.test(x)).sort()
      }
      const t = tidySchematic(before)
      if (!t.ok) {
        refusals.push(`${name}: ${t.message} ${t.problems.slice(0, 2).join(" / ")}`)
        if (!t.message.trim()) mute.push(name)
      } else {
        tidied++
        const problems = netlistChanges(before, t.project, t.renamed)
        if (problems.length) wrong.push(`${name} (tidy): ${problems.slice(0, 3).join("; ")}`)
        const was = named(before)
        const now = named(t.project)
        if (JSON.stringify(was) !== JSON.stringify(now)) wrong.push(`${name} (tidy): names ${was.filter((x) => !now.includes(x)).slice(0, 2).join(", ")} became ${now.filter((x) => !was.includes(x)).slice(0, 2).join(", ")}`)
        // items and labels' styles come through
        if ((before.items?.filter((i) => i.kind !== "junction").length ?? 0) !== (t.project.items?.filter((i) => i.kind !== "junction").length ?? 0)) wrong.push(`${name} (tidy): items changed`)
        // a second Tidy of a tidied sheet leaves it as it is
        const again = tidySchematic(t.project)
        if (again.ok && again.changed) unstable.push(name)
      }

      const c = cleanupSheet(before)
      if (!c.ok) {
        if (!c.message.trim()) mute.push(`${name} (clean up)`)
      } else {
        cleaned++
        const problems = netlistChanges(before, c.project, c.tidy?.renamed ?? {})
        if (problems.length) wrong.push(`${name} (clean up): ${problems.slice(0, 3).join("; ")}`)
        const was = named(before)
        const now = named(c.project)
        if (JSON.stringify(was) !== JSON.stringify(now)) wrong.push(`${name} (clean up): names ${was.filter((x) => !now.includes(x)).slice(0, 2).join(", ")} became ${now.filter((x) => !was.includes(x)).slice(0, 2).join(", ")}`)
      }
    }
    if (process.env.TIDY_CORPUS_LOG) console.log(`tidy corpus: ${files} files, ${withPins} with parts, tidied ${tidied}, cleaned ${cleaned}, refused ${refusals.length}, unstable ${unstable.length}`)
    for (const m of refusals) if (process.env.TIDY_CORPUS_LOG) console.log(`refused: ${m}`)
    for (const m of unstable) if (process.env.TIDY_CORPUS_LOG) console.log(`unstable: ${m}`)
    expect(files).toBeGreaterThanOrEqual(118)
    // a sheet with parts and wires whose parts see no net would mean the check is blind
    expect(noPins).toEqual([])
    expect(withPins).toBeGreaterThanOrEqual(20)
    expect(wrong).toEqual([])
    expect(mute).toEqual([])
    // a second Tidy leaves a tidied sheet as it is
    expect(unstable).toEqual([])
    // the sheets Tidy takes in are most of those with parts (it was none of them while the parts counted as off the board)
    expect(tidied).toBeGreaterThanOrEqual(70)
    expect(cleaned).toBeGreaterThanOrEqual(90)
    // a refusal for the text of a part names the part and its fields
    expect(refusals.some((m) => /The text of U1 \(Reference, Value\) is where KiCad drew it/.test(m))).toBe(true)
  }, 900_000)
})
