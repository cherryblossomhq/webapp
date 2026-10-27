import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PHASE_LABELS } from "../src/kicadImport/protocol"
import { reportLead, reportSections, reportTitle, reportTone } from "../src/kicadImport/sections"
import { PLAIN_NAMES, plainName, reportJson, reportName, reportText, stoppedSummary, summarize, unsupportedLead, type ImportSummary, type SummaryReason } from "../src/kicadImport/summary"
import { BUILT_EXTENSIONS, EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { EXTENSION_NAMES as SCHEMATIC_NAMES } from "../src/model/kicad/schematic"
import { board, footprint, pad, REFUSED_BOARD } from "./kicad-board-fixtures"

// The words of the report: every extension id has a plain name that covers what triggers it, a
// refusal says what in the board needs each one, and the downloads say the same as the screen.

const ctx = { used: ["b.kicad_pcb"], notRead: [{ file: "x.kicad_pro", why: "the schematic import is coming" }], ignored: [], boardBytes: 1 }

describe("plain names for the extensions", () => {
  it("has one for every extension the importer knows, and none for one it does not", () => {
    expect(Object.keys(PLAIN_NAMES).sort()).toEqual(Object.keys({ ...EXTENSION_NAMES, ...SCHEMATIC_NAMES }).sort())
  })

  it("names are words, not ids", () => {
    for (const [id, name] of Object.entries(PLAIN_NAMES)) {
      expect(name, id).not.toMatch(/\bX\d+\b/)
      expect(name.length, id).toBeGreaterThan(5)
    }
    expect(PLAIN_NAMES.X3).toMatch(/^copper pours/)
  })

  // What `needs.ts` raises each extension for, from its rules (docs/kicad-import.md section 6): a name
  // that says less than that tells a user their board has something it does not.
  const COVERS: Record<string, RegExp[]> = {
    X1: [/two copper layers/, /stackup/],
    X2: [/not a plain or rounded rectangle/, /cutouts/, /open or missing/],
    X3: [/pours/, /keepouts/, /rule areas/, /teardrops/],
    X4: [/curved tracks/],
    X5: [/blind, buried or micro vias/, /via stacks/, /via options/],
    X6: [/not a multiple of 90 degrees/],
    X7: [/turned/, /rounded/, /custom/, /off centre/, /slotted/, /unusual layers/, /margins/, /nets/],
    X8: [/silkscreen/, /any layer/, /no pads/],
    X9: [/reference and value/, /board/],
    X10: [/net classes/, /design rules/, /drill/],
    X11: [/dimensions/],
    X12: [/groups/],
    X13: [/tracks and vias that carry a net/],
    X14: [/images/],
    X15: [/flags/, /net ties/],
    X19: [/text outlines/, /fonts/],
    X20: [/placement rule areas/, /component classes/],
    X21: [/tuning/, /pad lengths/],
    X22: [/via protection/, /backdrill/],
    X23: [/variants/, /units/, /points/],
    X23X: [/custom properties/],
    X24: [/hatched fills/, /line end shapes/, /colours/, /negative width/, /solder mask/],
    X25: [/tables/, /barcodes/, /drill charts/, /text boxes/, /expressions/, /variables/],
    // the schematic's (docs/kicad-import-schematic.md section 3)
    S1: [/sheets inside sheets/, /hierarchical/, /sheet pins/],
    S1T: [/several top level sheets/],
    S2: [/net labels/, /local and global/, /net names/],
    S3: [/buses/, /bus entries/, /bus aliases/],
    S3B: [/bus names/, /on a wire/, /9 and 10/, /too large/],
    S4: [/notes/, /shapes/, /pictures/, /tables/, /wires and junctions/],
    S5: [/several units/, /mirrored/, /hidden power pins/, /share a number/, /fields/],
    S6: [/arcs/, /curves/, /fills/, /line styles/],
    S7: [/flags/, /do not populate/, /not on the board/, /simulation/],
    S8: [/directive labels/, /rule areas/],
    S9: [/variants/],
    S9X: [/overrides/, /custom properties/],
    S10: [/kept inside the project/],
    S11: [/wire joins/, /label on a pin/],
    S11L: [/KiCad 5/, /no-connect/, /label names/],
    S12: [/libraries/, /parts database/],
    X26: [/creepage/],
    X27: [/dimensions inside parts/],
    X28: [/PNG or JPEG/],
    X29: [/not copper/, /solder mask/, /paste/, /silkscreen/, /user layers/],
    X30: [/belong to a part/, /keepout/, /footprint/],
    X31: [/pad/, /pour/, /some copper layers/],
  }

  it("every name covers everything its extension is raised for", () => {
    expect(Object.keys(COVERS).sort()).toEqual(Object.keys(PLAIN_NAMES).sort())
    for (const [id, res] of Object.entries(COVERS)) for (const re of res) expect(PLAIN_NAMES[id], id).toMatch(re)
  })

  it("an id the table has never heard of is still named in words, with the id for support", () => {
    expect(plainName("X99")).toBe("a feature the editor does not have yet (X99)")
  })

  it("the lead for a refusal counts the things and points to the list", () => {
    expect(unsupportedLead(1)).toBe("This board uses 1 thing Cherry Blossom cannot hold yet, listed below.")
    expect(unsupportedLead(3)).toBe("This board uses 3 things Cherry Blossom cannot hold yet, listed below.")
  })
})

const refused = importKicadBoard(REFUSED_BOARD)
const imported = importKicadBoard(board({}))
// What this fixture is refused for is whatever the importer does not build yet: read from its own result, so the tests keep passing as slices build more.
const MISSING = refused.status === "refused" ? refused.needs.map((n) => n.ext) : []

describe("the summary of a real result", () => {
  it("a refusal lists what the board uses, by plain name, with what in the board needs it", () => {
    const s = summarize(refused, ctx)
    expect(s.status).toBe("refused")
    expect(MISSING.length).toBeGreaterThan(0)
    expect(MISSING.every((id) => !BUILT_EXTENSIONS.has(id))).toBe(true)
    expect(s.missing.map((m) => m.id)).toEqual(MISSING)
    expect(s.missing.map((m) => m.name)).toEqual(MISSING.map((id) => PLAIN_NAMES[id]))
    expect(s.missing.every((m) => m.why.length > 10)).toBe(true)
    expect(s.refusals.every((r) => r.code !== "unsupported")).toBe(true)
    expect(s.brought).toEqual([])
    expect(s.projectBytes).toBeNull()
    expect(s.message).toBe(unsupportedLead(MISSING.length))
  })

  it("an import has what came in, the node count, the notes, and no backticks in the words", () => {
    const s = summarize(imported, ctx)
    expect(s.status).toBe("imported")
    expect(s.accounted?.total).toBeGreaterThan(0)
    expect(JSON.stringify(s)).not.toContain("`")
    expect(s.notNeeded.length).toBeGreaterThan(0)
    expect(s.detail).toBeNull()
  })

  it("is plain data: it survives JSON and structuredClone unchanged, as it must across the worker", () => {
    const s = summarize(refused, { ...ctx, ignored: [{ path: "a/b.png", why: "not a KiCad design file" }] })
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(structuredClone(s)).toEqual(s)
    expect(s.ignored).toEqual([{ why: "not a KiCad design file", count: 1, examples: ["b.png"] }])
  })

  it("a stop before any board was read is a refusal with its reason and nothing else", () => {
    const s = stoppedSummary("no-board", "There is no KiCad board in these files.")
    expect(s).toMatchObject({ status: "refused", reason: "no-board", stamp: null, missing: [], projectBytes: null, detail: null })
  })
})

describe("every need shows what in the board raised it", () => {
  const boards: Record<string, string> = {
    "text in a font of the computer": board({ body: [footprint({ pads: [pad({ at: "-1 0" }), pad({ number: "2", at: "1 0" })] }), '(gr_text "x" (at 3 3) (layer "F.SilkS") (effects (font (face "Arial") (size 1 1) (thickness 0.15))))'] }),
    "a barcode and a track": board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), "(barcode)", '(segment (start 0 0) (end 5 0) (width 0.2) (layer "F.Cu") (net 0))'] }),
    "a custom property": board({ body: ["(custom_property)"] }),
    "a hatched copper pour": board({ body: [footprint({ pads: [pad({ at: "0 0" })] }), '(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5) (fill yes (mode hatch) (hatch_thickness 0.5) (hatch_gap 1) (hatch_orientation 0)) (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5))))'] }),
  }

  for (const [what, text] of Object.entries(boards)) {
    it(`${what}: each need's line carries the reason, its name leads, and the downloads carry both`, () => {
      const result = importKicadBoard(text)
      expect(result.status).toBe("refused")
      if (result.status !== "refused") return
      expect(result.needs.length).toBeGreaterThan(0)
      const s = summarize(result, ctx)
      const lines = reportSections(s).find((x) => x.title.startsWith("What this board uses"))!.lines
      const download = reportText(s, "b")
      for (const need of result.needs) {
        const why = need.why.replace(/`/g, "")
        expect(lines.some((l) => l.lead === plainName(need.ext) && l.text.includes(why)), need.ext).toBe(true)
        expect(download, need.ext).toContain(`${plainName(need.ext)} (${need.ext}): ${why}`)
        expect(JSON.parse(reportJson(s, "b")).missing.find((m: { id: string }) => m.id === need.ext).why).toBe(why)
      }
    })
  }

  it("holds for every extension id, whatever the reason says", () => {
    for (const id of Object.keys(EXTENSION_NAMES)) {
      const s = { ...stoppedSummary("unsupported", unsupportedLead(1)), missing: [{ id, name: plainName(id), why: `reason for ${id}` }] }
      expect(reportSections(s)[0].lines[0]).toEqual({ lead: PLAIN_NAMES[id], text: `reason for ${id}` })
      expect(reportText(s, "b")).toContain(`reason for ${id}`)
    }
  })
})

describe("the report screen's content", () => {
  it("a refusal says what the board uses and that nothing is half imported, once", () => {
    const s = summarize(refused, ctx)
    expect(reportTitle(s)).toBe("Not supported yet")
    expect(reportLead(s)).toBe(unsupportedLead(MISSING.length))
    expect(reportTone(s)).toBe("bad")
    const titles = reportSections(s).map((x) => x.title)
    expect(titles.slice(0, 2)).toEqual(["What this board uses that Cherry Blossom cannot hold yet", "Nothing was imported"])
  })

  it("for an unknown, inexact or unreadable refusal the lead is the importer's own message, not the missing sentence", () => {
    for (const reason of ["unknown", "inexact", "unreadable"] as const) {
      const s = { ...stoppedSummary(reason, `the importer says ${reason}`), missing: [{ id: "X9", name: "n", why: "w" }] }
      expect(reportLead(s)).toBe(`the importer says ${reason}`)
    }
  })

  it("an import has what came in, and its tone says whether something was left behind", () => {
    const s = summarize(imported, ctx)
    expect(reportTitle(s)).toBe("Imported from KiCad")
    expect(reportTone(s)).toBe("ok")
    expect(reportTone({ ...s, notBrought: [{ code: "x", object: "o", why: "w" }] })).toBe("warn")
    expect(reportSections(s).map((x) => x.title)).toEqual(expect.arrayContaining(["Left out because it is not needed", "Good to know", "Files not read"]))
    const withParts = summarize(importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }), { built: new Set(Object.keys(EXTENSION_NAMES)) }), ctx)
    expect(reportSections(withParts)[0]).toMatchObject({ title: "What came in", lines: [{ text: "1 parts, 2 texts of parts (references, values, labels)." }, expect.anything()] })
  })

  it("the lead does not repeat what the sections say", () => {
    const s = summarize(imported, ctx)
    expect(reportLead(s)).toBe("The board came in and is ready to open.")
    const tooLarge = summarize(importKicadBoard(board({}), { limitBytes: 100 }), ctx)
    expect(tooLarge.reason).toBe("too-large")
    expect(tooLarge.refusals).toEqual([])
    const said = JSON.stringify(reportSections(tooLarge))
    expect(said).not.toContain(tooLarge.message)
  })

  it("a failed save is titled Not saved, in the red tone, with the reason and a next step before anything else", () => {
    const s = summarize(imported, ctx)
    const err = "Couldn't save the project. It may not have been saved: check your projects list, then try again."
    expect(reportTitle(s, err)).toBe("Not saved")
    expect(reportTone(s, err)).toBe("bad")
    expect(reportLead(s, err)).toBe(err)
    expect(reportTitle(s, null)).toBe("Imported from KiCad")
    const withParts = summarize(importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }), { built: new Set(Object.keys(EXTENSION_NAMES)) }), ctx)
    expect(reportSections(withParts, err).map((x) => x.title)).toContain("What was read")
    expect(reportSections(withParts, err).map((x) => x.title)).not.toContain("What came in")
  })

  it("lists have no doubled counts", () => {
    const s = { ...summarize(imported, ctx), changed: [{ code: "renamed-ref", object: "3 references (C1; C2; C3)", why: "renamed", count: 3 }] }
    const line = reportSections(s).find((x) => x.title.startsWith("What changed"))!.lines[0]
    expect(line.lead).toBe("3 references (C1; C2; C3)")
    expect(reportText(s, "b")).toContain("3 references (C1; C2; C3): renamed")
    expect(reportText(s, "b")).not.toContain("(3)")
  })

  it("long lists show the cut and how many are hidden: entries, not needed, files not read, files set aside", () => {
    const base = summarize(imported, ctx)
    const many = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))
    const s: ImportSummary = {
      ...base,
      notBrought: many(40, (i) => ({ code: "x", object: `3D model ${i}`, why: "not in the library" })),
      notNeeded: many(30, (i) => ({ why: `reason ${i}`, count: 1 })),
      notRead: many(35, (i) => ({ file: `s${i}.kicad_sch`, why: "coming" })),
      ignored: many(9, (i) => ({ why: `group ${i}`, count: 2, examples: ["a", "b"] })),
    }
    const by = (t: string) => reportSections(s).find((x) => x.title === t)!
    expect(by("What was not brought in").count).toBe(40)
    expect(by("What was not brought in").lines.at(-1)!.text).toBe("and 15 more, in the full report.")
    expect(by("Left out because it is not needed").lines.at(-1)!.text).toBe("and 5 more, in the full report.")
    expect(by("Files not read").lines).toHaveLength(26)
    expect(by("Files not read").lines.at(-1)!.text).toBe("and 10 more, in the full report.")
    expect(by("Files set aside").lines).toHaveLength(7)
    expect(by("Files set aside").lines.at(-1)!.text).toBe("and 6 more files in other groups, in the full report.")
    expect(reportText(s, "b")).toContain("s34.kicad_sch")
  })

  it("every refusal reason has a title of its own", () => {
    const reasons: SummaryReason[] = ["too-large", "unsupported", "unknown", "inexact", "unreadable", "no-board", "bad-input", "failed", "cancelled"]
    const titles = reasons.map((r) => reportTitle(stoppedSummary(r, "m")))
    expect(new Set(titles).size).toBe(reasons.length)
  })
})

describe("the downloads", () => {
  const s = summarize(refused, { ...ctx, boardBytes: 4096 })

  it("the text report says the result, the same lead as the screen, the plain names with their ids and reasons, and the files not read", () => {
    const text = reportText(s, "my board")
    expect(text.startsWith(`KiCad import report: my board\nResult: not imported.\n${unsupportedLead(MISSING.length)}`)).toBe(true)
    for (const id of MISSING) {
      expect(text).not.toContain(EXTENSION_NAMES[id])
      expect(text).toContain(`${PLAIN_NAMES[id]} (${id}): `)
    }
    expect(text).toContain("x.kicad_pro: the schematic import is coming")
    expect(text).toContain("KiCad file version: 20240108")
  })

  it("the JSON report is the summary and the project's name", () => {
    expect(JSON.parse(reportJson(s, "my board"))).toMatchObject({ project: "my board", status: "refused", reason: "unsupported", missing: MISSING.map((id) => ({ id })) })
  })

  it("the technical detail of a failure is in the download and never in the words of the screen", () => {
    const failed = stoppedSummary("failed", "The import stopped before it finished. Nothing was saved. Reload the page and try again.", undefined, "TypeError: x is not a function")
    expect(reportText(failed, "b")).toContain("Technical detail: TypeError: x is not a function")
    expect(JSON.stringify([reportTitle(failed), reportLead(failed), reportSections(failed)])).not.toContain("TypeError")
  })

  it("a report with no project is named for the board file", () => {
    expect(reportName(s)).toBe("b")
    expect(reportName({ ...s, used: [] })).toBe("KiCad board")
  })
})

describe("the copy", () => {
  const sources = readdirSync(join(__dirname, "../src/kicadImport")).map((f) => join(__dirname, "../src/kicadImport", f))
  it("has no em dash or en dash anywhere in the import's files, tests included", () => {
    const tests = readdirSync(__dirname).filter((f) => f.startsWith("kicad-import")).map((f) => join(__dirname, f))
    for (const f of [...sources, ...tests]) expect(readFileSync(f, "utf8"), f).not.toMatch(/[\u2013\u2014]/)
  })

  it("every phase has a label", () => {
    expect(Object.keys(PHASE_LABELS).sort()).toEqual(["building", "reading", "saving"])
  })

  it("no summary built here carries a stack or a file path of this machine", () => {
    const s = summarize(refused, { used: [], notRead: [], ignored: [], boardBytes: 0 })
    expect(JSON.stringify(s)).not.toMatch(/\bat \S+ \(|node_modules|C:\\/)
  })
})
