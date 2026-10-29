import { describe, expect, it, vi } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { KicadImportController } from "../src/kicadImport/controller"
import { attachLcsc } from "../src/kicadImport/lcsc"
import { bodyOf, compareTrip, exportAndImport, sheetTexts } from "./kicad-roundtrip-editor"
import { cases } from "./kicad-roundtrip-cases"
import { getFootprint, likeFootprint, registerProjectFootprints } from "../src/model/footprints"
import { applyRecords, lcscNumberOf, lookupFromSource, matchLcsc, recordOfSupplierPart, sameLand, type LcscLookup } from "../src/model/lcscMatch"
import { modelAssignment } from "../src/model/models3d"
import { findPart } from "../src/model/library"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { importKicadProject } from "../src/model/kicad/project"
import { MOUNTING_HOLE_MARK } from "../src/model/kicad/mountingHoles"
import { pinKindOfType, pinTypeOfKind } from "../src/model/pinKinds"
import { pinRole } from "../src/model/supplier/roles"
import { mountingHoles } from "../src/model/board"
import type { ComponentInstance, Project } from "../src/model/types"
import { recordedPart, recordedSource } from "./fixtures/supplier/source"
import { entry, fakeStorage, fakeWorkers, stubLocalStorage } from "./kicad-import-helpers"

// What an editor project keeps when it is written as KiCad files and read again (`kicad-roundtrip-editor.ts` compares the two projects item by item): every
// text of the sheet where it was, every part with its body, the titled blocks, the board and its holes. And the step after an import that looks the parts' LCSC
// numbers up and attaches what is found, with the file's footprints exactly as they were.

const byId = (id: string) => cases().find((c) => c.id === id)!
const sch = (files: Record<string, string>) => Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
const pcb = (files: Record<string, string>) => Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const stubbed = lookupFromSource(recordedSource())

