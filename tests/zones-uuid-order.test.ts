import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { higherPriority, kicadUuid } from "../src/model/zones"
import type { Project, Zone } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { analyze, rectangle, twoResistors, withZone } from "./zones-fixtures"

// Two zones of equal priority are ordered by uuid, as KiCad's `ZONE::HigherPriority` orders them (zone.cpp of 6.0 to 10.0: `m_Uuid > aOther->m_Uuid`, and
// `KIID::operator>` compares the sixteen bytes), not by where the file lists them. A zone with no uuid (drawn here, or a KiCad 5 board) goes by file order.

const A = "11111111222233334444555555555555"
const B = "aaaaaaaabbbbccccddddeeeeeeeeeeee"

describe("kicadUuid", () => {
  it("reads the sixteen bytes of a uuid and the four of a KiCad 6 timestamp, as KiCad does, and nothing else", () => {
    expect(kicadUuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(B)
    expect(kicadUuid(B)).toBe(B)
    expect(kicadUuid("5A1B2C3D")).toBe("0000000000000000000000005a1b2c3d")
    expect(kicadUuid("5a1b2c3d")!.length).toBe(32)
    expect(kicadUuid("a1")).toBeUndefined()
    expect(kicadUuid("zzzzzzzz")).toBeUndefined()
    expect(kicadUuid("")).toBeUndefined()
  })
})

describe("higherPriority", () => {
  const zones = (a: Partial<Zone>, b: Partial<Zone>): [Project, Zone, Zone] => {
    const za: Zone = { id: "a", net: "", layer: "top", ...a }
    const zb: Zone = { id: "b", net: "", layer: "top", ...b }
    return [{ zones: [za, zb] } as Project, za, zb]
  }
  it("is the priority first, whatever the uuids", () => {
    const [p, a, b] = zones({ priority: 2, uuid: A }, { uuid: B })
    expect(higherPriority(p, a, b)).toBe(true)
    expect(higherPriority(p, b, a)).toBe(false)
  })
  it("is the greater uuid at equal priority, whichever the file lists first", () => {
    const [p, a, b] = zones({ uuid: A }, { uuid: B })
    expect(higherPriority(p, b, a)).toBe(true)
    expect(higherPriority(p, a, b)).toBe(false)
    const [q, c, d] = zones({ uuid: B }, { uuid: A })
    expect(higherPriority(q, c, d)).toBe(true)
  })
  it("is neither of two zones of a board from KiCad 5 or earlier, which cut only out of zones of strictly higher priority", () => {
    const [p, a, b] = zones({ unordered: true }, { unordered: true })
    expect(higherPriority(p, a, b)).toBe(false)
    expect(higherPriority(p, b, a)).toBe(false)
    const [q, c, d] = zones({ unordered: true, priority: 1 }, { unordered: true })
    expect(higherPriority(q, c, d)).toBe(true)
    // Against a zone drawn here it is the file's order, as for any zone with no uuid.
    const [r, e, f] = zones({ unordered: true }, {})
    expect(higherPriority(r, f, e)).toBe(true)
  })
  it("is the later zone of the file when either has no uuid", () => {
    const [p, a, b] = zones({ uuid: B }, {})
    expect(higherPriority(p, b, a)).toBe(true)
    const [q, c, d] = zones({}, {})
    expect(higherPriority(q, d, c)).toBe(true)
  })
})

describe("equal-priority zones that overlap", () => {
  /** A GND zone and a zone on no net over the same ground, in the order given. */
  const pair = (uuids: [string | undefined, string | undefined], flip = false): Project => {
    let p = withZone(twoResistors(), rectangle(-19, -13, 19, 13), { net: "GND" }, "gnd")
    p = withZone(p, rectangle(-19, -13, 19, 13), { net: "" }, "none")
    p = { ...p, zones: p.zones.map((z, i) => ({ ...z, ...(uuids[i] ? { uuid: uuids[i] } : {}) })) }
    return flip ? { ...p, zones: [...p.zones].reverse() } : p
  }
  const area = (p: Project, id: string) => {
    const f = analyze(p).zoneFills.find((x) => x.zoneId === id && x.layer === "top")!
    return f.polygons.reduce((n, poly) => n + poly.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(r.reduce((a, q, k) => a + (r[(k + r.length - 1) % r.length].x * q.y - q.x * r[(k + r.length - 1) % r.length].y), 0) / 2), 0), 0)
  }

  it("go by uuid: the greater one is filled first and the other keeps out of it", () => {
    const gndWins = pair([B, A])
    const noneWins = pair([A, B])
    expect(area(gndWins, "gnd")).toBeGreaterThan(area(noneWins, "gnd") + 100)
    // The order of the file decides nothing once both have a uuid.
    expect(area(pair([B, A], true), "gnd")).toBeCloseTo(area(gndWins, "gnd"), 6)
    expect(area(pair([A, B], true), "gnd")).toBeCloseTo(area(noneWins, "gnd"), 6)
  })

  it("overlap, each whole, when they come from KiCad 5 or earlier", () => {
    const old = pair([undefined, undefined])
    const unordered = { ...old, zones: old.zones.map((z) => ({ ...z, unordered: true as const })) }
    // The GND zone is cut by neither: it is the copper it is with nothing over it.
    const alone = { ...old, zones: old.zones.slice(0, 1) }
    expect(area(unordered, "gnd")).toBeCloseTo(area(alone, "gnd"), 6)
    expect(area(unordered, "none")).toBeGreaterThan(0)
  })

  it("go by the file when they have no uuid, as zones drawn here always did", () => {
    const a = pair([undefined, undefined])
    expect(area(a, "gnd")).toBeLessThan(area(pair([B, A]), "gnd") - 100)
    expect(area(pair([undefined, undefined], true), "gnd")).toBeGreaterThan(area(a, "gnd") + 100)
  })
})

