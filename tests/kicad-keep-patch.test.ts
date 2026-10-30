import { describe, expect, it } from "vitest"
import { patchFile } from "../src/export/keep/patch"
import { fileVersion, parseAt, scanList } from "../src/export/keep/sexp"

// Writing back only what the user changed (`export/keep/patch.ts`): small boards written by hand, in three spellings (the user's file with tabs and fields the
// exporter has no model for, and the exporter's before and after).

const SERIAL = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

/** A board as the user's KiCad wrote it. */
const original = [
  "(kicad_pcb",
  "\t(version 20241229)",
  '\t(generator "pcbnew")',
  '\t(general (thickness 1.6))',
  '\t(net 0 "")',
  '\t(net 1 "GND")',
  '\t(footprint "R:0603"',
  '\t\t(layer "F.Cu")',
  "\t\t(uuid aaaaaaaa-0000-4000-8000-000000000001)",
  "\t\t(at 10 20)",
  '\t\t(property "Reference" "R1" (at 0 -1 0) (layer "F.SilkS") (uuid aaaaaaaa-0000-4000-8000-000000000011))',
  '\t\t(model "${KICAD}/r.step" (offset (xyz 0 0 0.3)))',
  '\t\t(pad "1" smd rect (at -0.8 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid aaaaaaaa-0000-4000-8000-000000000012))',
  "\t)",
  '\t(footprint "R:0603"',
  '\t\t(layer "F.Cu")',
  "\t\t(uuid aaaaaaaa-0000-4000-8000-000000000002)",
  "\t\t(at 30 20)",
  '\t\t(property "Reference" "R2" (at 0 -1 0) (layer "F.SilkS") (uuid aaaaaaaa-0000-4000-8000-000000000021))',
  "\t)",
  "\t(segment (start 1 1) (end 5 1) (width 0.25) (layer \"F.Cu\") (net 1) (uuid aaaaaaaa-0000-4000-8000-000000000031))",
  "\t(segment (start 5 1) (end 9 1) (width 0.25) (layer \"F.Cu\") (net 1) (uuid aaaaaaaa-0000-4000-8000-000000000032))",
  ")",
  "",
].join("\n")

/** What the exporter writes for it: its own numbers, uuids and spacing, and no model offset. */
function written(opts: { r1x?: number; segments?: [number, number][]; extraNet?: boolean; r2?: boolean }): string {
  const segs = opts.segments ?? [[1, 5], [5, 9]]
  const nets = opts.extraNet ? [`  (net 0 "")`, `  (net 1 "VCC")`, `  (net 2 "GND")`] : [`  (net 0 "")`, `  (net 1 "GND")`]
  const gnd = opts.extraNet ? 2 : 1
  let n = 0
  const lines = [
    "(kicad_pcb",
    "  (version 20241229)",
    '  (generator "pcbnew")',
    "  (general",
    "    (thickness 1.6)",
    "  )",
    ...nets,
    "  (footprint \"R:0603\"",
    '    (layer "F.Cu")',
    `    (uuid ${SERIAL(++n)})`,
    `    (at ${opts.r1x ?? 10} 20)`,
    `    (property "Reference" "R1"`,
    "      (at 0 -1 0)",
    '      (layer "F.SilkS")',
    `      (uuid ${SERIAL(++n)})`,
    "    )",
    `    (pad "1" smd rect`,
    "      (at -0.8 0)",
    "      (size 1 1)",
    '      (layers "F.Cu")',
    `      (net ${gnd} "GND")`,
    `      (uuid ${SERIAL(++n)})`,
    "    )",
    "  )",
  ]
  if (opts.r2 !== false) lines.push('  (footprint "R:0603"', '    (layer "F.Cu")', `    (uuid ${SERIAL(++n)})`, "    (at 30 20)", '    (property "Reference" "R2"', "      (at 0 -1 0)", '      (layer "F.SilkS")', `      (uuid ${SERIAL(++n)})`, "    )", "  )")
  for (const [a, b] of segs) lines.push("  (segment", `    (start ${a} 1)`, `    (end ${b} 1)`, "    (width 0.25)", '    (layer "F.Cu")', `    (net ${gnd})`, `    (uuid ${SERIAL(++n)})`, "  )")
  lines.push(")", "")
  return lines.join("\n")
}