describe("an editor project written as KiCad files and read again", () => {
  // Every example and a dressed one: the texts, the symbols, the footprints and their bodies, the copper, the board, the blocks.
  for (const c of ["esp32-robot", "node", "blinker", "regulator", "mcu", "blinker+dressed", "regulator+dressed", "lcsc:ldo-and-friends", "lcsc:mcu-and-flash"]) {
    it(`loses nothing of ${c}: no text moved or gone, no part changed, no body black`, async () => {
      const trip = await exportAndImport(byId(c).project, stubbed)
      const { losses, counts } = compareTrip(trip)
      expect(losses.map((l) => `${l.kind}: ${l.detail}`)).toEqual([])
      expect(counts.text).toBeGreaterThan(10)
      expect(counts.component).toBeGreaterThan(2)
    }, 120_000)
  }

  it("shows the designator and the value of every part, where the sheet draws them, and the pins' names and numbers", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    const texts = sheetTexts(trip.after)
    for (const c of trip.before.components.filter((x) => !x.ref.startsWith("#"))) {
      const reference = texts.find((t) => t.key === `reference ${c.ref}`)
      expect(reference, `reference of ${c.ref}`).toBeTruthy()
      expect(reference!.text).toBe(c.ref)
      expect(reference!.hidden).toBe(false)
    }
    // The 555's pins, named as the sheet names them.
    const pinNames = texts.filter((t) => t.key === "symbol text U1").map((t) => t.text)
    for (const n of ["THR", "DIS", "CV", "VCC", "GND", "TRIG"]) expect(pinNames).toContain(n)
  }, 120_000)

  it("writes the designator and value as visible fields, not the converter's hidden ones", async () => {
    const { files } = await kicadFiles(byId("blinker").project)
    const r1 = sch(files).match(/\(property "Reference" "R1"[\s\S]*?\n {4}\)(?=\n)/)![0]
    expect(r1).not.toMatch(/\(hide yes\)/)
    expect(r1).toMatch(/\(size 1\.27 1\.27\)/)
    // the pins' names are texts of the library symbol (a symbol's text angle is in tenths of a degree), the pins keep their names
    const lib = sch(files).match(/\(symbol "Device:U_NE555_schematic_component_0"[\s\S]*?\n {4}\)(?=\n)/)![0]
    expect(lib).toMatch(/\(text "THR"/)
    expect(lib).toMatch(/\(name "THR"/)
  }, 120_000)

  it("keeps a vertical pin text vertical: its angle is written in tenths of a degree", async () => {
    const { files } = await kicadFiles(byId("esp32-robot").project)
    expect(sch(files)).toMatch(/\(text "3V3"\n\s+\(at [-\d. ]+ 900\)/)
  }, 120_000)

  it("keeps the free text, the box and the label the user drew", async () => {
    const trip = await exportAndImport(byId("blinker+dressed").project)
    const texts = sheetTexts(trip.after).map((t) => t.text)
    expect(texts).toContain("NOTE: check the supply before ordering")
    expect(texts).toContain("Rev B")
    expect(texts).toContain("TEST_POINT")
  }, 120_000)

  it("keeps the titled blocks as groups of their symbols", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    expect(sch(await kicadFiles(byId("blinker").project).then((r) => r.files))).toMatch(/\(group "555 TIMER"/)
    expect((trip.after.blocks ?? []).map((b) => b.name).sort()).toEqual(["555 TIMER", "LED", "POWER IN"])
  }, 120_000)

  it("keeps the board's rounded corners as arcs and its corner mounting holes as the board's own setting", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    expect(pcb((await kicadFiles(byId("blinker").project)).files)).toMatch(/\(gr_arc/)
    expect(trip.after.board.cornerRadius).toBeCloseTo(1, 3)
    expect(trip.after.board.outline ?? null).toBeNull()
    expect(trip.after.board.mountingHoles).toEqual({ drill: 2.2, diameter: 4.4, inset: 2.8 })
    expect(trip.after.components.some((c) => c.ref.startsWith("H"))).toBe(false)
    expect(mountingHoles(trip.after.board)).toHaveLength(4)
  }, 120_000)

  it("keeps a pour as one zone that KiCad refills, not as a polygon for each island it filled", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    expect(trip.after.zones).toHaveLength(trip.before.zones.length)
    expect(pcb((await kicadFiles(byId("blinker").project)).files).match(/\n {2}\(zone\b/g)).toHaveLength(trip.before.zones.length)
  }, 120_000)
})

describe("the electrical role of a pin and the designator prefix of a part", () => {
  it("are written as KiCad's pin types and the library symbol's reference, and read back as they were", async () => {
    const trip = await exportAndImport(byId("regulator").project)
    for (const c of trip.before.components.filter((x) => !x.ref.startsWith("#"))) {
      const a = trip.after.components.find((x) => x.ref === c.ref)!
      const part = findPart(c.partId)!
      const back = findPart(a.partId)!
      expect(back.refPrefix, c.ref).toBe(part.refPrefix)
      for (const pin of part.pins) if (pin.kind) expect(back.pins.find((q) => q.number === pin.number)?.kind, `${c.ref}.${pin.number}`).toBe(pin.kind)
    }
    const text = sch((await kicadFiles(byId("regulator").project)).files)
    expect(text).toMatch(/\(pin power_in line/)
    expect(text).toMatch(/\(pin output line/)
    expect(text).toMatch(/\(property "Reference" "J"/)
  }, 120_000)

  it("map both ways, and a ground pin is told from a supply by its name", () => {
    for (const kind of ["input", "output", "io", "passive", "nc"] as const) expect(pinKindOfType(pinTypeOfKind(kind)!, "X")).toBe(kind)
    expect(pinKindOfType(pinTypeOfKind("power")!, "VIN")).toBe("power")
    expect(pinKindOfType(pinTypeOfKind("ground")!, "GND")).toBe("ground")
    expect(pinKindOfType(pinTypeOfKind("ground")!, "PGND1")).toBe("ground")
    expect(pinRole("AGND")).toBe("ground")
    expect(pinTypeOfKind(undefined)).toBeUndefined()
  })
})

describe("a mounting hole that is not the board's corner hole stays a part", () => {
  it("when the four are not where the board's setting puts them", async () => {
    const project = byId("blinker").project
    const { files } = await kicadFiles(project)
    // move one hole by a millimetre in the file
    const moved = pcb(files).replace(/(MountingHole_2\.2mm"[\s\S]*?\(at )(\S+) (\S+)/, (_m, head: string, x: string, y: string) => `${head}${Number(x) + 1} ${y}`)
    expect(moved).not.toBe(pcb(files))
    const name = Object.keys(files).find((k) => k.endsWith(".kicad_pcb"))!
    const r = importKicadProject(Object.entries({ ...files, [name]: moved }).map(([path, data]) => ({ path, data })))
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.project.board.mountingHoles ?? null).toBeNull()
    expect(r.project.components.filter((c) => c.ref.startsWith("H"))).toHaveLength(4)
  }, 120_000)

  it("marks each hole with a property of its own, and keeps them out of the BOM and the position files", async () => {
    const text = pcb((await kicadFiles(byId("blinker").project)).files)
    expect(text.split(`(property "${MOUNTING_HOLE_MARK}"`).length - 1).toBe(4)
    expect(text).toMatch(/\(attr through_hole exclude_from_pos_files exclude_from_bom board_only\)/)
  }, 120_000)
})

describe("the 3D body of a part read back from the editor's own board", () => {
  it("is the body of the editor's footprint of that name, not a black block", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    for (const ref of ["R1", "C2", "U1", "D1", "J1"]) {
      const a = trip.after.components.find((c) => c.ref === ref)!
      const b = trip.before.components.find((c) => c.ref === ref)!
      expect(getFootprint(a.footprint).like, ref).toBe(b.footprint)
      expect(bodyOf(trip.after, a)!.materials, ref).toEqual(bodyOf(trip.before, b)!.materials)
      expect(bodyOf(trip.after, a)!.dark === bodyOf(trip.before, b)!.dark).toBe(true)
    }
    // an LED valued as a colour is an LED, a resistor is a resistor
    expect(bodyOf(trip.after, trip.after.components.find((c) => c.ref === "D1")!)!.materials.some((m) => m.startsWith("glow:"))).toBe(true)
  }, 120_000)

  it("keeps the file's own footprint: the pads are the file's, only the body comes from the library", async () => {
    const trip = await exportAndImport(byId("blinker").project)
    const a = trip.after.components.find((c) => c.ref === "R1")!
    const land = getFootprint(a.footprint)
    expect(land.name).not.toBe("0603")
    expect(land.pads.map((p) => p.pin)).toEqual(getFootprint("0603").pads.map((p) => p.pin))
  }, 120_000)

  it("is only claimed for a footprint the editor wrote, under its own library, and only when the pads are the same", () => {
    const pads = getFootprint("soic8").pads
    expect(likeFootprint("soic8", pads)).toBe("soic8")
    expect(likeFootprint("soic8", pads.map((p, i) => (i === 0 ? { ...p, x: p.x + 0.05 } : p)))).toBeUndefined()
    expect(likeFootprint("soic8", pads.slice(1))).toBeUndefined()
    expect(likeFootprint("not_a_footprint", pads)).toBeUndefined()
  })

  it("survives the project file", () => {
    const project: Project = { ...byId("blinker").project, footprints: [{ name: "x-abc123", pads: getFootprint("0603").pads, silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, like: "0603" }] }
    const back = parseProjectFile(serializeProject(project), { id: "x" })
    expect(back.footprints?.[0].like).toBe("0603")
  })
})

// ---------- the LCSC step ----------

/** A board read back from the editor's export whose parts carry the LCSC numbers of the recorded records. */
async function lcscBoard(id = "lcsc:ldo-and-friends"): Promise<Project> {
  return (await exportAndImport(byId(id).project)).after
}

const padsOf = (p: Project) => Object.fromEntries(p.components.map((c) => [c.ref, JSON.stringify(getFootprint(c.footprint).pads)]))

describe("LCSC numbers", () => {
  const c = (props: Record<string, string>) => ({ props }) as Pick<ComponentInstance, "props">

  it("are read from the fields boards use for them, and only when the value is one", () => {
    expect(lcscNumberOf(c({ LCSC: "C25804" }))).toBe("C25804")
    expect(lcscNumberOf(c({ "LCSC Part": " c25804 " }))).toBe("C25804")
    expect(lcscNumberOf(c({ "LCSC Part #": "C1" }))).toBeNull()
    expect(lcscNumberOf(c({ "JLCPCB Part #": "C2040" }))).toBe("C2040")
    expect(lcscNumberOf(c({ lcsc: "C99999" }))).toBe("C99999")
    expect(lcscNumberOf(c({ "Supplier Part Number": "C123456" }))).toBe("C123456")
    expect(lcscNumberOf(c({ "Supplier Part Number": "DK-1234" }))).toBeNull()
    expect(lcscNumberOf(c({ Manufacturer: "C123456" }))).toBeNull()
    expect(lcscNumberOf(c({}))).toBeNull()
  })

  it("find the real part for every part of a board that has a number, and attach the supplier's 3D model where the pads are the record's", async () => {
    const project = await lcscBoard()
    const before = padsOf(project)
    const found = await matchLcsc(project, stubbed)
    expect(found.stats).toMatchObject({ withNumber: 5, matched: 5, noMatch: 0, failed: 0 })
    // the TPS61023's model (the one recorded record that has one) sits on the file's pads
    const tps = found.project.components.find((x) => lcscNumberOf(x) === "C919459")!
    expect(modelAssignment(found.project, tps.partId, tps.footprint)?.source).toBe("supplier")
    expect(found.stats.models).toBe(1)
    // the package of a land that is the record's: the 3D view reads the body from it
    const ldo = found.project.components.find((x) => lcscNumberOf(x) === "C22365427")!
    expect(getFootprint(ldo.footprint).package).toMatch(/^SOT-23-5/)
    // and the footprints are exactly the file's
    expect(padsOf(found.project)).toEqual(before)
    expect(found.entries.find((e) => e.code === "lcsc-matched")?.why).toMatch(/exactly as the file has them/)
  }, 120_000)

  it("restore the 3D model the round trip lost, on the same pads", async () => {
    const trip = await exportAndImport(byId("lcsc:ldo-and-friends").project)
    const lost = compareTrip(trip).losses.filter((l) => l.kind === "3D model lost")
    expect(lost).toHaveLength(1)
    const again = await exportAndImport(byId("lcsc:ldo-and-friends").project, stubbed)
    expect(compareTrip(again).losses).toEqual([])
    expect(again.lcscStats).toMatchObject({ matched: 5, models: 1 })
  }, 120_000)

  it("add the data a file lacks and never overwrite what it has", async () => {
    const project = await lcscBoard()
    const tps = project.components.find((x) => lcscNumberOf(x) === "C919459")!
    const bare: Project = { ...project, components: project.components.map((x) => (x.id === tps.id ? { ...x, props: { value: "TPS", "LCSC Part": "C919459", MPN: "MY-OWN-MPN" } } : x)) }
    const found = await matchLcsc(bare, stubbed)
    const got = found.project.components.find((x) => x.id === tps.id)!
    expect(got.props.MPN).toBe("MY-OWN-MPN")
    expect(got.props.mpn).toBeUndefined()
    expect(got.props.manufacturer).toBe(recordedPart("C919459").manufacturer)
    expect(got.props.lcsc).toBe("C919459")
    expect(got.props["LCSC Part"]).toBe("C919459")
    expect(got.props.datasheet).toBe(recordedPart("C919459").datasheet ?? undefined)
  }, 120_000)

  it("say 'no LCSC match' for a number nothing has, and leave the part as the file has it", async () => {
    const project = await lcscBoard()
    const nobody: LcscLookup = async (n) => (n === "C919459" ? null : recordOfSupplierPart(recordedPart(n)))
    const found = await matchLcsc(project, nobody)
    expect(found.stats).toMatchObject({ matched: 4, noMatch: 1 })
    expect(found.entries.find((e) => e.code === "lcsc-no-match")?.object).toMatch(/no LCSC match for C919459/)
    const tps = found.project.components.find((x) => lcscNumberOf(x) === "C919459")!
    expect(modelAssignment(found.project, tps.partId, tps.footprint)).toBeNull()
  }, 120_000)

  it("report a lookup that failed and go on with the others", async () => {
    const project = await lcscBoard()
    const flaky: LcscLookup = async (n) => {
      if (n === "C138706") throw new Error("Sign in again to look parts up.")
      return recordOfSupplierPart(recordedPart(n))
    }
    const found = await matchLcsc(project, flaky)
    expect(found.stats).toMatchObject({ matched: 4, failed: 1 })
    expect(found.entries.find((e) => e.code === "lcsc-lookup-failed")?.why).toMatch(/Sign in again/)
  }, 120_000)

  it("do not move the model onto pads that are not the record's: a part on another land keeps its footprint and gets no model", async () => {
    const project = await lcscBoard()
    const tps = project.components.find((x) => lcscNumberOf(x) === "C919459")!
    // the record says the SOT-563 land; the file's part sits on a SOIC-8 land
    const wrong = { ...project, components: project.components.map((x) => (x.id === tps.id ? { ...x, props: { ...x.props, LCSC: "C919459" } } : x)) }
    const other = project.components.find((x) => lcscNumberOf(x) === "C138706")!
    const swapped = { ...wrong, components: wrong.components.map((x) => (x.id === tps.id ? { ...x, footprint: other.footprint } : x)) }
    registerProjectFootprints(swapped)
    const before = padsOf(swapped)
    const found = await matchLcsc(swapped, stubbed)
    expect(modelAssignment(found.project, tps.partId, other.footprint)).toBeNull()
    expect(found.entries.some((e) => e.code === "lcsc-land-differs")).toBe(true)
    expect(padsOf(found.project)).toEqual(before)
  }, 120_000)

  it("name a land the record's only when every pad is in the record's place within 0.01 mm", async () => {
    const project = await lcscBoard()
    const ldo = project.components.find((x) => lcscNumberOf(x) === "C22365427")!
    const def = getFootprint(ldo.footprint)
    const record = recordOfSupplierPart(recordedPart("C22365427"))
    expect(sameLand(def.pads, record.land!)).toBe(true)
    expect(sameLand(def.pads.map((p, i) => (i === 0 ? { ...p, x: p.x + 0.02 } : p)), record.land!)).toBe(false)
    expect(sameLand(def.pads.slice(1), record.land!)).toBe(false)
  }, 120_000)

  it("look every number up once, however many parts carry it", async () => {
    const project = await lcscBoard()
    const twin = project.components.find((x) => lcscNumberOf(x) === "C908680")!
    const doubled: Project = { ...project, components: [...project.components, { ...twin, id: "extra", ref: "D9" }] }
    const calls: string[] = []
    const counting: LcscLookup = async (n) => (calls.push(n), recordOfSupplierPart(recordedPart(n)))
    const found = await matchLcsc(doubled, counting)
    expect(calls.filter((n) => n === "C908680")).toHaveLength(1)
    expect(found.stats).toMatchObject({ withNumber: 6, numbers: 5, matched: 6 })
  }, 120_000)

  it("are looked up in the parts database first, the supplier second", async () => {
    const calls: string[] = []
    const stored = recordedPart("C22365427")
    const source = {
      async part(n: string) {
        calls.push(`part:${n}`)
        return n === "C22365427" ? stored : null
      },
      index: {
        async search(q: string) {
          calls.push(`index:${q}`)
          return { query: q, hits: [], attribution: [] }
        },
        async part() {
          return null
        },
      },
    }
    const record = await lookupFromSource(source)("C22365427")
    expect(record?.mpn).toBe(stored.mpn)
    expect(calls).toEqual(["index:C22365427", "part:C22365427"])
  })

  it("pure records can be applied without a network: nothing looked up is reported as such", async () => {
    const project = await lcscBoard()
    const out = applyRecords(project, new Map())
    expect(out.entries.map((e) => e.code)).toEqual(["lcsc-not-looked-up"])
    expect(out.project.components).toEqual(project.components)
  }, 120_000)
})

describe("the import's LCSC step, between reading the files and saving the project", () => {
  async function files(id = "lcsc:ldo-and-friends") {
    const { files } = await kicadFiles(byId(id).project)
    return Object.entries(files).map(([path, text]) => entry(path, text))
  }

  it("looks the numbers up with the host's lookup, shows the step, and saves the project with what it found", async () => {
    stubLocalStorage()
    const { storage, created } = fakeStorage()
    const phases: string[] = []
    const lookups: string[] = []
    const lookup: LcscLookup = async (n) => (lookups.push(n), recordOfSupplierPart(recordedPart(n)))
    const c = new KicadImportController(storage, { worker: fakeWorkers().create, lcsc: lookup })
    c.subscribe(() => c.state.step === "working" && phases.push(c.state.phase))
    c.start(await files())
    await vi.waitFor(() => expect(c.state.step).toBe("report"), { timeout: 60_000 })
    expect(phases).toContain("matching")
    expect(phases.indexOf("matching")).toBeLessThan(phases.indexOf("saving"))
    expect(lookups.sort()).toEqual(["C138706", "C22365427", "C80165", "C908680", "C919459"])
    expect(created).toHaveLength(1)
    // the project that was saved has the supplier's model of the TPS61023 and the package of the LDO's land
    const saved = parseProjectFile(created[0].content, { id: "x" })
    expect((saved.models ?? []).some((m) => m.model.source === "supplier")).toBe(true)
    expect((saved.footprints ?? []).some((f) => /^SOT-23-5/.test(f.package ?? ""))).toBe(true)
    expect(c.state.step === "report" && c.state.summary.notes.some((n) => n.code === "lcsc-matched")).toBe(true)
  }, 120_000)

  it("never asks the network when the board has no LCSC number, and never fails the import when there is no source", async () => {
    stubLocalStorage()
    const none = fakeStorage()
    const asked = vi.fn()
    const c1 = new KicadImportController(none.storage, { worker: fakeWorkers().create, lcsc: async (n) => (asked(n), null) })
    c1.start(await files("blinker"))
    await vi.waitFor(() => expect(c1.state.step).toBe("report"), { timeout: 60_000 })
    expect(asked).not.toHaveBeenCalled()

    const nosource = fakeStorage()
    const c2 = new KicadImportController(nosource.storage, { worker: fakeWorkers().create, lcsc: null })
    c2.start(await files())
    await vi.waitFor(() => expect(c2.state.step).toBe("report"), { timeout: 60_000 })
    expect(c2.state.step === "report" && c2.state.projectId).toBeTruthy()
    expect(c2.state.step === "report" && c2.state.summary.notes.some((n) => n.code === "lcsc-not-looked-up")).toBe(true)
  }, 120_000)

  it("is ended by Cancel: nothing is saved", async () => {
    stubLocalStorage()
    const { storage, created } = fakeStorage()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const slow: LcscLookup = async (n) => {
      await gate
      return recordOfSupplierPart(recordedPart(n))
    }
    const c = new KicadImportController(storage, { worker: fakeWorkers().create, lcsc: slow })
    c.start(await files())
    await vi.waitFor(() => expect(c.state.step === "working" && c.state.phase).toBe("matching"), { timeout: 60_000 })
    c.cancel()
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.state.step).toBe("idle")
    expect(created).toHaveLength(0)
  }, 120_000)

  it("attaches on the outcome without touching the importer: the project it was given is the one the importer built", async () => {
    const trip = await exportAndImport(byId("lcsc:ldo-and-friends").project)
    const outcome = { project: trip.after, summary: { status: "imported", notes: [], changed: [], notBrought: [], refusals: [] } as never }
    const result = await attachLcsc(outcome, stubbed)
    expect(result.stats?.matched).toBe(5)
    expect(result.outcome.project).not.toBe(trip.after)
    expect(findPart(trip.after.components[0].partId)).toBeTruthy()
  }, 120_000)
})