describe("the importer keeps the uuid", () => {
  const square = "(polygon (pts (xy 2 2) (xy 18 2) (xy 18 8) (xy 2 8)))"
  const part = footprint({ pads: [pad({ at: "5 5", net: '(net 1 "GND")' }), pad({ number: "2", at: "9 5", net: '(net 2 "SIG")' })] })
  const nets = ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")']
  const fill = "(connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.45) (thermal_bridge_width 0.35))"
  const zone = (stamp: string) => `(zone (net 1) (net_name "GND") (layer "F.Cu") ${stamp} (hatch edge 0.5) ${fill} ${square})`
  const zonesOf = (version: number, stamp: string) => {
    const r = importKicadBoard(board({ nets, body: [part, zone(stamp)], version }))
    if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
    return r.project
  }

  it("from the uuid of KiCad 7 and later, the timestamp of KiCad 6, and not at all from KiCad 5", () => {
    expect(zonesOf(20240108, `(uuid "${B.slice(0, 8)}-${B.slice(8, 12)}-${B.slice(12, 16)}-${B.slice(16, 20)}-${B.slice(20)}")`).zones[0].uuid).toBe(B)
    expect(zonesOf(20211014, "(tstamp 5A1B2C3D)").zones[0].uuid).toBe("0000000000000000000000005a1b2c3d")
    expect(zonesOf(4, "(tstamp 5A1B2C3D)").zones[0].uuid).toBeUndefined()
    // KiCad 5 and earlier, and a nightly before 6, order none: their filler cuts only out of zones of strictly higher priority.
    expect(zonesOf(4, "(tstamp 5A1B2C3D)").zones[0].unordered).toBe(true)
    expect(zonesOf(20190101, "(tstamp 5A1B2C3D)").zones[0].unordered).toBe(true)
    expect(zonesOf(20211014, "(tstamp 5A1B2C3D)").zones[0].unordered).toBeUndefined()
    expect(zonesOf(20240108, '(uuid "a1")').zones[0].unordered).toBeUndefined()
  })

  it("leaves it out when the word is not a uuid", () => {
    expect(zonesOf(20240108, '(uuid "a1")').zones[0].uuid).toBeUndefined()
  })

  it("survives a save and a load, and an export to KiCad and a read of that", async () => {
    const p = zonesOf(20240108, `(uuid "${B.slice(0, 8)}-${B.slice(8, 12)}-${B.slice(12, 16)}-${B.slice(16, 20)}-${B.slice(20)}")`)
    expect(parseProjectFile(serializeProject(p), { id: p.id }).zones[0].uuid).toBe(B)
    const { files } = await kicadFiles(p)
    const text = Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]
    expect(readKicadBoard(text).board.zones[0].uuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  })
})