describe("the lossless reader", () => {
  it("gives the place of every node, so a node can be cut out by its bytes", () => {
    const root = scanList(original, 0)
    expect(root.head).toBe("kicad_pcb")
    const fp = root.kids.filter((k) => original.startsWith("(footprint", k.start))
    expect(fp).toHaveLength(2)
    expect(original.slice(fp[0].start, fp[0].end).startsWith('(footprint "R:0603"')).toBe(true)
    const node = parseAt(original, fp[0].start, fp[0].end)
    expect(node.head).toBe("footprint")
    expect(node.kids!.find((k) => k.head === "at")!.kids!.map((k) => k.raw)).toEqual(["at", "10", "20"])
    expect(fileVersion(original)).toBe(20241229)
  })
})

describe("patching the user's file with what changed", () => {
  it("returns the original when nothing changed, even if the exporter's ids are different", () => {
    const r = patchFile("board", original, written({}), written({}).replaceAll("00000000-0000-4000-8000-", "00000000-0000-4000-8000-1"))
    expect(r.ok).toBe(true)
    expect(r.text).toBe(original)
  })

  it("moves one footprint and leaves every other byte alone", () => {
    const r = patchFile("board", original, written({}), written({ r1x: 11 }))
    expect(r.ok).toBe(true)
    expect(r.text).toBe(original.replace("(at 10 20)", "(at 11 20)"))
    expect(r.stats).toMatchObject({ changed: 1, added: 0, removed: 0 })
  })

  it("keeps what the exporter has no model for in a footprint it changes", () => {
    const r = patchFile("board", original, written({}), written({ r1x: 12 }))
    expect(r.text).toContain('(model "${KICAD}/r.step" (offset (xyz 0 0 0.3)))')
    expect(r.text).toContain("aaaaaaaa-0000-4000-8000-000000000011")
  })

  it("cuts out a deleted track and nothing else", () => {
    const r = patchFile("board", original, written({}), written({ segments: [[1, 5]] }))
    expect(r.ok).toBe(true)
    expect(r.text).toBe(original.split("\n").filter((l) => !l.includes("000000000032")).join("\n"))
    expect(r.stats.removed).toBe(1)
  })

  it("adds a track after the last item, with a uuid of its own and the net as the user's file numbers it", () => {
    const r = patchFile("board", original, written({}), written({ segments: [[1, 5], [5, 9], [9, 12]] }))
    expect(r.ok).toBe(true)
    expect(r.text.startsWith(original.slice(0, original.lastIndexOf("\n)")))).toBe(true)
    expect(r.text).toContain("(start 9 1)")
    expect(r.text).toContain("(net 1)")
    expect(r.text).not.toContain("00000000-0000-4000-8000-")
  })

  it("adds a new net to the table, after the user's own rows", () => {
    // The segment is moved to a net the file does not have: it is VCC, which is net 2 afterwards.
    const after = written({ extraNet: true }).replace(/\(net 2\)\n    \(uuid [^)]*\d{1}\)\n  \)\n\)\n$/, "(net 1)\n    (uuid 00000000-0000-4000-8000-00000000000f)\n  )\n)\n")
    const r = patchFile("board", original, written({}), after)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('(net 2 "VCC")')
    expect(r.text.indexOf('(net 2 "VCC")')).toBeGreaterThan(r.text.indexOf('(net 1 "GND")'))
  })

  it("refuses when a deleted item is not in the original, so the caller writes the whole file", () => {
    const other = original.replace("(start 5 1) (end 9 1)", "(start 5 2) (end 9 2)")
    const r = patchFile("board", other, written({}), written({ segments: [[1, 5]] }))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/deleted segment/)
  })

  it("tells a footprint that was moved from one that was added", () => {
    const r = patchFile("board", original, written({}), written({ r1x: 13, r2: false }))
    expect(r.ok).toBe(true)
    expect(r.stats).toMatchObject({ changed: 1, removed: 1, added: 0 })
    expect(r.text).toContain("(at 13 20)")
    expect(r.text).not.toContain("000000000002)")
  })
})
